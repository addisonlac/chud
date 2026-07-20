import { describe, expect, it } from "vitest";
import {
  sizePosition,
  meetsConfidenceThreshold,
  checkExitConditions,
  type RiskConfig,
} from "../src/risk/riskManager.js";
import type { PortfolioSnapshot, Position, TradeSignal } from "../src/types/index.js";

const config: RiskConfig = {
  maxRiskPctPerTrade: 0.02,
  stopLossPct: 0.2,
  maxPositionAgeHours: 48,
  minSolReserve: 0.5,
  confidenceThreshold: 0.72,
};

function portfolio(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    solBalance: 10,
    totalValueUsd: 1500, // 10 SOL @ $150
    openPositionCount: 0,
    reserveSol: 0.5,
    availableForTradingUsd: 1500,
    ...overrides,
  };
}

describe("sizePosition", () => {
  it("sizes to (riskPct / stopLossPct) of portfolio value — 2%/20% = 10%", () => {
    const result = sizePosition(portfolio(), 1, 150, config);
    expect(result.approved).toBe(true);
    if (!result.approved) throw new Error("expected approval");
    expect(result.costBasisUsd).toBeCloseTo(150, 5); // 10% of $1500
    expect(result.quantityTokens).toBeCloseTo(150, 5); // entry price $1
  });

  it("sets stop loss at 20% below entry", () => {
    const result = sizePosition(portfolio(), 2, 150, config);
    if (!result.approved) throw new Error("expected approval");
    expect(result.stopLossPriceUsd).toBeCloseTo(1.6, 5);
  });

  it("never lets a trade dip the wallet below the 0.5 SOL reserve", () => {
    const thin = portfolio({ solBalance: 0.6, totalValueUsd: 90, availableForTradingUsd: 90 });
    const result = sizePosition(thin, 1, 150, config);
    if (!result.approved) throw new Error("expected approval");
    expect(thin.solBalance - result.costBasisSol).toBeGreaterThanOrEqual(config.minSolReserve - 1e-9);
  });

  it("rejects when there's no room above the reserve", () => {
    const empty = portfolio({ solBalance: 0.5, totalValueUsd: 75, availableForTradingUsd: 75 });
    const result = sizePosition(empty, 1, 150, config);
    expect(result.approved).toBe(false);
  });

  it("caps position size at availableForTradingUsd even if the risk formula wants more", () => {
    const capped = portfolio({ availableForTradingUsd: 50 });
    const result = sizePosition(capped, 1, 150, config);
    if (!result.approved) throw new Error("expected approval");
    expect(result.costBasisUsd).toBeLessThanOrEqual(50);
  });

  it("rejects invalid prices", () => {
    expect(sizePosition(portfolio(), 0, 150, config).approved).toBe(false);
    expect(sizePosition(portfolio(), 1, 0, config).approved).toBe(false);
  });
});

describe("meetsConfidenceThreshold", () => {
  it("requires confidence strictly greater than 72%", () => {
    expect(meetsConfidenceThreshold(0.72, config)).toBe(false);
    expect(meetsConfidenceThreshold(0.7201, config)).toBe(true);
    expect(meetsConfidenceThreshold(0.5, config)).toBe(false);
  });
});

function makePosition(overrides: Partial<Position> = {}): Position {
  const signal: TradeSignal = {
    mint: "MintAddress",
    symbol: "TEST",
    confidence: 0.8,
    direction: "long",
    reasoning: "test",
    entryPriceUsd: 1,
    generatedAt: Date.now(),
  };

  return {
    id: "1",
    mint: "MintAddress",
    symbol: "TEST",
    status: "open",
    entryPriceUsd: 1,
    entryTimestamp: Date.now(),
    quantityTokens: 100,
    costBasisUsd: 100,
    costBasisSol: 0.67,
    stopLossPriceUsd: 0.8,
    maxAgeHours: 48,
    signal,
    ...overrides,
  };
}

describe("checkExitConditions", () => {
  it("exits on stop loss when price falls to or below the stop", () => {
    const position = makePosition({ stopLossPriceUsd: 0.8 });
    expect(checkExitConditions(position, 0.79).shouldExit).toBe(true);
    expect(checkExitConditions(position, 0.8).shouldExit).toBe(true);
    expect(checkExitConditions(position, 0.8).reason).toBe("stop_loss");
  });

  it("does not exit on profit — no take-profit rule, winners ride", () => {
    const position = makePosition({ stopLossPriceUsd: 0.8 });
    const result = checkExitConditions(position, 50); // 50x the entry price
    expect(result.shouldExit).toBe(false);
  });

  it("exits after the max hold age even if price is fine", () => {
    const oldEntry = Date.now() - 49 * 60 * 60 * 1000; // 49h ago
    const position = makePosition({ stopLossPriceUsd: 0.5, entryTimestamp: oldEntry, maxAgeHours: 48 });
    const result = checkExitConditions(position, 2); // price up, but too old
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe("max_age");
  });

  it("holds when neither condition is met", () => {
    const position = makePosition({ stopLossPriceUsd: 0.8, entryTimestamp: Date.now() });
    expect(checkExitConditions(position, 1.1).shouldExit).toBe(false);
  });
});
