import { env } from "../config/env.js";
import { fetchJson } from "../utils/http.js";
import { childLogger } from "../utils/logger.js";
import type { Position, TradeLogEntry } from "../types/index.js";

const log = childLogger("telegram");

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_REASONING_CHARS = 220;

// --- Pure message formatting (unit-testable without hitting the network) ---

export function formatPrice(price: number): string {
  if (!Number.isFinite(price) || price === 0) return "0";
  return price < 0.01 ? price.toFixed(8) : price.toFixed(4);
}

export function formatPct(fraction: number): string {
  const pct = fraction * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatStartupMessage(mode: "paper" | "live"): string {
  return mode === "live"
    ? "🤖 Bot started in LIVE mode. Real trades WILL execute with real funds."
    : "🤖 Bot started in PAPER mode. Signals will fire against real market data, but no real trades will execute.";
}

export function formatPositionOpenedMessage(position: Position): string {
  return [
    `🟢 OPENED $${position.symbol}`,
    `Entry: $${formatPrice(position.entryPriceUsd)}`,
    `Size: ${position.costBasisSol.toFixed(4)} SOL ($${position.costBasisUsd.toFixed(2)})`,
    `Confidence: ${(position.signal.confidence * 100).toFixed(0)}%`,
    `Reasoning: ${truncate(position.signal.reasoning, MAX_REASONING_CHARS)}`,
  ].join("\n");
}

export function formatPositionClosedMessage(entry: TradeLogEntry): string {
  const icon = entry.won ? "🟢 WIN" : "🔴 LOSS";
  return [
    `${icon} $${entry.symbol}`,
    `Exit reason: ${entry.exitReason}`,
    `PnL: ${formatPct(entry.pnlPct)} ($${entry.realizedPnlUsd >= 0 ? "+" : ""}${entry.realizedPnlUsd.toFixed(2)})`,
    `Held: ${entry.holdHours.toFixed(1)}h | Entry confidence was ${(entry.signalConfidence * 100).toFixed(0)}%`,
  ].join("\n");
}

export function formatExecutionErrorMessage(context: string, symbol: string, error: string): string {
  return `⚠️ EXECUTION ERROR (${context}) — $${symbol}\n${error}`;
}

// --- Sending ---

interface TelegramSendMessageResponse {
  ok: boolean;
  description?: string;
}

/**
 * Read-only trading visibility: posts trade opened/closed and execution
 * errors to a Telegram chat. Deliberately does NOT push a notification for
 * every rejected/filtered token — pump.fun's scan volume would make that
 * spam, not signal. Rejections stay in the structured logs.
 *
 * No parse_mode is set on purpose: token symbols/names come from pump.fun
 * and are attacker-controlled (anyone can name a token anything). Enabling
 * HTML/Markdown parsing on untrusted text risks malformed-entity 400s that
 * would silently break every notification, or odd rendering — plain text
 * sidesteps both.
 */
export class TelegramNotifier {
  private readonly enabled: boolean;

  constructor() {
    this.enabled = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
    if (!this.enabled) {
      log.warn("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — Telegram notifications disabled");
    }
  }

  private async send(text: string): Promise<void> {
    if (!this.enabled) return;

    try {
      const res = await fetchJson<TelegramSendMessageResponse>(
        `${TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
          timeoutMs: 8000,
          retries: 1,
        },
      );
      if (!res.ok) {
        log.error({ description: res.description }, "Telegram API rejected the message");
      }
    } catch (err) {
      // A notification failure must never break the trading pipeline.
      log.error({ err: (err as Error).message }, "failed to send Telegram notification");
    }
  }

  async notifyStartup(mode: "paper" | "live"): Promise<void> {
    await this.send(formatStartupMessage(mode));
  }

  async notifyPositionOpened(position: Position): Promise<void> {
    await this.send(formatPositionOpenedMessage(position));
  }

  async notifyPositionClosed(entry: TradeLogEntry): Promise<void> {
    await this.send(formatPositionClosedMessage(entry));
  }

  async notifyExecutionError(context: string, symbol: string, error: string): Promise<void> {
    await this.send(formatExecutionErrorMessage(context, symbol, error));
  }
}
