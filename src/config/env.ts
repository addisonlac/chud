import "dotenv/config";
import { z } from "zod";

const boolFromString = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : v.toLowerCase() === "true"));

const numFromString = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : Number(v)));

/**
 * Process-level settings: how the app itself boots. Everything about *what
 * the agent does* (API keys, niches, sender profile, SMTP...) lives in
 * src/config/settings.ts so it can be edited from the app's Settings page;
 * env vars only seed those defaults.
 */
const envSchema = z.object({
  PORT: numFromString(3000),
  // 127.0.0.1 keeps the dashboard private to this machine. Set 0.0.0.0 on a
  // server (Docker does) — APP_PASSWORD is then mandatory.
  HOST: z.string().default("127.0.0.1"),
  APP_PASSWORD: z.string().optional().default(""),
  DB_PATH: z.string().default("data/outreach.db"),
  OPEN_BROWSER: boolFromString(true),
  LOG_LEVEL: z.string().default("info"),
});

export const env = envSchema.parse(process.env);
export type Env = typeof env;

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
