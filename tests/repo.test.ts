import { describe, expect, it } from "vitest";
import { memRepo } from "./helpers.js";
import { normalizeDomain } from "../src/db/repo.js";
import { csvToLeads } from "../src/discover/csvImport.js";
import { SettingsStore } from "../src/config/settings.js";

describe("repo", () => {
  it("normalizes domains and dedupes leads", () => {
    expect(normalizeDomain("https://www.Lumen.co/collections/all")).toBe("lumen.co");
    const repo = memRepo();
    expect(repo.insertLead({ name: "Lumen", source: "manual", websiteUrl: "lumen.co" })).not.toBeNull();
    expect(repo.insertLead({ name: "Lumen again", source: "csv", websiteUrl: "https://www.lumen.co" })).toBeNull();
  });

  it("builds per-category queues sorted by score", () => {
    const repo = memRepo();
    for (const [name, score] of [["A", 30], ["B", 80]] as const) {
      const id = repo.insertLead({ name, source: "manual", websiteUrl: `${name}.com` })!;
      repo.updateLead(id, { status: "drafted", category: "cro", scores: { website: 0, ads: 0, cro: score } });
      repo.saveSequence(id, [{ step: 0, subject: "s", body: "b", channel: "email", composer: "template", delayDays: 0 }]);
    }
    expect(repo.queue("cro").map((l) => l.name)).toEqual(["B", "A"]);
    expect(repo.stats().queues).toEqual({ website: 0, ads: 0, cro: 2 });
  });
});

describe("csv import", () => {
  it("maps loose column names and skips rows without a website/facebook", () => {
    const leads = csvToLeads('Business Name,URL,Email\n"Lumen, & Co",lumen.co,hi@lumen.co\nNo Site,,x@y.com\n');
    expect(leads).toEqual([{ name: "Lumen, & Co", source: "csv", niche: undefined, websiteUrl: "lumen.co", facebookUrl: null, email: "hi@lumen.co" }]);
  });
});

describe("settings", () => {
  it("masks secrets for the UI and keeps them when the mask is saved back", () => {
    const repo = memRepo();
    const store = new SettingsStore(repo);
    store.save({ smtpPass: "hunter2", niches: "candles, soap" });
    const ui = store.forUi();
    expect(ui.values.smtpPass).not.toContain("hunter2");
    store.save({ smtpPass: ui.values.smtpPass });
    expect(store.get().smtpPass).toBe("hunter2");
    expect(store.get().niches).toEqual(["candles", "soap"]);
  });
});
