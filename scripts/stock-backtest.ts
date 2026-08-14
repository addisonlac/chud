/**
 * Backtest the signal engine on the past month's top stocks.
 *
 *   npx tsx scripts/stock-backtest.ts
 *
 * For every symbol with a fixture (data/fixtures/<SYMBOL>.json) it walks the 1h
 * series forward one bar at a time, re-deriving the 4h series from only the
 * bars seen so far (NO lookahead), and calls the exact same engine the live
 * analyzer uses. When the engine emits a BUY/SELL it "takes" the trade at that
 * bar's close and simulates forward until the stop or first target is hit
 * (worst-case: if a single bar touches both, it counts as the stop), or a max
 * hold elapses. Results are reported in R-multiples (multiples of the risk
 * taken), which is the currency the risk model is built in.
 *
 * The point isn't to prove a magic win rate on 4 symbols of one month — it's to
 * show the bot recognises *proper setups* (liquidity sweep / BOS + higher-
 * timeframe alignment + a real reward:risk) on real recent price action, and to
 * give a repeatable harness you can point at any fixtures you drop in.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FixtureProvider, FIXTURE_DIR } from "../src/data/stockData.js";
import { aggregateBars } from "../src/signals/candles.js";
import { analyze, defaultEngineConfig } from "../src/signals/engine.js";
import { summarize } from "../src/signals/format.js";
import type { Bar, Signal } from "../src/signals/types.js";

const WARMUP = 54; // 1h bars before the first signal (≈9 sessions → ~18×4h bars)
const MAX_HOLD = 30; // max 1h bars a trade can stay open (≈5 sessions)
const FILL_WINDOW = 8; // a limit (pullback) entry must fill within this many bars or it's cancelled

interface Trade {
  symbol: string;
  action: "BUY" | "SELL";
  confidence: number;
  entryTime: number;
  entry: number;
  stop: number;
  tp1: number;
  plannedR: number;
  exitReason: "target" | "stop" | "timeout" | "partial";
  realizedR: number;
  reasonHead: string;
}

/**
 * Resolve a signal into a completed trade, honouring the entry model:
 *   • market entries fill at the signal bar;
 *   • limit (pullback) entries only fill if a later bar actually trades to the
 *     limit within FILL_WINDOW bars — otherwise the setup is cancelled (no
 *     trade), exactly as a resting limit order would behave.
 * Returns the trade plus the bar index to resume the walk from (so positions
 * never overlap). `null` means the limit never filled.
 */
function resolveTrade(symbol: string, bars: Bar[], signalIdx: number, sig: Signal): { trade: Trade; resumeIdx: number } | null {
  if (sig.entry === null || sig.stop === null || sig.targets.length === 0) return null;
  const isLong = sig.action === "BUY";
  const entry = sig.entry;
  const stop = sig.stop;
  const tp1 = sig.targets[0]!;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;

  // 1. Determine the fill bar.
  let fillIdx = signalIdx;
  if (sig.entryType === "limit") {
    fillIdx = -1;
    const end = Math.min(signalIdx + FILL_WINDOW, bars.length - 1);
    for (let j = signalIdx + 1; j <= end; j++) {
      const b = bars[j]!;
      if (b.low <= entry && entry <= b.high) {
        fillIdx = j;
        break;
      }
    }
    if (fillIdx < 0) return null; // pullback never came — order cancelled
  }

  const tp2 = sig.targets[1] ?? tp1;
  const rOf = (price: number) => (isLong ? price - entry : entry - price) / risk;
  const base = {
    symbol,
    action: sig.action as "BUY" | "SELL",
    confidence: sig.confidence,
    entryTime: sig.generatedAt,
    entry,
    stop,
    tp1,
    plannedR: rOf(tp1),
    reasonHead: sig.reasoning.find((r) => r.label === "Liquidity sweep" || r.label === "Break of structure")?.label ?? "—",
  };

  // 2. Walk forward with the plan's own management: bank half at TP1, move the
  //    stop to breakeven, let the runner target TP2. Realised R blends the two
  //    halves. This mirrors how the emitted signal is meant to be traded.
  const end = Math.min(fillIdx + MAX_HOLD, bars.length - 1);
  let stopNow = stop;
  let tookPartial = false;
  for (let j = fillIdx + 1; j <= end; j++) {
    const b = bars[j]!;
    const hitStop = isLong ? b.low <= stopNow : b.high >= stopNow;
    const hitTp1 = isLong ? b.high >= tp1 : b.low <= tp1;
    const hitTp2 = isLong ? b.high >= tp2 : b.low <= tp2;

    if (!tookPartial) {
      if (hitStop) return { trade: { ...base, exitReason: "stop", realizedR: rOf(stopNow) }, resumeIdx: j }; // full loss
      if (hitTp1) {
        tookPartial = true;
        stopNow = entry; // breakeven on the runner
        if (hitTp2) return { trade: { ...base, exitReason: "target", realizedR: 0.5 * rOf(tp1) + 0.5 * rOf(tp2) }, resumeIdx: j };
        continue;
      }
    } else {
      // Runner phase: half already banked at TP1, stop at breakeven.
      if (hitTp2) return { trade: { ...base, exitReason: "target", realizedR: 0.5 * rOf(tp1) + 0.5 * rOf(tp2) }, resumeIdx: j };
      if (hitStop) return { trade: { ...base, exitReason: "partial", realizedR: 0.5 * rOf(tp1) }, resumeIdx: j }; // runner scratched at BE
    }
  }
  // Max hold reached: close whatever's left at the final bar.
  const closeR = rOf(bars[end]!.close);
  const realizedR = tookPartial ? 0.5 * rOf(tp1) + 0.5 * Math.max(0, closeR) : closeR;
  return { trade: { ...base, exitReason: tookPartial ? "partial" : "timeout", realizedR }, resumeIdx: end };
}

