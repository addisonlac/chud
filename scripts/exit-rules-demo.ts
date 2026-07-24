/**
 * Deterministic, no-API demonstration of the exit-rule overhaul.
 *
 *   npm run demo:exits
 *
 * The live backtest (npm run backtest) needs a Birdeye key and only returns
 * data for a handful of tokens on the free tier. This script instead runs
 * BOTH the old exit rules and the new ones over the same hand-built,
 * archetypal memecoin price paths, so you can see — reproducibly and with no
 * network — exactly what the new rules change.
 *
 *   OLD rules: fixed -20% stop, single 25% trailing stop, 48h max hold,
 *              no take-profit ("let winners ride").
 *   NEW rules: partial take-profit (bank half at +60%), breakeven floor +
 *              tightened 15% trail once up +12%, same 48h max hold. The NEW
 *              path reuses the exact live risk-manager functions.
 *
 * The paths are illustrative, not a claim about real hit-rates — they show
 * the mechanism. Run npm run backtest with your own key for real data.
 */
import { checkTakeProfit, computeEffectiveStop, defaultRiskConfig, type RiskConfig } from "../src/risk/riskManager.js";
import type { Candle, Position, TradeSignal } from "../src/types/index.js";

const HOUR_S = 3600;

/** Compact candle builder: one 1h candle from close/high/low multiples of entry. */
function candle(i: number, close: number, high = close, low = close): Candle {
  return { timestamp: i * HOUR_S, open: close, high, low, close, volumeUsd: 0 };
}

interface Path {
  name: string;
  note: string;
  candles: Candle[];
}

// Archetypal memecoin paths (entry = candle 0 close = 1.0).
const PATHS: Path[] = [
  {
    name: "slow bleed → stop",
    note: "drifts straight down and hits the -20% stop",
    candles: [candle(0, 1), candle(1, 0.95, 0.97, 0.94), candle(2, 0.88, 0.95, 0.86), candle(3, 0.82, 0.88, 0.79)],
  },
  {
    name: "pop +40% then fade below entry",
    note: "the classic: spikes, never hits the +60% target, round-trips down",
    candles: [
      candle(0, 1),
      candle(1, 1.2, 1.25, 0.99),
      candle(2, 1.35, 1.42, 1.28),
      candle(3, 1.1, 1.38, 1.05),
      candle(4, 0.95, 1.12, 0.9),
    ],
  },
  {
    name: "pop to +80% (hits target) then crash",
    note: "spikes through the +60% take-profit, then dumps back to entry",
    candles: [
      candle(0, 1),
      candle(1, 1.3, 1.35, 1.05),
      candle(2, 1.7, 1.82, 1.6),
      candle(3, 1.15, 1.7, 1.1),
      candle(4, 0.92, 1.16, 0.88),
    ],
  },
  {
    name: "chop sideways → max age",
    note: "hovers near entry for 48h+, exits on the max-hold clock",
    candles: [
      candle(0, 1),
      candle(12, 1.03, 1.06, 0.98),
      candle(24, 0.99, 1.05, 0.96),
      candle(36, 1.02, 1.05, 0.97),
      candle(49, 1.01, 1.04, 0.98),
    ],
  },
  {
    name: "moonshot with a pullback",
    note: "keeps running to 4x, then gives back some",
    candles: [
      candle(0, 1),
      candle(1, 1.5, 1.6, 1.1),
      candle(2, 2.5, 2.7, 1.9),
      candle(3, 4.0, 4.3, 2.4),
      candle(4, 3.2, 4.1, 3.0),
    ],
  },
];

interface Outcome {
  pnlPct: number;
  reason: string;
}

// ---- OLD rules (reference reimplementation of the pre-overhaul logic) ----
function simulateOld(series: Candle[], config: RiskConfig): Outcome {
  const entry = series[0]!.close;
  const fixedStop = entry * (1 - config.stopLossPct);
  let peak = entry;
  for (let i = 1; i < series.length; i++) {
    const c = series[i]!;
    peak = Math.max(peak, c.high);
    const trailingStop = peak * (1 - config.trailingStopPct); // single, loose trail
    const effStop = Math.max(fixedStop, trailingStop);
    if (c.low <= effStop) {
      return { pnlPct: (effStop - entry) / entry, reason: trailingStop > fixedStop ? "trailing_stop" : "stop_loss" };
    }
    const ageHours = (c.timestamp - series[0]!.timestamp) / 3600;
    if (ageHours >= config.maxPositionAgeHours) return { pnlPct: (c.close - entry) / entry, reason: "max_age" };
  }
  const last = series[series.length - 1]!;
  return { pnlPct: (last.close - entry) / entry, reason: "end_of_data" };
}

