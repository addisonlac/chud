import { describe, expect, it } from "vitest";
import { detectPlatform, detectTracking, isSocialHost } from "../src/fingerprint/platform.js";

describe("detectPlatform", () => {
  it("detects Shopify", () => {
    expect(detectPlatform('<script src="//cdn.shopify.com/s/files/1/x.js"></script>')).toBe("shopify");
  });
  it("detects WordPress, Wix, Squarespace", () => {
    expect(detectPlatform('<link href="/wp-content/themes/x/style.css">')).toBe("wordpress");
    expect(detectPlatform('<img src="https://static.wixstatic.com/media/a.jpg">')).toBe("wix");
    expect(detectPlatform('<script src="https://static1.squarespace.com/x.js"></script>')).toBe("squarespace");
  });
  it("detects parked domains", () => {
    expect(detectPlatform("<html><body>This domain is for sale! Contact us.</body></html>")).toBe("parked");
  });
  it("falls back to custom", () => {
    expect(detectPlatform("<html><body>Joe's Plumbing</body></html>")).toBe("custom");
  });
});

describe("detectTracking", () => {
  it("finds a Meta pixel and Google Ads tag", () => {
    const t = detectTracking(`<script>fbq('init', '123');</script><script>gtag('config','AW-123456789')</script>`);
    expect(t.metaPixel).toBe(true);
    expect(t.googleAds).toBe(true);
  });
  it("reports nothing on a bare page", () => {
    expect(detectTracking("<html></html>").metaPixel).toBe(false);
  });
});

describe("isSocialHost", () => {
  it("treats social/link-in-bio hosts as not-a-website", () => {
    expect(isSocialHost("instagram.com")).toBe(true);
    expect(isSocialHost("linktr.ee")).toBe(true);
    expect(isSocialHost("m.facebook.com")).toBe(true);
    expect(isSocialHost("lumencandles.com")).toBe(false);
  });
});
