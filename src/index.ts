import { exec } from "node:child_process";
import { Agent } from "./agent/agent.js";
import { env, isLoopbackHost } from "./config/env.js";
import { SettingsStore } from "./config/settings.js";
import { openDb } from "./db/db.js";
import { Repo } from "./db/repo.js";
import { createApp } from "./server/app.js";
import { logger } from "./utils/logger.js";

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => undefined); // best effort — headless servers simply have no browser
}

async function main(): Promise<void> {
  if (!isLoopbackHost(env.HOST) && !env.APP_PASSWORD) {
    logger.fatal(`HOST=${env.HOST} exposes the app to the network — set APP_PASSWORD to protect it.`);
    process.exit(1);
  }

  const repo = new Repo(openDb(env.DB_PATH));
  const settings = new SettingsStore(repo);
  const agent = new Agent(repo, settings);
  const app = createApp({ repo, settings, agent, password: env.APP_PASSWORD || undefined });

  const server = app.listen(env.PORT, env.HOST, () => {
    const url = `http://${isLoopbackHost(env.HOST) ? "localhost" : env.HOST}:${env.PORT}`;
    logger.info(`Outreach Agent is running → ${url}`);
    if (env.OPEN_BROWSER && isLoopbackHost(env.HOST) && process.stdout.isTTY) openBrowser(url);
  });

  agent.startBackground();
  // Resume where we left off: if it was running before a restart (or auto-start is on), keep hunting.
  const wasRunning = repo.getKv("agentRunning");
  if (wasRunning === "true" || (wasRunning === null && settings.get().autoStart)) agent.start();

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    agent.stopAll();
    server.close(() => {
      repo.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));
}

void main();
