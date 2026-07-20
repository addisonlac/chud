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

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional().default(""),
  SENTIMENT_MODEL: z.string().default("claude-sonnet-5"),
  SCORING_MODEL: z.string().default("claude-opus-4-8"),

  BIRDEYE_API_KEY: z.string().optional().default(""),
  BIRDEYE_BASE_URL: z.string().default("https://public-api.birdeye.so"),

  PUMPFUN_BASE_URL: z.string().default("https://frontend-api.pump.fun"),
  PUMPFUN_SCAN_INTERVAL_MS: numFromString(500),

  HELIUS_API_KEY: z.string().optional().default(""),
  HELIUS_RPC_URL: z.string().default("https://mainnet.helius-rpc.com"),
  HELIUS_WEBHOOK_SECRET: z.string().optional().default(""),
  HELIUS_WEBHOOK_URL: z.string().optional().default(""),

  NEWSAPI_KEY: z.string().optional().default(""),
  NEWSAPI_BASE_URL: z.string().default("https://newsapi.org/v2"),

  JUPITER_BASE_URL: z.string().default("https://quote-api.jup.ag/v6"),
  SOLANA_RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),

  WALLET_PRIVATE_KEY: z.string().optional().default(""),

  LIVE_TRADING: boolFromString(false),

  MIN_MARKET_CAP_USD: numFromString(50_000),
  CONFIDENCE_THRESHOLD: numFromString(0.72),
  MAX_RISK_PCT_PER_TRADE: numFromString(0.02),
  STOP_LOSS_PCT: numFromString(0.2),
  TRAILING_STOP_PCT: numFromString(0.25),
  MAX_POSITION_AGE_HOURS: numFromString(48),
  MIN_SOL_RESERVE: numFromString(0.5),
  WHALE_WATCHLIST_SIZE: numFromString(50),

  // Rug/safety gate (src/safety/rugCheck.ts)
  REQUIRE_MINT_AUTHORITY_REVOKED: boolFromString(true),
  REQUIRE_FREEZE_AUTHORITY_REVOKED: boolFromString(true),
  MAX_TOP10_HOLDER_PCT: numFromString(0.6),
  MAX_CREATOR_PCT: numFromString(0.15),
  BLOCK_TOKEN2022_TRANSFER_FEE: boolFromString(true),
  MIN_LIQUIDITY_USD: numFromString(10_000),

  PORT: numFromString(3000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;

export type Env = typeof env;

/**
 * Fails fast on startup when a mode requires credentials that aren't set,
 * instead of discovering it mid-pipeline (e.g. a silent 401 loop).
 */
export function assertRequiredConfig(): string[] {
  const missing: string[] = [];

  if (!env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!env.BIRDEYE_API_KEY) missing.push("BIRDEYE_API_KEY");
  if (!env.HELIUS_API_KEY) missing.push("HELIUS_API_KEY");
  if (!env.NEWSAPI_KEY) missing.push("NEWSAPI_KEY");

  if (env.LIVE_TRADING && !env.WALLET_PRIVATE_KEY) {
    missing.push("WALLET_PRIVATE_KEY (required because LIVE_TRADING=true)");
  }

  return missing;
}
