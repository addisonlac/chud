import { describe, expect, it } from "vitest";
import { analyzeShopify, countAppScripts, isVintageTheme, parseShopifyTheme } from "../src/audit/shopify.js";

const theme = (name: string) => `<script>Shopify.theme = {"name":"${name} - live","id":1,"schema_name":"${name}","schema_version":"17.9.0","theme_store_id":796,"role":"main"};</script>`;
const asyncLoad = (n: number) => `<script>(function(){ var urls = [${Array.from({ length: n }, (_, i) => `"https:\\/\\/app${i}.com\\/s.js?shop=x"`).join(",")}]; })();</script>`;

describe("shopify theme", () => {
  it("parses the theme and recognises vintage ones", () => {
    expect(parseShopifyTheme(theme("Debut"))).toBe("Debut");
    expect(isVintageTheme("Debut")).toBe(true);
    expect(isVintageTheme("Dawn")).toBe(false);
  });
});

describe("analyzeShopify", () => {
  it("flags vintage theme, app bloat, no reviews, no email capture, stale catalog", () => {
    const html = theme("Brooklyn") + asyncLoad(15);
    expect(countAppScripts(html)).toBe(15);
    const f = analyzeShopify({ html, domain: "s.com", products: { count: 12, newestPublished: "2024-03-01T00:00:00Z" }, now: new Date("2026-11-02") });
    expect(f.map((x) => x.id)).toEqual(["vintage_theme", "app_bloat", "no_reviews", "no_email_capture", "stale_catalog"]);
    expect(f.find((x) => x.id === "app_bloat")!.evidence).toBe("15 app scripts");
    expect(f.every((x) => x.category === "cro")).toBe(true);
  });

  it("stays quiet on a well-run store", () => {
    const html = theme("Dawn") + asyncLoad(4) + '<div class="jdgm-widget"></div><script src="https://static.klaviyo.com/x.js"></script>';
    expect(analyzeShopify({ html, domain: "s.com", products: { count: 40, newestPublished: "2026-10-01" }, now: new Date("2026-11-02") })).toEqual([]);
  });
});
