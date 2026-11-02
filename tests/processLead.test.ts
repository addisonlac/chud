import { describe, expect, it } from "vitest";
import { processLead } from "../src/pipeline/processLead.js";
import { memRepo, testSettings } from "./helpers.js";

const page = (url: string, html: string, status = 200) => ({ ok: status < 400, status, url, html, headers: new Headers(), ms: 100 });

describe("processLead (end to end, network stubbed)", () => {
  it("audits an outdated site and drops a ready-to-send email in the Website queue", async () => {
    const repo = memRepo();
    const id = repo.insertLead({ name: "Joe's Plumbing", source: "manual", websiteUrl: "https://joesplumbing.com" })!;
    const html = `<html><head><meta name="generator" content="WordPress 4.9"></head><body>Call Joe. © 2016 Joe's Plumbing</body></html>`;
    const outcome = await processLead(repo.getLead(id)!, {
      repo,
      settings: testSettings({ pagespeedEnabled: false }),
      fetchPage: async () => page("http://joesplumbing.com/", html),
      findContactsFn: async () => ({ email: "joe@joesplumbing.com", name: "Joe", socials: [] }),
    });
    expect(outcome).toBe("drafted");
    const lead = repo.getLead(id)!;
    expect(lead.category).toBe("website");
    expect(lead.platform).toBe("wordpress");
    const [first] = repo.draftsForLead(id);
    expect(first!.body.startsWith("Hi Joe,")).toBe(true);
    expect(first!.status).toBe("pending");
    expect(repo.queue("website")).toHaveLength(1);
  });

  it("Meta advertiser with no website → Website pitch delivered as a DM", async () => {
    const repo = memRepo();
    const id = repo.insertLead({
      name: "Glow Skin", source: "meta_ads", websiteUrl: null, facebookUrl: "https://www.facebook.com/1",
      adData: { pageId: "1", pageName: "Glow Skin", activeAds: 3, oldestStart: "2026-09-01", linkDomains: ["instagram.com"], snapshotUrl: null, platforms: [] },
    })!;
    expect(await processLead(repo.getLead(id)!, { repo, settings: testSettings() })).toBe("drafted");
    const [first] = repo.draftsForLead(id);
    expect(first!.channel).toBe("manual");
    expect(first!.body).toContain("Instagram profile");
  });

  it("skips healthy sites", async () => {
    const repo = memRepo();
    const id = repo.insertLead({ name: "Good", source: "manual", websiteUrl: "https://good.com" })!;
    const html = `<meta name="viewport" content="width=device-width"><meta name="description" content="x"><form></form>© 2026`;
    expect(await processLead(repo.getLead(id)!, { repo, settings: testSettings({ pagespeedEnabled: false }), fetchPage: async () => page("https://good.com/", html) })).toBe("no_opportunity");
  });
});

describe("processLead: our own connection problems", () => {
  it("does not pitch 'site down' when we are offline — lead is retried later", async () => {
    const repo = memRepo();
    const id = repo.insertLead({ name: "Fine Shop", source: "manual", websiteUrl: "https://fineshop.com" })!;
    const outcome = await processLead(repo.getLead(id)!, {
      repo, settings: testSettings(), retryDelayMs: 0,
      fetchPage: async () => { throw new Error("ENOTFOUND"); },
      isOnline: async () => false,
    });
    expect(outcome).toBe("error");
    expect(repo.getLead(id)!.status).toBe("new");
    expect(repo.draftsForLead(id)).toHaveLength(0);
  });

  it("retries once and audits normally if the site comes back", async () => {
    const repo = memRepo();
    const id = repo.insertLead({ name: "Flaky", source: "manual", websiteUrl: "https://flaky.com" })!;
    let calls = 0;
    const html = `<meta name="viewport" content="width=device-width"><meta name="description" content="x"><form></form>© 2026`;
    const outcome = await processLead(repo.getLead(id)!, {
      repo, settings: testSettings({ pagespeedEnabled: false }), retryDelayMs: 0, isOnline: async () => true,
      fetchPage: async (u) => { calls++; if (calls <= 2) throw new Error("ECONNRESET"); return page(u, html); },
    });
    expect(outcome).toBe("no_opportunity");
    expect(repo.getLead(id)!.platform).toBe("custom");
  });
});
