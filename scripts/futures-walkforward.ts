/**
 * Walk-forward evaluation — the honest way to "keep improving" without fooling
 * ourselves. For each forward week, pick the preset using ONLY the weeks before
 * it, then trade the forward week with that choice. We never select a preset on
 * the week we score. The aggregate of the forward weeks is a realistic estimate
 * of how the system would have performed live as it adapted.
 *
 *   npx tsx scripts/futures-walkforward.ts
 *
 * Reads data/oos/<week-monday>/{SPX,NDX}.json (SPX→MES, NDX→MNQ).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { normalize } from "../src/signals/candles.js";
import { getContract } from "../src/signals/instruments.js";
import { runFutures, filteredPreset, safePreset, type FuturesTrade, type Preset } from "../src/signals/futuresStrategy.js";
import type { EngineConfig } from "../src/signals/engine.js";
import type { SessionConfig } from "../src/signals/session.js";
import type { GuardConfig } from "../src/signals/sessionGuard.js";
import type { Bar } from "../src/signals/types.js";

const OOS = path.resolve("data/oos");
const RISK = Number(process.env.RISK_USD) || 250;
const MAP: Record<string, string> = { SPX: "MES", NDX: "MNQ" };

function win(start: string, end: string): SessionConfig {
  return { enabled: true, timezone: "America/New_York", weekdays: [1, 2, 3, 4, 5], windows: [{ start, end, label: "NY" }] };
}
function guard(minConf: number, cap: number, consec: number, cooldown: number): GuardConfig {
  return { minConfidence: minConf, maxTradesPerSession: cap, maxConsecutiveLosses: consec, cooldownBarsAfterLoss: cooldown, timezone: "America/New_York" };
}

// A compact ladder the walk-forward chooses from each step.
const LADDER: Preset[] = [
  filteredPreset(),
  { name: "mid", engine: { minConfidence: 0.8, requireBiasAligned: true, requireZoneConfluence: true, tp1MinR: 1.0, tp1MaxR: 1.0, minRiskReward: 1.0, session: win("09:30", "11:00") } as Partial<EngineConfig>, guard: guard(0.8, 3, 2, 15) },
  safePreset(),
];

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

function stat(ts: FuturesTrade[]) {
  const n = ts.length, w = ts.filter((t) => t.realizedR > 0).length;
  const R = ts.reduce((s, t) => s + t.realizedR, 0), usd = ts.reduce((s, t) => s + t.pnlUsd, 0);
  const gw = ts.filter((t) => t.realizedR > 0).reduce((s, t) => s + t.realizedR, 0);
  const gl = Math.abs(ts.filter((t) => t.realizedR <= 0).reduce((s, t) => s + t.realizedR, 0));
  return { n, w, winPct: n ? (100 * w) / n : 0, R, usd, pf: gl > 0 ? gw / gl : Infinity, exp: n ? R / n : 0 };
}
const money = (n: number) => `${n >= 0 ? "+$" : "-$"}${Math.abs(n).toFixed(0)}`;

async function main() {
  const weeks = (await readdir(OOS)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  // Load each week's 1m series once.
  const series = new Map<string, Bar[]>(); // key `${week}:${root}`
  for (const wk of weeks) {
    for (const [sym, root] of Object.entries(MAP)) {
      try {
        const raw = JSON.parse(await readFile(path.join(OOS, wk, `${sym}.json`), "utf-8")) as { bars: IdxBar[] };
        series.set(`${wk}:${root}`, toBars(raw.bars));
      } catch { /* skip */ }
    }
  }

  // Precompute trades for every (preset, week).
  const cache = new Map<string, FuturesTrade[]>(); // `${presetName}:${week}`
  for (const p of LADDER) {
    for (const wk of weeks) {
      const ts: FuturesTrade[] = [];
      for (const [, root] of Object.entries(MAP)) {
        const ltf = series.get(`${wk}:${root}`);
        if (ltf && ltf.length > 300) ts.push(...runFutures(root, getContract(root)!, ltf, { engine: p.engine, guard: p.guard, riskUsd: RISK }));
      }
      cache.set(`${p.name}:${wk}`, ts);
    }
  }

  console.log(`\n=== WALK-FORWARD — pick preset on PAST weeks only, trade the next ($${RISK}/trade) ===`);
  console.log("Ladder:", LADDER.map((p) => p.name).join(", "), "\n");
  console.log("forward week   chosen(on past)   trades  win%    netR     net$");
  console.log("─".repeat(66));

  const forward: FuturesTrade[] = [];
  for (let i = 1; i < weeks.length; i++) {
    const train = weeks.slice(0, i);
    // choose preset with best expectancy over training weeks (≥6 trades, else prefer 'safe')
    let best = LADDER[0]!, bestExp = -Infinity, bestN = 0;
    for (const p of LADDER) {
      const tr = train.flatMap((wk) => cache.get(`${p.name}:${wk}`) ?? []);
      const s = stat(tr);
      if (s.n >= 6 && s.exp > bestExp) { bestExp = s.exp; best = p; bestN = s.n; }
    }
    if (bestN === 0) best = safePreset();
    const fwd = cache.get(`${best.name}:${weeks[i]!}`) ?? [];
    forward.push(...fwd);
    const s = stat(fwd);
    console.log(`${weeks[i]}   ${best.name.padEnd(15)}  ${String(s.n).padStart(5)}  ${s.winPct.toFixed(0).padStart(4)}%  ${(s.R >= 0 ? "+" : "") + s.R.toFixed(2).padStart(6)}R  ${money(s.usd).padStart(7)}`);
  }
  console.log("─".repeat(66));
  const s = stat(forward);
  console.log(`FORWARD total  ${String(s.n).padStart(19)}  ${s.winPct.toFixed(1)}%  ${(s.R >= 0 ? "+" : "") + s.R.toFixed(2)}R  ${money(s.usd)}  PF ${s.pf === Infinity ? "∞" : s.pf.toFixed(2)}  exp ${s.exp.toFixed(2)}R`);
  console.log("─".repeat(66));
  console.log("Every forward week was scored with a preset chosen only from earlier weeks —");
  console.log("no peeking. This is the number to trust over any single in-sample result.\n");
}

void main();
