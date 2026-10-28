import express, { type Express } from "express";
import type { OutreachConfig } from "./config.js";
import { parseWebhookPayload, verifyWebhookSignature } from "./facebook.js";
import type { OutreachAgent } from "./agent.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("outreach-webhook");

/**
 * /health for your host's uptime checks, plus the optional Meta webhook.
 * Webhooks make replies near-instant; without them the agent still answers
 * via polling every OUTREACH_POLL_INTERVAL_SEC.
 */
export function createOutreachServer(agent: OutreachAgent, cfg: OutreachConfig): Express {
  const app = express();
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true, stats: agent.state.stats, pendingReplies: agent.state.pending().length });
  });

  // Meta's one-time subscription handshake.
  app.get("/webhook", (req, res) => {
    const ok = req.query["hub.mode"] === "subscribe" && cfg.FB_VERIFY_TOKEN && req.query["hub.verify_token"] === cfg.FB_VERIFY_TOKEN;
    if (ok) res.status(200).send(String(req.query["hub.challenge"] ?? ""));
    else res.sendStatus(403);
  });

  app.post("/webhook", (req, res) => {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    if (!verifyWebhookSignature(rawBody, req.header("x-hub-signature-256"), cfg.FB_APP_SECRET)) {
      res.sendStatus(401);
      return;
    }
    // Ack immediately — Meta retries (and eventually disables the hook) on slow responses.
    res.sendStatus(200);
    for (const event of parseWebhookPayload(req.body, cfg.FB_PAGE_ID)) {
      agent.handleInbound(event).catch((err: Error) => log.error({ err: err.message }, "webhook event failed; polling will retry"));
    }
  });

  return app;
}
