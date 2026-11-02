import type { Finding } from "../types.js";

/** Shopify's pre-Online-Store-2.0 ("vintage") free themes. */
const VINTAGE_THEMES = [
  "debut",
  "brooklyn",
  "minimal",
  "narrative",
  "supply",
  "venture",
  "boundless",
  "simple",
  "express",
  "jumpstart",
  "pop",
  "kagami",
  "launch",
  "lookbook",
  "classic",
  "new standard",
];

const REVIEW_APPS = ["judge.me", "judgeme", "jdgm", "loox", "yotpo", "stamped.io", "okendo", "reviews.io", "junip", "rivyo", "product-reviews", "spr-badge", "ali-reviews", "trustoo", "air reviews", "opinew", "fera.ai", "trustpilot"];
const EMAIL_APPS = ["klaviyo", "omnisend", "privy", "mailchimp", "justuno", "drip.com", "attentive", "postscript", "sendlane", "seguno", "shopify-forms", "contact[tags]", "newsletter"];

export interface ShopifyProductsSummary {
  count: number; // products returned (max 250 per page)
  newestPublished: string | null;
}

export interface ShopifyAuditInput {
  html: string;
  domain: string;
  products?: ShopifyProductsSummary | null;
  now?: Date;
}

export function parseShopifyTheme(html: string): string | null {
  const block = /Shopify\.theme\s*=\s*(\{[^;]*?\});/.exec(html)?.[1];
  if (!block) return null;
  const schema = /"schema_name"\s*:\s*"([^"]+)"/.exec(block)?.[1];
  const name = /"name"\s*:\s*"([^"]+)"/.exec(block)?.[1];
  return (schema && schema !== "null" ? schema : name) ?? null;
}

export function isVintageTheme(theme: string): boolean {
  const t = theme.toLowerCase().trim();
  return VINTAGE_THEMES.some((v) => t === v || t.startsWith(`${v} `) || t.startsWith(`${v}-`));
}

/** Number of app scripts Shopify's asyncLoad injects (each one adds weight to every page). */
export function countAppScripts(html: string): number {
  const m = /var\s+urls\s*=\s*\[([\s\S]*?)\]\s*;/.exec(html);
  if (!m) return 0;
  return (m[1]!.match(/https?:\\?\/\\?\//g) ?? []).length;
}

export function analyzeShopify(input: ShopifyAuditInput): Finding[] {
  const { html, domain } = input;
  const now = input.now ?? new Date();
  const h = html.toLowerCase();
  const findings: Finding[] = [];

  const theme = parseShopifyTheme(html);
  if (theme && isVintageTheme(theme)) {
    findings.push({
      id: "vintage_theme",
      category: "cro",
      severity: 2,
      evidence: theme,
      pain: `The store is still on ${theme}, one of Shopify's older "vintage" themes — it's heavier on mobile and missing the Online Store 2.0 features (flexible sections, better product pages) that newer stores use to convert.`,
      fix: `Migrate to a modern Online Store 2.0 theme set up for your products, without losing your branding, SEO or apps.`,
    });
  }

  const apps = countAppScripts(html);
  if (apps >= 12) {
    findings.push({
      id: "app_bloat",
      category: "cro",
      severity: 2,
      evidence: `${apps} app scripts`,
      pain: `Every page on the store loads ${apps} separate app scripts — each one slows the page down a little, and together they add up to a store that feels sluggish on phones.`,
      fix: `An app audit: remove what you're not using, replace overlapping apps, and defer the rest so pages load fast.`,
    });
  }

  if (!REVIEW_APPS.some((a) => h.includes(a))) {
    findings.push({
      id: "no_reviews",
      category: "cro",
      severity: 2,
      evidence: "no product reviews",
      pain: `I couldn't find product reviews on the store — and most shoppers won't buy from a brand they don't know without seeing what other customers say.`,
      fix: `Set up reviews (with photo reviews and automatic review-request emails) and show them on product pages and the homepage.`,
    });
  }

  if (!EMAIL_APPS.some((a) => h.includes(a))) {
    findings.push({
      id: "no_email_capture",
      category: "cro",
      severity: 2,
      evidence: "no email signup",
      pain: `There's no email signup or popup on the store, so the large majority of visitors who don't buy on their first visit leave and never hear from you again.`,
      fix: `An email capture (welcome offer popup + footer signup) wired into abandoned-cart and welcome flows — usually the cheapest revenue a store can add.`,
    });
  }

  const newest = input.products?.newestPublished ? new Date(input.products.newestPublished) : null;
  if (newest && !Number.isNaN(newest.getTime()) && now.getTime() - newest.getTime() > 365 * 24 * 3600 * 1000) {
    const label = newest.toLocaleString("en-US", { month: "long", year: "numeric" });
    findings.push({
      id: "stale_catalog",
      category: "cro",
      severity: 1,
      evidence: label,
      pain: `The newest product on ${domain} was published in ${label}, so returning visitors don't see anything new to come back for.`,
      fix: `A simple merchandising plan — new arrivals, bundles and featured collections on the homepage — so the store feels alive.`,
    });
  }

  return findings;
}
