// ---------------------------------------------------------------------------
// Market structure — the skeleton every other SMC concept hangs off.
//
//   • Swings (fractals): local highs/lows that define the zig-zag of price.
//   • BOS  (Break of Structure): a close beyond the last swing in the *same*
//     direction as the prevailing trend — trend continuation.
//   • CHoCH (Change of Character): a close beyond the last swing *against* the
//     trend — the first sign of a reversal.
//
// Everything is computed walk-forward using only bars available at each step,
// so it is safe to reuse the same functions in a backtest without lookahead.
// ---------------------------------------------------------------------------
import type { Bar, Swing, StructureBreak, StructureState, MarketTrend } from "./types.js";

/**
 * Williams-style fractals. A swing high at `i` is strictly higher than the
 * `strength` bars on each side; a swing low is strictly lower. Strict
 * comparison avoids emitting duplicate pivots on flat tops — genuine "equal
 * highs" for liquidity come from two *separate* swings at the same price,
 * which the liquidity module reads off this list.
 *
 * A pivot at `i` is only knowable `strength` bars later; callers that must
 * avoid lookahead should treat a swing as "confirmed" at bar `i + strength`.
 */
export function findSwings(bars: Bar[], strength = 2): Swing[] {
  const swings: Swing[] = [];
  for (let i = strength; i < bars.length - strength; i++) {
    const h = bars[i]!.high;
    const l = bars[i]!.low;
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= strength; k++) {
      if (bars[i - k]!.high >= h || bars[i + k]!.high >= h) isHigh = false;
      if (bars[i - k]!.low <= l || bars[i + k]!.low <= l) isLow = false;
    }
    if (isHigh) swings.push({ index: i, time: bars[i]!.time, price: h, kind: "high" });
    if (isLow) swings.push({ index: i, time: bars[i]!.time, price: l, kind: "low" });
  }
  return swings;
}

/**
 * Walk the bars maintaining the running trend, classifying each decisive close
 * beyond the most recent *confirmed* swing as a BOS (continuation) or CHoCH
 * (reversal). Returns the state as of the final bar plus the full break list
 * (useful for drawing / debugging).
 */
export function computeStructure(bars: Bar[], strength = 2): StructureState & { breaks: StructureBreak[] } {
  const swings = findSwings(bars, strength);
  const breaks: StructureBreak[] = [];

  let trend: MarketTrend = "ranging";
  // The reference swings a break is measured against. They advance as new
  // confirmed swings appear and reset (get "consumed") once broken.
  let refHigh: Swing | null = null;
  let refLow: Swing | null = null;
  // Track the most recent confirmed swing of each kind for reporting.
  let lastSwingHigh: Swing | null = null;
  let lastSwingLow: Swing | null = null;
  let lastBreak: StructureBreak | null = null;

  let si = 0; // pointer into swings, consumed as they become confirmed

  for (let i = 0; i < bars.length; i++) {
    // Promote any swings that are now confirmed (their +strength bar has passed).
    while (si < swings.length && swings[si]!.index + strength <= i) {
      const s = swings[si]!;
      if (s.kind === "high") {
        lastSwingHigh = s;
        // Only adopt as the break reference if it sits above a consumed one.
        if (!refHigh || s.price > refHigh.price || refHigh.index < s.index) refHigh = s;
      } else {
        lastSwingLow = s;
        if (!refLow || s.price < refLow.price || refLow.index < s.index) refLow = s;
      }
      si++;
    }

    const close = bars[i]!.close;

    if (refHigh && close > refHigh.price && i > refHigh.index) {
      const event = trend === "bullish" ? "BOS" : "CHoCH";
      const brk: StructureBreak = {
        index: i,
        time: bars[i]!.time,
        event,
        direction: "bullish",
        brokenSwingPrice: refHigh.price,
        price: close,
      };
      breaks.push(brk);
      lastBreak = brk;
      trend = "bullish";
      refHigh = null; // consumed; wait for the next confirmed high above
    } else if (refLow && close < refLow.price && i > refLow.index) {
      const event = trend === "bearish" ? "BOS" : "CHoCH";
      const brk: StructureBreak = {
        index: i,
        time: bars[i]!.time,
        event,
        direction: "bearish",
        brokenSwingPrice: refLow.price,
        price: close,
      };
      breaks.push(brk);
      lastBreak = brk;
      trend = "bearish";
      refLow = null;
    }
  }

  return { trend, lastBreak, lastSwingHigh, lastSwingLow, swings, breaks };
}
