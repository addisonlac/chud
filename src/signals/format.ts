// ---------------------------------------------------------------------------
// Human-readable rendering of a Signal — used by the analyzer CLI, the Telegram
// / TradingView webhook messages, and the backtest trace. The overlay dashboard
// consumes the raw Signal JSON directly.
// ---------------------------------------------------------------------------
import type { Signal } from "./types.js";
import { sizeShares, DEFAULT_RISK_USD } from "./sizing.js";

const ICON: Record<string, string> = { bullish: "🟢", bearish: "🔴", neutral: "⚪", info: "ℹ️" };
const ACTION_ICON: Record<string, string> = { BUY: "🟢 BUY", SELL: "🔴 SELL", WAIT: "⚪ WAIT" };

/** Full multi-line breakdown suitable for a terminal or a chat message. */
export function formatSignal(sig: Signal, riskUsd = DEFAULT_RISK_USD): string {
  const lines: string[] = [];
  const conf = (sig.confidence * 100).toFixed(0);
  const size = sizeShares(sig, riskUsd);
  const shareWord = sig.action === "WAIT" ? "" : ` ${size.shares} share${size.shares === 1 ? "" : "s"}`;
  lines.push(`${ACTION_ICON[sig.action]}${shareWord}  ${sig.symbol}  @ ${sig.price.toFixed(2)}   confidence ${conf}%`);
  lines.push(`15m bias: ${sig.htfTrend}   |   1m structure: ${sig.ltfTrend}`);

  if (sig.action !== "WAIT" && sig.entry !== null && sig.stop !== null) {
    const tgt = sig.targets.map((t, i) => `TP${i + 1} ${t.toFixed(2)}`).join("  ");
    lines.push(`Plan: entry ${sig.entry.toFixed(2)}  stop ${sig.stop.toFixed(2)}  ${tgt}  (${sig.riskReward ?? "?"}R)`);
    lines.push(`Size: ${size.shares} shares  ≈ $${size.notionalUsd.toFixed(0)} notional, risking $${size.riskUsd.toFixed(0)} to the stop`);
  }

  lines.push("");
  lines.push("Reasoning:");
  sig.reasoning.forEach((r, i) => {
    const w = r.weight > 0 ? ` (+${(r.weight * 100).toFixed(0)})` : "";
    lines.push(`  ${i + 1}. ${ICON[r.verdict] ?? "•"} ${r.label}${w}: ${r.detail}`);
  });

  return lines.join("\n");
}

/** One-line summary for logs / alert titles. */
export function summarize(sig: Signal, riskUsd = DEFAULT_RISK_USD): string {
  const conf = (sig.confidence * 100).toFixed(0);
  if (sig.action === "WAIT") return `${sig.symbol}: WAIT (${conf}%) — ${sig.htfTrend}/${sig.ltfTrend}`;
  const size = sizeShares(sig, riskUsd);
  return `${sig.symbol}: ${sig.action} ${size.shares} shares @ ${sig.price.toFixed(2)} stop ${sig.stop?.toFixed(2)} → ${sig.targets[0]?.toFixed(2)} (${conf}%, ${sig.riskReward}R)`;
}
