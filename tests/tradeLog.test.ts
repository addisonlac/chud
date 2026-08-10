import { describe, expect, it } from "vitest";
import {
  computeTradeStats,
  toTradeLogEntry,
  evaluateGoLiveReadiness,
  computeAdaptiveConfidenceThreshold,
} from "../src/state/tradeLog.js";
import type { Position, TradeLogEntry, TradeSignal } from "../src/types/index.js";

const CRITERIA = { minTrades: 30, minExpectancyPct: 1 };

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

describe("evaluateGoLiveReadiness", () => {
  // Build N entries: `wins` winners at +winPct in the given confidence bucket,
  // the rest losers at -lossPct in the other bucket.
  function makeSet(opts: {
    wins: number;
    losses: number;
    winPct: number;
    lossPct: number;
    winConf: number;
    lossConf: number;
  }): TradeLogEntry[] {
    const w = Array.from({ length: opts.wins }, () =>
      makeEntry({ won: true, pnlPct: opts.winPct, realizedPnlUsd: opts.winPct * 100, signalConfidence: opts.winConf }),
    );
    const l = Array.from({ length: opts.losses }, () =>
      makeEntry({ won: false, pnlPct: -opts.lossPct, realizedPnlUsd: -opts.lossPct * 100, signalConfidence: opts.lossConf }),
    );
    return [...w, ...l];
  }

  it("is NOT ready with too few trades even if they're all winners", () => {
    const stats = computeTradeStats(makeSet({ wins: 5, losses: 0, winPct: 0.1, lossPct: 0, winConf: 0.95, lossConf: 0.75 }));
    const r = evaluateGoLiveReadiness(stats, CRITERIA);
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.label === "Sample size")?.passed).toBe(false);
  });

  it("is NOT ready when expectancy after costs is negative", () => {
    const stats = computeTradeStats(makeSet({ wins: 10, losses: 20, winPct: 0.05, lossPct: 0.1, winConf: 0.95, lossConf: 0.75 }));
    const r = evaluateGoLiveReadiness(stats, CRITERIA);
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.label === "Expectancy after costs")?.passed).toBe(false);
  });

  it("is NOT ready when confidence is anti-informative (high-conf bucket wins less)", () => {
    // positive expectancy, enough trades, net positive — but wins sit in the
    // LOW confidence bucket and losses in the HIGH one, so the AI's confidence
    // is worse than useless.
    const stats = computeTradeStats(makeSet({ wins: 20, losses: 10, winPct: 0.1, lossPct: 0.05, winConf: 0.75, lossConf: 0.95 }));
    const r = evaluateGoLiveReadiness(stats, CRITERIA);
    expect(r.checks.find((c) => c.label === "Expectancy after costs")?.passed).toBe(true);
    expect(r.checks.find((c) => c.label === "Confidence is informative")?.passed).toBe(false);
    expect(r.ready).toBe(false);
  });

  it("is READY only when every check passes", () => {
    // 30 trades, +5% expectancy, net positive, and higher confidence wins more.
    const stats = computeTradeStats(makeSet({ wins: 20, losses: 10, winPct: 0.1, lossPct: 0.05, winConf: 0.95, lossConf: 0.75 }));
    const r = evaluateGoLiveReadiness(stats, CRITERIA);
    expect(r.ready).toBe(true);
    expect(r.checks.every((c) => c.passed)).toBe(true);
  });
});

describe("computeAdaptiveConfidenceThreshold", () => {
  const ADAPT = { minSample: 20, minBucketCount: 5, marginPct: 5 };

  // All wins +20% / all losses -20% → breakeven win rate 50%, target 55%.
  function bucket(conf: number, wins: number, losses: number): TradeLogEntry[] {
    return [
      ...Array.from({ length: wins }, () => makeEntry({ signalConfidence: conf, won: true, pnlPct: 0.2, realizedPnlUsd: 20 })),
      ...Array.from({ length: losses }, () => makeEntry({ signalConfidence: conf, won: false, pnlPct: -0.2, realizedPnlUsd: -20 })),
    ];
  }

  it("holds the baseline while still warming up (below minSample)", () => {
    const stats = computeTradeStats(bucket(0.75, 5, 5)); // 10 < 20
    const r = computeAdaptiveConfidenceThreshold(stats, 0.6, ADAPT);
    expect(r.active).toBe(false);
    expect(r.threshold).toBeCloseTo(0.6, 5);
    expect(r.reason).toMatch(/warming up/i);
  });

  it("raises the gate to the lowest bucket that clears breakeven, excluding losing low-confidence trades", () => {
    // 0.60-0.72 loses (40%), 0.72-0.80 wins (60%), 0.80-0.90 wins (70%).
    const stats = computeTradeStats([...bucket(0.65, 4, 6), ...bucket(0.75, 6, 4), ...bucket(0.85, 7, 3)]);
    const r = computeAdaptiveConfidenceThreshold(stats, 0.6, ADAPT);
    expect(r.active).toBe(true);
    expect(r.threshold).toBeCloseTo(0.72, 5); // excludes the losing 0.60-0.72 bucket
  });

  it("stays at baseline when the lowest bucket is already profitable", () => {
    const stats = computeTradeStats([...bucket(0.65, 6, 4), ...bucket(0.75, 6, 4), ...bucket(0.85, 7, 3)]);
    const r = computeAdaptiveConfidenceThreshold(stats, 0.6, ADAPT);
    expect(r.active).toBe(false);
    expect(r.threshold).toBeCloseTo(0.6, 5);
  });

  it("holds baseline (does not halt) when no confidence level has been profitable", () => {
    const stats = computeTradeStats([...bucket(0.65, 4, 6), ...bucket(0.75, 4, 6), ...bucket(0.85, 4, 6)]);
    const r = computeAdaptiveConfidenceThreshold(stats, 0.6, ADAPT);
    expect(r.active).toBe(false);
    expect(r.threshold).toBeCloseTo(0.6, 5);
    expect(r.reason).toMatch(/no confidence level/i);
  });

  it("never lowers the gate below the configured baseline", () => {
    // A profitable 0.72-0.80 bucket would set 0.72, but baseline 0.85 wins.
    const stats = computeTradeStats([...bucket(0.65, 4, 6), ...bucket(0.75, 6, 4), ...bucket(0.85, 7, 3)]);
    const r = computeAdaptiveConfidenceThreshold(stats, 0.85, ADAPT);
    expect(r.threshold).toBeCloseTo(0.85, 5);
    expect(r.active).toBe(false);
  });

  it("ignores buckets too thin to trust (below minBucketCount)", () => {
    // 0.72-0.80 is a perfect 3/3 but too thin; the gate must skip it and use
    // the next qualifying bucket (0.80-0.90) instead of trusting 3 trades.
    const stats = computeTradeStats([...bucket(0.65, 4, 6), ...bucket(0.75, 3, 0), ...bucket(0.85, 7, 3)]);
    const r = computeAdaptiveConfidenceThreshold(stats, 0.6, ADAPT);
    expect(r.threshold).toBeCloseTo(0.8, 5);
    expect(r.active).toBe(true);
  });
});
