/**
 * Backtest the exit/risk strategy against real historical price data.
 *
 *   npm run backtest
 *
 * For each token it simulates: buy at the start of the candle series, then
 * walk forward candle-by-candle applying the exact live exit rules — the
 * partial take-profit scale-out, the fixed/breakeven floor stop, the tiered
 * trailing stop off the peak, and the 48h max hold — by calling the same
 * risk-manager functions the live bot uses. Then it prints aggregate stats
 * (win rate, avg win/loss, expectancy, total return) using the same stats
 * code the live bot uses.
 *
 * Intra-candle assumption: within each candle we update the peak from the
 * high, fill the take-profit if the high reached the target, then check the
 * stop against the low (worst case). Real fills can't know intra-candle
 * ordering — this is a reasonable, mildly-optimistic-on-TP convention.
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
import { getCandlesForTimeframe, getTrendingTokenMints } from "../src/data/birdeye.js";
import { checkTakeProfit, computeEffectiveStop, defaultRiskConfig } from "../src/risk/riskManager.js";
import { computeTradeStats } from "../src/state/tradeLog.js";
import type { Candle, ExitReason, Position, TradeLogEntry, TradeSignal } from "../src/types/index.js";

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

/** Build a minimal open Position so the backtest can call the live risk functions. */
function makeBacktestPosition(mint: string, entry: number, entryTime: number): Position {
  const config = defaultRiskConfig();
  const signal: TradeSignal = {
    mint,
    symbol: mint.slice(0, 6),
    confidence: 0,
    direction: "long",
    reasoning: "",
    entryPriceUsd: entry,
    generatedAt: entryTime,
  };
  return {
    id: mint,
    mint,
    symbol: mint.slice(0, 6),
    status: "open",
    entryPriceUsd: entry,
    entryTimestamp: entryTime,
    quantityTokens: 1,
    costBasisUsd: entry,
    costBasisSol: 0,
    stopLossPriceUsd: entry * (1 - config.stopLossPct),
    peakPriceUsd: entry,
    maxAgeHours: config.maxPositionAgeHours,
    tookPartialProfit: false,
    scaledOutQuantityTokens: 0,
    realizedScaleOutPnlUsd: 0,
    signal,
  };
}

/**
 * Walk the candle series applying the live exit rules, reusing the exact
 * risk-manager functions (checkTakeProfit + computeEffectiveStop). Tracks a
 * fractional position: the take-profit banks part of the gain, the rest
 * rides the (tightened, breakeven-floored) trailing stop. Returns the
 * blended outcome as a return on the full original position.
 */
function simulate(mint: string, series: Candle[]): SimResult | null {
  if (series.length < 2) return null;

  const config = defaultRiskConfig();
  const entry = series[0]!.close;
  if (entry <= 0) return null;

  const entryTime = series[0]!.timestamp * 1000;
  const pos = makeBacktestPosition(mint, entry, entryTime);

  let remaining = 1; // fraction of the original position still held
  let bankedPnlPct = 0; // return already realized via scale-out, as a fraction of entry

  const finish = (exitPriceUsd: number, exitReason: SimResult["exitReason"], heldHours: number): SimResult => ({
    mint,
    entryPriceUsd: entry,
    exitPriceUsd,
    pnlPct: bankedPnlPct + remaining * ((exitPriceUsd - entry) / entry),
    exitReason,
    heldHours,
  });

  for (let i = 1; i < series.length; i++) {
    const c = series[i]!;
    pos.peakPriceUsd = Math.max(pos.peakPriceUsd, c.high); // new highs arm the trail/breakeven

    // 1. Partial take-profit — fills if the candle's high reached the target.
    const tp = checkTakeProfit(pos, c.high, config);
    if (tp.shouldScaleOut) {
      const soldFraction = remaining * tp.sellFraction;
      bankedPnlPct += soldFraction * ((tp.targetPriceUsd - entry) / entry);
      remaining -= soldFraction;
      pos.tookPartialProfit = true;
      pos.stopLossPriceUsd = Math.max(pos.stopLossPriceUsd, entry); // breakeven floor
    }

    // 2. Stop — fills if the candle's low pierces the effective stop (worst case).
    const stop = computeEffectiveStop(pos, config);
    if (c.low <= stop.price) {
      return finish(stop.price, stop.isTrailing ? "trailing_stop" : "stop_loss", (c.timestamp * 1000 - entryTime) / 3.6e6);
    }

    // 3. Max hold age.
    const ageHours = (c.timestamp * 1000 - entryTime) / 3.6e6;
    if (ageHours >= config.maxPositionAgeHours) {
      return finish(c.close, "max_age", ageHours);
    }
  }

  // Never exited within the data window — close the remainder at the last candle.
  const last = series[series.length - 1]!;
  return finish(last.close, "end_of_data", (last.timestamp * 1000 - entryTime) / 3.6e6);
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
    // Blended return (banked scale-out + remainder) on the 1-token position.
    realizedPnlUsd: r.pnlPct * r.entryPriceUsd,
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
      // Prefer 1h candles (up to 7d of history); fall back to 5m only if the
      // 1h series is too short. One Birdeye call per token (two at most) keeps
      // us well under the free-tier rate limit so more tokens get evaluated.
      let series = await getCandlesForTimeframe(mint, "1h");
      if (series.length < 2) {
        series = await getCandlesForTimeframe(mint, "5m");
      }
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
