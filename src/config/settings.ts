import type { Repo } from "../db/repo.js";

/**
 * Everything the agent does is driven by these settings. Defaults come from
 * env vars (handy for Docker), and anything saved from the app's Settings
 * page overrides them — so a non-technical user never has to touch .env.
 */
type FieldType = "text" | "textarea" | "number" | "bool" | "secret" | "list";

export interface SettingDef {
  key: string;
  env: string;
  label: string;
  type: FieldType;
  group: string;
  default: string;
  help?: string;
}

export const SETTING_DEFS: SettingDef[] = [
  // --- Agent ---
  { key: "niches", env: "NICHES", label: "Niches to hunt", type: "list", group: "Agent", default: "candles, skincare, pet supplies, jewelry, coffee, fitness apparel, home decor, supplements", help: "Comma-separated. The agent rotates through these, one per cycle." },
  { key: "sources", env: "SOURCES", label: "Lead sources", type: "list", group: "Agent", default: "shopify_search, shopify_ct, meta_ads", help: "shopify_search (needs Brave key), shopify_ct (keyless), meta_ads (needs Meta token)." },
  { key: "cycleMinutes", env: "CYCLE_MINUTES", label: "Minutes between cycles", type: "number", group: "Agent", default: "30" },
  { key: "leadsPerCycle", env: "LEADS_PER_CYCLE", label: "New leads per cycle (per source)", type: "number", group: "Agent", default: "15" },
  { key: "autoStart", env: "AUTO_START", label: "Start the agent automatically when the app opens", type: "bool", group: "Agent", default: "true" },
  { key: "minScore", env: "MIN_SCORE", label: "Minimum opportunity score to draft (0–100)", type: "number", group: "Agent", default: "25" },
  { key: "metaCountries", env: "META_COUNTRIES", label: "Meta Ad Library countries", type: "list", group: "Agent", default: "IE, MT, NL, DE, FR", help: "Meta's API only returns commercial (non-political) ads delivered in the EU. IE and MT are English-speaking." },

  // --- API keys ---
  { key: "groqApiKey", env: "GROQ_API_KEY", label: "Groq API key (AI writing — free)", type: "secret", group: "API keys", default: "", help: "console.groq.com → API Keys. Without it, emails use the built-in template writer." },
  { key: "groqModel", env: "GROQ_MODEL", label: "Groq model", type: "text", group: "API keys", default: "llama-3.3-70b-versatile" },
  { key: "groqBaseUrl", env: "GROQ_BASE_URL", label: "Groq base URL", type: "text", group: "API keys", default: "https://api.groq.com/openai/v1" },
  { key: "braveApiKey", env: "BRAVE_API_KEY", label: "Brave Search API key (Shopify discovery)", type: "secret", group: "API keys", default: "", help: "api-dashboard.search.brave.com — free tier." },
  { key: "metaAccessToken", env: "META_ACCESS_TOKEN", label: "Meta Ad Library access token", type: "secret", group: "API keys", default: "", help: "developers.facebook.com → Ad Library API (identity-verified account)." },
  { key: "pagespeedEnabled", env: "PAGESPEED_ENABLED", label: "Measure mobile speed with Google PageSpeed", type: "bool", group: "API keys", default: "true" },
  { key: "pagespeedApiKey", env: "PAGESPEED_API_KEY", label: "PageSpeed API key (optional, raises limits)", type: "secret", group: "API keys", default: "" },

  // --- You / the offer ---
  { key: "senderName", env: "SENDER_NAME", label: "Your name", type: "text", group: "Your business", default: "" },
  { key: "senderCompany", env: "SENDER_COMPANY", label: "Company", type: "text", group: "Your business", default: "" },
  { key: "senderTitle", env: "SENDER_TITLE", label: "Your title", type: "text", group: "Your business", default: "" },
  { key: "senderPhone", env: "SENDER_PHONE", label: "Phone", type: "text", group: "Your business", default: "" },
  { key: "senderWebsite", env: "SENDER_WEBSITE", label: "Website", type: "text", group: "Your business", default: "" },
  { key: "senderAddress", env: "SENDER_ADDRESS", label: "Physical mailing address (required by CAN-SPAM)", type: "text", group: "Your business", default: "" },
  { key: "senderProof", env: "SENDER_PROOF", label: "Proof line (a real result)", type: "textarea", group: "Your business", default: "", help: "e.g. \"We took a Shopify candle brand from 1.1% to 2.4% conversion in 6 weeks.\" Used verbatim — never invented." },
  { key: "bookingUrl", env: "BOOKING_URL", label: "Booking link (optional)", type: "text", group: "Your business", default: "" },
  { key: "offerWebsite", env: "OFFER_WEBSITE", label: "Website offer", type: "textarea", group: "Your business", default: "We design and build fast, mobile-first websites that turn visitors into calls and orders — typically live in 2–3 weeks." },
  { key: "offerAds", env: "OFFER_ADS", label: "Ad management offer", type: "textarea", group: "Your business", default: "We run and fix Meta/Google ads: proper pixel and conversion tracking, fresh creatives, and landing pages built to convert the traffic you're paying for." },
  { key: "offerCro", env: "OFFER_CRO", label: "Shopify CRO offer", type: "textarea", group: "Your business", default: "We speed up and optimize Shopify stores — modern theme, faster mobile load, reviews, email capture and a smoother checkout path — so more visitors buy." },

  // --- Email sending ---
  { key: "fromEmail", env: "FROM_EMAIL", label: "From email", type: "text", group: "Email sending", default: "" },
  { key: "smtpHost", env: "SMTP_HOST", label: "SMTP host", type: "text", group: "Email sending", default: "smtp.gmail.com" },
  { key: "smtpPort", env: "SMTP_PORT", label: "SMTP port", type: "number", group: "Email sending", default: "465" },
  { key: "smtpSecure", env: "SMTP_SECURE", label: "Use SSL/TLS (port 465)", type: "bool", group: "Email sending", default: "true" },
  { key: "smtpUser", env: "SMTP_USER", label: "SMTP username", type: "text", group: "Email sending", default: "" },
  { key: "smtpPass", env: "SMTP_PASS", label: "SMTP password / app password", type: "secret", group: "Email sending", default: "", help: "For Gmail: Google Account → Security → App passwords." },
  { key: "dailyCap", env: "DAILY_CAP", label: "Max emails per day", type: "number", group: "Email sending", default: "30", help: "Keep low (20–40) on a fresh mailbox to protect deliverability." },
  { key: "followupDays", env: "FOLLOWUP_DAYS", label: "Follow-up schedule (days after previous email)", type: "list", group: "Email sending", default: "3, 4" },
  { key: "sendWindow", env: "SEND_WINDOW", label: "Send window (24h, server time)", type: "text", group: "Email sending", default: "08-18", help: "Approved emails only go out inside this window, Mon–Fri." },

  // --- Reply detection ---
  { key: "imapHost", env: "IMAP_HOST", label: "IMAP host (reply detection)", type: "text", group: "Reply detection", default: "imap.gmail.com" },
  { key: "imapPort", env: "IMAP_PORT", label: "IMAP port", type: "number", group: "Reply detection", default: "993" },
  { key: "imapUser", env: "IMAP_USER", label: "IMAP username (blank = same as SMTP)", type: "text", group: "Reply detection", default: "" },
  { key: "imapPass", env: "IMAP_PASS", label: "IMAP password (blank = same as SMTP)", type: "secret", group: "Reply detection", default: "" },

  // --- Notifications ---
  { key: "telegramBotToken", env: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", type: "secret", group: "Notifications", default: "" },
  { key: "telegramChatId", env: "TELEGRAM_CHAT_ID", label: "Telegram chat ID", type: "text", group: "Notifications", default: "" },
  { key: "appUrl", env: "APP_URL", label: "Public URL of this app (for links in alerts)", type: "text", group: "Notifications", default: "" },
];

export interface Settings {
  niches: string[];
  sources: string[];
  cycleMinutes: number;
  leadsPerCycle: number;
  autoStart: boolean;
  minScore: number;
  metaCountries: string[];
  groqApiKey: string;
  groqModel: string;
  groqBaseUrl: string;
  braveApiKey: string;
  metaAccessToken: string;
  pagespeedEnabled: boolean;
  pagespeedApiKey: string;
  senderName: string;
  senderCompany: string;
  senderTitle: string;
  senderPhone: string;
  senderWebsite: string;
  senderAddress: string;
  senderProof: string;
  bookingUrl: string;
  offerWebsite: string;
  offerAds: string;
  offerCro: string;
  fromEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  dailyCap: number;
  followupDays: number[];
  sendWindow: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  telegramBotToken: string;
  telegramChatId: string;
  appUrl: string;
}

const SECRET_MASK = "••••••••";

function parse(def: SettingDef, raw: string): unknown {
  switch (def.type) {
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : Number(def.default);
    }
    case "bool":
      return raw.toLowerCase() === "true";
    case "list": {
      const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
      return def.key === "followupDays" ? items.map(Number).filter((n) => Number.isFinite(n) && n > 0) : items;
    }
    default:
      return raw;
  }
}

