import { outreachConfig, missingFacebookConfig, parseTargets } from "./config.js";
import { OutreachAgent } from "./agent.js";
import { createOutreachServer } from "./server.js";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("outreach");

/**
 * 24/7 entrypoint: `npm run outreach:daemon`. Starts the webhook/health
 * server and ticks the agent forever. Designed to be left running under
 * Docker (restart: unless-stopped), pm2, systemd, Railway, Render, etc.
 */
async function main(): Promise<void> {
  const cfg = outreachConfig;
  const agent = new OutreachAgent(cfg);

  const missingFb = missingFacebookConfig(cfg);
  if (missingFb.length) log.warn({ missing: missingFb }, "Facebook not configured — inbound replies and Page posts are OFF");
  if (!env.GROQ_API_KEY) log.warn("GROQ_API_KEY not set — using built-in message templates instead of AI-written ones");
  if (!cfg.GOOGLE_PLACES_API_KEY || parseTargets(cfg.OUTREACH_TARGETS).length === 0) {
    log.warn("GOOGLE_PLACES_API_KEY or OUTREACH_TARGETS not set — automatic prospect finding is OFF (CSV import still works)");
  }
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) log.warn("TELEGRAM_* not set — no hot-lead alerts or daily DM queue");

  // OUTREACH_PORT wins so a shared .env doesn't collide with the trading
  // bot's PORT; hosts like Render/Railway that only inject PORT still work.
  const port = process.env.OUTREACH_PORT ? cfg.OUTREACH_PORT : Number(process.env.PORT) || cfg.OUTREACH_PORT;
  const server = createOutreachServer(agent, cfg).listen(port, () => log.info({ port }, "outreach agent listening"));

  const intervalMs = Math.max(30, cfg.OUTREACH_POLL_INTERVAL_SEC) * 1000;
  await agent.tick();
  const timer = setInterval(() => void agent.tick(), intervalMs);
  log.info({ autoReply: cfg.FB_AUTO_REPLY, pollEverySec: intervalMs / 1000 }, "outreach agent running 24/7");

  const shutdown = () => {
    log.info("shutting down");
    clearInterval(timer);
    agent.state.save();
    agent.leads.save();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Last-resort guards: log and keep running rather than letting one stray
// rejection take the 24/7 process down.
process.on("unhandledRejection", (err) => log.error({ err: (err as Error)?.message }, "unhandled rejection"));

main().catch((err: Error) => {
  log.fatal({ err: err.message }, "outreach daemon failed to start");
  process.exit(1);
});
