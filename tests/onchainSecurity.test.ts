import { describe, expect, it } from "vitest";
import { parseTokenSecurity, type SecurityInputs } from "../src/data/onchainSecurity.js";

function inputs(overrides: Partial<SecurityInputs> = {}): SecurityInputs {
  return {
    mint: "MintAddr",
    program: "spl-token",
    info: { mintAuthority: null, freezeAuthority: null, supply: "1000000000000000", decimals: 6 },
    top10UiAmount: 300_000_000,
    totalUiSupply: 1_000_000_000,
    ...overrides,
  };
}

describe("parseTokenSecurity", () => {
  it("reports revoked authorities as null", () => {
    const r = parseTokenSecurity(inputs());
    expect(r.mintAuthority).toBeNull();
    expect(r.freezeAuthority).toBeNull();
  });

  it("surfaces an un-revoked mint/freeze authority", () => {
    const r = parseTokenSecurity(inputs({ info: { mintAuthority: "AUTH1", freezeAuthority: "AUTH2", supply: "1000000000000000", decimals: 6 } }));
    expect(r.mintAuthority).toBe("AUTH1");
    expect(r.freezeAuthority).toBe("AUTH2");
  });

  it("computes top-10 holder concentration as a fraction of supply", () => {
    const r = parseTokenSecurity(inputs({ top10UiAmount: 300_000_000, totalUiSupply: 1_000_000_000 }));
    expect(r.top10HolderPct).toBeCloseTo(0.3, 5);
  });

  it("treats zero/unknown supply as fully concentrated (worst case)", () => {
    const r = parseTokenSecurity(inputs({ totalUiSupply: 0 }));
    expect(r.top10HolderPct).toBe(1);
  });

  it("flags Token-2022 with a transfer-fee extension", () => {
    const r = parseTokenSecurity(
      inputs({
        program: "spl-token-2022",
        info: { supply: "1000000000000000", decimals: 6, extensions: [{ extension: "transferFeeConfig" }] },
      }),
    );
    expect(r.isToken2022).toBe(true);
    expect(r.transferFeeEnabled).toBe(true);
  });

  it("does not flag a plain SPL token as Token-2022", () => {
    const r = parseTokenSecurity(inputs({ program: "spl-token" }));
    expect(r.isToken2022).toBe(false);
    expect(r.transferFeeEnabled).toBe(false);
  });
});
