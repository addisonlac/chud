import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Keep tests offline even if a developer's .env has a real GROQ_API_KEY.
vi.mock("../src/ai/groqClient.js", () => ({ callGroqTool: async () => ({ message: "AI draft" }) }));
import { parseTargets, outreachConfig } from "../src/outreach/config.js";
import { parseWebhookPayload, verifyWebhookSignature } from "../src/outreach/facebook.js";
import { LeadStore, leadsFromCsv, parseCsv } from "../src/outreach/leads.js";
import { AgentState } from "../src/outreach/state.js";
import { OutreachAgent, commentsNeedingReply, formatQueueMessage, messagesNeedingReply } from "../src/outreach/agent.js";
import { buildColdMessagePrompt } from "../src/outreach/writer.js";

const tmp = () => mkdtempSync(join(tmpdir(), "outreach-"));
const PAGE = "page-1";

describe("CSV import", () => {
  it("handles quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv('name,city,notes\r\n"Joe\'s Plumbing, LLC",Austin,"says ""call me"""\n');
    expect(rows).toEqual([{ name: "Joe's Plumbing, LLC", city: "Austin", notes: 'says "call me"' }]);
  });

  it("maps columns to leads and skips rows without a name", () => {
    const leads = leadsFromCsv("Name,Niche,City,Facebook_URL\nBella Salon,hair salon,Dallas,https://fb.com/bella\n,x,y,\n");
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ name: "Bella Salon", niche: "hair salon", facebookUrl: "https://fb.com/bella", source: "csv" });
  });
});

describe("LeadStore", () => {
  it("dedupes by name + city", () => {
    const store = new LeadStore(join(tmp(), "leads.json"));
    const lead = { name: "Acme Roofing", niche: "roofer", city: "Tulsa", source: "csv" as const };
    expect(store.add([lead, lead])).toBe(1);
    expect(store.add([lead])).toBe(0);
  });

  it("counts follow-ups and stops at the cap", () => {
    const store = new LeadStore(join(tmp(), "leads.json"));
    store.add([{ name: "A", niche: "", city: "X", source: "csv" }]);
    const t0 = new Date("2026-01-01T00:00:00Z");
    store.markSent("a-x", t0);
    const day5 = new Date("2026-01-06T00:00:00Z");
    expect(store.followUpsDue(4, 2, day5).map((l) => l.id)).toEqual(["a-x"]);
    store.markSent("a-x", day5);
    store.markSent("a-x", new Date("2026-01-11T00:00:00Z"));
    expect(store.get("a-x")!.followUpCount).toBe(2);
    expect(store.followUpsDue(4, 2, new Date("2026-02-01T00:00:00Z"))).toEqual([]);
  });
});

describe("webhook", () => {
  it("verifies Meta's sha256 signature", () => {
    const body = Buffer.from('{"object":"page"}');
    const sig = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(verifyWebhookSignature(body, sig, "secret")).toBe(true);
    expect(verifyWebhookSignature(body, sig, "wrong")).toBe(false);
    expect(verifyWebhookSignature(body, undefined, "secret")).toBe(false);
  });

  it("extracts messages and new comments, ignoring the Page's own echoes", () => {
    const events = parseWebhookPayload(
      {
        object: "page",
        entry: [
          {
            messaging: [
              { sender: { id: "u1" }, timestamp: 1, message: { mid: "m1", text: "how much for a site?" } },
              { sender: { id: PAGE }, timestamp: 2, message: { mid: "m2", text: "echo", is_echo: true } },
            ],
            changes: [
              { field: "feed", value: { item: "comment", verb: "add", comment_id: "c1", message: "interested!", from: { id: "u2", name: "Sam" }, created_time: 10 } },
              { field: "feed", value: { item: "comment", verb: "add", comment_id: "c2", message: "thanks", from: { id: PAGE } } },
              { field: "feed", value: { item: "reaction", verb: "add" } },
            ],
          },
        ],
      },
      PAGE,
    );
    expect(events.map((e) => (e.kind === "message" ? e.id : e.commentId))).toEqual(["m1", "c1"]);
  });
});

