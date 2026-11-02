/** The three outreach queues — one per offer. */
export type Category = "website" | "ads" | "cro";
export const CATEGORIES: Category[] = ["website", "ads", "cro"];
export const CATEGORY_LABELS: Record<Category, string> = {
  website: "Website",
  ads: "Ad Management",
  cro: "Shopify CRO",
};

export type LeadSource = "shopify_search" | "shopify_ct" | "meta_ads" | "csv" | "manual";

export type Platform = "shopify" | "wordpress" | "wix" | "squarespace" | "webflow" | "godaddy" | "weebly" | "custom" | "none" | "parked" | "unreachable";

export type LeadStatus =
  | "new" // discovered, not processed yet
  | "drafted" // has a pending draft in a queue
  | "approved" // user approved, waiting in send queue / sequence running
  | "contacted" // first email sent
  | "replied" // they replied — sequence stopped
  | "skipped" // user skipped it
  | "no_opportunity" // audit found nothing worth pitching
  | "no_contact" // no way to reach them
  | "error";

/**
 * One concrete, observed problem. `pain` and `fix` are written in plain
 * English from measured facts; `evidence` is the short verifiable token
 * (e.g. "© 2017", "34/100", "Debut") a draft must quote so every email is
 * provably grounded in what we actually saw on their site/ads.
 */
export interface Finding {
  id: string;
  category: Category;
  /** 1 = minor, 2 = real problem, 3 = costing them sales right now */
  severity: 1 | 2 | 3;
  evidence: string;
  pain: string;
  fix: string;
}

/** Aggregated Meta Ad Library data for one advertiser (Facebook page). */
export interface AdData {
  pageId: string;
  pageName: string;
  activeAds: number;
  oldestStart: string | null; // ISO date of the longest-running active ad
  linkDomains: string[]; // display domains from ad link captions
  snapshotUrl: string | null;
  platforms: string[];
}

export interface Lead {
  id: number;
  domain: string | null;
  page_id: string | null;
  name: string;
  source: LeadSource;
  niche: string | null;
  website_url: string | null;
  facebook_url: string | null;
  platform: Platform | null;
  status: LeadStatus;
  category: Category | null;
  scores: Record<Category, number> | null;
  email: string | null;
  contact_name: string | null;
  socials: string[] | null;
  ad_data: AdData | null;
  findings: Finding[] | null;
  error: string | null;
  replied_at: string | null;
  created_at: string;
  updated_at: string;
}

export type DraftStatus = "pending" | "approved" | "sent" | "skipped" | "cancelled" | "failed";
export type DraftChannel = "email" | "manual";

export interface Draft {
  id: number;
  lead_id: number;
  step: number; // 0 = first touch, 1..n = follow-ups
  channel: DraftChannel;
  subject: string;
  body: string;
  status: DraftStatus;
  composer: "ai" | "template";
  delay_days: number;
  send_after: string | null;
  sent_at: string | null;
  message_id: string | null;
  error: string | null;
  created_at: string;
}

/** A lead freshly found by a discovery source, before it is stored. */
export interface DiscoveredLead {
  name: string;
  source: LeadSource;
  niche?: string;
  websiteUrl?: string | null;
  facebookUrl?: string | null;
  email?: string | null;
  adData?: AdData | null;
}
