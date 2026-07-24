import { describe, expect, it } from "vitest";
import { computeTradeStats, toTradeLogEntry } from "../src/state/tradeLog.js";
import type { Position, TradeLogEntry, TradeSignal } from "../src/types/index.js";

function makeEntry(overrides: Partial<TradeLogEntry> = {}): TradeLogEntry {
  return {
    id: "1",
    mint: "mint",
    symbol: "TEST",
    entryPriceUsd: 1,
    exitPriceUsd: 1,
    entryTimestamp: Date.now() - 1000,
    exitTimestamp: Date.now(),
    holdHours: 1,
    quantityTokens: 100,
    costBasisUsd: 100,
    realizedPnlUsd: 0,
    pnlPct: 0,
    exitReason: "stop_loss",
    signalConfidence: 0.8,
    won: false,
    ...overrides,
  };
}

describe("computeTradeStats", () => {
  it("returns a null Brier score and a warning when there are no trades", () => {
    const stats = computeTradeStats([]);
    expect(stats.totalTrades).toBe(0);
    expect(stats.brierScore).toBeNull();
    expect(stats.sampleSizeWarning).not.toBeNull();
  });

  it("computes win rate, expectancy, and total realized PnL", () => {
    const entries = [
      makeEntry({ realizedPnlUsd: 50, pnlPct: 0.5, won: true }),
      makeEntry({ realizedPnlUsd: -20, pnlPct: -0.2, won: false }),
    ];
    const stats = computeTradeStats(entries);
    expect(stats.totalTrades).toBe(2);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.winRatePct).toBeCloseTo(50, 5);
    expect(stats.totalRealizedPnlUsd).toBeCloseTo(30, 5);
    expect(stats.expectancyPct).toBeCloseTo(15, 5); // average of +50% and -20%
  });

  it("computes the Brier score as mean squared error between confidence and outcome", () => {
    // trade 1: predicted 0.8, won (outcome=1) -> (0.8-1)^2 = 0.04
    // trade 2: predicted 0.9, lost (outcome=0) -> (0.9-0)^2 = 0.81
    const entries = [
      makeEntry({ signalConfidence: 0.8, won: true }),
      makeEntry({ signalConfidence: 0.9, won: false }),
    ];
    const stats = computeTradeStats(entries);
    expect(stats.brierScore).toBeCloseTo((0.04 + 0.81) / 2, 5);
  });

  it("flags when the AI's confidence is not actually informative: higher-confidence bucket with a worse win rate", () => {
    const entries = [
      // low-confidence bucket: 2 wins, 0 losses -> 100% win rate
      makeEntry({ signalConfidence: 0.75, won: true }),
      makeEntry({ signalConfidence: 0.76, won: true }),
      // high-confidence bucket: 0 wins, 2 losses -> 0% win rate — confidence is anti-informative here
      makeEntry({ signalConfidence: 0.95, won: false }),
      makeEntry({ signalConfidence: 0.96, won: false }),
    ];
    const stats = computeTradeStats(entries);
    const lowBucket = stats.calibrationBuckets.find((b) => b.rangeLabel === "0.72-0.80");
    const highBucket = stats.calibrationBuckets.find((b) => b.rangeLabel === "0.90-1.00");
    expect(lowBucket?.actualWinRatePct).toBe(100);
    expect(highBucket?.actualWinRatePct).toBe(0);
  });

  it("warns when sample size is too small to trust the stats", () => {
    const stats = computeTradeStats([makeEntry()]);
    expect(stats.sampleSizeWarning).toContain("1 closed trade");
  });

  it("does not warn once enough trades have accumulated", () => {
    const entries = Array.from({ length: 30 }, () => makeEntry());
    const stats = computeTradeStats(entries);
    expect(stats.sampleSizeWarning).toBeNull();
  });
});

function makeClosedPosition(overrides: Partial<Position> = {}): Position {
  const signal: TradeSignal = {
    mint: "mint",
    symbol: "TEST",
    confidence: 0.85,
    direction: "long",
    reasoning: "test",
    entryPriceUsd: 1,
    generatedAt: Date.now() - 2000,
  };

  return {
    id: "1",
    mint: "mint",
    symbol: "TEST",
    status: "closed",
    entryPriceUsd: 1,
    entryTimestamp: Date.now() - 2 * 60 * 60 * 1000,
    quantityTokens: 100,
    costBasisUsd: 100,
    costBasisSol: 0.67,
    stopLossPriceUsd: 0.8,
    peakPriceUsd: 1.5,
    maxAgeHours: 48,
    exitPriceUsd: 1.2,
    exitTimestamp: Date.now(),
    exitReason: "trailing_stop",
    realizedPnlUsd: 20,
    signal,
    ...overrides,
  };
}

describe("toTradeLogEntry", () => {
  it("carries the entry-time AI confidence and derives pnlPct/won from the closed position", () => {
    const entry = toTradeLogEntry(makeClosedPosition());
    expect(entry.signalConfidence).toBe(0.85);
    expect(entry.pnlPct).toBeCloseTo(0.2, 5); // exit 1.2 vs entry 1.0
    expect(entry.won).toBe(true);
    expect(entry.exitReason).toBe("trailing_stop");
  });

  it("includes banked partial-take-profit gains in pnlPct, not just the final exit price", () => {
    // A scaled winner: sold half at the target (banked), the rest trailed out
    // lower. realizedPnlUsd is the blended total; pnlPct must reflect it
    // (return on the original $100 cost basis), not just (exit − entry)/entry.
    const scaled = makeClosedPosition({
      entryPriceUsd: 1,
      exitPriceUsd: 1.1, // remainder exited only +10%…
      costBasisUsd: 100,
      realizedScaleOutPnlUsd: 30, // …but +30 was already banked at the take-profit
      realizedPnlUsd: 35, // 30 banked + 5 on the remainder
    });
    const entry = toTradeLogEntry(scaled);
    expect(entry.pnlPct).toBeCloseTo(0.35, 5); // 35 / 100, not 0.10
    expect(entry.won).toBe(true);
  });

  it("throws for a position that isn't actually closed", () => {
    const open = makeClosedPosition({ status: "open", exitPriceUsd: undefined, exitTimestamp: undefined, exitReason: undefined, realizedPnlUsd: undefined });
    expect(() => toTradeLogEntry(open)).toThrow();
  });
});
