import { env } from "../config/env.js";
import { fetchJson } from "../utils/http.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("sol-price");

interface CoinbaseSpotResponse {
  data?: { amount?: string };
}

interface CoinGeckoSimpleResponse {
  solana?: { usd?: number };
}

// --- Pure parsers (unit-testable without the network) ---

export function parseCoinbasePrice(res: CoinbaseSpotResponse): number {
  const price = Number(res.data?.amount);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Coinbase returned no usable SOL price");
  }
  return price;
}

export function parseCoinGeckoPrice(res: CoinGeckoSimpleResponse): number {
  const price = res.solana?.usd;
  if (price === undefined || !Number.isFinite(price) || price <= 0) {
    throw new Error("CoinGecko returned no usable SOL price");
  }
  return price;
}

async function fromCoinbase(): Promise<number> {
  const res = await fetchJson<CoinbaseSpotResponse>(env.COINBASE_SPOT_URL, { timeoutMs: 6000, retries: 1 });
  return parseCoinbasePrice(res);
}

async function fromCoinGecko(): Promise<number> {
  const res = await fetchJson<CoinGeckoSimpleResponse>(env.COINGECKO_PRICE_URL, { timeoutMs: 6000, retries: 1 });
  return parseCoinGeckoPrice(res);
}

/**
 * SOL/USD from keyless public price APIs — Coinbase primary, CoinGecko
 * fallback — instead of the rate-limited Birdeye token_overview. Both are
 * free and need no API key; behind marketContext's 30s cache they're queried
 * roughly twice a minute, well under any published limit. Throws only if
 * BOTH sources fail, so the caller keeps the last known price.
 */
export async function fetchSolPriceUsd(): Promise<number> {
  try {
    return await fromCoinbase();
  } catch (primaryErr) {
    log.warn({ err: (primaryErr as Error).message }, "Coinbase SOL price failed, trying CoinGecko");
    try {
      return await fromCoinGecko();
    } catch (fallbackErr) {
      throw new Error(`all SOL price sources failed (last: ${(fallbackErr as Error).message})`);
    }
  }
}
