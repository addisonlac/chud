import { describe, expect, it, vi } from "vitest";
import { aiSequence, composeSequence, renderEmail, templateSequence, validateMessage, type ComposeContext } from "../src/draft/compose.js";
import type { Finding } from "../src/types.js";
import { testSettings } from "./helpers.js";

const findings: Finding[] = [
  { id: "slow_mobile", category: "cro", severity: 3, evidence: "8.7s", pain: "On Google's PageSpeed test, lumen.co scores 24/100 on mobile and the main content takes 8.7s to show up on a phone — most mobile shoppers give up after about 3 seconds.", fix: "Speed work on the store." },
  { id: "vintage_theme", category: "cro", severity: 2, evidence: "Debut", pain: "The store is still on Debut, an older vintage theme.", fix: "Migrate to an Online Store 2.0 theme." },
  { id: "no_reviews", category: "cro", severity: 2, evidence: "no product reviews", pain: "I couldn't find product reviews on the store.", fix: "Set up photo reviews." },
];

const ctx = (o: Partial<ComposeContext> = {}): ComposeContext => ({
  businessName: "Lumen & Co", firstName: "Sarah", domain: "lumen.co", category: "cro", findings, channel: "email", settings: testSettings(), ...o,
});

describe("templateSequence", () => {
  it("writes a complete 3-step sequence grounded in the findings, with no placeholders", () => {
    const seq = templateSequence(ctx());
    expect(seq.composer).toBe("template");
    expect(seq.steps.map((s) => [s.step, s.delayDays])).toEqual([[0, 0], [1, 3], [2, 4]]);
    const first = seq.steps[0]!;
    expect(first.subject).toBe("Lumen & Co takes 8.7s to load on mobile");
    expect(first.body.startsWith("Hi Sarah,")).toBe(true);
    expect(first.body).toContain("8.7s"); // pain
    expect(first.body).toContain("Speed work on the store."); // relief
    expect(first.body).toContain("1.1% to 2.4%"); // proof, verbatim
    expect(first.body).toMatch(/Want me to send it over\?$/); // CTA
    // the template passes its own validator
    expect(validateMessage(first.body, ctx(), { maxWords: 400, requireEvidence: true })).toEqual([]);
    expect(seq.steps[1]!.subject).toBe(`Re: ${first.subject}`);
  });

  it("falls back to '<Business> team' when no name was found, and DMs get one message", () => {
    const seq = templateSequence(ctx({ firstName: null, channel: "manual" }));
    expect(seq.steps).toHaveLength(1);
    expect(seq.steps[0]!.body.startsWith("Hi Lumen & Co team,")).toBe(true);
  });
});

describe("renderEmail", () => {
  it("appends signature and the CAN-SPAM footer", () => {
    const text = renderEmail("Hi Sarah,\n\nBody.", testSettings());
    expect(text).toContain("Sam Rivera");
    expect(text).toContain("1 Main St, Austin, TX 78701");
    expect(text).toMatch(/reply "stop"/);
  });
});

describe("validateMessage", () => {
  const opts = { maxWords: 170, requireEvidence: true };
  it("rejects placeholders, invented numbers and missing evidence", () => {
    const errs = validateMessage("Hi Sarah,\n\nWe boosted sales 300% for [Client]. Want to chat?", ctx(), opts);
    expect(errs.join(" | ")).toMatch(/placeholder/);
    expect(errs.join(" | ")).toMatch(/300/);
    expect(errs.join(" | ")).toMatch(/evidence/);
  });
  it("rejects a sign-off and a wrong greeting", () => {
    const errs = validateMessage("Hello there,\n\nYour store loads in 8.7s.\n\nBest,\nSam", ctx(), opts);
    expect(errs.some((e) => e.includes("must start with"))).toBe(true);
    expect(errs.some((e) => e.includes("signature"))).toBe(true);
  });
  it("accepts a grounded message", () => {
    expect(validateMessage("Hi Sarah,\n\nYour store takes 8.7s to load on a phone. We fix that. Want me to send a free 2-minute video?", ctx(), opts)).toEqual([]);
  });
});

describe("aiSequence", () => {
  it("returns null without a Groq key (template is used instead)", async () => {
    expect(await aiSequence(ctx())).toBeNull();
    expect((await composeSequence(ctx())).composer).toBe("template");
  });

  it("asks for a rewrite when the AI invents a number, then accepts the fixed draft", async () => {
    const http = await import("../src/utils/http.js");
    const good = {
      subject: "Lumen & Co's 8.7s mobile load",
      email: "Hi Sarah,\n\nlumen.co takes 8.7s to load on a phone, and it's still on Debut. We'd move you to a modern theme and speed it up. Last month we took a candle store from 1.1% to 2.4% conversion in 6 weeks. Want me to send a free 2-minute video?",
      followup1: "Hi Sarah,\n\nOne more thing: I couldn't find product reviews. Want the video?",
      followup2: "Hi Sarah,\n\nLast note from me — reply any time if speed becomes a priority.",
    };
    const bad = { ...good, email: good.email.replace("8.7s", "12s") };
    const spy = vi.spyOn(http, "fetchJson")
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: JSON.stringify(bad) } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [{ id: "2", type: "function", function: { name: "x", arguments: JSON.stringify(good) } }] } }] });
    const seq = await aiSequence(ctx({ settings: testSettings({ groqApiKey: "k" }) }));
    expect(spy).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(spy.mock.calls[1]![1]!.body as string);
    expect(retryBody.messages.at(-1).content).toMatch(/12/);
    expect(seq?.composer).toBe("ai");
    expect(seq?.steps[0]!.body).toContain("8.7s");
    spy.mockRestore();
  });
});