describe("polling filters", () => {
  const now = new Date("2026-03-01T12:00:00Z").getTime();
  const msg = (id: string, conv: string, from: string, iso: string) => ({ id, conversationId: conv, text: "hi", fromId: from, fromName: "", createdTime: iso });

  it("only answers conversations whose newest message is from the customer and inside 24h", () => {
    const out = messagesNeedingReply(
      [
        msg("a1", "A", "cust", "2026-03-01T10:00:00Z"),
        msg("a2", "A", PAGE, "2026-03-01T10:05:00Z"), // already answered
        msg("b1", "B", "cust", "2026-03-01T11:00:00Z"),
        msg("c1", "C", "cust", "2026-02-27T11:00:00Z"), // outside the window
      ],
      PAGE,
      now,
    );
    expect(out.map((m) => m.id)).toEqual(["b1"]);
  });

  it("skips the Page's own comments", () => {
    const c = (id: string, from: string) => ({ id, postId: "p", message: "x", fromId: from, fromName: "", createdTime: "" });
    expect(commentsNeedingReply([c("1", PAGE), c("2", "u")], PAGE).map((x) => x.id)).toEqual(["2"]);
  });
});

describe("AgentState scheduling", () => {
  it("runs tasks once per interval and persists across restarts", () => {
    const path = join(tmp(), "state.json");
    const t0 = new Date("2026-01-01T00:00:00Z");
    const state = new AgentState(path, t0);
    expect(state.isDue("post", 48, t0)).toBe(true);
    state.markRan("post", t0);
    state.save();
    const reloaded = new AgentState(path);
    expect(reloaded.isDue("post", 48, new Date("2026-01-02T00:00:00Z"))).toBe(false);
    expect(reloaded.isDue("post", 48, new Date("2026-01-03T00:00:00Z"))).toBe(true);
    expect(reloaded.isDue("post", 0, t0)).toBe(false); // 0 disables
  });
});

describe("OutreachAgent (no network)", () => {
  it("drafts up to the daily limit using fallback templates and builds the queue", async () => {
    const cfg = { ...outreachConfig, OUTREACH_DATA_DIR: tmp(), OUTREACH_DAILY_LIMIT: 2, FB_PAGE_ID: "", FB_PAGE_ACCESS_TOKEN: "" };
    const notes: string[] = [];
    const agent = new OutreachAgent(cfg, async (t) => void notes.push(t));
    agent.leads.add(["A", "B", "C"].map((name) => ({ name, niche: "bakery", city: "Reno", source: "csv" as const })));
    await agent.tick(new Date("2026-01-01T00:00:00Z"));
    expect(agent.leads.byStatus("drafted")).toHaveLength(2);
    expect(agent.sendQueue()).toHaveLength(2);
    // digest + one message per queued DM
    expect(notes).toHaveLength(3);
    expect(notes[1]).toContain("facebook.com/search");
  });

  it("formats a queue entry with the draft and the mark-sent command", () => {
    const text = formatQueueMessage(
      { id: "x-y", name: "X", niche: "", city: "Y", source: "csv", status: "drafted", followUpCount: 0, createdAt: "", draft: "Hello!" },
      false,
    );
    expect(text).toContain("Hello!");
    expect(text).toContain("npm run outreach -- sent x-y");
  });
});

describe("prompts / config", () => {
  it("tells the model when the prospect has no website", () => {
    const prompt = buildColdMessagePrompt(
      { id: "a", name: "Tony's Tacos", niche: "restaurant", city: "Fresno", source: "google-places", status: "new", followUpCount: 0, createdAt: "", rating: 4.8, reviewCount: 212 },
      outreachConfig,
    );
    expect(prompt).toContain("no website");
    expect(prompt).toContain("4.8 (212 reviews)");
  });

  it("parses niche|city targets", () => {
    expect(parseTargets("plumbers|Austin TX; salons | Dallas ;bad")).toEqual([
      { niche: "plumbers", city: "Austin TX" },
      { niche: "salons", city: "Dallas" },
    ]);
  });
});
