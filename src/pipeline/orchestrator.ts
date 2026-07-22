import { PumpFunScanner } from "../scanners/pumpfun.js";
import { PumpPortalScanner } from "../scanners/pumpportal.js";
import type { TokenScanner } from "../scanners/types.js";
import { passesMarketCapFilter } from "../scanners/filters.js";
import { getCandles, getTokenOverview, getTokenSecurity } from "../data/birdeye.js";
import { marketContext } from "../data/marketContext.js";
import { analyzeSentiment } from "../ai/sentiment.js";
import { scoreTrade } from "../ai/scorer.js";
import { assessTokenSafety, defaultRugCheckConfig } from "../safety/rugCheck.js";
import { sizePosition, meetsConfidenceThreshold, checkExitConditions, defaultRiskConfig } from "../risk/riskManager.js";
import { executeBuy, executeSell } from "../execution/jupiterExecutor.js";
import { Portfolio } from "../state/portfolio.js";
import { PositionStore } from "../state/positionStore.js";
import { TradeLog } from "../state/tradeLog.js";
import { WhaleTracker } from "../whales/whaleTracker.js";
import { TelegramNotifier } from "../notify/telegram.js";
import { Semaphore } from "../utils/semaphore.js";
import { childLogger } from "../utils/logger.js";
import { env } from "../config/env.js";
import type { PumpFunToken, ScoringPayload, TradeSignal } from "../types/index.js";

const log = childLogger("orchestrator");

const MAX_CONCURRENT_EVALUATIONS = 3;
const POSITION_MONITOR_INTERVAL_MS = 30_000;

export interface OrchestratorDeps {
  portfolio: Portfolio;
  positionStore: PositionStore;
  whaleTracker: WhaleTracker;
  tradeLog: TradeLog;
  telegram: TelegramNotifier;
}

/**
 * Wires strategy rules #1-7 together: scan -> filter -> enrich (candles +
 * sentiment + whale activity) -> score -> risk-size -> execute, plus a
 * separate loop that enforces the two hard exit rules (stop loss, 48h
 * max age) on open positions.
 */
const FUNNEL_LOG_INTERVAL_MS = 60_000;

export class TradingOrchestrator {
  private readonly scanner: TokenScanner;
  private readonly semaphore = new Semaphore(MAX_CONCURRENT_EVALUATIONS);
  private positionMonitorTimer: NodeJS.Timeout | null = null;
  private funnelTimer: NodeJS.Timeout | null = null;

  // Visibility into where tokens drop out of the pipeline, logged
  // periodically so "no trades" is explainable at a glance instead of a
  // silent mystery.
  private funnel = {
    seen: 0,
    passedMcap: 0,
    evaluated: 0,
    evalFailed: 0,
    rejectedSafety: 0,
    rejectedLowConfidence: 0,
    signals: 0,
    tradesOpened: 0,
    maxMcapUsdSeen: 0,
  };

  constructor(private readonly deps: OrchestratorDeps) {
    // Default to PumpPortal's websocket (reliable, bot-friendly); the
    // pump.fun HTTP poller stays available via SCANNER_SOURCE=pumpfun.
    this.scanner =
      env.SCANNER_SOURCE === "pumpfun"
        ? new PumpFunScanner()
        : new PumpPortalScanner(() => marketContext.getSolPriceUsd());
  }

  start(): void {
    log.info({ source: env.SCANNER_SOURCE }, "using token discovery source");
    this.scanner.on("newToken", (token) => {
      void this.handleNewToken(token);
    });
    // Both scanners emit "error" on failures (already logged internally).
    // Node crashes the whole process on an unhandled "error" event if
    // nothing is listening for it -- this listener keeps a transient
    // scanner outage from taking the bot down.
    this.scanner.on("error", () => {});
    this.scanner.start();

    this.positionMonitorTimer = setInterval(() => void this.monitorPositions(), POSITION_MONITOR_INTERVAL_MS);
    this.funnelTimer = setInterval(() => this.logFunnel(), FUNNEL_LOG_INTERVAL_MS);

    log.info({ mode: env.LIVE_TRADING ? "live" : "paper" }, "orchestrator started");
  }

