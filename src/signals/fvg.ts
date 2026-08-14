// ---------------------------------------------------------------------------
// Fair Value Gaps (FVG / imbalance) — a 3-bar pattern where bar1 and bar3 do
// not overlap, leaving a price range that traded through in one direction only.
// Price tends to revisit ("fill") these inefficiencies, so an FVG aligned with
// the trade direction is treated as confluence, and an unfilled FVG below entry
// is a natural stop-run risk.
// ---------------------------------------------------------------------------
import type { Bar, FairValueGap } from "./types.js";

/**
 * All FVGs in the series. A bullish FVG (middle bar `i`) exists when
 * `bars[i-1].high < bars[i+1].low` — a gap of untraded price below. Bearish is
 * the mirror: `bars[i-1].low > bars[i+1].high`.
 */
export function findFvgs(bars: Bar[]): FairValueGap[] {
  const out: FairValueGap[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const prev = bars[i - 1]!;
    const next = bars[i + 1]!;
    if (prev.high < next.low) {
      out.push({ index: i, time: bars[i]!.time, side: "bullish", top: next.low, bottom: prev.high });
    } else if (prev.low > next.high) {
      out.push({ index: i, time: bars[i]!.time, side: "bearish", top: prev.low, bottom: next.high });
    }
  }
  return out;
}

/**
 * The most recent FVG on `side` that price has not yet fully filled, scanning
 * from newest to oldest. A gap counts as filled once any later bar's range has
 * traded fully back through it.
 */
export function latestUnfilledFvg(bars: Bar[], fvgs: FairValueGap[], side: "bullish" | "bearish"): FairValueGap | null {
  for (let k = fvgs.length - 1; k >= 0; k--) {
    const g = fvgs[k]!;
    if (g.side !== side) continue;
    let filled = false;
    for (let j = g.index + 2; j < bars.length; j++) {
      const b = bars[j]!;
      if (b.low <= g.bottom && b.high >= g.top) {
        filled = true;
        break;
      }
    }
    if (!filled) return g;
  }
  return null;
}
