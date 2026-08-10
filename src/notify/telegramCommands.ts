import { env } from "../config/env.js";
import { fetchJson } from "../utils/http.js";
import { childLogger } from "../utils/logger.js";
import { TELEGRAM_API_BASE, sendTelegramMessage, formatPrice } from "./telegram.js";
import type { Position } from "../types/index.js";
import type { TradeStats, GoLiveReadiness } from "../state/tradeLog.js";

const log = childLogger("telegram-commands");

const GETUPDATES_TIMEOUT_SECONDS = 30;
const ERROR_BACKOFF_MS = 5000;
const MAX_LISTED_POSITIONS = 15;

// --- Pure reply formatting (unit-testable without hitting the network) ---

export const HELP_TEXT = [
  "Commands:",
  "/status — portfolio snapshot + open positions",
  "/stats — win rate, expectancy, Brier score",
  "/positions — open position detail",
  "/help — this message",
].join("\n");

export interface StatusSnapshot {
  mode: "paper" | "live";
  solBalance: number;
  totalValueUsd: number;
  openPositions: Position[];
}

export function formatStatusReply(snapshot: StatusSnapshot): string {
  const lines = [
    `🤖 Mode: ${snapshot.mode.toUpperCase()}`,
    `SOL balance: ${snapshot.solBalance.toFixed(4)}`,
    `Total value: $${snapshot.totalValueUsd.toFixed(2)}`,
    `Open positions: ${snapshot.openPositions.length}`,
  ];

  for (const p of snapshot.openPositions.slice(0, MAX_LISTED_POSITIONS)) {
    const ageHours = (Date.now() - p.entryTimestamp) / (1000 * 60 * 60);
    lines.push(
      `  $${p.symbol}: entry $${formatPrice(p.entryPriceUsd)}, ${ageHours.toFixed(1)}h old, conf ${(p.signal.confidence * 100).toFixed(0)}%`,
    );
  }
  if (snapshot.openPositions.length > MAX_LISTED_POSITIONS) {
    lines.push(`  ...and ${snapshot.openPositions.length - MAX_LISTED_POSITIONS} more`);
  }

  return lines.join("\n");
}

export function formatStatsReply(stats: TradeStats, goLive?: GoLiveReadiness): string {
  if (stats.totalTrades === 0) return "No closed trades yet.";

  const lines = [
    `📊 ${stats.totalTrades} closed trades | ${stats.winRatePct.toFixed(1)}% win rate`,
    `Avg win: +${stats.avgWinPct.toFixed(1)}% | Avg loss: ${stats.avgLossPct.toFixed(1)}%`,
    `Expectancy: ${stats.expectancyPct >= 0 ? "+" : ""}${stats.expectancyPct.toFixed(1)}% | Total PnL: $${stats.totalRealizedPnlUsd.toFixed(2)}`,
    `Brier score: ${stats.brierScore !== null ? stats.brierScore.toFixed(3) : "n/a"} (0=perfect, 0.25=no better than a coin flip)`,
  ];
  if (stats.sampleSizeWarning) lines.push(`⚠️ ${stats.sampleSizeWarning}`);

  if (goLive) {
    lines.push("");
    lines.push(goLive.ready ? "✅ GO-LIVE GATE: READY" : "⛔ GO-LIVE GATE: NOT READY");
    for (const c of goLive.checks) {
      lines.push(`  ${c.passed ? "✅" : "❌"} ${c.label}: ${c.detail}`);
    }
    if (goLive.ready) {
      lines.push("Bar met on paper — but this is permission to consider live with tiny size, not a guarantee.");
    }
  }

  return lines.join("\n");
}

/**
 * Once-a-day push summarizing paper progress toward the go-live gate. Reuses
 * the /stats rendering and adds a headline: how many more closed trades until
 * the gate can even be judged, so "check daily" is effortless. Pure.
 */
