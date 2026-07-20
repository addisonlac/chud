import { env } from "../config/env.js";
import { fetchJson } from "../utils/http.js";
import type { NewsItem } from "../types/index.js";

interface NewsApiArticle {
  title: string;
  description: string | null;
  url: string;
  publishedAt: string;
  source: { name: string };
}

interface NewsApiResponse {
  status: string;
  totalResults: number;
  articles: NewsApiArticle[];
}

/**
 * Strategy rule #4 (data source half): pulls recent crypto news. Brand new
 * pump.fun tokens rarely have dedicated coverage, so callers typically pass
 * a broad market query (SOL/memecoin/crypto) for macro sentiment context
 * rather than expecting per-token headlines.
 */
export async function fetchCryptoNews(query = "solana OR crypto OR memecoin", pageSize = 20): Promise<NewsItem[]> {
  const url =
    `${env.NEWSAPI_BASE_URL}/everything?q=${encodeURIComponent(query)}` +
    `&language=en&sortBy=publishedAt&pageSize=${pageSize}`;

  const res = await fetchJson<NewsApiResponse>(url, {
    headers: { "X-Api-Key": env.NEWSAPI_KEY },
  });

  return res.articles.map((a) => ({
    title: a.title,
    description: a.description,
    source: a.source.name,
    url: a.url,
    publishedAt: a.publishedAt,
  }));
}
