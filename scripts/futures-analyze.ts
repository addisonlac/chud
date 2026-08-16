/**
 * Analyse one futures contract right now and print the plan in CONTRACTS.
 *
 *   npx tsx scripts/futures-analyze.ts MES
 *   npx tsx scripts/futures-analyze.ts MNQ --risk 500
 *   npx tsx scripts/futures-analyze.ts NQ --json
 *
 * Reasons on the contract's cash-index price series (SPX for ES/MES, NDX for
 * NQ/MNQ) via the default provider (fixture if present, else the keyless feed),
 * then sizes the trade in whole contracts to a fixed dollar risk.
 */
import { defaultProvider } from "../src/data/stockData.js";
import { analyze } from "../src/signals/engine.js";
import { sizeContracts, DEFAULT_RISK_USD } from "../src/signals/sizing.js";
import { getContract } from "../src/signals/instruments.js";

async function main() {
  const root = (process.argv[2] ?? "").toUpperCase();
  const asJson = process.argv.includes("--json");
  const riskIdx = process.argv.indexOf("--risk");
  const riskUsd = riskIdx >= 0 ? Number(process.argv[riskIdx + 1]) || DEFAULT_RISK_USD : DEFAULT_RISK_USD;
  const contract = getContract(root);
  if (!contract) {
    console.error(`usage: tsx scripts/futures-analyze.ts <MES|ES|MNQ|NQ> [--risk <usd>] [--json]`);
    process.exit(1);
  }

  const { ltf, htf } = await defaultProvider().getSeries(contract.dataSymbol);
  if (ltf.length === 0) {
    console.error(`No data for ${contract.dataSymbol} (no fixture and live feed returned nothing).`);
    process.exit(1);
  }
  const sig = analyze(root, ltf, htf);
  const size = sizeContracts(sig, contract, riskUsd);

  if (asJson) {
    console.log(JSON.stringify({ contract, signal: sig, size }, null, 2));
    return;
  }

  const icon = sig.action === "BUY" ? "🟢 BUY" : sig.action === "SELL" ? "🔴 SELL" : "⚪ WAIT";
  console.log(`\n${contract.root} — ${contract.name}  ($${contract.pointValue}/pt, tick ${contract.tickSize})`);
  console.log(`Data: ${contract.dataSymbol}  (1m bars: ${ltf.length}, 15m bars: ${htf.length})   risk/trade: $${riskUsd}\n`);
  console.log(`${icon}${sig.action === "WAIT" ? "" : ` ${size.contracts} contract${size.contracts === 1 ? "" : "s"}`}  ${contract.root} @ ${sig.price.toFixed(2)}   confidence ${(sig.confidence * 100).toFixed(0)}%`);
  console.log(`15m bias: ${sig.htfTrend}   |   1m structure: ${sig.ltfTrend}`);
  if (sig.action !== "WAIT" && sig.entry !== null && sig.stop !== null) {
    const tgt = sig.targets.map((t, i) => `TP${i + 1} ${t.toFixed(2)}`).join("  ");
    console.log(`Plan: entry ${sig.entry.toFixed(2)}  stop ${sig.stop.toFixed(2)}  ${tgt}  (${sig.riskReward ?? "?"}R)`);
    console.log(`Size: ${size.contracts} ${contract.root}  (${size.stopPoints.toFixed(2)} pt stop = $${size.riskPerContract.toFixed(2)}/contract)  → risking $${size.riskUsd.toFixed(0)}, ≈ $${size.notionalUsd.toFixed(0)} notional`);
    if (size.targetPnlUsd[0] !== undefined) console.log(`P&L if hit: TP1 +$${size.targetPnlUsd[0].toFixed(0)}${size.targetPnlUsd[1] !== undefined ? `   TP2 +$${size.targetPnlUsd[1].toFixed(0)}` : ""}`);
  }
  console.log("\nReasoning:");
  sig.reasoning.forEach((r, i) => {
    const dot = r.verdict === "bullish" ? "🟢" : r.verdict === "bearish" ? "🔴" : r.verdict === "info" ? "ℹ️" : "⚪";
    console.log(`  ${i + 1}. ${dot} ${r.label}${r.weight > 0 ? ` (+${Math.round(r.weight * 100)})` : ""}: ${r.detail}`);
  });
  console.log("");
}

void main();
