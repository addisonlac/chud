import { describe, expect, it } from "vitest";
import { extractEmails, extractOwnerName, extractSocials, robotsAllows } from "../src/contacts/extract.js";

describe("extractEmails", () => {
  it("prefers same-domain addresses and drops junk", () => {
    const html = `<a href="mailto:hello@lumen.co?subject=hi">Email</a> orders@gmail.com logo@2x.png
      <img src="icon@2x.png"> noreply@lumen.co <script>{"email":"sarah&#64;lumen.co"}</script> test@example.com`;
    const emails = extractEmails(html, "lumen.co");
    expect(emails[0]).toBe("sarah@lumen.co");
    expect(emails).toContain("hello@lumen.co");
    expect(emails).toContain("orders@gmail.com");
    expect(emails.some((e) => e.includes("noreply") || e.includes("example.com") || e.endsWith(".png"))).toBe(false);
  });
  it("decodes [at] obfuscation", () => {
    expect(extractEmails("<p>info [at] bakery.ie</p>", "bakery.ie")).toEqual(["info@bakery.ie"]);
  });
});

describe("extractOwnerName", () => {
  it("finds the founder's first name", () => {
    expect(extractOwnerName("<p>Hi, I'm Sarah and I pour every candle by hand.</p>")).toBe("Sarah");
    expect(extractOwnerName("<p>Lumen was founded by James Carter in 2019.</p>")).toBe("James");
  });
  it("returns null when unsure", () => {
    expect(extractOwnerName("<p>Welcome to our shop</p>")).toBeNull();
  });
});

describe("extractSocials", () => {
  it("collects profile links, not share buttons", () => {
    const s = extractSocials(`<a href="https://www.instagram.com/lumen/">ig</a><a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>`);
    expect(s).toEqual(["https://www.instagram.com/lumen/"]);
  });
});

describe("robotsAllows", () => {
  const robots = "User-agent: *\nDisallow: /private\nAllow: /private/contact\n\nUser-agent: Googlebot\nDisallow: /";
  it("respects disallow and the more specific allow", () => {
    expect(robotsAllows(robots, "/pages/contact")).toBe(true);
    expect(robotsAllows(robots, "/private/x")).toBe(false);
    expect(robotsAllows(robots, "/private/contact")).toBe(true);
  });
});
