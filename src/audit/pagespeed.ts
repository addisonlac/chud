import { fetchJson } from "../utils/http.js";
import type { SpeedResult } from "./website.js";

interface PsiResponse {
  lighthouseResult?: {
    categories?: { performance?: { score?: number | null } };
    audits?: Record<string, { numericValue?: number }>;
  };
}

/** Google PageSpeed Insights (mobile). Free; a key only raises the rate limit. */
export async function measureMobileSpeed(url: string, apiKey?: string): Promise<SpeedResult | null> {
  const params = new URLSearchParams({ url, strategy: "mobile", category: "performance" });
  if (apiKey) params.set("key", apiKey);
  try {
    const res = await fetchJson<PsiResponse>(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, {
      timeoutMs: 90_000,
      retries: 1,
      retryDelayMs: 5000,
    });
    const score = res.lighthouseResult?.categories?.performance?.score;
    if (score == null) return null;
    const lcpMs = res.lighthouseResult?.audits?.["largest-contentful-paint"]?.numericValue;
    return { score: Math.round(score * 100), lcpSeconds: lcpMs ? Math.round(lcpMs / 100) / 10 : null };
  } catch {
    return null;
  }
}
