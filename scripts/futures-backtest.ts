/**
 * Futures backtest — runs the exact live engine on index-futures price series
 * (ES/MES on SPX, NQ/MNQ on NDX), sizes in whole contracts to a fixed dollar
 * risk, and reports results in R and in dollars.
 *
 *   npx tsx scripts/futures-backtest.ts            # default universe (MES, MNQ)
 *   RISK_USD=500 npx tsx scripts/futures-backtest.ts
 *   npx tsx scripts/futures-backtest.ts MES MNQ ES NQ
 *
 * It runs TWO configurations back to back so the effect of the discipline layer
 * is visible:
 *   • baseline  — every in-session signal ≥ engine min confidence, no guard.
 *   • filtered  — SessionGuard on: confidence floor, per-session trade cap,
 *                 post-loss cooldown, and a two-loss-in-a-row daily lockout.
 *
 * Walk is 1m bar-by-bar, 15m bias re-derived from only the bars seen (no
 * lookahead), trades managed exactly as the live signal intends (bank half at
 * TP1, stop to breakeven, runner to TP2).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FixtureProvider, FIXTURE_DIR } from "../src/data/stockData.js";
import { aggregateBars } from "../src/signals/candles.js";
import { analyze, defaultEngineConfig } from "../src/signals/engine.js";
import { sizeContracts, DEFAULT_RISK_USD } from "../src/signals/sizing.js";
import { getContract, DEFAULT_FUTURES_UNIVERSE, type FuturesContract } from "../src/signals/instruments.js";
import { SessionGuard, defaultGuardConfig } from "../src/signals/sessionGuard.js";
import type { Bar, Signal } from "../src/signals/types.js";

const WARMUP = 240, MAX_HOLD = 120, FILL_WINDOW = 15;
const RISK_USD = Number(process.env.RISK_USD) || DEFAULT_RISK_USD;

interface Trade {
  root: string;
  action: "BUY" | "SELL";
  confidence: number;
  entryTime: number;
  contracts: number;
  realizedR: number;
  pnlUsd: number;
  exit: string;
}

function resolve(bars: Bar[], idx: number, sig: Signal): { R: number; exit: string; resume: number } | null {
  if (sig.entry == null || sig.stop == null || !sig.targets.length) return null;
  const isLong = sig.action === "BUY", entry = sig.entry, stop = sig.stop, tp1 = sig.targets[0]!, tp2 = sig.targets[1] ?? tp1;
  const risk = Math.abs(entry - stop); if (risk <= 0) return null;
  const rOf = (p: number) => (isLong ? p - entry : entry - p) / risk;
  let fill = idx;
  if (sig.entryType === "limit") {
    fill = -1; const e = Math.min(idx + FILL_WINDOW, bars.length - 1);
    for (let j = idx + 1; j <= e; j++) { const b = bars[j]!; if (b.low <= entry && entry <= b.high) { fill = j; break; } }
    if (fill < 0) return null;
  }
  const end = Math.min(fill + MAX_HOLD, bars.length - 1); let sN = stop, partial = false;
  for (let j = fill + 1; j <= end; j++) {
    const b = bars[j]!; const hs = isLong ? b.low <= sN : b.high >= sN; const h1 = isLong ? b.high >= tp1 : b.low <= tp1; const h2 = isLong ? b.high >= tp2 : b.low <= tp2;
    if (!partial) {
      if (hs) return { R: rOf(sN), exit: "stop", resume: j };
      if (h1) { partial = true; sN = entry; if (h2) return { R: 0.5 * rOf(tp1) + 0.5 * rOf(tp2), exit: "target", resume: j }; continue; }
    } else {
      if (h2) return { R: 0.5 * rOf(tp1) + 0.5 * rOf(tp2), exit: "target", resume: j };
      if (hs) return { R: 0.5 * rOf(tp1), exit: "partial(BE)", resume: j };
    }
  }
  const cR = rOf(bars[end]!.close);
  return { R: partial ? 0.5 * rOf(tp1) + 0.5 * Math.max(0, cR) : cR, exit: partial ? "timeout" : "timeout", resume: end };
}

function walk(root: string, contract: FuturesContract, ltf: Bar[], useGuard: boolean): Trade[] {
  const trades: Trade[] = [];
  const cfg = defaultEngineConfig();
  const guard = useGuard ? new SessionGuard(defaultGuardConfig()) : null;
  let i = WARMUP;
  while (i < ltf.length - 1) {
    const seen = ltf.slice(0, i + 1);
    const sig = analyze(root, seen, aggregateBars(seen, 15), cfg);
    if (sig.action !== "WAIT") {
      const size = sizeContracts(sig, contract, RISK_USD);
      if (size.contracts > 0) {
        const gate = guard ? guard.canEnter(sig.generatedAt, i, sig.confidence) : { ok: true };
        if (gate.ok) {
          const r = resolve(ltf, i, sig);
          if (r) {
            const pnlUsd = r.R * size.riskUsd;
            trades.push({ root, action: sig.action as "BUY" | "SELL", confidence: sig.confidence, entryTime: sig.generatedAt, contracts: size.contracts, realizedR: r.R, pnlUsd, exit: r.exit });
            guard?.record(sig.generatedAt, i, r.R);
            i = Math.max(i + 1, r.resume + 1);
            continue;
          }
        }
      }
    }
    i++;
  }
  return trades;
}

function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }
function usd(n: number): string { return `${n >= 0 ? "+$" : "-$"}${Math.abs(n).toFixed(0)}`; }

function report(mode: string, byRoot: Map<string, Trade[]>) {
  const all: Trade[] = [];
  console.log(`\n── ${mode} ──`);
  for (const [root, trades] of byRoot) {
    all.push(...trades);
    const r = trades.reduce((s, t) => s + t.realizedR, 0);
    const d = trades.reduce((s, t) => s + t.pnlUsd, 0);
    const w = trades.filter((t) => t.realizedR > 0).length;
    console.log(`  ${root.padEnd(4)} ${String(trades.length).padStart(3)} trades  ${String(w).padStart(2)}W/${String(trades.length - w).padStart(2)}L  net ${r >= 0 ? "+" : ""}${r.toFixed(2)}R  ${usd(d)}`);
  }
  if (all.length === 0) { console.log("  (no trades)"); return { trades: 0, net: 0, usd: 0 }; }
  const wins = all.filter((t) => t.realizedR > 0);
  const netR = all.reduce((s, t) => s + t.realizedR, 0);
  const netUsd = all.reduce((s, t) => s + t.pnlUsd, 0);
  const gw = wins.reduce((s, t) => s + t.realizedR, 0);
  const gl = Math.abs(all.filter((t) => t.realizedR <= 0).reduce((s, t) => s + t.realizedR, 0));
  console.log(`  ── total: ${all.length} trades  win ${pct(wins.length / all.length)}  net ${netR >= 0 ? "+" : ""}${netR.toFixed(2)}R  ${usd(netUsd)}  |  PF ${gl > 0 ? (gw / gl).toFixed(2) : "∞"}  expectancy ${(netR / all.length).toFixed(2)}R/trade`);
  return { trades: all.length, net: netR, usd: netUsd };
}

async function pickUniverse(argv: string[]): Promise<string[]> {
  if (argv.length > 0) return argv.map((s) => s.toUpperCase());
  try {
    return JSON.parse(await readFile(path.join(FIXTURE_DIR, "futures-universe.json"), "utf-8")) as string[];
  } catch {
    return DEFAULT_FUTURES_UNIVERSE;
  }
}

async function main() {
  const roots = await pickUniverse(process.argv.slice(2));
  console.log("\n=== FUTURES backtest — 1m entry / 15m bias, index-futures (real cash-index data) ===");
  console.log(`Risk/trade: $${RISK_USD}   Universe: ${roots.join(", ")}`);

  const provider = new FixtureProvider();
  const base = new Map<string, Trade[]>();
  const filt = new Map<string, Trade[]>();
  const samples: Trade[] = [];

  for (const root of roots) {
    const contract = getContract(root);
    if (!contract) { console.log(`  ${root}: unknown contract — skipped`); continue; }
    let ltf: Bar[];
    try { ({ ltf } = await provider.getSeries(contract.dataSymbol)); }
    catch { console.log(`  ${root}: no fixture for ${contract.dataSymbol} — run build-futures-fixtures`); continue; }
    if (ltf.length === 0) { console.log(`  ${root}: empty series`); continue; }
    base.set(root, walk(root, contract, ltf, false));
    const f = walk(root, contract, ltf, true);
    filt.set(root, f);
    samples.push(...f);
  }

  const b = report("BASELINE  (every in-session signal ≥60% conf, no guard)", base);
  const g = report("FILTERED  (SessionGuard: ≥70% conf, ≤3/session, 15-bar cooldown, 2-loss lockout)", filt);

  console.log("\n─────────────────────────────────────────────");
  console.log(`  Discipline layer effect:  ${b.net >= 0 ? "+" : ""}${b.net.toFixed(2)}R (${usd(b.usd)}) → ${g.net >= 0 ? "+" : ""}${g.net.toFixed(2)}R (${usd(g.usd)})`);
  console.log("  Real cash-index minute data, this week, no lookahead. One week on 2 names is a");
  console.log("  demonstration, not proof of a durable edge — widen the window before trusting it.");
  console.log("─────────────────────────────────────────────");

  if (samples.length > 0) {
    console.log("\nSample FILTERED trades (highest confidence):");
    [...samples].sort((a, b) => b.confidence - a.confidence).slice(0, 8).forEach((t) => {
      const when = new Date(t.entryTime * 1000).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
      console.log(`  ${when} ET  ${t.root} ${t.action.padEnd(4)} ${t.contracts}c  conf ${pct(t.confidence)}  → ${t.exit.padEnd(12)} ${t.realizedR >= 0 ? "+" : ""}${t.realizedR.toFixed(2)}R  ${usd(t.pnlUsd)}`);
    });
  }
  console.log("");
}

void main();