export class SettingsStore {
  private cache: Settings | null = null;

  constructor(private readonly repo: Repo) {}

  private rawValues(): Record<string, string> {
    const saved = Object.fromEntries(
      (this.repo.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]),
    );
    const out: Record<string, string> = {};
    for (const def of SETTING_DEFS) {
      out[def.key] = saved[def.key] ?? process.env[def.env] ?? def.default;
    }
    return out;
  }

  get(): Settings {
    if (this.cache) return this.cache;
    const raw = this.rawValues();
    const out: Record<string, unknown> = {};
    for (const def of SETTING_DEFS) out[def.key] = parse(def, raw[def.key] ?? def.default);
    this.cache = out as unknown as Settings;
    return this.cache;
  }

  /** For the Settings page: secrets are masked, never sent to the browser. */
  forUi(): { defs: SettingDef[]; values: Record<string, string> } {
    const raw = this.rawValues();
    const values: Record<string, string> = {};
    for (const def of SETTING_DEFS) {
      const v = raw[def.key] ?? "";
      values[def.key] = def.type === "secret" ? (v ? SECRET_MASK : "") : v;
    }
    return { defs: SETTING_DEFS, values };
  }

  /** Saves values from the Settings page. Masked secrets are left unchanged. */
  save(values: Record<string, unknown>): void {
    const upsert = this.repo.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const tx = this.repo.db.transaction(() => {
      for (const def of SETTING_DEFS) {
        if (!(def.key in values)) continue;
        const v = String(values[def.key] ?? "").trim();
        if (def.type === "secret" && v === SECRET_MASK) continue;
        upsert.run(def.key, v);
      }
    });
    tx();
    this.cache = null;
  }

  /** What's missing before the agent can run end-to-end — shown as a setup checklist. */
  setupChecklist(): { id: string; label: string; done: boolean; required: boolean }[] {
    const s = this.get();
    return [
      { id: "sender", label: "Add your name, company and mailing address", done: Boolean(s.senderName && s.senderCompany && s.senderAddress), required: true },
      { id: "source", label: "Add a lead source key (Brave and/or Meta) — or rely on the keyless Shopify CT source", done: Boolean(s.braveApiKey || s.metaAccessToken), required: false },
      { id: "ai", label: "Add a free Groq key for AI-written emails", done: Boolean(s.groqApiKey), required: false },
      { id: "smtp", label: "Connect your email (SMTP) so approved emails can send", done: Boolean(s.smtpHost && s.smtpUser && s.smtpPass && (s.fromEmail || s.smtpUser)), required: true },
      { id: "proof", label: "Add a proof line (a real result) to strengthen emails", done: Boolean(s.senderProof), required: false },
    ];
  }
}
