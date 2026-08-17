/**
 * Opening Range Breakout backtest — AFTER COSTS, on real cash-index minute data.
 *
 *   npx tsx scripts/orb-backtest.ts                 # MES + MNQ, all data/oos weeks
 *   ORB_OPEN=30 ORB_TARGET=2.5 npx tsx scripts/orb-backtest.ts
 *   npx tsx scripts/orb-backtest.ts MES MNQ ES NQ
 *
 * Every trade pays commission + slippage per contract, so the numbers are net of
 * the costs that quietly kill tight-stop scalps. ORB uses a range-width stop, so
 * contract size is small and costs are a small % of the move.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { normalize } from "../src/signals/candles.js";
import { detectOrbSetups, splitSessions, defaultOrbConfig, type OrbSetup } from "../src/signals/orb.js";
import { getContract, DEFAULT_FUTURES_UNIVERSE } from "../src/signals/instruments.js";
import type { Bar } from "../src/signals/types.js";

const OOS = path.resolve("data/oos");
const SYM_FOR: Record<string, string> = { MES: "SPX", ES: "SPX", MNQ: "NDX", NQ: "NDX" };
const RISK = Number(process.env.RISK_USD) || 250;
const COMMISSION_RT = Number(process.env.ORB_COMMISSION_RT) || 1.24; // $/contract round trip
const SLIPPAGE_TICKS = Number(process.env.ORB_SLIPPAGE_TICKS ?? 1); // ticks per side

const cfg = {
  ...defaultOrbConfig(),
  openMinutes: Number(process.env.ORB_OPEN) || 15,
  targetR: Number(process.env.ORB_TARGET) || 2,
};

interface IdxBar { begins_at: string; open_value: string; high_value: string; low_value: string; close_value: string; interpolated?: boolean }
function toBars(raw: IdxBar[]): Bar[] {
  const bars: Bar[] = [];
  for (const r of raw) {
    if (r.interpolated) continue;
    const t = Math.floor(new Date(r.begins_at).getTime() / 1000);
    const o = +r.open_value, h = +r.high_value, l = +r.low_value, c = +r.close_value;
    if ([t, o, h, l, c].every(Number.isFinite)) bars.push({ time: t, open: o, high: h, low: l, close: c, volume: 0 });
  }
  return normalize(bars);
}

interface Trade { root: string; date: string; dir: string; grossR: number; netUsd: number; contracts: number; exit: string }

function sessionEnd(bars: Bar[], entryIdx: number): number {
  for (const s of splitSessions(bars)) if (entryIdx >= s.from && entryIdx <= s.to) return s.to;
  return bars.length - 1;
}

function simulate(bars: Bar[], su: OrbSetup, contract: { pointValue: number; tickValue: number }): Trade {
  const isLong = su.direction === "long";
  const risk = Math.abs(su.entry - su.stop);
  const rOf = (p: number) => (isLong ? p - su.entry : su.entry - p) / risk;
  const end = sessionEnd(bars, su.entryIdx);
  const contracts = Math.max(1, Math.floor(RISK / (risk * contract.pointValue)));
  const actualRiskUsd = contracts * risk * contract.pointValue;
  const costUsd = contracts * (COMMISSION_RT + 2 * SLIPPAGE_TICKS * contract.tickValue);

  let grossR = rOf(bars[end]!.close), exit = "close";
  for (let j = su.entryIdx + 1; j <= end; j++) {
    const b = bars[j]!;
    const hitStop = isLong ? b.low <= su.stop : b.high >= su.stop;
    const hitTgt = isLong ? b.high >= su.target : b.low <= su.target;
    if (hitStop && hitTgt) { grossR = rOf(su.stop); exit = "stop"; break; } // worst-case same bar
    if (hitStop) { grossR = rOf(su.stop); exit = "stop"; break; }
    if (hitTgt) { grossR = rOf(su.target); exit = "target"; break; }
  }
  const netUsd = grossR * actualRiskUsd - costUsd;
  return { root: "", date: su.date, dir: su.direction, grossR, netUsd, contracts, exit };
}

function report(label: string, trades: Trade[]) {
  if (!trades.length) { console.log(`  ${label}: no trades`); return; }
  const wins = trades.filter((t) => t.netUsd > 0);
  const losses = trades.filter((t) => t.netUsd <= 0);
  const netUsd = trades.reduce((s, t) => s + t.netUsd, 0);
  const grossR = trades.reduce((s, t) => s + t.grossR, 0);
  const avgWinR = wins.length ? wins.reduce((s, t) => s + t.grossR, 0) / wins.length : 0;
  const avgLossR = losses.length ? losses.reduce((s, t) => s + t.grossR, 0) / losses.length : 0;
  const gw = wins.reduce((s, t) => s + t.netUsd, 0), gl = Math.abs(losses.reduce((s, t) => s + t.netUsd, 0));
  console.log(
    `  ${label.padEnd(6)} ${String(trades.length).padStart(3)} trades  win ${((100 * wins.length) / trades.length).toFixed(1)}%  ` +
      `avgWin ${avgWinR.toFixed(2)}R avgLoss ${avgLossR.toFixed(2)}R  net ${netUsd >= 0 ? "+$" : "-$"}${Math.abs(netUsd).toFixed(0)}  ` +
      `grossR ${grossR >= 0 ? "+" : ""}${grossR.toFixed(1)}  PF ${gl > 0 ? (gw / gl).toFixed(2) : "∞"}`,
  );
}

async function main() {
  const roots = process.argv.slice(2).filter((a) => !a.startsWith("--")).map((s) => s.toUpperCase());
  const universe = roots.length ? roots : DEFAULT_FUTURES_UNIVERSE;
  const weeks = (await readdir(OOS)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();

  console.log(`\n=== ORB backtest — AFTER COSTS — ${cfg.openMinutes}m range, ${cfg.targetR}R target ===`);
  console.log(`Risk $${RISK}/trade · commission $${COMMISSION_RT} rt/contract · slippage ${SLIPPAGE_TICKS} tick/side · VWAP filter ${cfg.requireVwapAlign ? "on" : "off"}`);
  console.log(`Data: ${weeks.length} weeks of real cash-index minute bars\n`);

  const all: Trade[] = [];
  for (const root of universe) {
    const contract = getContract(root);
    const sym = SYM_FOR[root];
    if (!contract || !sym) { console.log(`  ${root}: unknown`); continue; }
    const rootTrades: Trade[] = [];
    for (const wk of weeks) {
      let raw: { bars: IdxBar[] };
      try { raw = JSON.parse(await readFile(path.join(OOS, wk, `${sym}.json`), "utf-8")); } catch { continue; }
      const bars = toBars(raw.bars);
      for (const su of detectOrbSetups(bars, cfg)) {
        const t = simulate(bars, su, contract);
        t.root = root; rootTrades.push(t); all.push(t);
      }
    }
    report(root, rootTrades);
  }
  console.log("  ─────────────────────────────────────────────");
  report("ALL", all);
  const netUsd = all.reduce((s, t) => s + t.netUsd, 0);
  const wins = all.filter((t) => t.netUsd > 0).length;
  console.log("  ─────────────────────────────────────────────");
  console.log(`  Net after costs: ${netUsd >= 0 ? "+$" : "-$"}${Math.abs(netUsd).toFixed(0)} over ${all.length} trades (${weeks.length} weeks, ${universe.join("+")}), win ${((100 * wins) / Math.max(1, all.length)).toFixed(1)}%.`);
  console.log("  One trade/session, range-width stop → small size → costs ~a few % of risk. Small sample; widen before trusting.\n");
}

void main();
