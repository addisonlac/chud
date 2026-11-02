import type { Category, Finding, Platform } from "../types.js";
import { CATEGORIES } from "../types.js";

const WEIGHT: Record<Finding["severity"], number> = { 1: 10, 2: 22, 3: 40 };

export interface ScoreResult {
  scores: Record<Category, number>;
  category: Category | null;
}

/**
 * Opportunity score 0–100 per offer, from the severity of the problems we
 * found. The highest-scoring offer decides which queue the lead lands in.
 */
export function scoreFindings(findings: Finding[], minScore: number, platform?: Platform | null): ScoreResult {
  const scores = { website: 0, ads: 0, cro: 0 } as Record<Category, number>;
  for (const f of findings) scores[f.category] = Math.min(100, scores[f.category] + WEIGHT[f.severity]);

  // Tie-break: a Shopify store is a CRO lead first, then ads, then website.
  const order: Category[] = platform === "shopify" ? ["cro", "ads", "website"] : ["website", "ads", "cro"];
  let best: Category | null = null;
  for (const c of order) if (best === null || scores[c] > scores[best]) best = c;
  if (best === null || scores[best] < minScore) return { scores, category: null };
  return { scores, category: best };
}

/** Generic problems any site can have — pitched after the offer-specific ones on ties. */
const GENERIC = new Set(["no_https", "no_meta_description", "old_jquery", "no_mobile"]);

/** The findings to pitch for a category, worst first (max 3 — emails stay short). */
export function topFindings(findings: Finding[], category: Category, max = 3): Finding[] {
  return findings
    .filter((f) => f.category === category)
    .sort((a, b) => b.severity - a.severity || Number(GENERIC.has(a.id)) - Number(GENERIC.has(b.id)))
    .slice(0, max);
}

export { CATEGORIES };
