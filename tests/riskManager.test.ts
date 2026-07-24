import { describe, expect, it } from "vitest";
import {
  sizePosition,
  meetsConfidenceThreshold,
  checkExitConditions,
  checkTakeProfit,
  computeEffectiveStop,
  updatePeakPrice,
  type RiskConfig,
} from "../src/risk/riskManager.js";
import type { PortfolioSnapshot, Position, TradeSignal } from "../src/types/index.js";

const config: RiskConfig = {
  maxRiskPctPerTrade: 0.02,
  stopLossPct: 0.2,
  trailingStopPct: 0.25,
  maxPositionAgeHours: 48,
  minSolReserve: 0.5,
  confidenceThreshold: 0.72,
  takeProfitPct: 0.6,
  takeProfitSizePct: 0.5,
  breakevenTriggerPct: 0.3,
  trailingStopTightPct: 0.15,
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
    peakPriceUsd: 1,
    maxAgeHours: 48,
    signal,
    ...overrides,
  };
}

describe("checkExitConditions", () => {
  it("exits on stop loss when price falls to or below the stop", () => {
    const position = makePosition({ stopLossPriceUsd: 0.8, peakPriceUsd: 1 });
    expect(checkExitConditions(position, 0.79, Date.now(), config).shouldExit).toBe(true);
    expect(checkExitConditions(position, 0.8, Date.now(), config).shouldExit).toBe(true);
    expect(checkExitConditions(position, 0.8, Date.now(), config).reason).toBe("stop_loss");
  });

  it("checkExitConditions does not full-exit on a price spike (take-profit is a separate scale-out)", () => {
    // checkExitConditions only handles the stop + max-age FULL exits. Banking
    // profit on a spike is checkTakeProfit's job (a partial scale-out), so a
    // bare price check here shouldn't fully close the position.
    const position = makePosition({ stopLossPriceUsd: 0.8, peakPriceUsd: 1 });
    const result = checkExitConditions(position, 50, Date.now(), config); // 50x the entry price
    expect(result.shouldExit).toBe(false);
  });

  it("exits after the max hold age even if price is fine", () => {
    const oldEntry = Date.now() - 49 * 60 * 60 * 1000; // 49h ago
    const position = makePosition({ stopLossPriceUsd: 0.5, peakPriceUsd: 1, entryTimestamp: oldEntry, maxAgeHours: 48 });
    const result = checkExitConditions(position, 2, Date.now(), config); // price up, but too old
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe("max_age");
  });

  it("holds when neither condition is met", () => {
    const position = makePosition({ stopLossPriceUsd: 0.8, peakPriceUsd: 1, entryTimestamp: Date.now() });
    expect(checkExitConditions(position, 1.1, Date.now(), config).shouldExit).toBe(false);
  });
});

describe("updatePeakPrice", () => {
  it("tracks the highest price seen, never decreasing", () => {
    const position = makePosition({ peakPriceUsd: 2 });
    expect(updatePeakPrice(position, 3)).toBe(3);
    expect(updatePeakPrice(position, 1)).toBe(2); // lower price doesn't lower the peak
  });
});

