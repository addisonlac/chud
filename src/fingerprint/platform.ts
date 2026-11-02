import type { Platform } from "../types.js";

/** Identify the site builder/platform from a page's HTML (+ headers if available). */
export function detectPlatform(html: string, headers?: Headers): Platform {
  const h = html.toLowerCase();
  if (isParked(h)) return "parked";
  if (
    h.includes("cdn.shopify.com") ||
    h.includes("shopify.theme") ||
    h.includes("myshopify.com") ||
    headers?.get("x-shopid") ||
    headers?.get("powered-by")?.toLowerCase().includes("shopify")
  )
    return "shopify";
  if (h.includes("static.wixstatic.com") || h.includes("wix.com website builder") || headers?.get("x-wix-request-id")) return "wix";
  if (h.includes("static1.squarespace.com") || h.includes("squarespace.com")) return "squarespace";
  if (h.includes("data-wf-page") || h.includes("webflow.js") || h.includes("assets.website-files.com")) return "webflow";
  if (h.includes("img1.wsimg.com") || h.includes("godaddy website builder")) return "godaddy";
  if (h.includes("editmysite.com") || h.includes("weebly.com")) return "weebly";
  if (h.includes("/wp-content/") || h.includes("/wp-includes/") || /<meta[^>]+generator[^>]+wordpress/i.test(html)) return "wordpress";
  return "custom";
}

const PARKED_MARKERS = [
  "this domain is for sale",
  "this domain may be for sale",
  "buy this domain",
  "domain is parked",
  "parked free, courtesy of",
  "sedoparking",
  "hugedomains.com",
  "dan.com/buy-domain",
  "afternic.com",
  "parkingcrew",
  "this site can’t be reached",
  "future home of something quite cool",
  "website coming soon",
  "under construction",
];

export function isParked(lowerHtml: string): boolean {
  // Tiny pages that contain a marker are parked/placeholder pages.
  return lowerHtml.length < 40_000 && PARKED_MARKERS.some((m) => lowerHtml.includes(m));
}

export interface Tracking {
  metaPixel: boolean;
  googleAds: boolean;
  googleAnalytics: boolean;
  tiktokPixel: boolean;
}

/** Ad/analytics tags present on the page — a proxy for "is this business advertising?". */
export function detectTracking(html: string): Tracking {
  const h = html.toLowerCase();
  return {
    metaPixel: h.includes("connect.facebook.net") || /fbq\(\s*['"]init/.test(h) || h.includes("facebook-pixel") || h.includes("fbevents.js"),
    googleAds: /['"]aw-\d{6,}/.test(h) || h.includes("googleadservices.com") || h.includes("googleads.g.doubleclick.net"),
    googleAnalytics: /g-[a-z0-9]{6,}/.test(h) || h.includes("google-analytics.com") || h.includes("googletagmanager.com"),
    tiktokPixel: h.includes("analytics.tiktok.com") || /ttq\.load\(/.test(h),
  };
}

const SOCIAL_HOSTS = [
  "facebook.com",
  "fb.com",
  "fb.me",
  "instagram.com",
  "wa.me",
  "whatsapp.com",
  "linktr.ee",
  "linkin.bio",
  "tiktok.com",
  "m.me",
  "messenger.com",
  "beacons.ai",
  "taplink.cc",
  "etsy.com",
  "amazon.com",
];

/** True for "domains" that are really social/link-in-bio pages, not a website the business owns. */
export function isSocialHost(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return SOCIAL_HOSTS.some((s) => d === s || d.endsWith(`.${s}`));
}
