import { describe, expect, it, vi } from "vitest";
import {
  formatStatusReply,
  formatStatsReply,
  formatPositionsReply,
  routeCommand,
  HELP_TEXT,
  type CommandHandlers,
} from "../src/notify/telegramCommands.js";
import type { Position, TradeSignal } from "../src/types/index.js";
import type { TradeStats } from "../src/state/tradeLog.js";

function makePosition(overrides: Partial<Position> = {}): Position {
  const signal: TradeSignal = {
    mint: "mint",
    symbol: "DOGWIF2",
    confidence: 0.78,
    direction: "long",
    reasoning: "test",
    entryPriceUsd: 0.00042,
    generatedAt: Date.now(),
  };

  return {
    id: "1",
    mint: "mint",
    symbol: "DOGWIF2",
    status: "open",
    entryPriceUsd: 0.00042,
    entryTimestamp: Date.now() - 2 * 60 * 60 * 1000,
    quantityTokens: 190_000,
    costBasisUsd: 80,
    costBasisSol: 0.8,
    stopLossPriceUsd: 0.000336,
    peakPriceUsd: 0.00042,
    maxAgeHours: 48,
    signal,
    ...overrides,
  };
}

function makeStats(overrides: Partial<TradeStats> = {}): TradeStats {
  return {
    totalTrades: 40,
    wins: 18,
    losses: 22,
    winRatePct: 45,
    avgWinPct: 62,
    avgLossPct: -19,
    expectancyPct: 8.3,
    totalRealizedPnlUsd: 332.5,
    largestWinUsd: 400,
    largestLossUsd: -80,
    brierScore: 0.19,
    calibrationBuckets: [],
    sampleSizeWarning: null,
    ...overrides,
  };
}

describe("formatStatusReply", () => {
  it("includes mode, balance, and open position count", () => {
    const reply = formatStatusReply({
      mode: "paper",
      solBalance: 9.3421,
      totalValueUsd: 1401.32,
      openPositions: [makePosition()],
    });
    expect(reply).toContain("PAPER");
    expect(reply).toContain("9.3421");
    expect(reply).toContain("$1401.32");
    expect(reply).toContain("Open positions: 1");
    expect(reply).toContain("$DOGWIF2");
  });

  it("truncates a long position list", () => {
    const positions = Array.from({ length: 20 }, (_, i) => makePosition({ id: String(i), symbol: `TOK${i}` }));
    const reply = formatStatusReply({ mode: "paper", solBalance: 1, totalValueUsd: 1, openPositions: positions });
    expect(reply).toContain("...and 5 more");
  });
});

describe("formatStatsReply", () => {
  it("reports no trades yet when the ledger is empty", () => {
    expect(formatStatsReply(makeStats({ totalTrades: 0 }))).toMatch(/no closed trades/i);
  });

  it("includes win rate, expectancy, and Brier score", () => {
    const reply = formatStatsReply(makeStats());
    expect(reply).toContain("40 closed trades");
    expect(reply).toContain("45.0% win rate");
    expect(reply).toContain("0.190");
  });

  it("surfaces the small-sample warning when present", () => {
    const reply = formatStatsReply(makeStats({ sampleSizeWarning: "Only 3 closed trade(s)..." }));
    expect(reply).toContain("⚠️");
  });
});

describe("formatPositionsReply", () => {
  it("reports no open positions when empty", () => {
    expect(formatPositionsReply([])).toMatch(/no open positions/i);
  });

  it("lists entry price and stop for each position", () => {
    const reply = formatPositionsReply([makePosition()]);
    expect(reply).toContain("$DOGWIF2");
    expect(reply).toContain("stop $");
  });
});

function makeHandlers(): CommandHandlers {
  return {
    getStatusReply: vi.fn().mockResolvedValue("status-reply"),
    getStatsReply: vi.fn().mockResolvedValue("stats-reply"),
    getPositionsReply: vi.fn().mockResolvedValue("positions-reply"),
  };
}

const OWNER_CHAT_ID = 8690806947;
const OWNER_CHAT_ID_STR = String(OWNER_CHAT_ID);

describe("routeCommand", () => {
  it("silently ignores messages from any chat other than the owner's", async () => {
    const handlers = makeHandlers();
    const reply = await routeCommand("/status", 999999999, OWNER_CHAT_ID_STR, handlers);
    expect(reply).toBeNull();
    expect(handlers.getStatusReply).not.toHaveBeenCalled();
  });

  it("dispatches /status to getStatusReply for the owner chat", async () => {
    const handlers = makeHandlers();
    const reply = await routeCommand("/status", OWNER_CHAT_ID, OWNER_CHAT_ID_STR, handlers);
    expect(reply).toBe("status-reply");
  });

  it("dispatches /stats and /positions to their handlers", async () => {
    const handlers = makeHandlers();
    expect(await routeCommand("/stats", OWNER_CHAT_ID, OWNER_CHAT_ID_STR, handlers)).toBe("stats-reply");
    expect(await routeCommand("/positions", OWNER_CHAT_ID, OWNER_CHAT_ID_STR, handlers)).toBe("positions-reply");
  });

  it("returns the help text for /help and /start", async () => {
    const handlers = makeHandlers();
    expect(await routeCommand("/help", OWNER_CHAT_ID, OWNER_CHAT_ID_STR, handlers)).toBe(HELP_TEXT);
    expect(await routeCommand("/start", OWNER_CHAT_ID, OWNER_CHAT_ID_STR, handlers)).toBe(HELP_TEXT);
  });

  it("is case-insensitive and ignores trailing whitespace/args", async () => {
    const handlers = makeHandlers();
    expect(await routeCommand("/STATUS", OWNER_CHAT_ID, OWNER_CHAT_ID_STR, handlers)).toBe("status-reply");
    expect(await routeCommand("  /stats  ", OWNER_CHAT_ID, OWNER_CHAT_ID_STR, handlers)).toBe("stats-reply");
  });

  it("replies with help for an unrecognized command instead of throwing", async () => {
    const handlers = makeHandlers();
    const reply = await routeCommand("/nonsense", OWNER_CHAT_ID, OWNER_CHAT_ID_STR, handlers);
    expect(reply).toContain("Unrecognized command");
    expect(reply).toContain(HELP_TEXT);
  });
});
