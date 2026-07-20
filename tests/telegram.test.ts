import { describe, expect, it } from "vitest";
import {
  formatPrice,
  formatPct,
  formatStartupMessage,
  formatPositionOpenedMessage,
  formatPositionClosedMessage,
  formatExecutionErrorMessage,
} from "../src/notify/telegram.js";
import type { Position, TradeLogEntry, TradeSignal } from "../src/types/index.js";

describe("formatPrice", () => {
  it("uses more decimals for sub-cent memecoin prices", () => {
    expect(formatPrice(0.00000042)).toBe("0.00000042");
  });

  it("uses fewer decimals for normal prices", () => {
    expect(formatPrice(1.23456)).toBe("1.2346");
  });

  it("handles zero", () => {
    expect(formatPrice(0)).toBe("0");
  });
});

describe("formatPct", () => {
  it("prefixes gains with a plus sign", () => {
    expect(formatPct(0.342)).toBe("+34.2%");
  });

  it("leaves losses with their natural minus sign", () => {
    expect(formatPct(-0.2)).toBe("-20.0%");
  });
});

describe("formatStartupMessage", () => {
  it("warns clearly about real funds in live mode", () => {
    expect(formatStartupMessage("live")).toMatch(/LIVE/);
    expect(formatStartupMessage("live")).toMatch(/real funds/i);
  });

  it("reassures no real trades happen in paper mode", () => {
    expect(formatStartupMessage("paper")).toMatch(/PAPER/);
    expect(formatStartupMessage("paper")).toMatch(/no real trades/i);
  });
});

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    mint: "mint",
    symbol: "DOGWIF2",
    confidence: 0.78,
    direction: "long",
    reasoning: "Strong whale accumulation and rising volume.",
    entryPriceUsd: 0.00042,
    generatedAt: Date.now(),
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: "1",
    mint: "mint",
    symbol: "DOGWIF2",
    status: "open",
    entryPriceUsd: 0.00042,
    entryTimestamp: Date.now(),
    quantityTokens: 190_000,
    costBasisUsd: 80,
    costBasisSol: 0.8,
    stopLossPriceUsd: 0.000336,
    peakPriceUsd: 0.00042,
    maxAgeHours: 48,
    signal: makeSignal(),
    ...overrides,
  };
}

describe("formatPositionOpenedMessage", () => {
  it("includes symbol, entry price, size, and confidence", () => {
    const msg = formatPositionOpenedMessage(makePosition());
    expect(msg).toContain("$DOGWIF2");
    expect(msg).toContain("0.8000 SOL");
    expect(msg).toContain("78%");
  });

  it("truncates long reasoning instead of sending an unbounded message", () => {
    const longReasoning = "x".repeat(500);
    const msg = formatPositionOpenedMessage(makePosition({ signal: makeSignal({ reasoning: longReasoning }) }));
    expect(msg.length).toBeLessThan(500 + 100);
    expect(msg).toContain("…");
  });
});

function makeTradeLogEntry(overrides: Partial<TradeLogEntry> = {}): TradeLogEntry {
  return {
    id: "1",
    mint: "mint",
    symbol: "PEPE3",
    entryPriceUsd: 0.001,
    exitPriceUsd: 0.0019,
    entryTimestamp: Date.now() - 6 * 60 * 60 * 1000,
    exitTimestamp: Date.now(),
    holdHours: 6.3,
    quantityTokens: 100_000,
    costBasisUsd: 100,
    realizedPnlUsd: 42,
    pnlPct: 0.34,
    exitReason: "trailing_stop",
    signalConfidence: 0.81,
    won: true,
    ...overrides,
  };
}

describe("formatPositionClosedMessage", () => {
  it("marks a winning trade clearly", () => {
    const msg = formatPositionClosedMessage(makeTradeLogEntry());
    expect(msg).toMatch(/WIN/);
    expect(msg).toContain("$PEPE3");
    expect(msg).toContain("trailing_stop");
    expect(msg).toContain("+34.0%");
  });

  it("marks a losing trade clearly", () => {
    const msg = formatPositionClosedMessage(
      makeTradeLogEntry({ won: false, pnlPct: -0.2, realizedPnlUsd: -20, exitReason: "stop_loss" }),
    );
    expect(msg).toMatch(/LOSS/);
    expect(msg).toContain("-20.0%");
    expect(msg).toContain("stop_loss");
  });
});

describe("formatExecutionErrorMessage", () => {
  it("includes the context, symbol, and error text", () => {
    const msg = formatExecutionErrorMessage("sell", "SCAM1", "insufficient liquidity");
    expect(msg).toContain("sell");
    expect(msg).toContain("$SCAM1");
    expect(msg).toContain("insufficient liquidity");
  });
});
