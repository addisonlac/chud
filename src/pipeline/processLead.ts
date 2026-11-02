import type { Settings } from "../config/settings.js";
import type { Repo } from "../db/repo.js";
import { normalizeDomain } from "../db/repo.js";
import { analyzeAds, trackingGapFinding } from "../audit/ads.js";
import { measureMobileSpeed } from "../audit/pagespeed.js";
import { analyzeShopify, type ShopifyProductsSummary } from "../audit/shopify.js";
import { analyzeWebsite, noWebsiteFinding, speedFindings, type SpeedResult } from "../audit/website.js";
import { findContacts } from "../contacts/extract.js";
import { composeSequence } from "../draft/compose.js";
import { detectPlatform, detectTracking } from "../fingerprint/platform.js";
import { scoreFindings, topFindings } from "../score/score.js";
import type { Finding, Lead, Platform } from "../types.js";
import { CATEGORY_LABELS } from "../types.js";
import { fetchJson, fetchText, type FetchTextResult } from "../utils/http.js";

export interface ProcessDeps {
  repo: Repo;
  settings: Settings;
  /** Injected for tests. */
  fetchPage?: (url: string) => Promise<FetchTextResult>;
  measureSpeed?: (url: string) => Promise<SpeedResult | null>;
  findContactsFn?: typeof findContacts;
  /** Is our own internet working? (Injected for tests.) */
  isOnline?: () => Promise<boolean>;
  retryDelayMs?: number;
}

const ONLINE_PROBES = ["https://www.google.com/generate_204", "https://cloudflare.com/cdn-cgi/trace", "https://www.bing.com/"];

/** True if at least one well-known site answers — i.e. a failure is theirs, not ours. */
export async function isOnline(): Promise<boolean> {
  for (const url of ONLINE_PROBES) {
    try {
      await fetchText(url, { timeoutMs: 8000, maxBytes: 10_000 });
      return true;
    } catch {
      /* try the next probe */
    }
  }
  return false;
}

export type ProcessOutcome = "drafted" | "no_opportunity" | "no_contact" | "error";

async function fetchProducts(baseUrl: string): Promise<ShopifyProductsSummary | null> {
  try {
    const res = await fetchJson<{ products: { published_at?: string }[] }>(new URL("/products.json?limit=250", baseUrl).toString(), {
      timeoutMs: 12_000,
      retries: 0,
    });
    const dates = res.products.map((p) => p.published_at).filter((d): d is string => Boolean(d)).sort();
    return { count: res.products.length, newestPublished: dates.at(-1) ?? null };
  } catch {
    return null;
  }
}

/**
 * The whole per-lead pipeline: load their site, figure out the platform,
 * audit website/store/ads, find a contact, score the three offers, and
 * write the outreach sequence into the right review queue.
 */
