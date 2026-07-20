import { describe, expect, it } from "vitest";
import { parseWhaleTransaction, type WalletTxBalances } from "../src/whales/solanaWhalePoller.js";

const WHALE = "WhaleWallet111111111111111111111111111111";
const MINT = "TokenMint33333333333333333333333333333333";
const SOL_MINT = "So11111111111111111111111111111111111111112";

function makeBalances(overrides: Partial<WalletTxBalances> = {}): WalletTxBalances {
  return {
    signature: "sig1",
    blockTimeSeconds: Math.floor(Date.now() / 1000),
    walletSolDeltaLamports: -1_000_000_000, // spent 1 SOL
    tokenBalanceDeltas: [{ mint: MINT, uiAmountDelta: 1000 }], // received 1000 tokens
    ...overrides,
  };
}

describe("parseWhaleTransaction", () => {
  it("classifies a positive non-quote balance delta as a buy", () => {
    const tx = parseWhaleTransaction(makeBalances(), WHALE, 150);
    expect(tx).not.toBeNull();
    expect(tx?.type).toBe("buy");
    expect(tx?.mint).toBe(MINT);
    expect(tx?.amountUsd).toBeCloseTo(150, 5); // 1 SOL * $150
  });

  it("classifies a negative non-quote balance delta as a sell", () => {
    const tx = parseWhaleTransaction(
      makeBalances({
        walletSolDeltaLamports: 2_000_000_000, // received 2 SOL
        tokenBalanceDeltas: [{ mint: MINT, uiAmountDelta: -1000 }],
      }),
      WHALE,
      150,
    );
    expect(tx?.type).toBe("sell");
    expect(tx?.amountUsd).toBeCloseTo(300, 5); // 2 SOL * $150
  });

  it("ignores quote-mint (SOL/USDC) balance changes when picking the involved token", () => {
    const tx = parseWhaleTransaction(
      makeBalances({
        tokenBalanceDeltas: [
          { mint: SOL_MINT, uiAmountDelta: -1 },
          { mint: MINT, uiAmountDelta: 1000 },
        ],
      }),
      WHALE,
      150,
    );
    expect(tx?.mint).toBe(MINT);
  });

  it("picks the largest-magnitude non-quote delta when multiple tokens moved", () => {
    const tx = parseWhaleTransaction(
      makeBalances({
        tokenBalanceDeltas: [
          { mint: "SmallMove1111111111111111111111111111111", uiAmountDelta: 5 },
          { mint: MINT, uiAmountDelta: 1000 },
        ],
      }),
      WHALE,
      150,
    );
    expect(tx?.mint).toBe(MINT);
  });

  it("returns null when there is no non-quote token movement", () => {
    const tx = parseWhaleTransaction(makeBalances({ tokenBalanceDeltas: [] }), WHALE, 150);
    expect(tx).toBeNull();
  });

  it("returns null when the only delta is exactly zero", () => {
    const tx = parseWhaleTransaction(
      makeBalances({ tokenBalanceDeltas: [{ mint: MINT, uiAmountDelta: 0 }] }),
      WHALE,
      150,
    );
    expect(tx).toBeNull();
  });

  it("falls back to roughly the current time when blockTimeSeconds is null", () => {
    // the fallback rounds to whole seconds (matching real Solana blockTime
    // precision), so it can trail the exact millisecond by up to ~1s
    const before = Date.now();
    const tx = parseWhaleTransaction(makeBalances({ blockTimeSeconds: null }), WHALE, 150);
    expect(tx?.timestamp).toBeGreaterThanOrEqual(before - 1000);
  });
});
