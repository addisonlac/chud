import { describe, expect, it } from "vitest";
import { scoreFindings, topFindings } from "../src/score/score.js";
import type { Finding } from "../src/types.js";

const f = (category: Finding["category"], severity: Finding["severity"], id = `${category}${severity}`): Finding => ({ id, category, severity, evidence: id, pain: "p", fix: "x" });

describe("scoreFindings", () => {
  it("routes to the category with the most severe problems", () => {
    const r = scoreFindings([f("website", 1), f("ads", 3), f("cro", 2)], 25);
    expect(r.category).toBe("ads");
    expect(r.scores).toEqual({ website: 10, ads: 40, cro: 22 });
  });
  it("caps at 100", () => {
    expect(scoreFindings([f("cro", 3), f("cro", 3), f("cro", 3)], 25).scores.cro).toBe(100);
  });
  it("returns no category below the minimum score", () => {
    expect(scoreFindings([f("website", 1)], 25).category).toBeNull();
  });
  it("prefers CRO for Shopify stores on ties", () => {
    expect(scoreFindings([f("website", 2), f("cro", 2)], 10, "shopify").category).toBe("cro");
  });
  it("topFindings keeps the worst 3 of a category", () => {
    const top = topFindings([f("cro", 1, "a"), f("cro", 3, "b"), f("ads", 3, "c"), f("cro", 2, "d"), f("cro", 2, "e")], "cro");
    expect(top.map((x) => x.id)).toEqual(["b", "d", "e"]);
  });
});
