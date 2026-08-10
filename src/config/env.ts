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
  // Minimum gap between Birdeye requests, to stay under the free tier's
  // rate limit (raise if you still see 429s; lower on a paid plan).
  BIRDEYE_MIN_REQUEST_INTERVAL_MS: numFromString(1200),

  // Token discovery source:
  //  "graduated" (default) — tokens graduating to a DEX (~$69k), the
  //     established ">$50k runners" the strategy targets. These are the
  //     tokens the pipeline can actually EVALUATE and TRADE: they're on a
  //     DEX so Birdeye has real OHLCV/liquidity for them, their authorities
  //     are usually revoked, and the lower volume sidesteps the free-RPC/
  //     Birdeye rate limits. Brand-new creations (below) have none of that.
  //  "pumpportal" — brand-new pump.fun token creations (~$5k). High volume
  //     but tiny, no Birdeye OHLCV, and mostly rugs — hard to evaluate or
  //     trade. Use only if you specifically want new-mint exposure.
  //  "pumpfun" — pump.fun's Cloudflare-gated HTTP endpoint (unreliable).
  SCANNER_SOURCE: z.enum(["pumpportal", "graduated", "pumpfun"]).default("graduated"),
  PUMPPORTAL_WS_URL: z.string().default("wss://pumpportal.fun/api/data"),
  PUMPFUN_BASE_URL: z.string().default("https://frontend-api.pump.fun"),
  PUMPFUN_SCAN_INTERVAL_MS: numFromString(200),

  // Whale wallet tracking polls the Solana RPC (SOLANA_RPC_URL below). It
  // defaults to OFF because the free public RPC endpoint is heavily
  // rate-limited and produces a storm of 429s when polling many wallets.
  // To use it: point SOLANA_RPC_URL at a real RPC (e.g. a free Helius RPC
  // key) and set WHALE_TRACKING_ENABLED=true. WHALE_POLL_INTERVAL_MS is
  // deliberately conservative to reduce throttling.
  WHALE_TRACKING_ENABLED: boolFromString(false),
  WHALE_POLL_INTERVAL_MS: numFromString(60_000),
  // Minimum gap between Solana RPC calls (the on-chain safety check uses
  // them). The free public RPC rate-limits hard; raise if you see 429s, or
  // point SOLANA_RPC_URL at a free Helius RPC key for much higher limits.
  SOLANA_RPC_MIN_REQUEST_INTERVAL_MS: numFromString(400),

  NEWSAPI_KEY: z.string().optional().default(""),
  NEWSAPI_BASE_URL: z.string().default("https://newsapi.org/v2"),

  JUPITER_BASE_URL: z.string().default("https://quote-api.jup.ag/v6"),
  SOLANA_RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),

  WALLET_PRIVATE_KEY: z.string().optional().default(""),

  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),

  LIVE_TRADING: boolFromString(false),

  // --- Paper realism & go-live gating ---
  // Round-trip execution cost applied to every PAPER exit (and each partial
  // take-profit leg), modeling Jupiter route fees + slippage on thin
  // memecoin liquidity + Solana priority fees. Without this, paper P&L fills
  // at the perfect quoted price and a losing strategy can look "profitable"
  // — the exact false positive that pushes you live into a loss. Applied
  // per sell leg, so it's slightly conservative on scale-outs (biased toward
  // NOT going live on a marginal edge, which is the safe direction).
  PAPER_TRADING_COST_PCT: numFromString(0.04), // ~4% round-trip; raise for thinner tokens
  // Objective go-live bar (see evaluateGoLiveReadiness). The paper /stats
  // must clear ALL of these before it's honest to risk real money.
  GO_LIVE_MIN_TRADES: numFromString(30), // minimum closed trades for statistical meaning
  GO_LIVE_MIN_EXPECTANCY_PCT: numFromString(1), // required expectancy per trade, AFTER costs (%)
  // Daily digest: the bot pushes a once-a-<interval> summary to Telegram —
  // go-live gate status + progress toward GO_LIVE_MIN_TRADES — so you can
  // watch it daily without polling. Needs TELEGRAM_* set.
  DAILY_DIGEST_ENABLED: boolFromString(true),
  DAILY_DIGEST_INTERVAL_HOURS: numFromString(24),
  // Auto-calibration: the bot reads its own realized win rate per confidence
  // bucket and RAISES the confidence gate to exclude levels that have been
  // losing money — never below CONFIDENCE_THRESHOLD, and only after enough
  // data. This is the feedback loop that turns /stats into self-improvement.
  ADAPTIVE_CONFIDENCE_ENABLED: boolFromString(true),
  ADAPTIVE_CONFIDENCE_MIN_SAMPLE: numFromString(20), // don't adapt until this many closed trades
  ADAPTIVE_CONFIDENCE_MIN_BUCKET: numFromString(5), // ignore buckets with fewer trades than this (too noisy)
  ADAPTIVE_CONFIDENCE_MARGIN_PCT: numFromString(5), // require win rate this many points ABOVE breakeven

  // Entry gates. Defaults are tuned for PAPER data-collection: permissive
  // enough that the pipeline actually takes trades (so /stats accumulates
  // and you learn whether the strategy has edge), while the hard rug checks
  // below stay strict. Tighten these before ever going live.
  MIN_MARKET_CAP_USD: numFromString(25_000), // was 50k; graduated tokens (~$69k) clear it, plus near-graduation runners
  CONFIDENCE_THRESHOLD: numFromString(0.6), // was 0.72; lower gate = more trades = more calibration data
  MAX_RISK_PCT_PER_TRADE: numFromString(0.02),
  STOP_LOSS_PCT: numFromString(0.2),
  TRAILING_STOP_PCT: numFromString(0.25),
  // Max hold. Lowered 48 -> 12 so trades close and hit the ledger faster,
  // accumulating the 30 closed trades the go-live gate needs in days instead
  // of weeks. NOTE: this changes the strategy you're validating (a 12h-hold
  // variant, not the original 48h). Set back to 48 to test the original.
  MAX_POSITION_AGE_HOURS: numFromString(12),
  MIN_SOL_RESERVE: numFromString(0.5),

  // --- Profit-taking / stop-tightening (exit-rule overhaul) ---
  // The original "no take-profit, let winners ride" rules had negative
  // expectancy in backtests: stops took full -20% losses while winners got
  // clipped small by the 48h max-hold. These add asymmetry back.
  //
  // Partial take-profit: once a position is up TAKE_PROFIT_PCT, sell
  // TAKE_PROFIT_SIZE_PCT of it to bank the gain, and let the rest ride the
  // trailing stop. Set TAKE_PROFIT_PCT=0 to disable (pure ride-the-trail).
  TAKE_PROFIT_PCT: numFromString(0.6), // +60% first target
  TAKE_PROFIT_SIZE_PCT: numFromString(0.5), // sell half at the target
  // Breakeven floor: once the peak is up BREAKEVEN_TRIGGER_PCT from entry (or
  // once partial profit is banked), the floor stop rises to breakeven so a
  // winner that reverses can't become a full loss. Kept high enough that a
  // normal first pullback doesn't scratch the trade out.
  BREAKEVEN_TRIGGER_PCT: numFromString(0.3), // +30% arms the breakeven floor
  // The trailing stop tightens to this ONLY after partial profit is banked —
  // before that it stays loose (TRAILING_STOP_PCT) so memecoin volatility
  // doesn't wick the position out before it reaches the take-profit target.
  TRAILING_STOP_TIGHT_PCT: numFromString(0.15), // tighter trail on the banked runner
  WHALE_WATCHLIST_SIZE: numFromString(50),

  // Rug/safety gate (src/safety/rugCheck.ts). These stay STRICT even in the
  // permissive paper posture — they're the hard rug protections, not tuning
  // knobs. The authority + concentration checks are what stop "one wallet
  // funded the whole supply" tokens; keep them on.
  REQUIRE_MINT_AUTHORITY_REVOKED: boolFromString(true),
  REQUIRE_FREEZE_AUTHORITY_REVOKED: boolFromString(true),
  MAX_TOP10_HOLDER_PCT: numFromString(0.6), // concentration cap: no single cabal owning the float
  MAX_CREATOR_PCT: numFromString(0.15), // creator can't be sitting on a dump-ready bag
  BLOCK_TOKEN2022_TRANSFER_FEE: boolFromString(true),
  MIN_LIQUIDITY_USD: numFromString(4_000), // was 10k; lower so more real tokens clear (paper: no slippage cost anyway)

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
