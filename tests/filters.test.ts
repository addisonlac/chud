import { describe, expect, it } from "vitest";
import { passesMarketCapFilter } from "../src/scanners/filters.js";
import { mapRawCoin } from "../src/scanners/pumpfun.js";
import type { PumpFunToken } from "../src/types/index.js";

function makeToken(marketCapUsd: number): PumpFunToken {
  return {
    mint: "mint",
    symbol: "TEST",
    name: "Test Token",
    createdAt: Date.now(),
    creator: "creator",
    marketCapUsd,
    priceUsd: 0.001,
  };
}

describe("passesMarketCapFilter", () => {
  it("rejects tokens at or below the $50k floor", () => {
    expect(passesMarketCapFilter(makeToken(50_000), 50_000)).toBe(false);
    expect(passesMarketCapFilter(makeToken(49_999), 50_000)).toBe(false);
  });

  it("accepts tokens strictly above the floor", () => {
    expect(passesMarketCapFilter(makeToken(50_001), 50_000)).toBe(true);
  });
});

describe("mapRawCoin", () => {
  it("derives price from virtual reserves when present", () => {
    const token = mapRawCoin({
      mint: "abc",
      symbol: "PEPE2",
      name: "Pepe Two",
      creator: "creator",
      created_timestamp: 1234,
      usd_market_cap: 60000,
      virtual_sol_reserves: 30_000_000_000, // 30 SOL in lamports
      virtual_token_reserves: 1_000_000_000_000,
    });

    expect(token.marketCapUsd).toBe(60000);
    expect(token.priceUsd).toBeCloseTo(30_000_000_000 / 1_000_000_000_000, 10);
  });

  it("falls back to market_cap and zero price when fields are missing", () => {
    const token = mapRawCoin({
      mint: "abc",
      symbol: "X",
      name: "X",
      creator: "creator",
      created_timestamp: 1234,
      market_cap: 12345,
    });

    expect(token.marketCapUsd).toBe(12345);
    expect(token.priceUsd).toBe(0);
  });
});
