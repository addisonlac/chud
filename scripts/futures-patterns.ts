/**
 * Pattern hit-rate report — for each named pattern, how often does it actually
 * work on the real data? Runs the recogniser across every week in data/oos
 * (SPX→MES, NDX→MNQ), gates each call to the 15-minute bias, simulates it to a
 * 1R-bank / breakeven-runner exit, and tallies per-pattern win rate, expectancy
 * and profit factor. This is how we tell which calls are "sure hits" — by
 * measuring them, not asserting them.
 *
 *   npx tsx scripts/futures-patterns.ts
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { aggregateBars, normalize } from "../src/signals/candles.js";
import { ema } from "../src/signals/indicators.js";
import { detectPatterns, type PatternHit, type PatternName } from "../src/signals/patterns.js";
import { resolveTrade } from "../src/signals/futuresStrategy.js";
import type { Bar, Signal } from "../src/signals/types.js";

const OOS = path.resolve("data/oos");
const SYMS = ["SPX", "NDX"];
const WARMUP = 240;

interface IdxBar { begins_at: string; open_value: string; high_value: string; low_value: string; close_value: string; interpolated?: boolean }
function toBars(raw: IdxBar[]): Bar[] {
  const bars: Bar[] = [];
  for (const r of raw) {
    if (r.interpolated) continue;
    const time = Math.floor(new Date(r.begins_at).getTime() / 1000);
    const o = +r.open_value, h = +r.high_value, l = +r.low_value, c = +r.close_value;
    if ([time, o, h, l, c].every(Number.isFinite)) bars.push({ time, open: o, high: h, low: l, close: c, volume: 0 });
  }
  return normalize(bars);
}

/** Completed-15m bias at time t: sign of (htf close − htf EMA) of the last closed 15m bar. */
function biasFn(ltf: Bar[]) {
  const htf = aggregateBars(ltf, 15);
  const emaS = ema(htf.map((b) => b.close), Math.min(50, Math.max(2, Math.floor(htf.length / 2))));
  return (t: number): "long" | "short" | "flat" => {
    let j = -1;
    for (let k = 0; k < htf.length; k++) { if (htf[k]!.time <= t) j = k; else break; }
    const c = j - 1; // last *completed* 15m bar
    if (c < 0 || emaS[c] == null) return "flat";
    return htf[c]!.close > emaS[c]! ? "long" : htf[c]!.close < emaS[c]! ? "short" : "flat";
  };
}

interface Tally { n: number; w: number; R: number; gw: number; gl: number }
const blank = (): Tally => ({ n: 0, w: 0, R: 0, gw: 0, gl: 0 });

function record(t: Tally, R: number) {
  t.n++; t.R += R;
  if (R > 0) { t.w++; t.gw += R; } else t.gl += Math.abs(R);
}

async function main() {
  const weeks = (await readdir(OOS)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const byPattern = new Map<PatternName, Tally>();
  const overall = blank();

  for (const wk of weeks) {
    for (const sym of SYMS) {
      let raw: { bars: IdxBar[] };
      try { raw = JSON.parse(await readFile(path.join(OOS, wk, `${sym}.json`), "utf-8")); } catch { continue; }
      const ltf = toBars(raw.bars);
      if (ltf.length < WARMUP + 30) continue;
      const bias = biasFn(ltf);
      const hits = detectPatterns(ltf).filter((h) => h.index >= WARMUP);
      for (const h of hits) {
        if (bias(h.time) !== h.direction) continue; // with-15m-bias only
        const risk = Math.abs(h.entry - h.stop);
        if (risk <= 0) continue;
        const dir = h.direction === "long" ? 1 : -1;
        const sig = { action: h.direction === "long" ? "BUY" : "SELL", entry: h.entry, stop: h.stop, targets: [h.entry + dir * risk, h.entry + dir * 2 * risk], entryType: "market" } as unknown as Signal;
        const r = resolveTrade(ltf, h.index, sig);
        if (!r) continue;
        const t = byPattern.get(h.name) ?? blank();
        record(t, r.R); byPattern.set(h.name, t);
        record(overall, r.R);
      }
    }
  }

  console.log("\n=== PATTERN HIT-RATE — real cash-index data, 15m-bias-gated, 1R-bank/BE-runner ===");
  console.log(`${weeks.length} weeks · SPX(MES) + NDX(MNQ) · a hit is scored independently (setup quality, not a portfolio)\n`);
  console.log("pattern              calls   win%    avg R    expectancy   PF");
  console.log("─".repeat(66));
  const order: PatternName[] = ["Sweep + MSS", "Equal-Level Raid", "Breaker Block", "Order Block Retest", "FVG Displacement", "Liquidity Sweep"];
  const rank = [...byPattern.entries()].sort((a, b) => (b[1].n ? b[1].w / b[1].n : 0) - (a[1].n ? a[1].w / a[1].n : 0));
  const rows = rank.length ? rank.map(([k]) => k) : order;
  for (const name of rows) {
    const t = byPattern.get(name); if (!t || !t.n) continue;
    const win = (100 * t.w) / t.n, avgR = t.R / t.n, pf = t.gl > 0 ? t.gw / t.gl : Infinity;
    const flag = win >= 65 && t.n >= 8 ? "  ★" : "";
    console.log(`${name.padEnd(20)} ${String(t.n).padStart(4)}  ${win.toFixed(1).padStart(5)}%  ${(avgR >= 0 ? "+" : "") + avgR.toFixed(2)}R   ${(avgR >= 0 ? "+" : "") + avgR.toFixed(2)}R/call   ${pf === Infinity ? "∞" : pf.toFixed(2)}${flag}`);
  }
  console.log("─".repeat(66));
  const win = overall.n ? (100 * overall.w) / overall.n : 0;
  console.log(`${"ALL".padEnd(20)} ${String(overall.n).padStart(4)}  ${win.toFixed(1).padStart(5)}%  ${(overall.R / Math.max(1, overall.n)).toFixed(2)}R/call            ${overall.gl > 0 ? (overall.gw / overall.gl).toFixed(2) : "∞"}`);
  console.log("─".repeat(66));
  console.log("★ = ≥65% win on ≥8 calls. Small samples — read as which setups look strongest here,");
  console.log("  not a guarantee. Widen the weeks before trusting any single pattern's number.\n");
}

void main();
