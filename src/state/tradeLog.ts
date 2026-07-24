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
