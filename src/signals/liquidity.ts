// ---------------------------------------------------------------------------
// Liquidity — where stop orders rest, and what happens when price runs them.
//
//   • Pools: clusters of swing highs (buyside liquidity, above the market) or
//     swing lows (sellside liquidity, below it). "Equal highs/lows" are the
//     obvious pools every breakout trader parks a stop behind.
//   • Sweep (stop hunt): a bar pierces a pool with its wick then CLOSES back on
//     the origin side, trapping the breakout crowd. A *sellside* sweep (runs
//     lows, closes back up) is a bullish trigger; a *buyside* sweep is bearish.
//
// The sweep is the engine's primary entry trigger: it marks the moment smart
// money has sourced the liquidity it needs to push the other way.
// ---------------------------------------------------------------------------
import type { Bar, Swing, LiquidityPool, LiquiditySweep } from "./types.js";

export interface LiquidityOptions {
  /** Two swings are "equal" if within this fraction of price (default 0.15%). */
  equalTolerancePct?: number;
  /** Minimum fraction of the sweeping bar's range that the rejection wick must be. */
  minRejectionWick?: number;
}

const DEFAULTS: Required<LiquidityOptions> = {
  equalTolerancePct: 0.0015,
  minRejectionWick: 0.3,
};

/**
 * Cluster swing highs into buyside pools and swing lows into sellside pools.
 * A pool with `touches >= 2` is an "equal highs/lows" magnet; single swings are
 * still returned (touches = 1) because the most recent swing extreme is itself
 * a liquidity target.
 */
export function findLiquidityPools(swings: Swing[], opts: LiquidityOptions = {}): LiquidityPool[] {
  const { equalTolerancePct } = { ...DEFAULTS, ...opts };
  const pools: LiquidityPool[] = [];

  for (const side of ["high", "low"] as const) {
    const group = swings.filter((s) => s.kind === side).sort((a, b) => a.price - b.price);
    let cluster: Swing[] = [];

    const flush = () => {
      if (cluster.length === 0) return;
      const price = side === "high" ? Math.max(...cluster.map((c) => c.price)) : Math.min(...cluster.map((c) => c.price));
      const time = Math.max(...cluster.map((c) => c.time)); // most recent touch
      pools.push({ side: side === "high" ? "buyside" : "sellside", price, time, touches: cluster.length });
      cluster = [];
    };

    for (const s of group) {
      if (cluster.length === 0) {
        cluster.push(s);
        continue;
      }
      const ref = cluster[cluster.length - 1]!.price;
      if (Math.abs(s.price - ref) <= ref * equalTolerancePct) cluster.push(s);
      else {
        flush();
        cluster.push(s);
      }
    }
    flush();
  }

  return pools.sort((a, b) => b.time - a.time);
}

/**
 * Scan for liquidity sweeps against prior *confirmed* swing levels. A bar `i`
 * sweeps buyside liquidity when its high pushes above a prior swing high but it
 * closes back below that level with a meaningful upper wick; sellside is the
 * mirror. Returns sweeps in bar order — callers usually want the last one.
 */
export function detectSweeps(bars: Bar[], swings: Swing[], strength = 2, opts: LiquidityOptions = {}): LiquiditySweep[] {
  const { minRejectionWick } = { ...DEFAULTS, ...opts };
  const sweeps: LiquiditySweep[] = [];

  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");

  for (let i = strength; i < bars.length; i++) {
    const b = bars[i]!;
    const range = b.high - b.low;
    if (range <= 0) continue;

    // Nearest confirmed swing high strictly below this bar's high — the level
    // the wick reached over. "Confirmed" = its +strength bar has passed.
    const sweptHigh = highs
      .filter((s) => s.index + strength <= i && s.index < i && b.high > s.price)
      .sort((a, c) => c.price - a.price)
      .find((s) => b.close < s.price); // and we closed back below it
    if (sweptHigh) {
      const wick = (b.high - Math.max(b.open, b.close)) / range;
      if (wick >= minRejectionWick) {
        sweeps.push({ index: i, time: b.time, side: "buyside", sweptPrice: sweptHigh.price, extreme: b.high, close: b.close });
        continue; // one sweep classification per bar
      }
    }

    const sweptLow = lows
      .filter((s) => s.index + strength <= i && s.index < i && b.low < s.price)
      .sort((a, c) => a.price - c.price)
      .find((s) => b.close > s.price); // closed back above the swept low
    if (sweptLow) {
      const wick = (Math.min(b.open, b.close) - b.low) / range;
      if (wick >= minRejectionWick) {
        sweeps.push({ index: i, time: b.time, side: "sellside", sweptPrice: sweptLow.price, extreme: b.low, close: b.close });
      }
    }
  }

  return sweeps;
}