// ---- NEW rules (reuses the exact live risk-manager functions) ----
function makePosition(entry: number, entryTime: number): Position {
  const config = defaultRiskConfig();
  const signal: TradeSignal = {
    mint: "demo",
    symbol: "DEMO",
    confidence: 0,
    direction: "long",
    reasoning: "",
    entryPriceUsd: entry,
    generatedAt: entryTime,
  };
  return {
    id: "demo",
    mint: "demo",
    symbol: "DEMO",
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

function simulateNew(series: Candle[], config: RiskConfig): Outcome {
  const entry = series[0]!.close;
  const entryTime = series[0]!.timestamp * 1000;
  const pos = makePosition(entry, entryTime);
  let remaining = 1;
  let banked = 0;

  const blend = (exitPrice: number) => banked + remaining * ((exitPrice - entry) / entry);

  for (let i = 1; i < series.length; i++) {
    const c = series[i]!;
    pos.peakPriceUsd = Math.max(pos.peakPriceUsd, c.high);

    const tp = checkTakeProfit(pos, c.high, config);
    if (tp.shouldScaleOut) {
      const soldFraction = remaining * tp.sellFraction;
      banked += soldFraction * ((tp.targetPriceUsd - entry) / entry);
      remaining -= soldFraction;
      pos.tookPartialProfit = true;
      pos.stopLossPriceUsd = Math.max(pos.stopLossPriceUsd, entry);
    }

    const stop = computeEffectiveStop(pos, config);
    if (c.low <= stop.price) return { pnlPct: blend(stop.price), reason: stop.isTrailing ? "trailing_stop" : "stop_loss" };

    const ageHours = (c.timestamp * 1000 - entryTime) / 3.6e6;
    if (ageHours >= config.maxPositionAgeHours) return { pnlPct: blend(c.close), reason: "max_age" };
  }
  const last = series[series.length - 1]!;
  return { pnlPct: blend(last.close), reason: "end_of_data" };
}

function pct(x: number): string {
  return `${x * 100 >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
}

function main(): void {
  const config = defaultRiskConfig();
  console.log("\n=== Exit-rule comparison: OLD vs NEW (same price paths, no API) ===\n");
  console.log(
    `  Config: stop ${pct(-config.stopLossPct)}, trail ${pct(-config.trailingStopPct)}→${pct(-config.trailingStopTightPct)} ` +
      `once up ${pct(config.breakevenTriggerPct)}, take-profit ${pct(config.takeProfitPct)} on ${(config.takeProfitSizePct * 100).toFixed(0)}%\n`,
  );

  let oldSum = 0;
  let newSum = 0;
  for (const p of PATHS) {
    const o = simulateOld(p.candles, config);
    const n = simulateNew(p.candles, config);
    oldSum += o.pnlPct;
    newSum += n.pnlPct;
    const delta = n.pnlPct - o.pnlPct;
    console.log(`  ${p.name}`);
    console.log(`    ${p.note}`);
    console.log(
      `    OLD ${pct(o.pnlPct).padStart(7)} (${o.reason})   NEW ${pct(n.pnlPct).padStart(7)} (${n.reason})   ` +
        `Δ ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp\n`,
    );
  }

  const oldExp = oldSum / PATHS.length;
  const newExp = newSum / PATHS.length;
  console.log("─────────────────────────────────────────────");
  console.log(`  Expectancy per trade (equal-weight across paths):`);
  console.log(`    OLD rules: ${pct(oldExp)}`);
  console.log(`    NEW rules: ${pct(newExp)}`);
  console.log(`    Improvement: ${newExp - oldExp >= 0 ? "+" : ""}${((newExp - oldExp) * 100).toFixed(1)}pp per trade`);
  console.log("─────────────────────────────────────────────");
  console.log(
    "\n  These are archetypal paths chosen to show the mechanism, NOT a claim\n" +
      "  about real win rates. Note what does and doesn't change: the loser and\n" +
      "  the sub-target fade are UNCHANGED (the new rules never make them worse),\n" +
      "  while the paths that reach the +60% target bank a defined gain and then\n" +
      "  protect the runner with the tightened trail. Keeping the trail loose\n" +
      "  until the take-profit fires is what stops volatility from wicking the\n" +
      "  position out before the target. Run `npm run backtest` with a Birdeye\n" +
      "  key for the same rules against real historical candles.\n",
  );
}

main();
