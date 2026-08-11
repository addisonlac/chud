import { describe, expect, it } from "vitest";
import { parseCoinbasePrice, parseCoinGeckoPrice } from "../src/data/solPrice.js";

describe("parseCoinbasePrice", () => {
  it("parses the spot amount string into a number", () => {
    expect(parseCoinbasePrice({ data: { amount: "212.47" } })).toBeCloseTo(212.47, 5);
  });

  it("throws on missing / non-numeric / non-positive amounts", () => {
    expect(() => parseCoinbasePrice({})).toThrow();
    expect(() => parseCoinbasePrice({ data: {} })).toThrow();
    expect(() => parseCoinbasePrice({ data: { amount: "nope" } })).toThrow();
    expect(() => parseCoinbasePrice({ data: { amount: "0" } })).toThrow();
  });
});

describe("parseCoinGeckoPrice", () => {
  it("reads solana.usd", () => {
    expect(parseCoinGeckoPrice({ solana: { usd: 209.9 } })).toBeCloseTo(209.9, 5);
  });

  it("throws on missing / non-positive prices", () => {
    expect(() => parseCoinGeckoPrice({})).toThrow();
    expect(() => parseCoinGeckoPrice({ solana: {} })).toThrow();
    expect(() => parseCoinGeckoPrice({ solana: { usd: 0 } })).toThrow();
  });
});
