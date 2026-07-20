import { getTokenOverview } from "./birdeye.js";
import { fetchCryptoNews } from "../news/newsApi.js";
import { childLogger } from "../utils/logger.js";
import type { NewsItem } from "../types/index.js";

const log = childLogger("market-context");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_PRICE_TTL_MS = 30_000;
const NEWS_TTL_MS = 5 * 60_000;

/**
 * Caches the two pieces of context that are expensive/rate-limited but
 * change slowly relative to the 200ms scan loop: SOL/USD price and the
 * broad crypto news feed. Every evaluated token reads from this cache
 * instead of re-fetching per-mint.
 */
class MarketContext {
  private solPriceUsd = 150;
  private solPriceFetchedAt = 0;

  private news: NewsItem[] = [];
  private newsFetchedAt = 0;

  async getSolPriceUsd(): Promise<number> {
    if (Date.now() - this.solPriceFetchedAt < SOL_PRICE_TTL_MS) return this.solPriceUsd;

    try {
      const overview = await getTokenOverview(SOL_MINT);
      if (overview.priceUsd > 0) {
        this.solPriceUsd = overview.priceUsd;
        this.solPriceFetchedAt = Date.now();
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, "failed to refresh SOL price, using stale value");
    }

    return this.solPriceUsd;
  }

  async getCryptoNews(): Promise<NewsItem[]> {
    if (Date.now() - this.newsFetchedAt < NEWS_TTL_MS) return this.news;

    try {
      this.news = await fetchCryptoNews();
      this.newsFetchedAt = Date.now();
    } catch (err) {
      log.warn({ err: (err as Error).message }, "failed to refresh crypto news, using stale value");
    }

    return this.news;
  }
}

export const marketContext = new MarketContext();
