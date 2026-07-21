import { describe, expect, it } from "vitest";
import { mapCreateEvent } from "../src/scanners/pumpportal.js";

const SOL_PRICE = 150;

describe("mapCreateEvent", () => {
  it("maps a valid create event to a PumpFunToken with USD market cap", () => {
    const token = mapCreateEvent(
      {
        txType: "create",
        mint: "MintAddr111",
        name: "Test Token",
        symbol: "TEST",
        traderPublicKey: "Creator111",
        marketCapSol: 400, // 400 SOL
        vSolInBondingCurve: 30,
        vTokensInBondingCurve: 1_000_000,
      },
      SOL_PRICE,
    );

    expect(token).not.toBeNull();
    expect(token?.mint).toBe("MintAddr111");
    expect(token?.symbol).toBe("TEST");
    expect(token?.marketCapUsd).toBeCloseTo(400 * SOL_PRICE, 5); // $60,000
    expect(token?.priceUsd).toBeCloseTo((30 / 1_000_000) * SOL_PRICE, 10);
  });

  it("returns null for a non-create event (e.g. a trade)", () => {
    expect(mapCreateEvent({ txType: "buy", mint: "x", symbol: "X" }, SOL_PRICE)).toBeNull();
  });

  it("returns null when the mint or symbol is missing", () => {
    expect(mapCreateEvent({ txType: "create", symbol: "X" }, SOL_PRICE)).toBeNull();
    expect(mapCreateEvent({ txType: "create", mint: "x" }, SOL_PRICE)).toBeNull();
  });

  it("falls back to symbol for name and zero price when reserves are missing", () => {
    const token = mapCreateEvent({ txType: "create", mint: "m", symbol: "SYM", marketCapSol: 10 }, SOL_PRICE);
    expect(token?.name).toBe("SYM");
    expect(token?.priceUsd).toBe(0);
    expect(token?.marketCapUsd).toBeCloseTo(1500, 5);
  });

  it("produces a market cap that the >$50k filter can evaluate", () => {
    // 400 SOL * $150 = $60k -> should clear the default $50k floor;
    // 100 SOL * $150 = $15k -> should not
    const big = mapCreateEvent({ txType: "create", mint: "m", symbol: "S", marketCapSol: 400 }, SOL_PRICE);
    const small = mapCreateEvent({ txType: "create", mint: "m", symbol: "S", marketCapSol: 100 }, SOL_PRICE);
    expect(big?.marketCapUsd).toBeGreaterThan(50_000);
    expect(small?.marketCapUsd).toBeLessThan(50_000);
  });
});
