import { fetchJson, fetchText } from "../utils/http.js";
import { normalizeDomain } from "../db/repo.js";
import { isSocialHost } from "../fingerprint/platform.js";
import type { DiscoveredLead } from "../types.js";

const SKIP_DOMAINS = [
  "shopify.com",
  "shopify.dev",
  "amazon.",
  "etsy.com",
  "ebay.",
  "walmart.com",
  "reddit.com",
  "pinterest.",
  "youtube.com",
  "wikipedia.org",
  "quora.com",
  "medium.com",
  "yelp.com",
  "tripadvisor.",
  "google.",
  "apple.com",
  "bing.com",
  "trustpilot.com",
  "linkedin.com",
  "builtwith.com",
  "storeleads.app",
  "myip.ms",
  "aliexpress.",
  "temu.com",
];

function isSkippable(domain: string): boolean {
  return isSocialHost(domain) || SKIP_DOMAINS.some((s) => domain.includes(s));
}

/** Search queries that surface Shopify stores in a niche. */
export function shopifyQueries(niche: string): string[] {
  return [
    `${niche} site:myshopify.com`,
    `${niche} "powered by shopify"`,
    `${niche} shop inurl:collections/all`,
    `buy ${niche} online inurl:products`,
  ];
}

interface BraveResponse {
  web?: { results?: { url: string; title: string }[] };
}

/** Brave Search API (free tier) → candidate store domains. */
export async function discoverViaBrave(
  apiKey: string,
  niche: string,
  page: number,
  limit: number,
): Promise<DiscoveredLead[]> {
  const out = new Map<string, DiscoveredLead>();
  const queries = shopifyQueries(niche);
  const query = queries[page % queries.length]!;
  const offset = Math.floor(page / queries.length) % 9; // Brave allows offset 0–9

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20&offset=${offset}`;
  const res = await fetchJson<BraveResponse>(url, {
    headers: { accept: "application/json", "x-subscription-token": apiKey },
    timeoutMs: 15_000,
  });
  for (const r of res.web?.results ?? []) {
    const domain = normalizeDomain(r.url);
    if (!domain || isSkippable(domain) || out.has(domain)) continue;
    const name = cleanTitle(r.title, domain);
    out.set(domain, { name, source: "shopify_search", niche, websiteUrl: `https://${domain}` });
    if (out.size >= limit) break;
  }
  return [...out.values()];
}

interface CrtShEntry {
  name_value: string;
  entry_timestamp?: string;
}

/**
 * Keyless discovery from Certificate Transparency logs: every Shopify store
 * gets a TLS cert for <handle>.myshopify.com, and handles usually contain
 * the brand/niche word. We then resolve each handle to its real domain.
 */
export async function discoverViaCertificates(
  niche: string,
  limit: number,
  seen: (handle: string) => boolean,
  markSeen: (handle: string) => void = () => {},
): Promise<DiscoveredLead[]> {
  const keyword = niche.toLowerCase().split(/\s+/)[0]!.replace(/[^a-z0-9]/g, "").replace(/s$/, "");
  if (keyword.length < 3) return [];
  const entries = await fetchJson<CrtShEntry[]>(
    `https://crt.sh/?q=${encodeURIComponent(`%${keyword}%.myshopify.com`)}&output=json&exclude=expired`,
    { timeoutMs: 60_000, retries: 1, retryDelayMs: 3000 },
  );

  const handles = new Set<string>();
  const sorted = [...entries].sort((a, b) => (b.entry_timestamp ?? "").localeCompare(a.entry_timestamp ?? ""));
  for (const e of sorted) {
    for (const name of e.name_value.split("\n")) {
      const m = /^([a-z0-9-]+)\.myshopify\.com$/.exec(name.trim().toLowerCase());
      if (m && !seen(m[1]!)) handles.add(m[1]!);
    }
  }

  const out: DiscoveredLead[] = [];
  for (const handle of handles) {
    if (out.length >= limit) break;
    markSeen(handle);
    const resolved = await resolveMyshopify(handle).catch(() => null);
    if (!resolved) continue;
    out.push({ name: resolved.name, source: "shopify_ct", niche, websiteUrl: resolved.url });
  }
  return out;
}

/** <handle>.myshopify.com redirects to the store's primary domain. Skips password-protected/closed stores. */
async function resolveMyshopify(handle: string): Promise<{ url: string; name: string } | null> {
  const res = await fetchText(`https://${handle}.myshopify.com/`, { timeoutMs: 12_000 });
  if (!res.ok || /\/password\b/.test(res.url) || /store (is )?unavailable|opening soon/i.test(res.html.slice(0, 5000))) return null;
  const domain = normalizeDomain(res.url);
  if (!domain) return null;
  const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(res.html)?.[1]?.trim() ?? handle;
  return { url: res.url.replace(/\/$/, ""), name: cleanTitle(title, domain) };
}

/** "Hand-Poured Soy Candles – Lumen & Co" → "Lumen & Co" (best guess at the brand). */
export function cleanTitle(title: string, domain: string): string {
  const decoded = title.replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').trim();
  const parts = decoded.split(/\s+[|–—-]\s+|\s*:\s+/).map((p) => p.trim()).filter(Boolean);
  const brandFromDomain = domain.split(".")[0]!.replace(/-/g, " ");
  const match = parts.find((p) => p.toLowerCase().replace(/[^a-z0-9]/g, "").includes(brandFromDomain.replace(/\s/g, "")));
  const pick = match ?? (parts.length > 1 ? parts[parts.length - 1]! : parts[0]);
  if (pick && pick.length <= 50) return pick;
  return brandFromDomain.replace(/\b\w/g, (c) => c.toUpperCase());
}
