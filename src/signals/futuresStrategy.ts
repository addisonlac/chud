// ---------------------------------------------------------------------------
// Shared futures backtest logic — one implementation used by the backtest, the
// tuning sweep, and the HUD renderer so they never diverge.
//
// A "trade" carries the bar indices (entry / fill / exit) so a chart can draw
// exactly where it happened. Management mirrors the live signal: bank half at
// TP1, move the stop to breakeven, let the runner target TP2.
// ---------------------------------------------------------------------------
import { aggregateBars } from "./candles.js";
import { analyze, defaultEngineConfig, type EngineConfig } from "./engine.js";
import { sizeContracts } from "./sizing.js";
import type { FuturesContract } from "./instruments.js";
import { SessionGuard, defaultGuardConfig, type GuardConfig } from "./sessionGuard.js";
import type { SessionConfig } from "./session.js";
import type { Bar, Signal } from "./types.js";

export const WARMUP = 240;
export const MAX_HOLD = 120;
export const FILL_WINDOW = 15;

export interface FuturesTrade {
  root: string;
  action: "BUY" | "SELL";
  confidence: number;
  trigger: string;
  entryIdx: number; // signal bar
  fillIdx: number; // bar the position actually opened
  exitIdx: number; // bar it closed
  entryTime: number;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  contracts: number;
  realizedR: number;
  pnlUsd: number;
  exit: "target" | "stop" | "partial(BE)" | "timeout";
}

interface Resolved {
  R: number;
  exit: FuturesTrade["exit"];
  fillIdx: number;
  exitIdx: number;
}

export function resolveTrade(bars: Bar[], idx: number, sig: Signal): Resolved | null {
  if (sig.entry == null || sig.stop == null || !sig.targets.length) return null;
  const isLong = sig.action === "BUY";
  const entry = sig.entry, stop = sig.stop, tp1 = sig.targets[0]!, tp2 = sig.targets[1] ?? tp1;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const rOf = (p: number) => (isLong ? p - entry : entry - p) / risk;

  let fill = idx;
  if (sig.entryType === "limit") {
    fill = -1;
    const e = Math.min(idx + FILL_WINDOW, bars.length - 1);
    for (let j = idx + 1; j <= e; j++) {
      const b = bars[j]!;
      if (b.low <= entry && entry <= b.high) { fill = j; break; }
    }
    if (fill < 0) return null;
  }

  const end = Math.min(fill + MAX_HOLD, bars.length - 1);
  let sN = stop, partial = false;
  for (let j = fill + 1; j <= end; j++) {
    const b = bars[j]!;
    const hs = isLong ? b.low <= sN : b.high >= sN;
    const h1 = isLong ? b.high >= tp1 : b.low <= tp1;
    const h2 = isLong ? b.high >= tp2 : b.low <= tp2;
    if (!partial) {
      if (hs) return { R: rOf(sN), exit: "stop", fillIdx: fill, exitIdx: j };
      if (h1) { partial = true; sN = entry; if (h2) return { R: 0.5 * rOf(tp1) + 0.5 * rOf(tp2), exit: "target", fillIdx: fill, exitIdx: j }; continue; }
    } else {
      if (h2) return { R: 0.5 * rOf(tp1) + 0.5 * rOf(tp2), exit: "target", fillIdx: fill, exitIdx: j };
      if (hs) return { R: 0.5 * rOf(tp1), exit: "partial(BE)", fillIdx: fill, exitIdx: j };
    }
  }
  const cR = rOf(bars[end]!.close);
  return { R: partial ? 0.5 * rOf(tp1) + 0.5 * Math.max(0, cR) : cR, exit: "timeout", fillIdx: fill, exitIdx: end };
}

export interface RunOpts {
  engine?: Partial<EngineConfig>;
  guard?: GuardConfig | null; // null = no guard
  riskUsd: number;
}

export function runFutures(root: string, contract: FuturesContract, ltf: Bar[], opts: RunOpts): FuturesTrade[] {
  const cfg = { ...defaultEngineConfig(), ...(opts.engine ?? {}) };
  const guard = opts.guard ? new SessionGuard(opts.guard) : null;
  const trades: FuturesTrade[] = [];
  let i = WARMUP;
  while (i < ltf.length - 1) {
    const seen = ltf.slice(0, i + 1);
    const sig = analyze(root, seen, aggregateBars(seen, 15), cfg);
    if (sig.action !== "WAIT") {
      const size = sizeContracts(sig, contract, opts.riskUsd);
      if (size.contracts > 0) {
        const gate = guard ? guard.canEnter(sig.generatedAt, i, sig.confidence) : { ok: true };
        if (gate.ok) {
          const r = resolveTrade(ltf, i, sig);
          if (r) {
            trades.push({
              root,
              action: sig.action as "BUY" | "SELL",
              confidence: sig.confidence,
              trigger: sig.reasoning.find((x) => x.label === "Liquidity sweep" || x.label === "Break of structure")?.label ?? "—",
              entryIdx: i,
              fillIdx: r.fillIdx,
              exitIdx: r.exitIdx,
              entryTime: sig.generatedAt,
              entry: sig.entry!,
              stop: sig.stop!,
              tp1: sig.targets[0]!,
              tp2: sig.targets[1] ?? sig.targets[0]!,
              contracts: size.contracts,
              realizedR: r.R,
              pnlUsd: r.R * size.riskUsd,
              exit: r.exit,
            });
            guard?.record(sig.generatedAt, i, r.R);
            i = Math.max(i + 1, r.exitIdx + 1);
            continue;
          }
        }
      }
    }
    i++;
  }
  return trades;
}

// --- Presets ----------------------------------------------------------------

/** A session window from "HH:MM"–"HH:MM" ET. */
function window(start: string, end: string): SessionConfig {
  return { enabled: true, timezone: "America/New_York", weekdays: [1, 2, 3, 4, 5], windows: [{ start, end, label: "NY" }] };
}

export interface Preset {
  name: string;
  engine: Partial<EngineConfig>;
  guard: GuardConfig | null;
}

/**
 * The SAFE preset — tuned for win rate and consistency over raw R. Selected by
 * the tuning sweep as the highest-win-rate config on the validation week:
 *   • with-trend only (no counter-trend reversals),
 *   • must react from an order block / FVG (zone confluence),
 *   • high confidence floor (0.85),
 *   • bank the first target at 1R so more trades close green,
 *   • the opening drive only (09:30–10:30 ET),
 *   • one loss ends the day; two trades max per session.
 *
 * NOTE: these values were chosen in-sample. They are a hypothesis to validate on
 * other weeks, not a proven edge — see scripts/futures-sweep.ts.
 */
export function safePreset(): Preset {
  return {
    name: "safe",
    engine: {
      minConfidence: 0.85,
      requireBiasAligned: true,
      requireZoneConfluence: true,
      tp1MinR: 1.0,
      tp1MaxR: 1.0,
      minRiskReward: 1.0,
      session: window("09:30", "10:30"),
    },
    guard: { minConfidence: 0.85, maxTradesPerSession: 2, maxConsecutiveLosses: 1, cooldownBarsAfterLoss: 20, timezone: "America/New_York" },
  };
}

export function baselinePreset(): Preset {
  return { name: "baseline", engine: {}, guard: null };
}

export function filteredPreset(): Preset {
  return { name: "filtered", engine: {}, guard: defaultGuardConfig() };
}