export async function processLead(lead: Lead, deps: ProcessDeps): Promise<ProcessOutcome> {
  const { repo, settings: s } = deps;
  const fetchPage = deps.fetchPage ?? ((u: string) => fetchText(u));
  const measure = deps.measureSpeed ?? ((u: string) => (s.pagespeedEnabled ? measureMobileSpeed(u, s.pagespeedApiKey) : Promise.resolve(null)));
  const contactsFn = deps.findContactsFn ?? findContacts;
  const checkOnline = deps.isOnline ?? isOnline;

  try {
    const findings: Finding[] = [];
    let platform: Platform = "none";
    let domain = lead.domain;
    let email = lead.email;
    let contactName = lead.contact_name;
    let socials: string[] = lead.socials ?? [];
    let page: FetchTextResult | null = null;

    if (lead.website_url) {
      const tryFetch = async (): Promise<FetchTextResult | null> => {
        try {
          return await fetchPage(lead.website_url!);
        } catch {
          try {
            // retry over plain http if https failed outright (e.g. no SSL)
            return await fetchPage(lead.website_url!.replace(/^https:/, "http:"));
          } catch {
            return null;
          }
        }
      };
      page = await tryFetch();
      const looksDown = (p: FetchTextResult | null) => !p || p.status >= 500 || p.status === 404 || p.status === 410;

      if (looksDown(page)) {
        // Never tell a business "your site is down" because OUR connection
        // blipped: confirm we're online, wait, and try once more first.
        if (!(await checkOnline())) {
          repo.updateLead(lead.id, { status: "new", error: "no internet connection — will retry" });
          return "error";
        }
        await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 5000));
        page = await tryFetch();
      }

      if (!page || looksDown(page)) {
        platform = "unreachable";
      } else if (page.status === 401 || page.status === 403 || page.status === 429) {
        // bot protection — we can't audit it honestly, so don't pitch it
        repo.updateLead(lead.id, { status: "no_opportunity", platform: "custom", error: `site blocked the audit (HTTP ${page.status})` });
        return "no_opportunity";
      } else {
        platform = detectPlatform(page.html, page.headers);
        const finalDomain = normalizeDomain(page.url);
        if (finalDomain && finalDomain !== domain && !repo.db.prepare("SELECT 1 FROM leads WHERE domain = ? AND id != ?").get(finalDomain, lead.id)) {
          domain = finalDomain;
        }
      }
    }

    // --- audits ---
    if (!lead.website_url && !lead.ad_data) {
      findings.push(noWebsiteFinding("none", lead.name));
    } else if (platform === "unreachable" || platform === "parked") {
      if (!lead.ad_data) findings.push(noWebsiteFinding(platform === "parked" ? "parked" : "unreachable", domain ?? lead.name));
    } else if (page && domain) {
      findings.push(...analyzeWebsite({ html: page.html, finalUrl: page.url, domain, platform }));
      if (platform === "shopify") {
        if (/\/password\b/.test(page.url)) {
          repo.updateLead(lead.id, { status: "no_opportunity", platform, error: "store is password-protected" });
          return "no_opportunity";
        }
        findings.push(...analyzeShopify({ html: page.html, domain, products: await fetchProducts(page.url) }));
      }
    }

    const tracking = page ? detectTracking(page.html) : null;
    let speed: SpeedResult | null = null;
    if (page && domain && platform !== "unreachable" && platform !== "parked") {
      speed = await measure(page.url);
      if (speed) findings.push(...speedFindings(speed, domain, platform));
    }

    if (lead.ad_data) {
      findings.push(
        ...analyzeAds({
          adData: lead.ad_data,
          domain: lead.website_url ? domain : null,
          siteReachable: platform !== "unreachable" && platform !== "parked",
          hasMetaPixel: tracking?.metaPixel ?? false,
          mobileSpeedScore: speed?.score ?? null,
        }),
      );
    } else if (domain && tracking && !tracking.metaPixel && platform === "shopify") {
      findings.push(trackingGapFinding(domain, tracking.googleAds));
    }

    // --- score + route to a queue ---
    const { scores, category } = scoreFindings(findings, s.minScore, platform);
    repo.updateLead(lead.id, { platform, domain, findings, scores, category });
    if (!category) {
      repo.updateLead(lead.id, { status: "no_opportunity" });
      return "no_opportunity";
    }

    // --- contact ---
    if (page && domain && platform !== "unreachable" && platform !== "parked") {
      const c = await contactsFn(page.url, page.html, domain);
      email ??= c.email;
      contactName ??= c.name;
      socials = [...new Set([...socials, ...c.socials])];
    }
    const facebook = lead.facebook_url ?? socials.find((x) => /facebook\.com/.test(x)) ?? null;
    const instagram = socials.find((x) => /instagram\.com/.test(x)) ?? null;
    const channel = email ? "email" : facebook || instagram ? "manual" : null;
    repo.updateLead(lead.id, { email, contact_name: contactName, socials, facebook_url: facebook });
    if (!channel) {
      repo.updateLead(lead.id, { status: "no_contact" });
      return "no_contact";
    }

    // --- write the sequence ---
    const seq = await composeSequence({
      businessName: lead.name,
      firstName: contactName,
      domain: lead.website_url || platform !== "none" ? domain : null,
      category,
      findings: topFindings(findings, category),
      channel,
      settings: s,
    });
    repo.saveSequence(
      lead.id,
      seq.steps.map((st) => ({ ...st, channel, composer: seq.composer })),
    );
    repo.updateLead(lead.id, { status: "drafted", error: null });
    repo.log(`Drafted ${CATEGORY_LABELS[category]} pitch for ${lead.name} (score ${scores[category]}${channel === "manual" ? ", DM" : ""})`);
    return "drafted";
  } catch (err) {
    repo.updateLead(lead.id, { status: "error", error: (err as Error).message });
    return "error";
  }
}

/** Re-write a lead's drafts (e.g. after editing settings or the proof line). */
export async function redraftLead(lead: Lead, deps: ProcessDeps): Promise<boolean> {
  if (!lead.category || !lead.findings?.length) return false;
  const channel = lead.email ? "email" : "manual";
  const seq = await composeSequence({
    businessName: lead.name,
    firstName: lead.contact_name,
    domain: lead.website_url ? lead.domain : null,
    category: lead.category,
    findings: topFindings(lead.findings, lead.category),
    channel,
    settings: deps.settings,
  });
  deps.repo.saveSequence(lead.id, seq.steps.map((st) => ({ ...st, channel, composer: seq.composer })));
  deps.repo.updateLead(lead.id, { status: "drafted" });
  return true;
}
