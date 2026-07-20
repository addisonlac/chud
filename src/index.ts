import { env, assertRequiredConfig } from "./config/env.js";
import { childLogger } from "./utils/logger.js";
import { Portfolio } from "./state/portfolio.js";
import { PositionStore } from "./state/positionStore.js";
import { TradeLog } from "./state/tradeLog.js";
import { WhaleTracker } from "./whales/whaleTracker.js";
import { WhaleList } from "./whales/whaleList.js";
import { SolanaWhalePoller } from "./whales/solanaWhalePoller.js";
import { TradingOrchestrator } from "./pipeline/orchestrator.js";
import { createServer } from "./server/webhookServer.js";
import { getWalletKeypair, getSolBalance } from "./execution/wallet.js";
import { TelegramNotifier } from "./notify/telegram.js";
import { marketContext } from "./data/marketContext.js";

const log = childLogger("bootstrap");

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
  const savedWhales = await whaleList.load();

  const whalePoller = new SolanaWhalePoller(whaleTracker, () => marketContext.getSolPriceUsd());

  if (savedWhales.length > 0) {
    whaleTracker.setWatchlist(whaleList.addresses());
    whalePoller.setWatchlist(whaleList.addresses());
    whalePoller.start();
    log.info(
      { count: savedWhales.length },
      "loaded whale watchlist from disk, polling via free public Solana RPC (see README free-tier tradeoffs)",
    );
  } else {
    log.warn(
      "No whale watchlist found at data/whale-watchlist.json — whale activity will be empty until one is seeded. " +
        "See README for how to populate it.",
    );
  }

  const telegram = new TelegramNotifier();
  await telegram.notifyStartup(env.LIVE_TRADING ? "live" : "paper");

  const app = createServer({ portfolio, positionStore, tradeLog });
  app.listen(env.PORT, () => log.info({ port: env.PORT }, "webhook/status server listening"));

  const orchestrator = new TradingOrchestrator({ portfolio, positionStore, whaleTracker, tradeLog, telegram });
  orchestrator.start();

  const shutdown = () => {
    log.info("shutting down");
    orchestrator.stop();
    whalePoller.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error({ err: (err as Error).stack ?? (err as Error).message }, "fatal startup error");
  process.exit(1);
});