export function formatDailyDigest(stats: TradeStats, goLive: GoLiveReadiness, minTrades: number): string {
  const header = "📅 Daily paper-trading digest";
  if (stats.totalTrades === 0) {
    return `${header}\n\nNo closed trades yet. The go-live gate needs ${minTrades}. Hang tight — trades log as positions close.`;
  }

  const remaining = Math.max(0, minTrades - stats.totalTrades);
  const progress =
    remaining > 0
      ? `${remaining} more closed trade${remaining === 1 ? "" : "s"} until the gate can be judged (${stats.totalTrades}/${minTrades}).`
      : `Sample size reached (${stats.totalTrades}/${minTrades}) — the gate verdict below is now meaningful.`;

  return `${header}\n\n${formatStatsReply(stats, goLive)}\n\n${progress}`;
}

export function formatPositionsReply(positions: Position[]): string {
  if (positions.length === 0) return "No open positions.";

  return positions
    .slice(0, MAX_LISTED_POSITIONS)
    .map((p) => {
      const ageHours = (Date.now() - p.entryTimestamp) / (1000 * 60 * 60);
      return `$${p.symbol}: entry $${formatPrice(p.entryPriceUsd)}, stop $${formatPrice(p.stopLossPriceUsd)}, ${ageHours.toFixed(1)}h old`;
    })
    .join("\n");
}

// --- Command routing ---

export interface CommandHandlers {
  getStatusReply: () => Promise<string>;
  getStatsReply: () => Promise<string>;
  getPositionsReply: () => Promise<string>;
}

/**
 * Decides the reply for one incoming message, or null to send nothing.
 * Takes the owner chat id as an explicit parameter (rather than reading
 * env directly) so it's a pure function, fully unit-testable without a
 * real long-poll loop or environment setup. Silently ignoring messages
 * from any chat other than ownerChatId (not even an error reply) means
 * the bot doesn't confirm to a stranger that it responds at all, even if
 * they find its username and message it.
 */
export async function routeCommand(
  text: string,
  chatId: number,
  ownerChatId: string,
  handlers: CommandHandlers,
): Promise<string | null> {
  if (String(chatId) !== ownerChatId) {
    log.warn({ chatId }, "ignoring Telegram message from unrecognized chat");
    return null;
  }

  const command = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  switch (command) {
    case "/status":
      return handlers.getStatusReply();
    case "/stats":
      return handlers.getStatsReply();
    case "/positions":
      return handlers.getPositionsReply();
    case "/help":
    case "/start":
      return HELP_TEXT;
    default:
      return `Unrecognized command "${command}".\n\n${HELP_TEXT}`;
  }
}

// --- Long polling ---

interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string };
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Responds to /status, /stats, /positions, /help via Telegram's getUpdates
 * long-polling API — no public URL/webhook needed, works fine from a
 * laptop behind NAT. Each poll blocks server-side for up to
 * GETUPDATES_TIMEOUT_SECONDS waiting for a new message, which is far
 * cheaper than short-interval polling.
 */
export class TelegramCommandListener {
  private offset = 0;
  private running = false;

  constructor(private readonly handlers: CommandHandlers) {}

  start(): void {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      log.warn("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — Telegram command listener disabled");
      return;
    }
    if (this.running) return;
    this.running = true;
    log.info("starting Telegram command listener (long polling)");
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const res = await fetchJson<TelegramGetUpdatesResponse>(
          `${TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${this.offset}&timeout=${GETUPDATES_TIMEOUT_SECONDS}`,
          { timeoutMs: (GETUPDATES_TIMEOUT_SECONDS + 5) * 1000, retries: 0 },
        );

        for (const update of res.result) {
          this.offset = update.update_id + 1;
          try {
            const text = update.message?.text;
            const chatId = update.message?.chat.id;
            if (!text || chatId === undefined) continue;

            const reply = await routeCommand(text, chatId, env.TELEGRAM_CHAT_ID, this.handlers);
            if (reply) await sendTelegramMessage(reply);
          } catch (err) {
            log.error({ err: (err as Error).message, updateId: update.update_id }, "failed to handle Telegram update");
          }
        }
      } catch (err) {
        log.error({ err: (err as Error).message }, "Telegram command poll failed, backing off");
        await sleep(ERROR_BACKOFF_MS);
      }
    }
  }
}
