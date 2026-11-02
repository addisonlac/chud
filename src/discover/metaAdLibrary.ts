import { fetchJson } from "../utils/http.js";
import { normalizeDomain } from "../db/repo.js";
import { isSocialHost } from "../fingerprint/platform.js";
import type { AdData, DiscoveredLead } from "../types.js";

const GRAPH = "https://graph.facebook.com/v21.0/ads_archive";

interface ArchiveAd {
  id: string;
  page_id: string;
  page_name: string;
  ad_delivery_start_time?: string;
  ad_creative_link_captions?: string[];
  ad_snapshot_url?: string;
  publisher_platforms?: string[];
}

interface ArchiveResponse {
  data: ArchiveAd[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** Group Ad Library rows by advertiser page. Pure — unit-tested. */
export function groupAdsByPage(ads: ArchiveAd[]): AdData[] {
  const pages = new Map<string, AdData>();
  for (const ad of ads) {
    const p =
      pages.get(ad.page_id) ??
      ({ pageId: ad.page_id, pageName: ad.page_name, activeAds: 0, oldestStart: null, linkDomains: [], snapshotUrl: null, platforms: [] } as AdData);
    p.activeAds++;
    if (ad.ad_delivery_start_time && (!p.oldestStart || ad.ad_delivery_start_time < p.oldestStart)) p.oldestStart = ad.ad_delivery_start_time;
    for (const cap of ad.ad_creative_link_captions ?? []) {
      const d = normalizeDomain(cap.trim().split(/\s/)[0]);
      if (d && !p.linkDomains.includes(d)) p.linkDomains.push(d);
    }
    p.snapshotUrl ??= ad.ad_snapshot_url ?? null;
    for (const pl of ad.publisher_platforms ?? []) if (!p.platforms.includes(pl)) p.platforms.push(pl);
    pages.set(ad.page_id, p);
  }
  return [...pages.values()];
}

/** Turn an advertiser into a lead: its website is the first non-social domain its ads link to. */
export function adDataToLead(ad: AdData, niche: string): DiscoveredLead {
  const site = ad.linkDomains.find((d) => !isSocialHost(d)) ?? null;
  return {
    name: ad.pageName,
    source: "meta_ads",
    niche,
    websiteUrl: site ? `https://${site}` : null,
    facebookUrl: `https://www.facebook.com/${ad.pageId}`,
    adData: ad,
  };
}

/**
 * Meta Ad Library API: active ads matching a niche keyword. Note Meta only
 * exposes commercial ads delivered in the EU through this API.
 */
export async function discoverViaMetaAds(
  token: string,
  niche: string,
  countries: string[],
  after: string | null,
  limit: number,
): Promise<{ leads: DiscoveredLead[]; nextCursor: string | null }> {
  const params = new URLSearchParams({
    access_token: token,
    search_terms: niche,
    ad_reached_countries: JSON.stringify(countries.length ? countries : ["IE"]),
    ad_active_status: "ACTIVE",
    ad_type: "ALL",
    fields: "id,page_id,page_name,ad_delivery_start_time,ad_creative_link_captions,ad_snapshot_url,publisher_platforms",
    limit: "200",
  });
  if (after) params.set("after", after);

  const res = await fetchJson<ArchiveResponse>(`${GRAPH}?${params}`, { timeoutMs: 30_000 });
  const pages = groupAdsByPage(res.data ?? []).slice(0, limit);
  return {
    leads: pages.map((p) => adDataToLead(p, niche)),
    nextCursor: res.paging?.next ? (res.paging.cursors?.after ?? null) : null,
  };
}
