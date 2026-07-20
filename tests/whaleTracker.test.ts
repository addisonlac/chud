import { describe, expect, it } from "vitest";
import { WhaleTracker } from "../src/whales/whaleTracker.js";
import type { HeliusEnhancedTransaction } from "../src/whales/heliusWebhook.js";

const WHALE = "WhaleWallet111111111111111111111111111111";
const OTHER_WALLET = "SomeoneElse2222222222222222222222222222222";
const MINT = "TokenMint33333333333333333333333333333333";
const SOL_MINT = "So11111111111111111111111111111111111111112";

function makeSwapTx(overrides: Partial<HeliusEnhancedTransaction> = {}): HeliusEnhancedTransaction {
  return {
    signature: "sig1",
    type: "SWAP",
    timestamp: Math.floor(Date.now() / 1000),
    feePayer: WHALE,
    events: {
      swap: {
        tokenInputs: [{ mint: SOL_MINT, tokenAmount: 1, userAccount: WHALE }],
        tokenOutputs: [{ mint: MINT, tokenAmount: 1000, userAccount: WHALE }],
        nativeInput: { account: WHALE, amount: "1000000000" }, // 1 SOL in lamports
      },
    },
    ...overrides,
  };
}

describe("WhaleTracker", () => {
  it("ignores transactions from wallets not on the watchlist", () => {
    const tracker = new WhaleTracker();
    tracker.setWatchlist([WHALE]);
    tracker.ingest([makeSwapTx({ feePayer: OTHER_WALLET, events: undefined })]);

    const activity = tracker.getActivity(MINT, 60);
    expect(activity.buyCount).toBe(0);
    expect(activity.distinctWhales).toBe(0);
  });

  it("classifies a whale receiving a non-quote token as a buy", () => {
    const tracker = new WhaleTracker();
    tracker.setWatchlist([WHALE]);
    tracker.setSolPriceUsd(150);
    tracker.ingest([makeSwapTx()]);

    const activity = tracker.getActivity(MINT, 60);
    expect(activity.buyCount).toBe(1);
    expect(activity.sellCount).toBe(0);
    expect(activity.distinctWhales).toBe(1);
    expect(activity.netFlowUsd).toBeCloseTo(150, 5); // 1 SOL * $150
  });

  it("classifies a whale sending a non-quote token as a sell and nets flow negative", () => {
    const tracker = new WhaleTracker();
    tracker.setWatchlist([WHALE]);
    tracker.setSolPriceUsd(150);
    tracker.ingest([
      makeSwapTx({
        signature: "sig2",
        events: {
          swap: {
            tokenInputs: [{ mint: MINT, tokenAmount: 1000, userAccount: WHALE }],
            tokenOutputs: [{ mint: SOL_MINT, tokenAmount: 1, userAccount: WHALE }],
            nativeOutput: { account: WHALE, amount: "2000000000" }, // 2 SOL
          },
        },
      }),
    ]);

    const activity = tracker.getActivity(MINT, 60);
    expect(activity.sellCount).toBe(1);
    expect(activity.netFlowUsd).toBeCloseTo(-300, 5);
  });

  it("only counts transactions within the requested time window", () => {
    const tracker = new WhaleTracker();
    tracker.setWatchlist([WHALE]);
    const oldTimestamp = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000); // 2h ago
    tracker.ingest([makeSwapTx({ timestamp: oldTimestamp })]);

    expect(tracker.getActivity(MINT, 60).buyCount).toBe(0);
    expect(tracker.getActivity(MINT, 180).buyCount).toBe(1);
  });
});
