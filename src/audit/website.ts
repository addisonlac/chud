import * as cheerio from "cheerio";
import type { Category, Finding, Platform } from "../types.js";

export interface WebsiteAuditInput {
  html: string;
  finalUrl: string;
  domain: string;
  platform: Platform;
  now?: Date;
}

/**
 * Pure HTML checks for an outdated / underperforming website. Every finding
 * is written from something we can point at in their own page source.
 */
export function analyzeWebsite(input: WebsiteAuditInput): Finding[] {
  const { html, finalUrl, domain, platform } = input;
  const now = input.now ?? new Date();
  const $ = cheerio.load(html);
  const findings: Finding[] = [];
  // Shopify stores' site problems are pitched as CRO; everything else as a website rebuild.
  const cat: Category = platform === "shopify" ? "cro" : "website";

  if (finalUrl.startsWith("http://")) {
    findings.push({
      id: "no_https",
      category: cat,
      severity: 3,
      evidence: "Not secure",
      pain: `${domain} loads without HTTPS, so Chrome labels it "Not secure" in the address bar — a lot of visitors leave right there, and Google ranks it lower.`,
      fix: `Move the site to HTTPS with a free SSL certificate, so the warning disappears and Google stops holding it back.`,
    });
  }

  const viewport = $('meta[name="viewport"]').attr("content");
  if (!viewport) {
    findings.push({
      id: "no_mobile",
      category: cat,
      severity: 3,
      evidence: "not mobile-friendly",
      pain: `The site isn't set up for phones (there's no mobile viewport), so on a phone it shows up as a shrunken desktop page that people have to pinch and zoom — and most of your visitors are on their phones.`,
      fix: platform === "shopify" ? `Make every page properly mobile-first, so it's easy to browse and buy from a phone.` : `Rebuild the site mobile-first, so it's easy to read, call and book from a phone.`,
    });
  }

  const year = latestCopyrightYear($("body").text() || html);
  if (year && now.getFullYear() - year >= 3) {
    findings.push({
      id: "old_copyright",
      category: "website",
      severity: 2,
      evidence: `© ${year}`,
      pain: `The footer still says © ${year}, which quietly tells visitors the site hasn't been touched in years — and makes people wonder if you're still open.`,
      fix: `A refreshed site with current content, photos and offers that shows you're active and trustworthy.`,
    });
  }

  const generator = $('meta[name="generator"]').attr("content") ?? "";
  const wp = /wordpress\s+(\d+)\.(\d+)/i.exec(generator);
  if (wp && Number(wp[1]) < 6) {
    findings.push({
      id: "old_wordpress",
      category: "website",
      severity: 2,
      evidence: `WordPress ${wp[1]}.${wp[2]}`,
      pain: `It's running WordPress ${wp[1]}.${wp[2]}, which is several major versions behind — old versions are slow and are one of the most common ways small-business sites get hacked.`,
      fix: `A rebuild on a current, maintained stack, so it's fast and secure.`,
    });
  }

  const jq = oldJquery(html);
  if (jq) {
    findings.push({
      id: "old_jquery",
      category: cat,
      severity: 1,
      evidence: `jQuery ${jq}`,
      pain: `Under the hood it still loads jQuery ${jq}, a library version from over a decade ago — a sign the code hasn't been updated in a long time.`,
      fix: `Clean, modern code that loads faster and is easy to maintain.`,
    });
  }

  if (/\.swf\b/i.test(html) && /<(object|embed)\b/i.test(html)) {
    findings.push({
      id: "flash",
      category: "website",
      severity: 3,
      evidence: "Flash",
      pain: `Parts of the site still use Flash, which no browser has supported since 2020 — those sections show up blank for every visitor.`,
      fix: `Replace the dead Flash sections with modern, mobile-friendly content.`,
    });
  }

  if (platform === "weebly" || platform === "godaddy") {
    const builder = platform === "weebly" ? "Weebly" : "GoDaddy's site builder";
    findings.push({
      id: "template_builder",
      category: "website",
      severity: 1,
      evidence: platform === "weebly" ? "Weebly" : "GoDaddy builder",
      pain: `The site is built on ${builder}, which limits design, speed and SEO — it tends to look like a template rather than your brand.`,
      fix: `A custom site you own outright, designed around your brand and built to rank and convert.`,
    });
  }

  if (!$('meta[name="description"]').attr("content")?.trim()) {
    findings.push({
      id: "no_meta_description",
      category: cat,
      severity: 1,
      evidence: "no meta description",
      pain: `The homepage has no meta description, so Google makes up its own snippet for you in search results — usually not the one that gets clicks.`,
      fix: `Write search titles and descriptions for every key page so you show up with a pitch, not a random sentence.`,
    });
  }

  const hasForm = $("form").length > 0;
  const hasTel = $('a[href^="tel:"]').length > 0;
  const hasMail = $('a[href^="mailto:"]').length > 0;
  if (platform !== "shopify" && !hasForm && !hasTel && !hasMail) {
    findings.push({
      id: "no_contact_path",
      category: "website",
      severity: 2,
      evidence: "no contact form",
      pain: `There's no contact form or tap-to-call button on the homepage, so a visitor who's ready to buy has to go hunting for how to reach you.`,
      fix: `Clear calls-to-action on every page — tap-to-call, a short quote/contact form, and booking where it fits.`,
    });
  }

  return findings;
}

