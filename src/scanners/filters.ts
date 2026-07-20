import type { PumpFunToken } from "../types/index.js";
import { env } from "../config/env.js";

/**
 * Strategy rule #2: only tokens with market cap above the configured floor
 * (default $50k) move on to the (expensive) candle/sentiment/whale/AI
 * pipeline. Filtering here, before any paid API calls, keeps cost and rate
 * limits under control against a 200ms scan cadence.
 */
export function passesMarketCapFilter(
  token: PumpFunToken,
  minMarketCapUsd: number = env.MIN_MARKET_CAP_USD,
): boolean {
  return token.marketCapUsd > minMarketCapUsd;
}
