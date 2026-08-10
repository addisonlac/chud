import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { childLogger } from "../utils/logger.js";
import type { Position, TradeLogEntry } from "../types/index.js";

const log = childLogger("trade-log");

const DATA_DIR = path.resolve("data");
const TRADE_LOG_PATH = path.join(DATA_DIR, "trade-log.json");

/** Confidence is bucketed rather than treated as continuous — coarse buckets are what's actually readable. The lowest bucket tracks the permissive paper gate (CONFIDENCE_THRESHOLD default 0.60); tighten the gate and the low bucket simply stays empty. */
const CALIBRATION_BUCKETS: { min: number; max: number; label: string }[] = [
  { min: 0.6, max: 0.72, label: "0.60-0.72" },
  { min: 0.72, max: 0.8, label: "0.72-0.80" },
  { min: 0.8, max: 0.9, label: "0.80-0.90" },
  { min: 0.9, max: 1.01, label: "0.90-1.00" },
];

const MIN_SAMPLE_SIZE_FOR_CONFIDENCE = 30;

export interface CalibrationBucket {
  rangeLabel: string;
  min: number; // lower confidence bound of the bucket (drives the adaptive gate)
  count: number;
  avgPredictedConfidence: number;
  actualWinRatePct: number;
}

export interface TradeStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancyPct: number;
  totalRealizedPnlUsd: number;
  largestWinUsd: number;
  largestLossUsd: number;
  /** Mean squared error between predicted confidence and realized outcome (0=perfect, 0.25=no better than always guessing 50%, 1=worst). Null until there's at least one closed trade. */
  brierScore: number | null;
  calibrationBuckets: CalibrationBucket[];
  sampleSizeWarning: string | null;
}

export interface GoLiveCheck {
  label: string;
  passed: boolean;
  detail: string;
}

export interface GoLiveReadiness {
  ready: boolean;
  checks: GoLiveCheck[];
}

export interface GoLiveCriteria {
  minTrades: number;
  minExpectancyPct: number;
}

/**
 * Turns "is it profitable enough to risk real money?" from a gut call into an
 * objective gate. ALL checks must pass. This is deliberately strict — the
 * cost of a false "ready" is real losses, so the bar errs toward NOT going
 * live. Note: these stats are only trustworthy if paper fills model real
 * execution costs (see PAPER_TRADING_COST_PCT); otherwise expectancy is a
 * frictionless fantasy and this gate will happily green-light a mirage.
 */
export function evaluateGoLiveReadiness(stats: TradeStats, criteria: GoLiveCriteria): GoLiveReadiness {
  const checks: GoLiveCheck[] = [];

  checks.push({
    label: "Sample size",
    passed: stats.totalTrades >= criteria.minTrades,
    detail: `${stats.totalTrades} / ${criteria.minTrades} closed trades`,
  });

  checks.push({
    label: "Expectancy after costs",
    passed: stats.expectancyPct >= criteria.minExpectancyPct,
    detail: `${stats.expectancyPct >= 0 ? "+" : ""}${stats.expectancyPct.toFixed(2)}% / trade (need ≥ +${criteria.minExpectancyPct}%)`,
  });

  checks.push({
    label: "Net profitable",
    passed: stats.totalRealizedPnlUsd > 0,
    detail: `total realized PnL $${stats.totalRealizedPnlUsd.toFixed(2)}`,
  });

  // Confidence must not be anti-informative: the highest populated
  // calibration bucket should win at least as often as the lowest. If higher
  // AI confidence doesn't mean higher realized win rate, the scorer has no
  // selection edge and the whole premise fails.
  const populated = stats.calibrationBuckets.filter((b) => b.count > 0);
  let calibrationOk = true;
  let calibrationDetail = "not enough spread across confidence buckets to judge";
  if (populated.length >= 2) {
    const lowest = populated[0]!;
    const highest = populated[populated.length - 1]!;
    calibrationOk = highest.actualWinRatePct >= lowest.actualWinRatePct;
    calibrationDetail = `${highest.rangeLabel} wins ${highest.actualWinRatePct.toFixed(0)}% vs ${lowest.rangeLabel} ${lowest.actualWinRatePct.toFixed(0)}%`;
  }
  checks.push({ label: "Confidence is informative", passed: calibrationOk, detail: calibrationDetail });

  return { ready: checks.every((c) => c.passed), checks };
}

