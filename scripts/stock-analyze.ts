/**
 * Analyse one stock right now and print the step-by-step reasoning.
 *
 *   npx tsx scripts/stock-analyze.ts NVDA
 *   npx tsx scripts/stock-analyze.ts NVDA --risk 500 # size shares to risk $500 to the stop
 *   npx tsx scripts/stock-analyze.ts NVDA --json     # machine-readable Signal
 *
 * Data comes from the default provider: a data/fixtures/<SYMBOL>.json file if
 * present (reproducible/offline), otherwise the keyless Yahoo feed. This is the
 * same engine the backtest and the TradingView webhook path use.
 */
import { defaultProvider } from "../src/data/stockData.js";
import { analyze } from "../src/signals/engine.js";
import { formatSignal } from "../src/signals/format.js";
import { DEFAULT_RISK_USD } from "../src/signals/sizing.js";

async function main() {
  const symbol = (process.argv[2] ?? "").toUpperCase();
  const asJson = process.argv.includes("--json");
  const riskIdx = process.argv.indexOf("--risk");
  const riskUsd = riskIdx >= 0 ? Number(process.argv[riskIdx + 1]) || DEFAULT_RISK_USD : DEFAULT_RISK_USD;
  if (!symbol) {
    console.error("usage: tsx scripts/stock-analyze.ts <SYMBOL> [--risk <usd>] [--json]");
    process.exit(1);
  }

  const provider = defaultProvider();
  const { h1, h4 } = await provider.getSeries(symbol);
  if (h1.length === 0) {
    console.error(`No data for ${symbol} (no fixture and live feed returned nothing).`);
    process.exit(1);
  }

  const signal = analyze(symbol, h1, h4);
  if (asJson) {
    console.log(JSON.stringify(signal, null, 2));
    return;
  }
  console.log(`\nSource: ${provider.name}   (1h bars: ${h1.length}, 4h bars: ${h4.length})   risk/trade: $${riskUsd}\n`);
  console.log(formatSignal(signal, riskUsd));
  console.log("");
}

void main();
