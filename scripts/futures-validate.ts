/**
 * Out-of-sample validation — run the FROZEN `safe` preset (tuned only on the
 * 2026-08-10 week) across several other weeks it never saw, with zero
 * re-tuning. This is the honest test: does the 71% win rate hold on data the
 * parameters were not fitted to?
 *
 *   npx tsx scripts/futures-validate.ts
 *
 * Reads per-week cash-index series from data/oos/<week-monday>/{SPX,NDX}.json
 * (native index shape). SPX → MES, NDX → MNQ.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { normalize } from "../src/signals/candles.js";
import { getContract } from "../src/signals/instruments.js";
import { runFutures, safePreset, type FuturesTrade } from "../src/signals/futuresStrategy.js";
import type { Bar } from "../src/signals/types.js";

const OOS = path.resolve("data/oos");
const RISK = Number(process.env.RISK_USD) || 250;
const INSAMPLE = "2026-08-10"; // the week the safe preset was tuned on
const MAP: Record<string, string> = { SPX: "MES", NDX: "MNQ" };

interface IdxBar { begins_at: string; open_value: string; high_value: string; low_value: string; close_value: string; interpolated?: boolean }

function toBars(raw: IdxBar[]): Bar[] {
  const bars: Bar[] = [];
  for (const r of raw) {
    if (r.interpolated) continue;
    const time = Math.floor(new Date(r.begins_at).getTime() / 1000);
    const o = +r.open_value, h = +r.high_value, l = +r.low_value, c = +r.close_value;
    if (![time, o, h, l, c].every(Number.isFinite)) continue;
    bars.push({ time, open: o, high: h, low: l, close: c, volume: 0 });
  }
  return normalize(bars);
}

interface WeekRow { wk: string; inSample: boolean; n: number; w: number; R: number; usd: number; pf: number }

function stat(trades: FuturesTrade[]) {
  const n = trades.length, w = trades.filter((t) => t.realizedR > 0).length;
  const R = trades.reduce((s, t) => s + t.realizedR, 0);
  const usd = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const gw = trades.filter((t) => t.realizedR > 0).reduce((s, t) => s + t.realizedR, 0);
  const gl = Math.abs(trades.filter((t) => t.realizedR <= 0).reduce((s, t) => s + t.realizedR, 0));
  return { n, w, R, usd, pf: gl > 0 ? gw / gl : Infinity };
}
const money = (n: number) => `${n >= 0 ? "+$" : "-$"}${Math.abs(n).toFixed(0)}`;

async function main() {
  const preset = safePreset();
  const weeks = (await readdir(OOS)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  console.log(`\n=== OUT-OF-SAMPLE VALIDATION — frozen "safe" preset, $${RISK}/trade ===`);
  console.log(`Preset tuned only on ${INSAMPLE}. Every other week below is unseen data, no re-tuning.\n`);
  console.log("week (Mon)    trades   win%     netR      net$     PF");
  console.log("─".repeat(60));

  const rows: WeekRow[] = [];
  const oos: FuturesTrade[] = [];
  for (const wk of weeks) {
    const weekTrades: FuturesTrade[] = [];
    for (const [sym, root] of Object.entries(MAP)) {
      let raw: { bars: IdxBar[] };
      try { raw = JSON.parse(await readFile(path.join(OOS, wk, `${sym}.json`), "utf-8")); } catch { continue; }
      const ltf = toBars(raw.bars);
      if (ltf.length < 300) continue;
      weekTrades.push(...runFutures(root, getContract(root)!, ltf, { engine: preset.engine, guard: preset.guard, riskUsd: RISK }));
    }
    const s = stat(weekTrades);
    const inSample = wk === INSAMPLE;
    if (!inSample) oos.push(...weekTrades);
    rows.push({ wk, inSample, ...s });
    const tag = inSample ? " (in-sample)" : "";
    const winPct = s.n ? (100 * s.w) / s.n : 0;
    console.log(
      `${wk}  ${String(s.n).padStart(5)}  ${winPct.toFixed(1).padStart(6)}%  ${(s.R >= 0 ? "+" : "") + s.R.toFixed(2).padStart(6)}R  ${money(s.usd).padStart(7)}  ${s.pf === Infinity ? "∞" : s.pf.toFixed(2)}${tag}`,
    );
  }

  console.log("─".repeat(60));
  const o = stat(oos);
  const oWin = o.n ? (100 * o.w) / o.n : 0;
  console.log(`OOS combined ${String(o.n).padStart(5)}  ${oWin.toFixed(1).padStart(6)}%  ${(o.R >= 0 ? "+" : "") + o.R.toFixed(2)}R  ${money(o.usd)}  PF ${o.pf === Infinity ? "∞" : o.pf.toFixed(2)}  (${weeks.length - 1} unseen weeks)`);
  console.log("─".repeat(60));
  const held = oWin >= 70;
  console.log(held
    ? `Out-of-sample win rate ${oWin.toFixed(1)}% — the 70% target HELD on unseen weeks.`
    : `Out-of-sample win rate ${oWin.toFixed(1)}% — BELOW the 70% in-sample figure. The tuning did`);
  if (!held) console.log("  not fully generalize; the in-sample 71% was partly luck/overfit. This is the honest result.");
  console.log("");
}

void main();