  stop(): void {
    this.scanner.stop();
    if (this.positionMonitorTimer) clearInterval(this.positionMonitorTimer);
    if (this.funnelTimer) clearInterval(this.funnelTimer);
    this.positionMonitorTimer = null;
    this.funnelTimer = null;
  }

  /**
   * One-line snapshot of the last interval's token funnel. Read it to see
   * where tokens drop out: almost all get cut at the >$50k market-cap
   * filter (brand-new tokens are tiny), which is why trades are rare.
   */
  private logFunnel(): void {
    const f = this.funnel;
    log.info(
      {
        seen: f.seen,
        mcapThresholdUsd: env.MIN_MARKET_CAP_USD,
        biggestTokenSeenUsd: Math.round(f.maxMcapUsdSeen),
        passedMcapFilter: f.passedMcap,
        evaluated: f.evaluated,
        evalFailed: f.evalFailed,
        rejectedBySafety: f.rejectedSafety,
        rejectedLowConfidence: f.rejectedLowConfidence,
        signals: f.signals,
        tradesOpened: f.tradesOpened,
      },
      "token funnel (last interval)",
    );
    this.funnel = {
      seen: 0,
      passedMcap: 0,
      evaluated: 0,
      evalFailed: 0,
      rejectedSafety: 0,
      rejectedLowConfidence: 0,
      signals: 0,
      tradesOpened: 0,
      maxMcapUsdSeen: 0,
    };
  }

  private async handleNewToken(token: PumpFunToken): Promise<void> {
    this.funnel.seen++;
    if (token.marketCapUsd > this.funnel.maxMcapUsdSeen) this.funnel.maxMcapUsdSeen = token.marketCapUsd;
    if (!passesMarketCapFilter(token)) return; // rule #2
    this.funnel.passedMcap++;
    if (this.deps.positionStore.hasOpenPosition(token.mint)) return;

    const release = await this.semaphore.acquire();
    try {
      this.funnel.evaluated++;
      await this.evaluateAndMaybeTrade(token);
    } catch (err) {
      this.funnel.evalFailed++;
      log.error({ mint: token.mint, err: (err as Error).message }, "evaluation failed");
    } finally {
      release();
    }
  }

  private async evaluateAndMaybeTrade(token: PumpFunToken): Promise<void> {
    // Rug/safety gate runs first and cheaply (two Birdeye calls), before
    // candles/news/whale enrichment and the AI calls, so an unsafe token
    // never burns that spend. A failed security lookup throws and the
    // caller's catch block skips the token — fail closed, not open.
    const [overview, security] = await Promise.all([getTokenOverview(token.mint), getTokenSecurity(token.mint)]);

    const safety = assessTokenSafety(security, overview, defaultRugCheckConfig());
    if (!safety.passed) {
      this.funnel.rejectedSafety++;
      log.info({ mint: token.mint, symbol: token.symbol, reasons: safety.reasons }, "rejected by rug/safety check");
      return;
    }

    const [candles, news, solPriceUsd] = await Promise.all([
      getCandles(token.mint), // rule #3
      marketContext.getCryptoNews(),
      marketContext.getSolPriceUsd(),
    ]);

    const sentiment = await analyzeSentiment(news, { symbol: token.symbol, tokenName: token.name }); // rule #4
    const whaleActivity = this.deps.whaleTracker.getActivity(token.mint, 60); // rule #5

    const openPositions = this.deps.positionStore.getOpen();
    const openPositionsValueUsd = openPositions.reduce((sum, p) => sum + p.costBasisUsd, 0);
    const portfolioSnapshot = this.deps.portfolio.getSnapshot(openPositionsValueUsd, solPriceUsd, openPositions.length);

    const payload: ScoringPayload = {
      token,
      overview,
      security,
      candles,
      sentiment,
      whaleActivity,
      portfolio: portfolioSnapshot,
    }; // rule #6: merged payload

    const scoring = await scoreTrade(payload); // rule #6: Opus scores the trade

    if (scoring.direction !== "long" || !meetsConfidenceThreshold(scoring.confidence)) {
      this.funnel.rejectedLowConfidence++;
      log.debug({ mint: token.mint, confidence: scoring.confidence, direction: scoring.direction }, "no trade");
      return;
    }
    this.funnel.signals++;

    const signal: TradeSignal = {
      mint: token.mint,
      symbol: token.symbol,
      confidence: scoring.confidence,
      direction: scoring.direction,
      reasoning: scoring.reasoning,
      entryPriceUsd: overview.priceUsd || token.priceUsd,
      generatedAt: Date.now(),
    };
    log.info({ signal }, "trade signal generated (confidence > threshold)"); // rule #7

    await this.executeSignal(signal, solPriceUsd);
  }

