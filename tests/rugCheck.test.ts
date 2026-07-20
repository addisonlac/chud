import { describe, expect, it } from "vitest";
import { assessTokenSafety, type RugCheckConfig } from "../src/safety/rugCheck.js";
import type { TokenOverview, TokenSecurityInfo } from "../src/types/index.js";

const config: RugCheckConfig = {
  requireMintAuthorityRevoked: true,
  requireFreezeAuthorityRevoked: true,
  maxTop10HolderPct: 0.6,
  maxCreatorPct: 0.15,
  blockToken2022TransferFee: true,
  minLiquidityUsd: 10_000,
};

function safeSecurity(overrides: Partial<TokenSecurityInfo> = {}): TokenSecurityInfo {
  return {
    mint: "mint",
    mintAuthority: null,
    freezeAuthority: null,
    top10HolderPct: 0.3,
    creatorPct: 0.05,
    isToken2022: false,
    transferFeeEnabled: false,
    ...overrides,
  };
}

function safeOverview(overrides: Partial<TokenOverview> = {}): TokenOverview {
  return {
    mint: "mint",
    marketCapUsd: 100_000,
    liquidityUsd: 50_000,
    priceUsd: 0.001,
    priceChange24hPct: 10,
    volume24hUsd: 20_000,
    holders: 200,
    ...overrides,
  };
}

describe("assessTokenSafety", () => {
  it("passes a token that clears every threshold", () => {
    const result = assessTokenSafety(safeSecurity(), safeOverview(), config);
    expect(result.passed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("rejects an un-revoked mint authority", () => {
    const result = assessTokenSafety(safeSecurity({ mintAuthority: "SomeAuthority111" }), safeOverview(), config);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("mint authority"))).toBe(true);
  });

  it("rejects an un-revoked freeze authority", () => {
    const result = assessTokenSafety(safeSecurity({ freezeAuthority: "SomeAuthority111" }), safeOverview(), config);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("freeze authority"))).toBe(true);
  });

  it("rejects excessive top-10 holder concentration", () => {
    const result = assessTokenSafety(safeSecurity({ top10HolderPct: 0.75 }), safeOverview(), config);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("top 10 holders"))).toBe(true);
  });

  it("rejects excessive creator concentration", () => {
    const result = assessTokenSafety(safeSecurity({ creatorPct: 0.5 }), safeOverview(), config);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("creator holds"))).toBe(true);
  });

  it("rejects Token-2022 tokens with a transfer fee extension enabled", () => {
    const result = assessTokenSafety(
      safeSecurity({ isToken2022: true, transferFeeEnabled: true }),
      safeOverview(),
      config,
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("transfer-fee"))).toBe(true);
  });

  it("allows Token-2022 tokens without a transfer fee extension", () => {
    const result = assessTokenSafety(
      safeSecurity({ isToken2022: true, transferFeeEnabled: false }),
      safeOverview(),
      config,
    );
    expect(result.passed).toBe(true);
  });

  it("rejects thin liquidity below the configured floor", () => {
    const result = assessTokenSafety(safeSecurity(), safeOverview({ liquidityUsd: 500 }), config);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("liquidity"))).toBe(true);
  });

  it("collects every failure reason at once, not just the first", () => {
    const result = assessTokenSafety(
      safeSecurity({ mintAuthority: "x", freezeAuthority: "y", top10HolderPct: 0.9 }),
      safeOverview({ liquidityUsd: 100 }),
      config,
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(4);
  });
});
