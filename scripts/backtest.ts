/**
 * Backtest the exit/risk strategy against real historical price data.
 *
 *   npm run backtest
 *
 * For each token it simulates: buy at the start of the candle series, then
 * walk forward candle-by-candle applying the exact live exit rules — fixed
 * -20% stop, trailing stop off the peak, and the 48h max hold — and records
 * the result. Then it prints aggregate stats (win rate, avg win/loss,
 * expectancy, total return) using the same stats code the live bot uses.
 *
 * Token universe: data/backtest-mints.json (a JSON array of mint strings)
 * if present, otherwise the current trending tokens from Birdeye.
 *
 * What this DOES test: the mechanical risk rules against real price action,
 * deterministically and fast.
 * What it does NOT test: the AI's token-SELECTION edge (whether it picks
 * winners) or entry timing — it assumes you bought each token at candle 0.
 * If the universe is trending tokens, note the survivorship bias (those are
 * today's winners). For an unbiased test, supply your own mint list.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getCandles, getTrendingTokenMints } from "../src/data/birdeye.js";
import { defaultRiskConfig } from "../src/risk/riskManager.js";
import { computeTradeStats } from "../src/state/tradeLog.js";
import type { Candle, ExitReason, TradeLogEntry } from "../src/types/index.js";

const DEFAULT_UNIVERSE_SIZE = 30;
const MINTS_FILE = path.resolve("data/backtest-mints.json");

interface SimResult {
  mint: string;
  entryPriceUsd: number;
  exitPriceUsd: number;
  pnlPct: number;
  exitReason: ExitReason | "end_of_data";
  heldHours: number;
}

/** Walk the candle series applying the live exit rules; return the outcome. */
function simulate(mint: string, series: Candle[]): SimResult | null {
  if (series.length < 2) return null;

  const config = defaultRiskConfig();
  const entry = series[0]!.close;
  if (entry <= 0) return null;

  const entryTime = series[0]!.timestamp * 1000;
  const fixedStop = entry * (1 - config.stopLossPct);
  let peak = entry;

  for (let i = 1; i < series.length; i++) {
    const c = series[i]!;
    peak = Math.max(peak, c.high); // new highs arm/raise the trailing stop
    const trailingStop = peak * (1 - config.trailingStopPct);
    const effStop = Math.max(fixedStop, trailingStop);

    // Stop fills if the candle's low pierces it (worst-case intra-candle).
    if (c.low <= effStop) {
      return {
        mint,
        entryPriceUsd: entry,
        exitPriceUsd: effStop,
        pnlPct: (effStop - entry) / entry,
        exitReason: trailingStop > fixedStop ? "trailing_stop" : "stop_loss",
        heldHours: (c.timestamp * 1000 - entryTime) / 3.6e6,
      };
    }

    const ageHours = (c.timestamp * 1000 - entryTime) / 3.6e6;
    if (ageHours >= config.maxPositionAgeHours) {
      return {
        mint,
        entryPriceUsd: entry,
        exitPriceUsd: c.close,
        pnlPct: (c.close - entry) / entry,
        exitReason: "max_age",
        heldHours: ageHours,
      };
    }
  }

  // Never exited within the data window — close at the last candle.
  const last = series[series.length - 1]!;
  return {
    mint,
    entryPriceUsd: entry,
    exitPriceUsd: last.close,
    pnlPct: (last.close - entry) / entry,
    exitReason: "end_of_data",
    heldHours: (last.timestamp * 1000 - entryTime) / 3.6e6,
  };
}

function toLogEntry(r: SimResult): TradeLogEntry {
  return {
    id: r.mint,
    mint: r.mint,
    symbol: r.mint.slice(0, 6),
    entryPriceUsd: r.entryPriceUsd,
    exitPriceUsd: r.exitPriceUsd,
    entryTimestamp: 0,
    exitTimestamp: r.heldHours * 3.6e6,
    holdHours: r.heldHours,
    quantityTokens: 1,
    costBasisUsd: r.entryPriceUsd,
    realizedPnlUsd: r.exitPriceUsd - r.entryPriceUsd,
    pnlPct: r.pnlPct,
    exitReason: r.exitReason === "end_of_data" ? "manual" : r.exitReason,
    signalConfidence: 0,
    won: r.pnlPct > 0,
  };
}

async function loadUniverse(): Promise<string[]> {
  try {
    const raw = await readFile(MINTS_FILE, "utf-8");
    const mints = JSON.parse(raw) as string[];
    if (Array.isArray(mints) && mints.length > 0) {
      console.log(`Universe: ${mints.length} mints from data/backtest-mints.json`);
      return mints;
    }
  } catch {
    /* fall through to trending */
  }
  console.log(`Universe: top ${DEFAULT_UNIVERSE_SIZE} trending tokens from Birdeye`);
  console.log("  (note: trending = today's winners, so results are survivorship-biased.");
  console.log("   Supply your own list in data/backtest-mints.json for an unbiased test.)\n");
  return getTrendingTokenMints(DEFAULT_UNIVERSE_SIZE);
}

async function main() {
  console.log("\n=== Strategy backtest (fixed stop / trailing stop / 48h max hold) ===\n");
  const mints = await loadUniverse();
  if (mints.length === 0) {
    console.log("No tokens to backtest. Set BIRDEYE_API_KEY or add data/backtest-mints.json.");
    process.exit(1);
  }

  const results: SimResult[] = [];
  for (const mint of mints) {
    try {
      const candles = await getCandles(mint);
      // Prefer 1h candles (up to 7d of history); fall back to 5m.
      const series = candles["1h"].length >= 2 ? candles["1h"] : candles["5m"];
      const r = simulate(mint, series);
      if (r) {
        results.push(r);
        console.log(
          `  ${mint.slice(0, 8)}…  ${(r.pnlPct * 100 >= 0 ? "+" : "") + (r.pnlPct * 100).toFixed(1)}%  (${r.exitReason}, ${r.heldHours.toFixed(1)}h)`,
        );
      } else {
        console.log(`  ${mint.slice(0, 8)}…  skipped (not enough candle history)`);
      }
    } catch (err) {
      console.log(`  ${mint.slice(0, 8)}…  error: ${(err as Error).message}`);
    }
  }

  if (results.length === 0) {
    console.log("\nNo tokens had usable candle data. Try again or supply your own mint list.");
    process.exit(1);
  }

  const stats = computeTradeStats(results.map(toLogEntry));
  console.log("\n─────────────────────────────────────────────");
  console.log("RESULTS");
  console.log(`  Trades simulated: ${stats.totalTrades}`);
  console.log(`  Win rate:         ${stats.winRatePct.toFixed(1)}%  (${stats.wins}W / ${stats.losses}L)`);
  console.log(`  Avg win:          +${stats.avgWinPct.toFixed(1)}%`);
  console.log(`  Avg loss:         ${stats.avgLossPct.toFixed(1)}%`);
  console.log(`  Expectancy/trade: ${stats.expectancyPct >= 0 ? "+" : ""}${stats.expectancyPct.toFixed(1)}%`);
  console.log("─────────────────────────────────────────────");
  console.log(
    stats.expectancyPct > 0
      ? "\n  Positive expectancy on this sample — but mind the caveats above\n  (survivorship bias, no AI selection, entry at candle 0).\n"
      : "\n  Negative/zero expectancy on this sample. The exit rules alone don't\n  come out ahead here — the AI's token selection would have to carry it.\n",
  );
}

void main();