export interface AdaptiveThreshold {
  threshold: number; // the confidence gate to actually use
  baseline: number; // the configured CONFIDENCE_THRESHOLD floor
  active: boolean; // true when it has raised the gate above the baseline
  reason: string; // human-readable explanation for logs/digest
}

export interface AdaptiveConfig {
  minSample: number; // min closed trades before adapting at all
  minBucketCount: number; // ignore confidence buckets thinner than this (too noisy)
  marginPct: number; // require realized win rate this many points above breakeven
}

/**
 * The self-calibration loop. Reads realized per-confidence-bucket win rates
 * and RAISES the confidence gate to the lowest bucket that has actually been
 * profitable — i.e. it stops trusting confidence levels that lose money.
 *
 * Rules that keep it honest rather than an overfitting machine:
 *  - Never lowers the gate below the configured baseline (only tightens).
 *  - Does nothing until minSample closed trades exist (no reacting to noise).
 *  - Ignores buckets thinner than minBucketCount.
 *  - "Profitable" = realized win rate ≥ the breakeven win rate implied by the
 *    realized avg win/loss, plus a safety margin.
 *  - If no level clears breakeven yet, it holds at baseline (keeps exploring
 *    in paper) rather than halting — the go-live gate is what blocks real
 *    money. Assumes roughly monotonic calibration (higher confidence should
 *    win more); on noisy small samples it takes the lowest clearing bucket.
 *
 * Note the exploit/explore tradeoff: once the gate rises past a bucket, that
 * bucket stops gathering NEW data (its estimate is frozen at what's logged).
 */
export function computeAdaptiveConfidenceThreshold(
  stats: TradeStats,
  baseline: number,
  config: AdaptiveConfig,
): AdaptiveThreshold {
  const hold = (reason: string): AdaptiveThreshold => ({ threshold: baseline, baseline, active: false, reason });

  if (stats.totalTrades < config.minSample) {
    return hold(`warming up (${stats.totalTrades}/${config.minSample} trades) — using baseline ${baseline}`);
  }
  if (stats.wins === 0 || stats.losses === 0) {
    return hold("need both wins and losses to calibrate — using baseline");
  }

  const avgWin = stats.avgWinPct; // positive %
  const avgLoss = Math.abs(stats.avgLossPct); // magnitude, positive %
  if (avgWin + avgLoss <= 0) return hold("degenerate win/loss sizes — using baseline");

  // Win rate needed just to break even given the realized payoff ratio.
  const breakevenWinRatePct = (avgLoss / (avgWin + avgLoss)) * 100;
  const targetWinRatePct = breakevenWinRatePct + config.marginPct;

  // Buckets are ordered ascending by confidence; take the lowest one with
  // enough samples whose realized win rate clears the target.
  const usable = stats.calibrationBuckets.filter((b) => b.count >= config.minBucketCount);
  const qualifying = usable.find((b) => b.actualWinRatePct >= targetWinRatePct);

  if (!qualifying) {
    return hold(
      `no confidence level has cleared breakeven (~${targetWinRatePct.toFixed(0)}% win rate) yet — holding baseline ${baseline}`,
    );
  }

  const threshold = Math.max(baseline, qualifying.min);
  return {
    threshold,
    baseline,
    active: threshold > baseline,
    reason:
      threshold > baseline
        ? `raised to ${threshold} — ${qualifying.rangeLabel} is the lowest level clearing breakeven (${qualifying.actualWinRatePct.toFixed(0)}% ≥ ${targetWinRatePct.toFixed(0)}%)`
        : `baseline ${baseline} already the lowest profitable level (${qualifying.rangeLabel} wins ${qualifying.actualWinRatePct.toFixed(0)}%)`,
  };
}

export function toTradeLogEntry(position: Position): TradeLogEntry {
  if (
    position.status !== "closed" ||
    position.exitPriceUsd === undefined ||
    position.exitTimestamp === undefined ||
    position.exitReason === undefined ||
    position.realizedPnlUsd === undefined
  ) {
    throw new Error(`cannot log unclosed position ${position.id}`);
  }

  return {
    id: position.id,
    mint: position.mint,
    symbol: position.symbol,
    entryPriceUsd: position.entryPriceUsd,
    exitPriceUsd: position.exitPriceUsd,
    entryTimestamp: position.entryTimestamp,
    exitTimestamp: position.exitTimestamp,
    holdHours: (position.exitTimestamp - position.entryTimestamp) / (1000 * 60 * 60),
    quantityTokens: position.quantityTokens,
    costBasisUsd: position.costBasisUsd,
    realizedPnlUsd: position.realizedPnlUsd,
    // Return on the capital deployed, so a partial take-profit's banked gain
    // is included (not just the final exit price). For a trade with no
    // scale-out this equals (exit − entry)/entry.
    pnlPct: position.costBasisUsd > 0 ? position.realizedPnlUsd / position.costBasisUsd : 0,
    exitReason: position.exitReason,
    signalConfidence: position.signal.confidence,
    won: position.realizedPnlUsd > 0,
  };
}

