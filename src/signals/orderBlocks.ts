// ---------------------------------------------------------------------------
// Order blocks — the last opposing candle before an impulsive, structure-
// breaking move. Read as institutional demand (bullish OB) or supply (bearish
// OB) zones that price tends to retrace into before continuing.
// ---------------------------------------------------------------------------
import type { Bar, OrderBlock, StructureBreak } from "./types.js";

/**
 * The order block that produced a given structure break: scan backwards from
 * the breaking bar for the last candle of the opposite colour. For a bullish
 * break that's the last down-candle (demand); for a bearish break the last
 * up-candle (supply). The zone is that candle's full high–low range.
 */
export function orderBlockForBreak(bars: Bar[], brk: StructureBreak, maxLookback = 15): OrderBlock | null {
  const from = brk.index - 1;
  const to = Math.max(0, brk.index - maxLookback);
  for (let i = from; i >= to; i--) {
    const b = bars[i]!;
    const isDown = b.close < b.open;
    const isUp = b.close > b.open;
    if (brk.direction === "bullish" && isDown) {
      return { index: i, time: b.time, side: "bullish", top: b.high, bottom: b.low };
    }
    if (brk.direction === "bearish" && isUp) {
      return { index: i, time: b.time, side: "bearish", top: b.high, bottom: b.low };
    }
  }
  return null;
}

/** Is `price` currently inside (or within `pad` fraction of) the OB zone? */
export function priceInOrderBlock(price: number, ob: OrderBlock, pad = 0.001): boolean {
  const padAbs = price * pad;
  return price >= ob.bottom - padAbs && price <= ob.top + padAbs;
}
