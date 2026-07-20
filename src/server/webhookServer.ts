import express, { type Express } from "express";
import { verifyWebhookAuth, type HeliusEnhancedTransaction } from "../whales/heliusWebhook.js";
import { childLogger } from "../utils/logger.js";
import { env } from "../config/env.js";
import type { Portfolio } from "../state/portfolio.js";
import type { PositionStore } from "../state/positionStore.js";
import type { TradeLog } from "../state/tradeLog.js";
import type { WhaleTracker } from "../whales/whaleTracker.js";
import { marketContext } from "../data/marketContext.js";

const log = childLogger("server");

export interface ServerDeps {
  whaleTracker: WhaleTracker;
  portfolio: Portfolio;
  positionStore: PositionStore;
  tradeLog: TradeLog;
}

export function createServer(deps: ServerDeps): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, mode: env.LIVE_TRADING ? "live" : "paper" });
  });

  // Strategy rule #5: whale wallet activity arrives here in real time.
  app.post("/webhooks/helius", (req, res) => {
    if (!verifyWebhookAuth(req.headers["authorization"])) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const transactions = req.body as HeliusEnhancedTransaction[];
    deps.whaleTracker.ingest(Array.isArray(transactions) ? transactions : [transactions]);
    log.debug({ count: Array.isArray(transactions) ? transactions.length : 1 }, "ingested whale webhook payload");
    res.status(200).json({ received: true });
  });

  app.get("/status", async (_req, res) => {
    const openPositions = deps.positionStore.getOpen();
    const solPriceUsd = await marketContext.getSolPriceUsd();
    const openPositionsValueUsd = openPositions.reduce((sum, p) => sum + p.costBasisUsd, 0);

    res.json({
      mode: env.LIVE_TRADING ? "live" : "paper",
      portfolio: deps.portfolio.getSnapshot(openPositionsValueUsd, solPriceUsd, openPositions.length),
      openPositions,
      solPriceUsd,
    });
  });

  app.get("/positions", (_req, res) => {
    res.json(deps.positionStore.getAll());
  });

  // Win/loss ledger + AI confidence calibration (Brier score, per-bucket
  // realized win rate) — check this before trusting the confidence gate
  // with real size.
  app.get("/stats", (_req, res) => {
    res.json(deps.tradeLog.getStats());
  });

  app.get("/trades", (_req, res) => {
    res.json(deps.tradeLog.getAll());
  });

  return app;
}