/**
 * Persisted ledger of every closed trade (win or loss), plus the aggregate
 * stats needed to answer "is the AI's confidence score actually
 * informative, or just a confident-sounding number?" — a Brier score and
 * per-confidence-bucket realized win rate. Nothing in the trading pipeline
 * enforces a conclusion from these numbers; they're here to be read before
 * trusting the confidence gate with real size.
 */
export class TradeLog {
  private entries: TradeLogEntry[] = [];

  async load(): Promise<void> {
    try {
      const raw = await readFile(TRADE_LOG_PATH, "utf-8");
      this.entries = JSON.parse(raw) as TradeLogEntry[];
      log.info({ count: this.entries.length }, "loaded trade log from disk");
    } catch {
      this.entries = [];
    }
  }

  private async persist(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(TRADE_LOG_PATH, JSON.stringify(this.entries, null, 2));
  }

  async record(entry: TradeLogEntry): Promise<void> {
    this.entries.push(entry);
    await this.persist();
    log.info(
      { symbol: entry.symbol, won: entry.won, pnlPct: entry.pnlPct, exitReason: entry.exitReason, confidence: entry.signalConfidence },
      entry.won ? "trade closed: WIN" : "trade closed: LOSS",
    );
  }

  async recordClosedPosition(position: Position): Promise<TradeLogEntry> {
    const entry = toTradeLogEntry(position);
    await this.record(entry);
    return entry;
  }

  getAll(): TradeLogEntry[] {
    return this.entries;
  }

  getStats(): TradeStats {
    return computeTradeStats(this.entries);
  }
}

/** Pure so it can be unit-tested without touching disk. */
export function computeTradeStats(entries: TradeLogEntry[]): TradeStats {
  const total = entries.length;

  if (total === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRatePct: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      expectancyPct: 0,
      totalRealizedPnlUsd: 0,
      largestWinUsd: 0,
      largestLossUsd: 0,
      brierScore: null,
      calibrationBuckets: [],
      sampleSizeWarning: "No closed trades yet.",
    };
  }

  const wins = entries.filter((e) => e.won);
  const losses = entries.filter((e) => !e.won);

  const brierScore = average(entries.map((e) => (e.signalConfidence - (e.won ? 1 : 0)) ** 2));

  const calibrationBuckets: CalibrationBucket[] = CALIBRATION_BUCKETS.map((bucket) => {
    const inBucket = entries.filter((e) => e.signalConfidence >= bucket.min && e.signalConfidence < bucket.max);
    return {
      rangeLabel: bucket.label,
      min: bucket.min,
      count: inBucket.length,
      avgPredictedConfidence: inBucket.length ? average(inBucket.map((e) => e.signalConfidence)) : 0,
      actualWinRatePct: inBucket.length ? (inBucket.filter((e) => e.won).length / inBucket.length) * 100 : 0,
    };
  }).filter((bucket) => bucket.count > 0);

  return {
    totalTrades: total,
    wins: wins.length,
    losses: losses.length,
    winRatePct: (wins.length / total) * 100,
    avgWinPct: wins.length ? average(wins.map((e) => e.pnlPct)) * 100 : 0,
    avgLossPct: losses.length ? average(losses.map((e) => e.pnlPct)) * 100 : 0,
    expectancyPct: average(entries.map((e) => e.pnlPct)) * 100,
    totalRealizedPnlUsd: sum(entries.map((e) => e.realizedPnlUsd)),
    largestWinUsd: wins.length ? Math.max(...wins.map((e) => e.realizedPnlUsd)) : 0,
    largestLossUsd: losses.length ? Math.min(...losses.map((e) => e.realizedPnlUsd)) : 0,
    brierScore,
    calibrationBuckets,
    sampleSizeWarning:
      total < MIN_SAMPLE_SIZE_FOR_CONFIDENCE
        ? `Only ${total} closed trade(s) — stats aren't statistically meaningful until at least ${MIN_SAMPLE_SIZE_FOR_CONFIDENCE}.`
        : null,
  };
}

function average(values: number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}
