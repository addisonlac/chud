import { describe, expect, it } from "vitest";
import { WhaleTracker } from "../src/whales/whaleTracker.js";
import type { WhaleTransaction } from "../src/types/index.js";

const WHALE = "WhaleWallet111111111111111111111111111111";
const OTHER_WALLET = "SomeoneElse2222222222222222222222222222222";
const MINT = "TokenMint33333333333333333333333333333333";

function makeTx(overrides: Partial<WhaleTransaction> = {}): WhaleTransaction {
  return {
    signature: "sig1",
    wallet: WHALE,
    mint: MINT,
    type: "buy",
    amountUsd: 150,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("WhaleTracker", () => {
  it("ignores transactions from wallets not on the watchlist", () => {
    const tracker = new WhaleTracker();
    tracker.setWatchlist([WHALE]);
    tracker.ingest([makeTx({ wallet: OTHER_WALLET })]);

    const activity = tracker.getActivity(MINT, 60);
    expect(activity.buyCount).toBe(0);
    expect(activity.distinctWhales).toBe(0);
  });

  it("counts a buy from a watched whale", () => {
    const tracker = new WhaleTracker();
    tracker.setWatchlist([WHALE]);
    tracker.ingest([makeTx({ type: "buy", amountUsd: 150 })]);

    const activity = tracker.getActivity(MINT, 60);
    expect(activity.buyCount).toBe(1);
    expect(activity.sellCount).toBe(0);
    expect(activity.distinctWhales).toBe(1);
    expect(activity.netFlowUsd).toBeCloseTo(150, 5);
  });

  it("nets flow negative for a sell", () => {
    const tracker = new WhaleTracker();
    tracker.setWatchlist([WHALE]);
    tracker.ingest([makeTx({ signature: "sig2", type: "sell", amountUsd: 300 })]);

    const activity = tracker.getActivity(MINT, 60);
    expect(activity.sellCount).toBe(1);
    expect(activity.netFlowUsd).toBeCloseTo(-300, 5);
  });

  it("only counts transactions within the requested time window", () => {
    const tracker = new WhaleTracker();
    tracker.setWatchlist([WHALE]);
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    tracker.ingest([makeTx({ timestamp: twoHoursAgo })]);

    expect(tracker.getActivity(MINT, 60).buyCount).toBe(0);
    expect(tracker.getActivity(MINT, 180).buyCount).toBe(1);
  });
});
