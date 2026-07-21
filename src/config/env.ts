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
  // Groq's OpenAI-compatible API, free tier — no payment method required.
  // Model IDs rotate over time; check console.groq.com/docs/models if
  // these defaults 404.
  GROQ_API_KEY: z.string().optional().default(""),
  GROQ_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),
  SENTIMENT_MODEL: z.string().default("llama-3.1-8b-instant"),
  SCORING_MODEL: z.string().default("llama-3.3-70b-versatile"),

  BIRDEYE_API_KEY: z.string().optional().default(""),
  BIRDEYE_BASE_URL: z.string().default("https://public-api.birdeye.so"),

  // Token discovery source. "pumpportal" (default) streams new pump.fun
  // tokens over a WebSocket built for bots — reliable and free. "pumpfun"
  // polls pump.fun's unofficial HTTP endpoint, which sits behind Cloudflare
  // and frequently returns HTTP 530/403 to non-browser traffic.
  SCANNER_SOURCE: z.enum(["pumpportal", "pumpfun"]).default("pumpportal"),
  PUMPPORTAL_WS_URL: z.string().default("wss://pumpportal.fun/api/data"),
  PUMPFUN_BASE_URL: z.string().default("https://frontend-api.pump.fun"),
  PUMPFUN_SCAN_INTERVAL_MS: numFromString(200),

  // Whale wallet tracking polls the free public Solana RPC (SOLANA_RPC_URL
  // below) instead of Helius webhooks. WHALE_POLL_INTERVAL_MS is
  // deliberately conservative — the public endpoint is shared/rate-limited.
  WHALE_POLL_INTERVAL_MS: numFromString(60_000),

  NEWSAPI_KEY: z.string().optional().default(""),
  NEWSAPI_BASE_URL: z.string().default("https://newsapi.org/v2"),

  JUPITER_BASE_URL: z.string().default("https://quote-api.jup.ag/v6"),
  SOLANA_RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),

  WALLET_PRIVATE_KEY: z.string().optional().default(""),

  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),

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

  if (!env.GROQ_API_KEY) missing.push("GROQ_API_KEY");
  if (!env.BIRDEYE_API_KEY) missing.push("BIRDEYE_API_KEY");
  if (!env.NEWSAPI_KEY) missing.push("NEWSAPI_KEY");

  if (env.LIVE_TRADING && !env.WALLET_PRIVATE_KEY) {
    missing.push("WALLET_PRIVATE_KEY (required because LIVE_TRADING=true)");
  }

  return missing;
}
