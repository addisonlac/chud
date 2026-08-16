/**
 * Tuning sweep — evaluate a ladder of presets on the SAME week and report win
 * rate, so we can find a configuration that clears a target win rate. This is
 * IN-SAMPLE optimization: it tells you which knobs move win rate on this data,
 * not that the result generalizes. Treat the winner as a hypothesis to test
 * out-of-sample, not a proven edge.
 *
 *   npx tsx scripts/futures-sweep.ts
 */
import { FixtureProvider } from "../src/data/stockData.js";
import { getContract, DEFAULT_FUTURES_UNIVERSE } from "../src/signals/instruments.js";
import { runFutures, type FuturesTrade } from "../src/signals/futuresStrategy.js";
import { defaultGuardConfig, type GuardConfig } from "../src/signals/sessionGuard.js";
import type { EngineConfig } from "../src/signals/engine.js";
import type { SessionConfig } from "../src/signals/session.js";

const RISK_USD = Number(process.env.RISK_USD) || 250;

function win(start: string, end: string): SessionConfig {
  return { enabled: true, timezone: "America/New_York", weekdays: [1, 2, 3, 4, 5], windows: [{ start, end, label: "NY" }] };
}
function guard(minConf: number, cap: number, consec: number, cooldown: number): GuardConfig {
  return { minConfidence: minConf, maxTradesPerSession: cap, maxConsecutiveLosses: consec, cooldownBarsAfterLoss: cooldown, timezone: "America/New_York" };
}

interface Cand { name: string; engine: Partial<EngineConfig>; guard: GuardConfig | null }

const CANDIDATES: Cand[] = [
  { name: "0 baseline (raw)", engine: {}, guard: null },
  { name: "1 filtered (guard)", engine: {}, guard: defaultGuardConfig() },
  { name: "2 with-trend", engine: { minConfidence: 0.8, requireBiasAligned: true, session: win("09:30", "11:00") }, guard: guard(0.8, 3, 2, 15) },
  { name: "3 +zone confluence", engine: { minConfidence: 0.8, requireBiasAligned: true, requireZoneConfluence: true, session: win("09:30", "11:00") }, guard: guard(0.8, 3, 2, 15) },
  { name: "4 +bank early 1R", engine: { minConfidence: 0.8, requireBiasAligned: true, requireZoneConfluence: true, tp1MinR: 1.0, tp1MaxR: 1.0, minRiskReward: 1.0, session: win("09:30", "11:00") }, guard: guard(0.8, 2, 1, 20) },
  { name: "5 +bank 0.8R, conf .85", engine: { minConfidence: 0.85, requireBiasAligned: true, requireZoneConfluence: true, tp1MinR: 0.8, tp1MaxR: 0.8, minRiskReward: 0.8, session: win("09:30", "11:00") }, guard: guard(0.85, 2, 1, 20) },
  { name: "6 strict conf .85, 1030 win", engine: { minConfidence: 0.85, requireBiasAligned: true, requireZoneConfluence: true, tp1MinR: 1.0, tp1MaxR: 1.0, minRiskReward: 1.0, session: win("09:30", "10:30") }, guard: guard(0.85, 2, 1, 20) },
];

async function main() {
  const provider = new FixtureProvider();
  const series = new Map<string, { ltf: import("../src/signals/types.js").Bar[] }>();
  for (const root of DEFAULT_FUTURES_UNIVERSE) {
    const c = getContract(root)!;
    series.set(root, await provider.getSeries(c.dataSymbol));
  }

  console.log(`\n=== FUTURES tuning sweep (in-sample, this week, $${RISK_USD}/trade) ===`);
  console.log("preset                        trades  win%    netR      net$     PF");
  console.log("─".repeat(74));
  for (const cand of CANDIDATES) {
    const all: FuturesTrade[] = [];
    for (const root of DEFAULT_FUTURES_UNIVERSE) {
      const c = getContract(root)!;
      all.push(...runFutures(root, c, series.get(root)!.ltf, { engine: cand.engine, guard: cand.guard, riskUsd: RISK_USD }));
    }
    const n = all.length;
    const w = all.filter((t) => t.realizedR > 0).length;
    const netR = all.reduce((s, t) => s + t.realizedR, 0);
    const netUsd = all.reduce((s, t) => s + t.pnlUsd, 0);
    const gw = all.filter((t) => t.realizedR > 0).reduce((s, t) => s + t.realizedR, 0);
    const gl = Math.abs(all.filter((t) => t.realizedR <= 0).reduce((s, t) => s + t.realizedR, 0));
    const winPct = n ? (100 * w) / n : 0;
    const flag = winPct >= 70 && n >= 8 ? "  ✅≥70%" : "";
    console.log(
      `${cand.name.padEnd(28)}  ${String(n).padStart(4)}  ${winPct.toFixed(1).padStart(5)}%  ${(netR >= 0 ? "+" : "") + netR.toFixed(2).padStart(6)}R  ${(netUsd >= 0 ? "+$" : "-$") + Math.abs(netUsd).toFixed(0).padStart(5)}  ${gl > 0 ? (gw / gl).toFixed(2) : "∞"}${flag}`,
    );
  }
  console.log("─".repeat(74));
  console.log("Higher win rate here is bought with fewer trades + earlier profit-taking;");
  console.log("it is in-sample and must be validated on other weeks before it means anything.\n");
}

void main();
