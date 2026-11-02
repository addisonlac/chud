import * as cheerio from "cheerio";
import { promises as dns } from "node:dns";
import { fetchText } from "../utils/http.js";

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const BAD_EMAIL_PARTS = [
  "example.com",
  "domain.com",
  "email.com",
  "yourdomain",
  "sentry",
  "wixpress.com",
  "shopify.com",
  "godaddy.com",
  "squarespace.com",
  "wordpress.com",
  "noreply",
  "no-reply",
  "donotreply",
  "privacy@",
  "abuse@",
  "postmaster@",
  "webmaster@",
  "user@",
  "test@",
  "@2x",
];
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|avif|css|js|ico|woff2?)$/i;
const PREFERRED_LOCAL = ["hello", "info", "contact", "team", "support", "sales", "shop", "orders", "care", "help", "admin", "office"];

/** All plausible business emails on a page, best first. */
export function extractEmails(html: string, siteDomain?: string | null): string[] {
  const $ = cheerio.load(html);
  const found = new Set<string>();

  $('a[href^="mailto:"]').each((_, el) => {
    const addr = decodeURIComponent(($(el).attr("href") ?? "").slice(7).split("?")[0] ?? "").trim();
    if (addr) found.add(addr.toLowerCase());
  });

  const text = $.root().text().replace(/\s*(?:\[at\]|\(at\))\s*/gi, "@").replace(/\s*(?:\[dot\]|\(dot\))\s*/gi, ".");
  for (const m of text.matchAll(EMAIL_RE)) found.add(m[0].toLowerCase());
  // JSON-LD / inline data often has the email when the visible page hides it
  for (const m of html.replace(/&#64;|&#x40;|\\u0040/gi, "@").matchAll(EMAIL_RE)) found.add(m[0].toLowerCase());

  const clean = [...found]
    .map((e) => e.replace(/^[^a-z0-9]+/, "").replace(/[.]+$/, ""))
    .filter((e) => !ASSET_EXT.test(e) && !BAD_EMAIL_PARTS.some((b) => e.includes(b)) && e.length <= 80);

  const domain = siteDomain?.toLowerCase().replace(/^www\./, "");
  const rank = (e: string) => {
    const [local = "", host = ""] = e.split("@");
    let r = 0;
    if (domain && (host === domain || host.endsWith(`.${domain}`))) r += 10;
    if (PREFERRED_LOCAL.includes(local)) r += 3;
    if (/^[a-z]+$/.test(local) && !PREFERRED_LOCAL.includes(local)) r += 4; // firstname@ — likely the owner
    return r;
  };
  return [...new Set(clean)].sort((a, b) => rank(b) - rank(a));
}

const NOT_NAMES = new Set(["Our", "The", "We", "Our Team", "Team", "Shop", "Store", "Us", "Me", "Here", "Welcome", "Contact", "About", "Hello", "Your", "This", "My", "A", "An"]);

/** Best-effort owner first name from an about page ("Hi, I'm Sarah", "founded by James"). */
export function extractOwnerName(html: string): string | null {
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ");
  const patterns = [
    /\b(?:[Hh]i|[Hh]ey|[Hh]ello)[,!]?\s+[Ii]['’]?m\s+([A-Z][a-z]{2,14})\b/,
    /\b[Mm]y name is\s+([A-Z][a-z]{2,14})\b/,
    /\b[Ff]ounded(?: in \d{4})? by\s+([A-Z][a-z]{2,14})\b/,
    /\b(?:founder|owner|ceo)[,:\s–-]+([A-Z][a-z]{2,14})\s+[A-Z][a-z]+/,
    /\b([A-Z][a-z]{2,14})\s+[A-Z][a-z]+,\s*(?:founder|owner|co-founder)\b/i,
  ];
  for (const re of patterns) {
    const name = re.exec(text)?.[1];
    if (name && !NOT_NAMES.has(name)) return name;
  }
  return null;
}

export function extractSocials(html: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (/^https?:\/\/(www\.)?(facebook|instagram|tiktok|linkedin|youtube|x|twitter|pinterest)\.com\/[^\s"'?#]+/i.test(href)) {
      const clean = href.split(/[?#]/)[0]!;
      if (!/\/(sharer|share|intent|plugins|dialog)/i.test(clean)) out.add(clean);
    }
  });
  return [...out].slice(0, 8);
}

/** Minimal robots.txt check for `User-agent: *`. */
export function robotsAllows(robotsTxt: string, path: string): boolean {
  let applies = false;
  const disallow: string[] = [];
  const allow: string[] = [];
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.split("#")[0]!.trim();
    const [k, ...rest] = line.split(":");
    const key = k?.trim().toLowerCase();
    const val = rest.join(":").trim();
    if (key === "user-agent") applies = val === "*";
    else if (applies && key === "disallow" && val) disallow.push(val);
    else if (applies && key === "allow" && val) allow.push(val);
  }
  const longest = (rules: string[]) => Math.max(-1, ...rules.filter((r) => path.startsWith(r.replace(/\*.*$/, ""))).map((r) => r.length));
  return longest(allow) >= longest(disallow);
}

export async function hasMx(domain: string): Promise<boolean> {
  try {
    const mx = await dns.resolveMx(domain);
    return mx.length > 0;
  } catch {
    return false;
  }
}

export interface ContactInfo {
  email: string | null;
  name: string | null;
  socials: string[];
}

/**
 * Looks for a contact email on the homepage, then on up to 3 contact/about
 * pages linked from it (respecting robots.txt). Only addresses the business
 * publishes on its own site are used.
 */
export async function findContacts(baseUrl: string, homeHtml: string, domain: string): Promise<ContactInfo> {
  let emails = extractEmails(homeHtml, domain);
  let name = extractOwnerName(homeHtml);
  const socials = extractSocials(homeHtml);

  if (!emails.length || !name) {
    let robots = "";
    try {
      const r = await fetchText(new URL("/robots.txt", baseUrl).toString(), { timeoutMs: 8000, maxBytes: 100_000 });
      if (r.ok) robots = r.html;
    } catch {
      /* no robots.txt → allowed */
    }
    const $ = cheerio.load(homeHtml);
    const candidates = new Set<string>();
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      if (/contact|about|our-story|team|impressum/i.test(href)) {
        try {
          const u = new URL(href, baseUrl);
          if (u.hostname.replace(/^www\./, "") === domain) candidates.add(u.origin + u.pathname);
        } catch {
          /* ignore bad hrefs */
        }
      }
    });
    for (const p of ["/pages/contact", "/contact", "/pages/about-us", "/about"]) candidates.add(new URL(p, baseUrl).toString());

    let fetched = 0;
    for (const url of candidates) {
      if (fetched >= 3 || (emails.length && name)) break;
      const path = new URL(url).pathname;
      if (robots && !robotsAllows(robots, path)) continue;
      try {
        const page = await fetchText(url, { timeoutMs: 10_000 });
        fetched++;
        if (!page.ok) continue;
        if (!emails.length) emails = extractEmails(page.html, domain);
        name ??= extractOwnerName(page.html);
        for (const s of extractSocials(page.html)) if (!socials.includes(s)) socials.push(s);
      } catch {
        fetched++;
      }
    }
  }

  let email: string | null = null;
  for (const e of emails.slice(0, 4)) {
    const host = e.split("@")[1];
    if (host && (await hasMx(host))) {
      email = e;
      break;
    }
  }
  return { email, name, socials };
}
