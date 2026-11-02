import type { AdData, Finding } from "../types.js";
import { isSocialHost } from "../fingerprint/platform.js";

export interface AdsAuditInput {
  adData: AdData;
  /** Domain the ads point to (null when they only link to social pages). */
  domain: string | null;
  siteReachable: boolean;
  hasMetaPixel: boolean;
  mobileSpeedScore?: number | null;
  now?: Date;
}

function socialLabel(domains: string[]): string {
  const d = domains.map((x) => x.toLowerCase());
  if (d.some((x) => x.includes("instagram"))) return "Instagram profile";
  if (d.some((x) => x.includes("wa.me") || x.includes("whatsapp"))) return "WhatsApp";
  if (d.some((x) => x.includes("linktr") || x.includes("beacons") || x.includes("linkin.bio"))) return "link-in-bio page";
  if (d.some((x) => x.includes("messenger") || x === "m.me")) return "Messenger";
  return "Facebook page";
}

/** Findings about an advertiser's Meta ads, from Ad Library data + their landing page. */
export function analyzeAds(input: AdsAuditInput): Finding[] {
  const { adData, domain } = input;
  const now = input.now ?? new Date();
  const findings: Finding[] = [];
  const n = adData.activeAds;
  const adsWord = n === 1 ? "1 active ad" : `${n} active ads`;

  const ownDomains = adData.linkDomains.filter((d) => !isSocialHost(d));
  if (!domain && ownDomains.length === 0) {
    const where = socialLabel(adData.linkDomains);
    findings.push({
      id: "ads_no_website",
      category: "website",
      severity: 3,
      evidence: "no website",
      pain: `You're paying for ${adsWord} on Facebook/Instagram, but they send people to your ${where} instead of a website — there's nowhere for a ready-to-buy customer to order, book or see your prices, so a lot of that ad spend leaks away.`,
      fix: `A fast landing site built for your ad traffic — clear offer, social proof and a one-tap way to buy or book — with the Meta pixel installed so your ads can optimize for real customers.`,
    });
    return findings; // the remaining checks need a landing page
  }

  if (domain && !input.siteReachable) {
    findings.push({
      id: "ads_dead_landing",
      category: "ads",
      severity: 3,
      evidence: "landing page down",
      pain: `You have ${adsWord} pointing to ${domain}, but the site didn't load when I checked it — every click you're paying for right now could be landing on an error.`,
      fix: `Get the landing page back up immediately, then put uptime monitoring on it so this can't silently burn ad spend again.`,
    });
    return findings;
  }

  if (domain && !input.hasMetaPixel) {
    findings.push({
      id: "ads_no_pixel",
      category: "ads",
      severity: 3,
      evidence: "no Meta pixel",
      pain: `You're running ${adsWord}, but there's no Meta pixel on ${domain} — so Meta can't see who actually buys, can't optimize toward buyers, and can't retarget the visitors who almost did. That usually means paying a lot more per customer than you need to.`,
      fix: `Install the Meta pixel + Conversions API with proper purchase/lead events, then restructure campaigns to optimize for conversions and retarget warm visitors.`,
    });
  }

  if (adData.oldestStart) {
    const days = Math.floor((now.getTime() - new Date(adData.oldestStart).getTime()) / 86_400_000);
    if (days >= 90 && n <= 3) {
      findings.push({
        id: "ads_creative_fatigue",
        category: "ads",
        severity: 2,
        evidence: `${days} days`,
        pain: `Your longest-running ad has been live for ${days} days with only ${n === 1 ? "itself" : `${n} ads`} in rotation — after a few weeks the same audience tunes it out (ad fatigue), and your cost per result quietly climbs.`,
        fix: `A steady creative pipeline — new hooks, UGC-style videos and offers tested every couple of weeks — so the winners keep getting replaced before they burn out.`,
      });
    }
  }

  if (n === 1 && !findings.some((f) => f.id === "ads_creative_fatigue")) {
    findings.push({
      id: "ads_single_creative",
      category: "ads",
      severity: 1,
      evidence: "1 active ad",
      pain: `You're running a single ad, so there's nothing to test it against — you can't know if a different hook, image or offer would get you customers for half the price.`,
      fix: `Structured creative testing (3–5 variations per offer) so budget moves to whatever is actually working.`,
    });
  }

  if (domain && input.mobileSpeedScore != null && input.mobileSpeedScore < 40) {
    findings.push({
      id: "ads_slow_landing",
      category: "ads",
      severity: 2,
      evidence: `${input.mobileSpeedScore}/100`,
      pain: `The page your ads send people to scores ${input.mobileSpeedScore}/100 on Google's mobile speed test — and almost all Facebook/Instagram traffic is mobile, so you're paying for clicks that leave before the page loads.`,
      fix: `A fast, focused landing page for your ad traffic so paid clicks actually see the offer.`,
    });
  }

  return findings;
}

/** Ads-category finding for a store with ad tags but no Meta pixel (no Ad Library data needed). */
export function trackingGapFinding(domain: string, hasGoogleAds: boolean): Finding {
  return {
    id: "no_meta_pixel_store",
    category: "ads",
    severity: hasGoogleAds ? 2 : 1,
    evidence: "no Meta pixel",
    pain: hasGoogleAds
      ? `${domain} has Google Ads tracking but no Meta pixel — so if you run Facebook/Instagram ads they can't track sales or retarget your visitors, and you're leaving the cheapest retargeting channel unused.`
      : `There's no Meta pixel on ${domain}, so you can't retarget the visitors who browse but don't buy — usually the cheapest sales a store can get from ads.`,
    fix: `Set up the Meta pixel + Conversions API and a simple retargeting campaign aimed at visitors and cart abandoners.`,
  };
}
