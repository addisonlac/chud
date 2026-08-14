/**
 * TradingView → bot webhook bridge.
 *
 *   npx tsx scripts/tv-webhook.ts            # listens on :8787
 *   PORT=9000 WEBHOOK_SECRET=abc npx tsx scripts/tv-webhook.ts
 *
 * Point a TradingView alert's webhook URL at  http://<host>:8787/tradingview
 * (append ?token=<WEBHOOK_SECRET> if you set one). The Pine overlay
 * (tradingview/chud-signals.pine) already emits the JSON body this expects:
 *
 *   {"source":"chud-signals","symbol":"NVDA","action":"BUY","price":225.3}
 *
 * On each alert the bridge re-runs the local engine for that symbol so the
 * message carries the full step-by-step reasoning (not just "BUY"), logs it,
 * and — if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are in the environment —
 * relays the breakdown to Telegram. It is intentionally standalone: no broker
 * keys, no SOL-bot config.
 */
import express from "express";
import { z } from "zod";
import { defaultProvider } from "../src/data/stockData.js";
import { analyze } from "../src/signals/engine.js";
import { formatSignal, summarize } from "../src/signals/format.js";
import { childLogger } from "../src/utils/logger.js";

const log = childLogger("tv-webhook");
const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.WEBHOOK_SECRET ?? "";

const AlertSchema = z.object({
  source: z.string().optional(),
  symbol: z.string().min(1).max(12),
  action: z.enum(["BUY", "SELL", "buy", "sell"]).transform((s) => s.toUpperCase()),
  price: z.union([z.number(), z.string()]).optional(),
  tf: z.string().optional(),
});

async function relayToTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    log.error({ err: (err as Error).message }, "telegram relay failed");
  }
}

const app = express();
app.use(express.json({ limit: "64kb" }));
// TradingView sometimes sends the alert as text/plain JSON — parse that too.
app.use(express.text({ type: ["text/*"], limit: "64kb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "chud tv-webhook" }));

app.post("/tradingview", async (req, res) => {
  if (SECRET && req.query.token !== SECRET) {
    return res.status(401).json({ error: "bad token" });
  }
  const body = typeof req.body === "string" ? safeJson(req.body) : req.body;
  const parsed = AlertSchema.safeParse(body);
  if (!parsed.success) {
    log.warn({ body }, "rejected malformed alert");
    return res.status(400).json({ error: "invalid alert payload", issues: parsed.error.issues });
  }
  const alert = parsed.data;
  log.info({ symbol: alert.symbol, action: alert.action, price: alert.price }, "alert received");

  // Enrich with the engine's own read so the notification is actionable.
  let message = `📡 TradingView alert: ${alert.action} ${alert.symbol}${alert.price ? ` @ ${alert.price}` : ""}`;
  try {
    const { h1, h4 } = await defaultProvider().getSeries(alert.symbol.toUpperCase());
    if (h1.length > 0) {
      const sig = analyze(alert.symbol.toUpperCase(), h1, h4);
      log.info(summarize(sig));
      message = `📡 ${alert.symbol} — TradingView says ${alert.action}\n\n${formatSignal(sig)}`;
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, "could not enrich alert with local analysis");
  }

  await relayToTelegram(message);
  res.json({ ok: true });
});

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

app.listen(PORT, () => {
  log.info(`TradingView webhook listening on http://0.0.0.0:${PORT}/tradingview`);
  if (!SECRET) log.warn("WEBHOOK_SECRET not set — anyone who can reach this port can post alerts");
  if (!process.env.TELEGRAM_BOT_TOKEN) log.warn("TELEGRAM_BOT_TOKEN not set — alerts will log only, not relay to Telegram");
});