describe("computeEffectiveStop / trailing stop", () => {
  it("stays at the fixed entry stop until the trailing stop would be higher", () => {
    // peak barely above entry: peak*(1-0.25) doesn't clear the fixed 0.8 stop yet
    const position = makePosition({ entryPriceUsd: 1, stopLossPriceUsd: 0.8, peakPriceUsd: 1.05 });
    const stop = computeEffectiveStop(position, config);
    expect(stop.isTrailing).toBe(false);
    expect(stop.price).toBeCloseTo(0.8, 5);
  });

  it("keeps the trail LOOSE before any take-profit, so volatility doesn't wick it out early", () => {
    // price ran to 2x entry but no partial profit banked yet — the trail stays
    // loose at 25%: 2 * (1 - 0.25) = 1.5, giving the token room to reach target
    const position = makePosition({ entryPriceUsd: 1, stopLossPriceUsd: 0.8, peakPriceUsd: 2 });
    const stop = computeEffectiveStop(position, config);
    expect(stop.isTrailing).toBe(true);
    expect(stop.price).toBeCloseTo(1.5, 5); // 2 * (1 - 0.25), loose
  });

  it("tightens the trail only after partial profit is banked, protecting the runner", () => {
    // same 2x peak, but now half was sold at the take-profit: the remainder's
    // trail tightens to 15%: 2 * (1 - 0.15) = 1.7
    const position = makePosition({ entryPriceUsd: 1, stopLossPriceUsd: 1, peakPriceUsd: 2, tookPartialProfit: true });
    const stop = computeEffectiveStop(position, config);
    expect(stop.isTrailing).toBe(true);
    expect(stop.price).toBeCloseTo(1.7, 5); // 2 * (1 - 0.15), tightened
  });

  it("exits with reason trailing_stop (not stop_loss) once armed, protecting realized gains", () => {
    const position = makePosition({ entryPriceUsd: 1, stopLossPriceUsd: 0.8, peakPriceUsd: 2 });
    // price pulls back from the 2x peak to 1.4 — below the 1.5 loose trailing
    // stop, but still 40% above entry, i.e. nowhere near the fixed -20% stop
    const result = checkExitConditions(position, 1.4, Date.now(), config);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe("trailing_stop");
  });

  it("never lets the effective stop trail below the original fixed stop", () => {
    // peak stayed at entry (never ran up) — trailing math would put the
    // stop at entry*(1-0.25)=0.75, but the fixed -20% stop at 0.8 is tighter
    // and must win, since it's what the 2%-risk position sizing was based on
    const position = makePosition({ entryPriceUsd: 1, stopLossPriceUsd: 0.8, peakPriceUsd: 1 });
    const stop = computeEffectiveStop(position, config);
    expect(stop.price).toBeCloseTo(0.8, 5);
    expect(stop.isTrailing).toBe(false);
  });

  it("raises the floor to breakeven after a large run-up, so a winner can't become a full loss", () => {
    // peak up +31% (past the +30% trigger). The loose 25% trail
    // (1.31*0.75≈0.9825) sits just below breakeven — the breakeven floor
    // (entry=1) binds, so a full reversal exits at ~scratch, not the -20% stop.
    const position = makePosition({ entryPriceUsd: 1, stopLossPriceUsd: 0.8, peakPriceUsd: 1.31 });
    const stop = computeEffectiveStop(position, config);
    expect(stop.price).toBeCloseTo(1, 5);
    expect(stop.isTrailing).toBe(false);
  });
});

describe("checkTakeProfit", () => {
  it("scales out half once price reaches the +60% target", () => {
    const position = makePosition({ entryPriceUsd: 1, tookPartialProfit: false });
    const below = checkTakeProfit(position, 1.59, config);
    expect(below.shouldScaleOut).toBe(false);

    const at = checkTakeProfit(position, 1.6, config);
    expect(at.shouldScaleOut).toBe(true);
    expect(at.sellFraction).toBeCloseTo(0.5, 5);
    expect(at.targetPriceUsd).toBeCloseTo(1.6, 5);
  });

  it("fires at most once — never scales out again after the first take-profit", () => {
    const position = makePosition({ entryPriceUsd: 1, tookPartialProfit: true });
    expect(checkTakeProfit(position, 2, config).shouldScaleOut).toBe(false);
  });

  it("is disabled when takeProfitPct is 0 (pure ride-the-trailing-stop)", () => {
    const noTp: RiskConfig = { ...config, takeProfitPct: 0 };
    const position = makePosition({ entryPriceUsd: 1 });
    expect(checkTakeProfit(position, 100, noTp).shouldScaleOut).toBe(false);
  });
});
