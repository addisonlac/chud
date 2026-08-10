import express, { type Express } from "express";
import { env } from "../config/env.js";
import type { Portfolio } from "../state/portfolio.js";
import type { PositionStore } from "../state/positionStore.js";
import { type TradeLog, evaluateGoLiveReadiness, computeAdaptiveConfidenceThreshold } from "../state/tradeLog.js";
import { marketContext } from "../data/marketContext.js";

export interface ServerDeps {
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

  app.get("/status", async (_req, res) => {
    const openPositions = deps.positionStore.getOpen();
    const solPriceUsd = await marketContext.getSolPriceUsd();
    // Remaining deployed value (drops as tokens scale out); costBasisUsd would
    // double-count against partial-take-profit proceeds already back in SOL.
    const openPositionsValueUsd = openPositions.reduce((sum, p) => sum + p.quantityTokens * p.entryPriceUsd, 0);

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
  // realized win rate) plus the objective go-live readiness gate — check
  // this before trusting the confidence gate with real size.
  app.get("/stats", (_req, res) => {
    const stats = deps.tradeLog.getStats();
    const goLive = evaluateGoLiveReadiness(stats, {
      minTrades: env.GO_LIVE_MIN_TRADES,
      minExpectancyPct: env.GO_LIVE_MIN_EXPECTANCY_PCT,
    });
    const adaptiveConfidence = env.ADAPTIVE_CONFIDENCE_ENABLED
      ? computeAdaptiveConfidenceThreshold(stats, env.CONFIDENCE_THRESHOLD, {
          minSample: env.ADAPTIVE_CONFIDENCE_MIN_SAMPLE,
          minBucketCount: env.ADAPTIVE_CONFIDENCE_MIN_BUCKET,
          marginPct: env.ADAPTIVE_CONFIDENCE_MARGIN_PCT,
        })
      : null;
    res.json({ ...stats, goLive, adaptiveConfidence });
  });

  app.get("/trades", (_req, res) => {
    res.json(deps.tradeLog.getAll());
  });

  return app;
}
