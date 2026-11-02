import { fetchJson } from "../utils/http.js";
import { childLogger } from "../utils/logger.js";
import type { Category } from "../types.js";

const log = childLogger("telegram");

export const TELEGRAM_API_BASE = "https://api.telegram.org";

export function formatQueueMessage(queues: Record<Category, number>, newDrafts: number, appUrl?: string): string {
  const total = queues.website + queues.ads + queues.cro;
  return [
    `📬 ${newDrafts} new outreach draft${newDrafts === 1 ? "" : "s"} ready`,
    `Website: ${queues.website} · Ads: ${queues.ads} · Shopify CRO: ${queues.cro}  (${total} waiting)`,
    appUrl ? `Review & approve: ${appUrl}` : "Open the Outreach app to review & approve.",
  ].join("\n");
}

/**
 * No parse_mode on purpose: business names come from scraped pages, and
 * Markdown/HTML parsing on untrusted text can 400 the whole message.
 */
export async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
  if (!token || !chatId) return;
  try {
    await fetchJson(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      timeoutMs: 8000,
      retries: 1,
    });
  } catch (err) {
    log.error({ err: (err as Error).message }, "failed to send Telegram message");
  }
}
