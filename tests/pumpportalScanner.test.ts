import { describe, expect, it } from "vitest";
import { mapCreateEvent, mapMigrationEvent } from "../src/scanners/pumpportal.js";

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

  it("computes market cap from reserves when marketCapSol is missing", () => {
    // price = 30/1e9 SOL/token; mcap = price * 1e9 supply = 30 SOL = $4500
    const token = mapCreateEvent(
      { txType: "create", mint: "m", symbol: "SYM", vSolInBondingCurve: 30, vTokensInBondingCurve: 1_000_000_000 },
      SOL_PRICE,
    );
    expect(token?.marketCapUsd).toBeCloseTo(30 * SOL_PRICE, 5);
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

describe("mapMigrationEvent", () => {
  it("maps a migration event and clears the $50k filter via the graduation sentinel", () => {
    const token = mapMigrationEvent({ mint: "GradMint111", symbol: "GRAD" }, SOL_PRICE);
    expect(token).not.toBeNull();
    expect(token?.mint).toBe("GradMint111");
    expect(token?.symbol).toBe("GRAD");
    expect(token?.marketCapUsd).toBeGreaterThan(50_000); // sentinel ~$69k
  });

  it("uses the event marketCapSol when present", () => {
    const token = mapMigrationEvent({ mint: "m", symbol: "S", marketCapSol: 500 }, SOL_PRICE);
    expect(token?.marketCapUsd).toBeCloseTo(500 * SOL_PRICE, 5);
  });

  it("falls back to a mint-prefix symbol when none is provided", () => {
    const token = mapMigrationEvent({ mint: "ABCDEF123456" }, SOL_PRICE);
    expect(token?.symbol).toBe("ABCDEF");
  });

  it("returns null without a mint", () => {
    expect(mapMigrationEvent({ symbol: "X" }, SOL_PRICE)).toBeNull();
  });
});
