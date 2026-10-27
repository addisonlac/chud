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
 * Config for the Facebook outreach agent. Kept separate from the trading
 * bot's env so running `npm run outreach` never requires Birdeye/Solana keys.
 * GROQ_API_KEY / TELEGRAM_* are shared with the bot via src/config/env.ts.
 */
const outreachSchema = z.object({
  // --- Your business (fed into every AI-written message) ---
  BUSINESS_NAME: z.string().default("My Web Studio"),
  BUSINESS_OWNER_NAME: z.string().default(""), // signs off messages, e.g. "Jai"
  BUSINESS_OFFER: z
    .string()
    .default("custom, mobile-friendly websites for local businesses, launched in about a week"),
  BUSINESS_PRICE_HINT: z.string().default(""), // e.g. "sites from $499" — leave blank to not mention price
  BUSINESS_PORTFOLIO_URL: z.string().default(""),
  BUSINESS_CONTACT: z.string().default(""), // phone/email/booking link used as the CTA

  // --- Facebook (Meta Graph API, Page-level access) ---
  // Page ID + a long-lived Page access token with pages_manage_posts,
  // pages_read_engagement, pages_manage_engagement and pages_messaging.
  FB_PAGE_ID: z.string().default(""),
  FB_PAGE_ACCESS_TOKEN: z.string().default(""),
  FB_APP_SECRET: z.string().default(""), // verifies webhook signatures
  FB_VERIFY_TOKEN: z.string().default(""), // any random string; also entered in the Meta app dashboard
  FB_GRAPH_VERSION: z.string().default("v23.0"),
  FB_GRAPH_BASE_URL: z.string().default("https://graph.facebook.com"),
  // When true (default) the agent answers inbound Page messages and comments
  // on its own. Set false to have replies wait in the inbox for
  // `npm run outreach -- approve <id>` instead.
  FB_AUTO_REPLY: boolFromString(true),
  // Also send ONE private Messenger reply to commenters the AI rates as hot
  // leads (Meta's sanctioned comment-to-DM path).
  FB_PRIVATE_REPLY_HOT_COMMENTS: boolFromString(true),

  // --- Lead finding (optional) ---
  // Google Places API (New) key. Lets `find` pull local businesses that have
  // NO website listed — the best prospects for a website-building service.
  GOOGLE_PLACES_API_KEY: z.string().default(""),

  // --- 24/7 daemon schedule (`npm run outreach:daemon`) ---
  // Searches to rotate through, one per lead-search cycle: "niche|city" pairs
  // separated by semicolons, e.g. "plumbers|Austin TX;hair salons|Austin TX".
  OUTREACH_TARGETS: z.string().default(""),
  OUTREACH_LEAD_SEARCH_INTERVAL_HOURS: numFromString(24),
  OUTREACH_POST_INTERVAL_HOURS: numFromString(48), // 0 disables auto-posting
  OUTREACH_POLL_INTERVAL_SEC: numFromString(120), // inbox/comment polling (works without webhooks)
  OUTREACH_DIGEST_INTERVAL_HOURS: numFromString(24), // Telegram summary + today's DM queue

  // --- Pacing ---
  // Max cold messages the queue hands you per day. Facebook flags accounts
  // that blast DMs; 15–25/day of genuinely personalized messages is safe.
  OUTREACH_DAILY_LIMIT: numFromString(20),
  OUTREACH_FOLLOWUP_DAYS: numFromString(4),
  OUTREACH_MAX_FOLLOWUPS: numFromString(2),
  OUTREACH_MODEL: z.string().default("llama-3.3-70b-versatile"),
  OUTREACH_PORT: numFromString(3100),
  OUTREACH_DATA_DIR: z.string().default("data"),
});

const parsed = outreachSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid outreach configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid outreach configuration");
}

export const outreachConfig = parsed.data;

export type OutreachConfig = typeof outreachConfig;

export interface OutreachTarget {
  niche: string;
  city: string;
}

export function parseTargets(raw: string): OutreachTarget[] {
  return raw
    .split(";")
    .map((t) => t.split("|").map((s) => s.trim()))
    .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]))
    .map(([niche, city]) => ({ niche, city }));
}

export function missingFacebookConfig(cfg: OutreachConfig = outreachConfig): string[] {
  const missing: string[] = [];
  if (!cfg.FB_PAGE_ID) missing.push("FB_PAGE_ID");
  if (!cfg.FB_PAGE_ACCESS_TOKEN) missing.push("FB_PAGE_ACCESS_TOKEN");
  return missing;
}
