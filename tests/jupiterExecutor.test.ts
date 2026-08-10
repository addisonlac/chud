import { describe, expect, it } from "vitest";
import { applyPaperExitCost } from "../src/execution/jupiterExecutor.js";

describe("applyPaperExitCost", () => {
  it("haircuts the exit price by the round-trip cost", () => {
    expect(applyPaperExitCost(1, 0.04)).toBeCloseTo(0.96, 5);
    expect(applyPaperExitCost(2, 0.05)).toBeCloseTo(1.9, 5);
  });

  it("returns the price unchanged when cost is zero", () => {
    expect(applyPaperExitCost(1.5, 0)).toBeCloseTo(1.5, 5);
  });

  it("treats a negative cost as zero (never inflates the fill)", () => {
    expect(applyPaperExitCost(1, -0.1)).toBeCloseTo(1, 5);
  });
});
