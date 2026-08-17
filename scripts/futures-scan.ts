/**
 * Scan the futures universe for the freshest pattern CALL — the terminal face of
 * the recogniser. It tells you the setup, direction, entry and protective stop;
 * you decide and trade.
 *
 *   npx tsx scripts/futures-scan.ts            # default universe (MES, MNQ)
 *   npx tsx scripts/futures-scan.ts MES MNQ ES NQ
 *   npx tsx scripts/futures-scan.ts --lookback 5
 */
import { defaultProvider } from "../src/data/stockData.js";
import { aggregateBars } from "../src/signals/candles.js";
import { ema, last } from "../src/signals/indicators.js";
import { latestPattern } from "../src/signals/patterns.js";
import { getContract, DEFAULT_FUTURES_UNIVERSE } from "../src/signals/instruments.js";
import { sizeContracts, DEFAULT_RISK_USD } from "../src/signals/sizing.js";

const ICON = (d: string) => (d === "long" ? "🟢 BUY " : "🔴 SELL");

async function main() {
  const args = process.argv.slice(2);
  const lbIdx = args.indexOf("--lookback");
  const lookback = lbIdx >= 0 ? Number(args[lbIdx + 1]) || 3 : 3;
  const roots = args.filter((a, i) => !a.startsWith("--") && !(lbIdx >= 0 && i === lbIdx + 1)).map((s) => s.toUpperCase());
  const universe = roots.length ? roots : DEFAULT_FUTURES_UNIVERSE;

  console.log(`\nCHUD Scanner — freshest pattern call within ${lookback} bars (risk $${DEFAULT_RISK_USD}/trade)\n`);
  const provider = defaultProvider();
  for (const root of universe) {
    const c = getContract(root);
    if (!c) { console.log(`  ${root}: unknown contract`); continue; }
    const { ltf, htf } = await provider.getSeries(c.dataSymbol);
    if (!ltf.length) { console.log(`  ${root}: no data`); continue; }
    const biasEma = last(ema(htf.map((b) => b.close), Math.min(50, Math.floor(htf.length / 2))));
    const biasClose = htf.length ? htf[htf.length - 1]!.close : 0;
    const bias = biasEma == null ? "flat" : biasClose > biasEma ? "bull" : "bear";
    const hit = latestPattern(ltf, lookback);
    const asOf = new Date((ltf[ltf.length - 1]!.time) * 1000).toISOString().slice(0, 16).replace("T", " ");
    if (!hit) {
      console.log(`  ${root.padEnd(4)} (${c.dataSymbol})  ⚪ no call   15m ${bias}   as of ${asOf}Z`);
      continue;
    }
    const aligned = (hit.direction === "long" && bias === "bull") || (hit.direction === "short" && bias === "bear");
    const sig = { action: hit.direction === "long" ? "BUY" : "SELL", entry: hit.entry, stop: hit.stop, targets: [hit.entry + (hit.direction === "long" ? 1 : -1) * Math.abs(hit.entry - hit.stop)] } as never;
    const size = sizeContracts(sig, c, DEFAULT_RISK_USD);
    console.log(`  ${root.padEnd(4)} (${c.dataSymbol})  ${ICON(hit.direction)}  ${hit.name.padEnd(18)} conf ${(hit.confidence * 100).toFixed(0)}%  15m ${bias}${aligned ? " ✓" : " ✗ (against bias)"}`);
    console.log(`        entry ${hit.entry.toFixed(2)}  stop ${hit.stop.toFixed(2)}  →  ${size.contracts} ${root} (risk $${size.riskUsd.toFixed(0)})`);
    console.log(`        ${hit.note}`);
  }
  console.log("\n  Calls are prompts, not guarantees — check measured hit rates in SIGNALS.md. Not financial advice.\n");
}

void main();
