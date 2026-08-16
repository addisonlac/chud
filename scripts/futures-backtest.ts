/**
 * Futures backtest — runs the exact live engine on index-futures price series
 * (ES/MES on SPX, NQ/MNQ on NDX), sizes in whole contracts to a fixed dollar
 * risk, and reports results in R and in dollars.
 *
 *   npx tsx scripts/futures-backtest.ts            # default universe (MES, MNQ)
 *   RISK_USD=500 npx tsx scripts/futures-backtest.ts
 *   npx tsx scripts/futures-backtest.ts MES MNQ ES NQ
 *
 * Runs three configurations so the trade-offs are visible:
 *   • baseline — every in-session signal ≥ engine min confidence, no guard.
 *   • filtered — SessionGuard on (confidence floor, per-session cap, cooldown,
 *                two-loss lockout).
 *   • SAFE     — the win-rate/consistency preset (with-trend only, zone
 *                confluence, bank the first target at 1R, opening drive only).
 *
 * Walk is 1m bar-by-bar, 15m bias re-derived from only bars seen (no lookahead),
 * trades managed as the live signal intends (bank half at TP1, stop to BE,
 * runner to TP2). All logic lives in src/signals/futuresStrategy.ts.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FixtureProvider, FIXTURE_DIR } from "../src/data/stockData.js";
import { DEFAULT_RISK_USD } from "../src/signals/sizing.js";
import { getContract, DEFAULT_FUTURES_UNIVERSE } from "../src/signals/instruments.js";
import { runFutures, baselinePreset, filteredPreset, safePreset, type FuturesTrade, type Preset } from "../src/signals/futuresStrategy.js";
import type { Bar } from "../src/signals/types.js";

const RISK_USD = Number(process.env.RISK_USD) || DEFAULT_RISK_USD;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const usd = (n: number) => `${n >= 0 ? "+$" : "-$"}${Math.abs(n).toFixed(0)}`;

function report(label: string, byRoot: Map<string, FuturesTrade[]>) {
  const all: FuturesTrade[] = [];
  console.log(`\n── ${label} ──`);
  for (const [root, trades] of byRoot) {
    all.push(...trades);
    const r = trades.reduce((s, t) => s + t.realizedR, 0);
    const d = trades.reduce((s, t) => s + t.pnlUsd, 0);
    const w = trades.filter((t) => t.realizedR > 0).length;
    console.log(`  ${root.padEnd(4)} ${String(trades.length).padStart(3)} trades  ${String(w).padStart(2)}W/${String(trades.length - w).padStart(2)}L  net ${r >= 0 ? "+" : ""}${r.toFixed(2)}R  ${usd(d)}`);
  }
  if (all.length === 0) { console.log("  (no trades)"); return { trades: 0, win: 0, net: 0, usd: 0 }; }
  const wins = all.filter((t) => t.realizedR > 0);
  const netR = all.reduce((s, t) => s + t.realizedR, 0);
  const netUsd = all.reduce((s, t) => s + t.pnlUsd, 0);
  const gw = wins.reduce((s, t) => s + t.realizedR, 0);
  const gl = Math.abs(all.filter((t) => t.realizedR <= 0).reduce((s, t) => s + t.realizedR, 0));
  const winRate = wins.length / all.length;
  console.log(`  ── total: ${all.length} trades  win ${pct(winRate)}  net ${netR >= 0 ? "+" : ""}${netR.toFixed(2)}R  ${usd(netUsd)}  |  PF ${gl > 0 ? (gw / gl).toFixed(2) : "∞"}  expectancy ${(netR / all.length).toFixed(2)}R/trade`);
  return { trades: all.length, win: winRate, net: netR, usd: netUsd };
}

async function pickUniverse(argv: string[]): Promise<string[]> {
  if (argv.length > 0) return argv.map((s) => s.toUpperCase());
  try { return JSON.parse(await readFile(path.join(FIXTURE_DIR, "futures-universe.json"), "utf-8")) as string[]; }
  catch { return DEFAULT_FUTURES_UNIVERSE; }
}

async function runPreset(roots: string[], provider: FixtureProvider, preset: Preset): Promise<Map<string, FuturesTrade[]>> {
  const byRoot = new Map<string, FuturesTrade[]>();
  for (const root of roots) {
    const contract = getContract(root);
    if (!contract) { console.log(`  ${root}: unknown contract — skipped`); continue; }
    let ltf: Bar[];
    try { ({ ltf } = await provider.getSeries(contract.dataSymbol)); }
    catch { console.log(`  ${root}: no fixture for ${contract.dataSymbol} — run npm run futures:fixtures`); continue; }
    if (ltf.length === 0) { console.log(`  ${root}: empty series`); continue; }
    byRoot.set(root, runFutures(root, contract, ltf, { engine: preset.engine, guard: preset.guard, riskUsd: RISK_USD }));
  }
  return byRoot;
}

async function main() {
  const roots = await pickUniverse(process.argv.slice(2));
  console.log("\n=== FUTURES backtest — 1m entry / 15m bias, index-futures (real cash-index data) ===");
  console.log(`Risk/trade: $${RISK_USD}   Universe: ${roots.join(", ")}`);

  const provider = new FixtureProvider();
  const b = report("BASELINE  (every in-session signal ≥60% conf, no guard)", await runPreset(roots, provider, baselinePreset()));
  const f = report("FILTERED  (SessionGuard: ≥70% conf, ≤3/session, cooldown, 2-loss lockout)", await runPreset(roots, provider, filteredPreset()));
  const safeTrades = await runPreset(roots, provider, safePreset());
  const s = report("SAFE      (with-trend + zone confluence + bank 1R + opening drive, 1-loss lockout)", safeTrades);

  console.log("\n─────────────────────────────────────────────");
  console.log(`  win rate:   baseline ${pct(b.win)}  →  filtered ${pct(f.win)}  →  SAFE ${pct(s.win)}`);
  console.log(`  net:        baseline ${b.net.toFixed(1)}R ${usd(b.usd)}  →  SAFE ${s.net.toFixed(1)}R ${usd(s.usd)} (fewer, higher-quality trades)`);
  console.log("  SAFE is tuned IN-SAMPLE on this week for win rate; validate on other weeks before trusting it.");
  console.log("─────────────────────────────────────────────");

  const samples: FuturesTrade[] = [...safeTrades.values()].flat();
  if (samples.length) {
    console.log("\nSAFE preset — every trade:");
    samples.sort((a, b) => a.entryTime - b.entryTime).forEach((t) => {
      const when = new Date(t.entryTime * 1000).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
      console.log(`  ${when} ET  ${t.root} ${t.action.padEnd(4)} ${String(t.contracts).padStart(2)}c  conf ${pct(t.confidence)}  ${t.trigger.padEnd(19)} → ${t.exit.padEnd(12)} ${t.realizedR >= 0 ? "+" : ""}${t.realizedR.toFixed(2)}R  ${usd(t.pnlUsd)}`);
    });
  }
  console.log("");
}

void main();
