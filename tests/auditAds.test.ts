import { describe, expect, it } from "vitest";
import { analyzeAds } from "../src/audit/ads.js";
import { groupAdsByPage, adDataToLead } from "../src/discover/metaAdLibrary.js";
import type { AdData } from "../src/types.js";

const now = new Date("2026-11-02T00:00:00Z");
const ad = (o: Partial<AdData> = {}): AdData => ({
  pageId: "1", pageName: "Glow Skin", activeAds: 2, oldestStart: "2026-10-20", linkDomains: ["glowskin.com"], snapshotUrl: null, platforms: [], ...o,
});

describe("analyzeAds", () => {
  it("advertiser with ads pointing only to Instagram → no-website pitch", () => {
    const f = analyzeAds({ adData: ad({ linkDomains: ["instagram.com"] }), domain: null, siteReachable: false, hasMetaPixel: false, now });
    expect(f).toHaveLength(1);
    expect(f[0]!.id).toBe("ads_no_website");
    expect(f[0]!.category).toBe("website");
    expect(f[0]!.pain).toContain("Instagram profile");
  });

  it("dead landing page", () => {
    const f = analyzeAds({ adData: ad(), domain: "glowskin.com", siteReachable: false, hasMetaPixel: false, now });
    expect(f.map((x) => x.id)).toEqual(["ads_dead_landing"]);
  });

  it("no pixel + stale single creative + slow landing", () => {
    const f = analyzeAds({ adData: ad({ activeAds: 1, oldestStart: "2026-05-01" }), domain: "glowskin.com", siteReachable: true, hasMetaPixel: false, mobileSpeedScore: 22, now });
    expect(f.map((x) => x.id)).toEqual(["ads_no_pixel", "ads_creative_fatigue", "ads_slow_landing"]);
    expect(f[1]!.evidence).toBe("185 days");
  });

  it("healthy advertiser → nothing", () => {
    expect(analyzeAds({ adData: ad({ activeAds: 8 }), domain: "glowskin.com", siteReachable: true, hasMetaPixel: true, mobileSpeedScore: 80, now })).toEqual([]);
  });
});

describe("Meta Ad Library grouping", () => {
  it("groups ads by page and keeps the oldest start and link domains", () => {
    const pages = groupAdsByPage([
      { id: "a", page_id: "9", page_name: "Bloom", ad_delivery_start_time: "2026-06-01", ad_creative_link_captions: ["bloomflowers.ie"] },
      { id: "b", page_id: "9", page_name: "Bloom", ad_delivery_start_time: "2026-03-01", ad_creative_link_captions: ["instagram.com"] },
    ]);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ activeAds: 2, oldestStart: "2026-03-01", linkDomains: ["bloomflowers.ie", "instagram.com"] });
    expect(adDataToLead(pages[0]!, "flowers").websiteUrl).toBe("https://bloomflowers.ie");
  });
});
