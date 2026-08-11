import { fetchSolPriceUsd } from "./solPrice.js";
import { fetchCryptoNews } from "../news/newsApi.js";
import { childLogger } from "../utils/logger.js";
import type { NewsItem } from "../types/index.js";

const log = childLogger("market-context");

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
    // Mark the attempt time BEFORE fetching so a failure still backs off for
    // the full TTL instead of retrying on every single token event — which
    // otherwise turns one failure into a storm.
    this.solPriceFetchedAt = Date.now();

    try {
      const price = await fetchSolPriceUsd();
      if (price > 0) this.solPriceUsd = price;
    } catch (err) {
      log.warn({ err: (err as Error).message }, "failed to refresh SOL price, using stale value");
    }

    return this.solPriceUsd;
  }

  async getCryptoNews(): Promise<NewsItem[]> {
    if (Date.now() - this.newsFetchedAt < NEWS_TTL_MS) return this.news;
    this.newsFetchedAt = Date.now(); // back off on failure too (see getSolPriceUsd)

    try {
      this.news = await fetchCryptoNews();
    } catch (err) {
      log.warn({ err: (err as Error).message }, "failed to refresh crypto news, using stale value");
    }

    return this.news;
  }
}

export const marketContext = new MarketContext();
