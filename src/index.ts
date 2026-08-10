import { env, assertRequiredConfig } from "./config/env.js";
import { childLogger } from "./utils/logger.js";
import { Portfolio } from "./state/portfolio.js";
import { PositionStore } from "./state/positionStore.js";
import { TradeLog, evaluateGoLiveReadiness } from "./state/tradeLog.js";
import { WhaleTracker } from "./whales/whaleTracker.js";
import { WhaleList } from "./whales/whaleList.js";
import { SolanaWhalePoller } from "./whales/solanaWhalePoller.js";
import { TradingOrchestrator } from "./pipeline/orchestrator.js";
import { createServer } from "./server/webhookServer.js";
import { getWalletKeypair, getSolBalance, getConnection } from "./execution/wallet.js";
import { TelegramNotifier } from "./notify/telegram.js";
import { TelegramCommandListener, formatStatusReply, formatStatsReply, formatPositionsReply } from "./notify/telegramCommands.js";
import { marketContext } from "./data/marketContext.js";
import { getTrendingTokenMints } from "./data/birdeye.js";

const log = childLogger("bootstrap");

/** Hide the api-key query param so it never lands in logs. */
function redactRpcUrl(url: string): string {
  return url.replace(/api-key=[^&]+/i, "api-key=***");
}

async function main(): Promise<void> {
  const missing = assertRequiredConfig();
  if (missing.length > 0) {
    log.warn({ missing }, "missing configuration — affected features will no-op or error until set");
  }

  if (env.LIVE_TRADING) {
    log.warn("LIVE_TRADING=true — this process WILL sign and submit real Jupiter swaps with real funds.");
  } else {
    log.info("Running in PAPER mode — no real trades will be signed or submitted.");
  }

  // Fail loudly at boot if the Solana RPC is unreachable / the key is bad,
  // instead of silently failing the safety check on every token.
  try {
    const slot = await getConnection().getSlot();
    log.info({ slot, rpc: redactRpcUrl(env.SOLANA_RPC_URL) }, "Solana RPC OK");
  } catch (err) {
    log.error(
      { err: (err as Error).message, rpc: redactRpcUrl(env.SOLANA_RPC_URL) },
      "Solana RPC check FAILED — token safety checks will fail on every token. " +
        "Fix SOLANA_RPC_URL (a 401 'invalid api key' means your Helius URL/key is wrong).",
    );
  }

  const positionStore = new PositionStore();
  await positionStore.load();

  const tradeLog = new TradeLog();
  await tradeLog.load();

  const portfolio = new Portfolio();
  if (env.LIVE_TRADING) {
    const keypair = getWalletKeypair();
    if (!keypair) {
      throw new Error("LIVE_TRADING=true but WALLET_PRIVATE_KEY is missing/invalid");
    }
    const balance = await getSolBalance(keypair.publicKey);
    portfolio.setSolBalance(balance);
    log.info({ publicKey: keypair.publicKey.toBase58(), balance }, "synced live wallet balance");
  }

  const whaleTracker = new WhaleTracker();
  const whaleList = new WhaleList();
  const whalePoller = new SolanaWhalePoller(whaleTracker, () => marketContext.getSolPriceUsd());

  if (!env.WHALE_TRACKING_ENABLED) {
    log.info(
      "Whale tracking is OFF (WHALE_TRACKING_ENABLED=false). The bot trades without it — this also " +
        "avoids the free public Solana RPC's 429 rate-limit noise.",
    );
  } else {
    let savedWhales = await whaleList.load();

    // No hand-curated watchlist? Auto-seed one from the large holders of
    // currently-trending Solana tokens (a documented proxy for "smart
    // money" — see README) so whale tracking works out of the box. Edit
    // data/whale-watchlist.json afterwards to curate it with wallets you
    // actually trust.
    if (savedWhales.length === 0 && env.BIRDEYE_API_KEY) {
      log.info("no whale watchlist found — auto-seeding from trending tokens' top holders (this can take a moment)");
      try {
        const trendingMints = await getTrendingTokenMints(15);
        if (trendingMints.length > 0) {
          await whaleList.discoverFromTrendingTokens(trendingMints);
          await whaleList.save();
          savedWhales = whaleList.get();
        }
      } catch (err) {
        log.warn({ err: (err as Error).message }, "whale auto-seed failed — continuing without whale tracking");
      }
    }

    if (savedWhales.length > 0) {
      whaleTracker.setWatchlist(whaleList.addresses());
      whalePoller.setWatchlist(whaleList.addresses());
      whalePoller.start();
      log.info(
        { count: savedWhales.length },
        "whale watchlist active, polling via free public Solana RPC (429s here are the public RPC throttling — " +
          "non-fatal; set WHALE_TRACKING_ENABLED=false to silence, or use a better SOLANA_RPC_URL)",
      );
    } else {
      log.info(
        "Whale tracking is ON but no watchlist could be seeded. The bot trades without it. " +
          "Add wallet addresses to data/whale-watchlist.json to enable.",
      );
    }
  }

  const telegram = new TelegramNotifier();
  await telegram.notifyStartup(env.LIVE_TRADING ? "live" : "paper");

  const commandListener = new TelegramCommandListener({
    getStatusReply: async () => {
      const openPositions = positionStore.getOpen();
      const solPriceUsd = await marketContext.getSolPriceUsd();
      // Remaining deployed value (drops as tokens are scaled out at take-profit);
      // costBasisUsd would double-count against the scale-out proceeds in SOL.
      const openPositionsValueUsd = openPositions.reduce((sum, p) => sum + p.quantityTokens * p.entryPriceUsd, 0);
      const snapshot = portfolio.getSnapshot(openPositionsValueUsd, solPriceUsd, openPositions.length);
      return formatStatusReply({
        mode: env.LIVE_TRADING ? "live" : "paper",
        solBalance: snapshot.solBalance,
        totalValueUsd: snapshot.totalValueUsd,
        openPositions,
      });
    },
    getStatsReply: async () =>
      formatStatsReply(
        tradeLog.getStats(),
        evaluateGoLiveReadiness(tradeLog.getStats(), {
          minTrades: env.GO_LIVE_MIN_TRADES,
          minExpectancyPct: env.GO_LIVE_MIN_EXPECTANCY_PCT,
        }),
      ),
    getPositionsReply: async () => formatPositionsReply(positionStore.getOpen()),
  });
  commandListener.start();

  const app = createServer({ portfolio, positionStore, tradeLog });
  const server = app.listen(env.PORT, () => log.info({ port: env.PORT }, "webhook/status server listening"));
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(
        { port: env.PORT },
        `Port ${env.PORT} is already in use — either stop whatever else is running on it ` +
          `(a previous "npm run dev" left running in another terminal tab is the usual cause), ` +
          `or set a different PORT in .env and restart.`,
      );
    } else {
      log.error({ err: err.message }, "server failed to start");
    }
    process.exit(1);
  });

  const orchestrator = new TradingOrchestrator({ portfolio, positionStore, whaleTracker, tradeLog, telegram });
  orchestrator.start();

  const shutdown = () => {
    log.info("shutting down");
    orchestrator.stop();
    whalePoller.stop();
    commandListener.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error({ err: (err as Error).stack ?? (err as Error).message }, "fatal startup error");
  process.exit(1);
});