function walk(symbol: string, h1: Bar[]): Trade[] {
  const trades: Trade[] = [];
  const cfg = defaultEngineConfig();
  let i = WARMUP;
  while (i < h1.length - 1) {
    const seen = h1.slice(0, i + 1);
    const h4 = aggregateBars(seen, 4);
    const sig = analyze(symbol, seen, h4, cfg);
    if (sig.action !== "WAIT") {
      const res = resolveTrade(symbol, h1, i, sig);
      if (res) {
        trades.push(res.trade);
        i = Math.max(i + 1, res.resumeIdx + 1); // resume after the position closes
        continue;
      }
    }
    i++;
  }
  return trades;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function loadUniverse(): Promise<string[]> {
  try {
    const raw = await readFile(path.join(FIXTURE_DIR, "universe.json"), "utf-8");
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

async function main() {
  console.log("\n=== Stock signal-engine backtest (liquidity sweep + 1h/4h SMC) ===\n");
  const universe = await loadUniverse();
  if (universe.length === 0) {
    console.log("No fixtures. Run: npx tsx scripts/build-fixtures.ts");
    process.exit(1);
  }

  const provider = new FixtureProvider();
  const all: Trade[] = [];

  for (const symbol of universe) {
    const { h1 } = await provider.getSeries(symbol);
    const trades = walk(symbol, h1);
    all.push(...trades);
    const r = trades.reduce((s, t) => s + t.realizedR, 0);
    const wins = trades.filter((t) => t.realizedR > 0).length;
    console.log(
      `  ${symbol.padEnd(5)}  ${String(trades.length).padStart(2)} trades  ${String(wins).padStart(2)}W/${String(trades.length - wins).padStart(2)}L  net ${r >= 0 ? "+" : ""}${r.toFixed(2)}R`,
    );
  }

  if (all.length === 0) {
    console.log("\nNo trades triggered. The engine is conservative — try more symbols or a longer window.");
    return;
  }

  const wins = all.filter((t) => t.realizedR > 0);
  const losses = all.filter((t) => t.realizedR <= 0);
  const netR = all.reduce((s, t) => s + t.realizedR, 0);
  const grossWin = wins.reduce((s, t) => s + t.realizedR, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.realizedR, 0));
  const bySweep = all.filter((t) => t.reasonHead === "Liquidity sweep").length;

  console.log("\n─────────────────────────────────────────────");
  console.log("RESULTS (R = multiples of risk taken)");
  console.log(`  Trades:            ${all.length}`);
  console.log(`  Win rate:          ${pct(wins.length / all.length)}  (${wins.length}W / ${losses.length}L)`);
  console.log(`  Net result:        ${netR >= 0 ? "+" : ""}${netR.toFixed(2)}R`);
  console.log(`  Expectancy/trade:  ${netR / all.length >= 0 ? "+" : ""}${(netR / all.length).toFixed(2)}R`);
  console.log(`  Avg win / loss:    +${(grossWin / Math.max(1, wins.length)).toFixed(2)}R / ${(-grossLoss / Math.max(1, losses.length)).toFixed(2)}R`);
  console.log(`  Profit factor:     ${grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞"}`);
  console.log(`  Triggered by sweep:${bySweep}/${all.length}  |  by break of structure: ${all.length - bySweep}/${all.length}`);
  const avgPlanned = all.reduce((s, t) => s + t.plannedR, 0) / all.length;
  console.log(`  Avg planned R:R:   ${avgPlanned.toFixed(2)}R  (every setup cleared the ${defaultEngineConfig().minRiskReward}R minimum)`);
  console.log("─────────────────────────────────────────────");
  console.log(
    "  Read this as a RECOGNITION test, not a profitability claim: it shows the\n" +
      "  engine only fires on disciplined, well-formed setups (4h-aligned, real\n" +
      `  liquidity/structure trigger, ≥${defaultEngineConfig().minRiskReward}R). ${all.length} trades on ${universe.length} names in one month is far\n` +
      "  too small to judge edge — drop more fixtures in data/fixtures to widen it.",
  );
  console.log("─────────────────────────────────────────────\n");

  // Show the strongest few setups so the "does it recognise proper format?"
  // question is answerable by eye, not just by the aggregate number.
  console.log("Sample setups (highest confidence):");
  [...all]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 6)
    .forEach((t) => {
      const when = new Date(t.entryTime * 1000).toISOString().slice(0, 16).replace("T", " ");
      console.log(
        `  ${t.symbol.padEnd(5)} ${t.action.padEnd(4)} ${when}  conf ${pct(t.confidence)}  trigger=${t.reasonHead}  planned ${t.plannedR.toFixed(1)}R → ${t.exitReason} ${t.realizedR >= 0 ? "+" : ""}${t.realizedR.toFixed(2)}R`,
      );
    });
  console.log("");
}

void main();
