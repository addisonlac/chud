// ---------------------------------------------------------------------------
// Stock signal engine — shared types
//
// This module is the "Smart Money Concepts" (SMC / ICT-style) brain of the
// stock signal bot. It works on plain OHLCV bars and is deliberately free of
// any data-source or broker specifics so it can be unit-tested and reused
// from the backtester, the live analyzer, and the TradingView webhook path.
// ---------------------------------------------------------------------------

/** One OHLCV bar. `time` is unix SECONDS at the bar's open (left edge). */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = "1h" | "4h";

/** A confirmed swing pivot (fractal) — a local extreme flanked by weaker bars. */
export interface Swing {
  index: number; // index into the bar array
  time: number;
  price: number;
  kind: "high" | "low";
}

export type StructureEvent = "BOS" | "CHoCH"; // break of structure / change of character

/** A break of a prior swing that either continues (BOS) or flips (CHoCH) trend. */
export interface StructureBreak {
  index: number; // bar that closed through the level
  time: number;
  event: StructureEvent;
  direction: "bullish" | "bearish";
  brokenSwingPrice: number;
  price: number; // close that confirmed the break
}

export type MarketTrend = "bullish" | "bearish" | "ranging";

/** Higher-timeframe / entry-timeframe directional read. */
export interface StructureState {
  trend: MarketTrend;
  lastBreak: StructureBreak | null;
  lastSwingHigh: Swing | null;
  lastSwingLow: Swing | null;
  swings: Swing[];
}

/** A pool of resting liquidity — equal highs/lows where stops cluster. */
export interface LiquidityPool {
  side: "buyside" | "sellside"; // buyside = above equal highs, sellside = below equal lows
  price: number;
  time: number;
  touches: number; // how many swings formed the pool (>= 2 means "equal")
}

/**
 * A liquidity sweep (a.k.a. stop hunt): price pokes *through* a liquidity pool
 * then closes back on the other side, trapping breakout traders. The engine's
 * highest-conviction entry trigger.
 */
export interface LiquiditySweep {
  index: number; // bar that swept and rejected
  time: number;
  side: "buyside" | "sellside";
  sweptPrice: number; // the pool level that was taken
  extreme: number; // the wick extreme that reached beyond the pool
  close: number; // where the sweeping bar closed (back inside)
}

/**
 * An order block: the last opposing candle before an impulsive, structure-
 * breaking move. Treated as a supply/demand zone price often returns to.
 */
export interface OrderBlock {
  index: number;
  time: number;
  side: "bullish" | "bearish"; // bullish = demand (buy) zone, bearish = supply (sell) zone
  top: number;
  bottom: number;
}

/**
 * A fair value gap (FVG / imbalance): a 3-bar pattern where bar1 and bar3 do
 * not overlap, leaving an inefficiency price tends to revisit.
 */
export interface FairValueGap {
  index: number; // index of the middle bar
  time: number;
  side: "bullish" | "bearish";
  top: number;
  bottom: number;
}

export type Action = "BUY" | "SELL" | "WAIT";

/** One line of the human-readable "why" behind a signal. */
export interface ReasoningStep {
  label: string; // short heading, e.g. "4h bias"
  detail: string; // the explanation
  verdict: "bullish" | "bearish" | "neutral" | "info";
  weight: number; // contribution to confidence, 0..1 (0 for pure-context steps)
}

/** The full analysis for one symbol at one moment. */
export interface Signal {
  symbol: string;
  action: Action;
  confidence: number; // 0..1
  price: number; // last close analysed
  generatedAt: number; // unix seconds of the entry bar

  entry: number | null;
  entryType: "market" | "limit"; // market = act on the trigger bar; limit = wait for a pullback fill
  stop: number | null;
  targets: number[]; // TP1, TP2 (structure-based)
  riskReward: number | null; // to the first target

  htfTrend: MarketTrend; // 4h bias
  ltfTrend: MarketTrend; // 1h structure

  reasoning: ReasoningStep[];
  // Raw evidence the overlay/Pine side can redraw.
  evidence: {
    sweep: LiquiditySweep | null;
    orderBlock: OrderBlock | null;
    fvg: FairValueGap | null;
    structureBreak: StructureBreak | null;
    liquidityPools: LiquidityPool[];
  };
}
