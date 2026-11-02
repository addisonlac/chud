import { describe, expect, it } from "vitest";
import { analyzeWebsite, speedFindings } from "../src/audit/website.js";

const now = new Date("2026-11-02T12:00:00Z");
const ids = (fs: { id: string }[]) => fs.map((f) => f.id);

describe("analyzeWebsite", () => {
  it("flags an outdated site", () => {
    const html = `<html><head><meta name="generator" content="WordPress 4.9.8"><script src="/js/jquery-1.11.3.min.js"></script></head>
      <body><p>Welcome</p><footer>© 2017 Joe's Plumbing</footer></body></html>`;
    const f = analyzeWebsite({ html, finalUrl: "http://joesplumbing.com/", domain: "joesplumbing.com", platform: "wordpress", now });
    expect(ids(f)).toEqual(expect.arrayContaining(["no_https", "no_mobile", "old_copyright", "old_wordpress", "old_jquery", "no_meta_description", "no_contact_path"]));
    expect(f.find((x) => x.id === "old_copyright")!.evidence).toBe("© 2017");
    expect(f.every((x) => x.category === "website")).toBe(true);
  });

  it("uses the latest year in a copyright range", () => {
    const html = `<meta name="viewport" content="width=device-width"><meta name="description" content="x"><footer>&copy; 2015-2026 Acme</footer><a href="tel:1">call</a>`;
    const f = analyzeWebsite({ html, finalUrl: "https://acme.com", domain: "acme.com", platform: "custom", now });
    expect(ids(f)).not.toContain("old_copyright");
  });

  it("finds nothing on a modern site", () => {
    const html = `<html><head><meta name="viewport" content="width=device-width"><meta name="description" content="Great"></head><body><form></form>© 2026</body></html>`;
    expect(analyzeWebsite({ html, finalUrl: "https://good.com", domain: "good.com", platform: "custom", now })).toEqual([]);
  });

  it("routes Shopify site problems to the CRO queue", () => {
    const f = analyzeWebsite({ html: "<html></html>", finalUrl: "https://s.com", domain: "s.com", platform: "shopify", now });
    expect(f.find((x) => x.id === "no_mobile")!.category).toBe("cro");
  });
});

describe("speedFindings", () => {
  it("reports slow mobile load with the LCP seconds as evidence", () => {
    const [f] = speedFindings({ score: 24, lcpSeconds: 8.7 }, "s.com", "shopify");
    expect(f!.severity).toBe(3);
    expect(f!.evidence).toBe("8.7s");
    expect(f!.pain).toContain("24/100");
  });
  it("is silent for decent scores", () => {
    expect(speedFindings({ score: 72, lcpSeconds: 2.1 }, "s.com", "custom")).toEqual([]);
  });
});