/** Finding for a business that has no working website at all. */
export function noWebsiteFinding(reason: "none" | "parked" | "unreachable" | "social_only", detail: string): Finding {
  const pains: Record<typeof reason, string> = {
    none: `I couldn't find a website for ${detail} — so anyone who searches for you on Google, or wants to check you out before buying, has nowhere to land.`,
    parked: `${detail} just shows a placeholder/parked page right now, so people who look you up find nothing about your business.`,
    unreachable: `${detail} didn't load when I tried it — anyone who searches for you lands on an error page.`,
    social_only: `${detail}`,
  };
  const evidence: Record<typeof reason, string> = {
    none: "no website",
    parked: "placeholder page",
    unreachable: "site down",
    social_only: "no website",
  };
  return {
    id: `no_site_${reason}`,
    category: "website",
    severity: 3,
    evidence: evidence[reason],
    pain: pains[reason],
    fix: `A fast, mobile-first website with your services, reviews and a clear way to buy or book — so the traffic you already get turns into customers.`,
  };
}

export interface SpeedResult {
  score: number; // 0–100 Lighthouse mobile performance
  lcpSeconds: number | null;
}

/** Findings from a Google PageSpeed (mobile) measurement. */
export function speedFindings(speed: SpeedResult, domain: string, platform: Platform): Finding[] {
  if (speed.score >= 50) return [];
  const cat: Category = platform === "shopify" ? "cro" : "website";
  const lcp = speed.lcpSeconds && speed.lcpSeconds >= 3 ? speed.lcpSeconds.toFixed(1) : null;
  const what = platform === "shopify" ? "shoppers" : "visitors";
  return [
    {
      id: "slow_mobile",
      category: cat,
      severity: speed.score < 30 ? 3 : 2,
      evidence: lcp ? `${lcp}s` : `${speed.score}/100`,
      pain: lcp
        ? `On Google's PageSpeed test, ${domain} scores ${speed.score}/100 on mobile and the main content takes ${lcp}s to show up on a phone — most mobile ${what} give up after about 3 seconds.`
        : `On Google's PageSpeed test, ${domain} scores ${speed.score}/100 on mobile — slow pages lose ${what} before they ever see what you sell.`,
      fix:
        platform === "shopify"
          ? `Speed work on the store: trim unused apps and scripts, compress images and lazy-load below the fold, so pages load in under 3 seconds on a phone.`
          : `A lightweight rebuild with optimized images and hosting, so pages load in under 3 seconds on a phone.`,
    },
  ];
}

function latestCopyrightYear(text: string): number | null {
  const re = /(?:©|&copy;|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi;
  let max: number | null = null;
  for (const m of text.matchAll(re)) {
    const y = Number(m[1]);
    if (y >= 1995 && y <= 2100 && (max === null || y > max)) max = y;
  }
  return max;
}

function oldJquery(html: string): string | null {
  const m = /jquery[.-]?(1\.\d+(?:\.\d+)?)(?:\.min)?\.js|jquery(?:\.min)?\.js\?ver=(1\.\d+(?:\.\d+)?)/i.exec(html);
  return m ? (m[1] ?? m[2] ?? null) : null;
}