  private async executeSignal(signal: TradeSignal, solPriceUsd: number): Promise<void> {
    const config = defaultRiskConfig();
    const openPositions = this.deps.positionStore.getOpen();
    const openPositionsValueUsd = openPositions.reduce((sum, p) => sum + p.costBasisUsd, 0);
    const snapshot = this.deps.portfolio.getSnapshot(openPositionsValueUsd, solPriceUsd, openPositions.length);

    const sizing = sizePosition(snapshot, signal.entryPriceUsd, solPriceUsd, config);
    if (!sizing.approved) {
      log.warn({ mint: signal.mint, reason: sizing.reason }, "trade rejected by risk manager");
      return;
    }

    const mode = env.LIVE_TRADING ? "live" : "paper";
    const result = await executeBuy(signal.mint, sizing.costBasisSol, mode); // rule #7: auto-execute via Jupiter

    if (!result.success) {
      log.error({ mint: signal.mint, error: result.error }, "buy execution failed");
      await this.deps.telegram.notifyExecutionError("buy", signal.symbol, result.error ?? "unknown error");
      return;
    }

    this.deps.portfolio.applyBuy(sizing.costBasisSol);
    const position = await this.deps.positionStore.openPosition({
      signal,
      entryPriceUsd: signal.entryPriceUsd,
      quantityTokens: sizing.quantityTokens,
      costBasisUsd: sizing.costBasisUsd,
      costBasisSol: sizing.costBasisSol,
      stopLossPriceUsd: sizing.stopLossPriceUsd,
      maxAgeHours: config.maxPositionAgeHours,
    });
    this.funnel.tradesOpened++;
    await this.deps.telegram.notifyPositionOpened(position);
  }

  /**
   * Enforces the (trailing) stop and 48h max-age exit. No fixed
   * take-profit — the trailing stop is what locks in gains on a winner
   * instead of letting it round-trip back to a stop-loss.
   */
  private async monitorPositions(): Promise<void> {
    const openPositions = this.deps.positionStore.getOpen();
    if (openPositions.length === 0) return;

    for (const position of openPositions) {
      try {
        const overview = await getTokenOverview(position.mint);
        const currentPriceUsd = overview.priceUsd;
        if (currentPriceUsd <= 0) continue;

        const tracked = (await this.deps.positionStore.updatePeakPrice(position.id, currentPriceUsd)) ?? position;
        const exitCheck = checkExitConditions(tracked, currentPriceUsd);
        if (!exitCheck.shouldExit || !exitCheck.reason) continue;

        const mode = env.LIVE_TRADING ? "live" : "paper";
        const result = await executeSell(position.mint, position.quantityTokens, mode);
        if (!result.success) {
          log.error({ mint: position.mint, error: result.error }, "sell execution failed");
          await this.deps.telegram.notifyExecutionError("sell", position.symbol, result.error ?? "unknown error");
          continue;
        }

        const proceedsSol = (currentPriceUsd * position.quantityTokens) / (await marketContext.getSolPriceUsd());
        this.deps.portfolio.applySell(proceedsSol);
        const closed = await this.deps.positionStore.closePosition(position.id, currentPriceUsd, exitCheck.reason);
        if (closed) {
          const entry = await this.deps.tradeLog.recordClosedPosition(closed);
          await this.deps.telegram.notifyPositionClosed(entry);
        }
      } catch (err) {
        log.error({ mint: position.mint, err: (err as Error).message }, "position monitor error");
      }
    }
  }
}
