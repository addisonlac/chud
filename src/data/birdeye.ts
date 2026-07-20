import { env } from "../config/env.js";
import { fetchJson } from "../utils/http.js";
import { childLogger } from "../utils/logger.js";
import type { Candle, CandleSet, CandleTimeframe, TokenOverview, TokenSecurityInfo, TopHolder } from "../types/index.js";

const log = childLogger("birdeye");

// Birdeye's `type` query param values for the OHLCV endpoint.
const TIMEFRAME_TO_BIRDEYE_TYPE: Record<CandleTimeframe, string> = {
  "5m": "5m",
  "1h": "1H",
  "1d": "1D",
};

// How far back to request per timeframe, so a 5m call doesn't pull a year
// of candles and a 1d call doesn't pull only a few points.
const TIMEFRAME_LOOKBACK_SECONDS: Record<CandleTimeframe, number> = {
  "5m": 60 * 60 * 6, // 6h of 5m candles
  "1h": 60 * 60 * 24 * 7, // 7d of 1h candles
  "1d": 60 * 60 * 24 * 90, // 90d of 1d candles
};

interface BirdeyeOhlcvItem {
  unixTime: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface BirdeyeOhlcvResponse {
  data?: { items?: BirdeyeOhlcvItem[] };
  success: boolean;
}

interface BirdeyeTokenOverviewResponse {
  success: boolean;
  data?: {
    mc?: number;
    liquidity?: number;
    price?: number;
    priceChange24hPercent?: number;
    v24hUSD?: number;
    holder?: number;
  };
}

interface BirdeyeHolderItem {
  owner: string;
  amount: string;
  ui_amount?: number;
  percentage?: number;
}

interface BirdeyeHolderResponse {
  success: boolean;
  data?: { items?: BirdeyeHolderItem[] };
}

interface BirdeyeTokenSecurityResponse {
  success: boolean;
  data?: {
    mintAuthority?: string | null;
    freezeAuthority?: string | null;
    top10HolderPercent?: number;
    creatorPercentage?: number;
    isToken2022?: boolean;
    transferFeeEnabled?: boolean;
  };
}

function authHeaders(): Record<string, string> {
  return {
    "X-API-KEY": env.BIRDEYE_API_KEY,
    "x-chain": "solana",
    accept: "application/json",
  };
}

async function getCandlesForTimeframe(mint: string, timeframe: CandleTimeframe): Promise<Candle[]> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - TIMEFRAME_LOOKBACK_SECONDS[timeframe];
  const type = TIMEFRAME_TO_BIRDEYE_TYPE[timeframe];

  const url =
    `${env.BIRDEYE_BASE_URL}/defi/ohlcv?address=${mint}` +
    `&type=${type}&time_from=${from}&time_to=${now}`;

  const res = await fetchJson<BirdeyeOhlcvResponse>(url, { headers: authHeaders() });

  return (res.data?.items ?? []).map((item) => ({
    timestamp: item.unixTime,
    open: item.o,
    high: item.h,
    low: item.l,
    close: item.c,
    volumeUsd: item.v,
  }));
}

/** Strategy rule #3: pull 5m, 1h and 1d candles for a token in one shot. */
export async function getCandles(mint: string): Promise<CandleSet> {
  const [fiveMin, oneHour, oneDay] = await Promise.all([
    getCandlesForTimeframe(mint, "5m"),
    getCandlesForTimeframe(mint, "1h"),
    getCandlesForTimeframe(mint, "1d"),
  ]);

  return { mint, "5m": fiveMin, "1h": oneHour, "1d": oneDay };
}

export async function getTokenOverview(mint: string): Promise<TokenOverview> {
  const url = `${env.BIRDEYE_BASE_URL}/defi/token_overview?address=${mint}`;
  const res = await fetchJson<BirdeyeTokenOverviewResponse>(url, { headers: authHeaders() });
  const data = res.data ?? {};

  return {
    mint,
    marketCapUsd: data.mc ?? 0,
    liquidityUsd: data.liquidity ?? 0,
    priceUsd: data.price ?? 0,
    priceChange24hPct: data.priceChange24hPercent ?? 0,
    volume24hUsd: data.v24hUSD ?? 0,
    holders: data.holder ?? 0,
  };
}

/**
 * Rug/safety signal used to hard-gate trades before any AI scoring happens.
 * Deliberately does NOT catch errors and default to "safe" — a failed
 * security lookup should block the trade (via the caller's evaluation
 * failing closed), not silently let an unvetted token through.
 */
export async function getTokenSecurity(mint: string): Promise<TokenSecurityInfo> {
  const url = `${env.BIRDEYE_BASE_URL}/defi/token_security?address=${mint}`;
  const res = await fetchJson<BirdeyeTokenSecurityResponse>(url, { headers: authHeaders() });
  const data = res.data ?? {};

  return {
    mint,
    mintAuthority: data.mintAuthority ?? null,
    freezeAuthority: data.freezeAuthority ?? null,
    top10HolderPct: data.top10HolderPercent ?? 1,
    creatorPct: data.creatorPercentage ?? 1,
    isToken2022: data.isToken2022 ?? false,
    transferFeeEnabled: data.transferFeeEnabled ?? false,
  };
}

/** Used to seed/refresh the top-50 whale watchlist per strategy rule #5. */
export async function getTopHolders(mint: string, limit = 50): Promise<TopHolder[]> {
  const url = `${env.BIRDEYE_BASE_URL}/defi/v3/token/holder?address=${mint}&offset=0&limit=${limit}`;

  try {
    const res = await fetchJson<BirdeyeHolderResponse>(url, { headers: authHeaders() });
    return (res.data?.items ?? []).map((item) => ({
      wallet: item.owner,
      amountUsd: item.ui_amount ?? 0,
      pctOfSupply: item.percentage ?? 0,
    }));
  } catch (err) {
    log.warn({ mint, err: (err as Error).message }, "failed to fetch top holders");
    return [];
  }
}
