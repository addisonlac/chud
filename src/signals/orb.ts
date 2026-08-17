// ---------------------------------------------------------------------------
// Opening Range Breakout (ORB) — the day-trading futures strategy with the best
// documented mix of a high hit rate AND asymmetric reward (avg win > avg loss).
//
// The idea: the first N minutes of the US cash session (the "opening range")
// bracket the day's initial auction. A decisive break of that range tends to
// run, and the longer/tighter the range, the cleaner the release. We enter on
// the FIRST break, stop at the OTHER side of the range (so risk = range width),
// and target a multiple of that risk (default 2R) — a structurally asymmetric
// trade. Because the stop is the whole range (not a scalp stop), contract size
// is small, so commissions + slippage stay a small fraction of the move.
//
// This module only RECOGNISES the setup (one per session). Simulation/cost
// accounting lives in the backtest; the same logic is ported into the app.
// ---------------------------------------------------------------------------
import type { Bar } from "./types.js";

export interface OrbConfig {
  openMinutes: number; // opening-range length in bars/minutes (15 or 30 typical)
  targetR: number; // profit target as a multiple of range-width risk
  entryBufferTicks: number; // require the close to clear the range by this many ticks
  tickSize: number; // instrument tick (for the buffer)
  maxEntryBar: number; // don't take a break after this many bars into the session
  minRangeFrac: number; // skip a dead open: range < this fraction of price
  maxRangeFrac: number; // skip a gappy/news open: range > this fraction of price
  requireVwapAlign: boolean; // only take breaks on the VWAP side of the trade
}

export function defaultOrbConfig(): OrbConfig {
  return {
    openMinutes: 15,
    targetR: 2,
    entryBufferTicks: 0,
    tickSize: 0.25,
    maxEntryBar: 150, // ~by noon on a 1m chart
    minRangeFrac: 0.0004,
    maxRangeFrac: 0.02,
    requireVwapAlign: true,
  };
}

export interface OrbSetup {
  sessionStartIdx: number;
  date: string; // ISO date of the session (UTC)
  direction: "long" | "short";
  orHigh: number;
  orLow: number;
  entryIdx: number;
  entry: number;
  stop: number;
  target: number;
  time: number; // unix seconds of the entry bar
}

/** Split a contiguous bar array into sessions on overnight/weekend gaps. */
export function splitSessions(bars: Bar[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  if (!bars.length) return out;
  let start = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i]!.time - bars[i - 1]!.time > 5 * 60) {
      out.push({ from: start, to: i - 1 });
      start = i;
    }
  }
  out.push({ from: start, to: bars.length - 1 });
  return out;
}

/** Session VWAP up to (and including) index j, using typical price × 1 (no volume on index bars). */
function sessionVwap(bars: Bar[], from: number, j: number): number {
  let sum = 0, n = 0;
  for (let i = from; i <= j; i++) {
    sum += (bars[i]!.high + bars[i]!.low + bars[i]!.close) / 3;
    n++;
  }
  return n ? sum / n : bars[j]!.close;
}

/** The ORB setup for each session (at most one — the first valid break). */
export function detectOrbSetups(bars: Bar[], cfgIn: Partial<OrbConfig> = {}): OrbSetup[] {
  const cfg = { ...defaultOrbConfig(), ...cfgIn };
  const setups: OrbSetup[] = [];

  for (const { from, to } of splitSessions(bars)) {
    const n = to - from + 1;
    if (n < cfg.openMinutes + 5) continue;

    // Opening range = first openMinutes bars of the session.
    let orHigh = -Infinity, orLow = Infinity;
    for (let i = from; i < from + cfg.openMinutes; i++) {
      orHigh = Math.max(orHigh, bars[i]!.high);
      orLow = Math.min(orLow, bars[i]!.low);
    }
    const width = orHigh - orLow;
    const ref = bars[from + cfg.openMinutes - 1]!.close;
    if (!(width > 0) || width < ref * cfg.minRangeFrac || width > ref * cfg.maxRangeFrac) continue;

    const buf = cfg.entryBufferTicks * cfg.tickSize;
    const lastEntry = Math.min(to, from + cfg.maxEntryBar);

    for (let i = from + cfg.openMinutes; i <= lastEntry; i++) {
      const b = bars[i]!;
      const brokeUp = b.close > orHigh + buf;
      const brokeDn = b.close < orLow - buf;
      if (!brokeUp && !brokeDn) continue;

      const direction: "long" | "short" = brokeUp ? "long" : "short";
      if (cfg.requireVwapAlign) {
        const v = sessionVwap(bars, from, i);
        if (direction === "long" && b.close < v) continue; // want break WITH VWAP
        if (direction === "short" && b.close > v) continue;
      }

      const entry = b.close;
      const stop = direction === "long" ? orLow : orHigh;
      const risk = Math.abs(entry - stop);
      if (risk <= 0) break;
      const target = direction === "long" ? entry + cfg.targetR * risk : entry - cfg.targetR * risk;

      setups.push({
        sessionStartIdx: from,
        date: new Date(bars[from]!.time * 1000).toISOString().slice(0, 10),
        direction,
        orHigh,
        orLow,
        entryIdx: i,
        entry,
        stop,
        target,
        time: b.time,
      });
      break; // one trade per session — the first valid break
    }
  }
  return setups;
}
