import { EventEmitter } from "node:events";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { fetchJson } from "../utils/http.js";
import type { PumpFunToken } from "../types/index.js";

const log = childLogger("pumpfun-scanner");

/**
 * Shape returned by pump.fun's unofficial frontend API
 * (GET /coins?offset=&limit=&sort=created_timestamp&order=DESC).
 * This endpoint is reverse-engineered and undocumented — it can change or
 * rate-limit without notice. See README for the PumpPortal websocket
 * fallback if this becomes unreliable in production.
 */
interface PumpFunCoinRaw {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  created_timestamp: number;
  usd_market_cap?: number;
  market_cap?: number;
  virtual_sol_reserves?: number;
  virtual_token_reserves?: number;
  uri?: string;
}

export function mapRawCoin(raw: PumpFunCoinRaw): PumpFunToken {
  const priceUsd =
    raw.virtual_sol_reserves && raw.virtual_token_reserves
      ? raw.virtual_sol_reserves / raw.virtual_token_reserves
      : 0;

  return {
    mint: raw.mint,
    symbol: raw.symbol,
    name: raw.name,
    createdAt: raw.created_timestamp,
    creator: raw.creator,
    marketCapUsd: raw.usd_market_cap ?? raw.market_cap ?? 0,
    priceUsd,
    virtualSolReserves: raw.virtual_sol_reserves,
    virtualTokenReserves: raw.virtual_token_reserves,
    uri: raw.uri,
  };
}

export interface PumpFunScannerOptions {
  baseUrl?: string;
  intervalMs?: number;
  pageLimit?: number;
  /** Caps memory for the dedupe set; oldest entries are pruned past this. */
  maxSeenMints?: number;
}

export declare interface PumpFunScanner {
  on(event: "newToken", listener: (token: PumpFunToken) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

/**
 * Polls pump.fun for newly created tokens on a fixed interval and emits
 * `newToken` exactly once per mint. Polling (rather than a long-lived
 * websocket) is what the strategy spec calls for, so failures are isolated
 * per-tick: a single failed fetch logs and waits for the next tick instead
 * of tearing down the loop.
 */
// pump.fun's frontend API sits behind Cloudflare and rejects requests that
// don't look like they came from the pump.fun web app (HTTP 530/403). These
// browser-like headers make the poll look like the site's own XHR calls,
// which gets past the basic bot filter most of the time.
const BROWSER_HEADERS: Record<string, string> = {
  accept: "application/json",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  origin: "https://pump.fun",
  referer: "https://pump.fun/",
};

export class PumpFunScanner extends EventEmitter {
  private readonly baseUrl: string;
  private readonly intervalMs: number;
  private readonly pageLimit: number;
  private readonly maxSeenMints: number;

  private seenMints = new Set<string>();
  private seenOrder: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private consecutiveFailures = 0;

  constructor(options: PumpFunScannerOptions = {}) {
    super();
    this.baseUrl = options.baseUrl ?? env.PUMPFUN_BASE_URL;
    this.intervalMs = options.intervalMs ?? env.PUMPFUN_SCAN_INTERVAL_MS;
    this.pageLimit = options.pageLimit ?? 50;
    this.maxSeenMints = options.maxSeenMints ?? 5000;
  }

  start(): void {
    if (this.timer) return;
    log.info({ intervalMs: this.intervalMs, baseUrl: this.baseUrl }, "starting pump.fun scanner");
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return; // don't stack requests if one tick runs long

    // Back off when the endpoint is consistently failing (e.g. Cloudflare
    // is blocking us): after a run of failures, only actually attempt the
    // request on a fraction of ticks, so we stop hammering a dead endpoint
    // and stop flooding the logs with one warning every interval.
    if (this.consecutiveFailures > 5) {
      const skipFactor = Math.min(this.consecutiveFailures, 60); // cap the backoff
      if (Math.floor(Date.now() / this.intervalMs) % skipFactor !== 0) return;
    }

    this.inFlight = true;
    try {
      const url = `${this.baseUrl}/coins?offset=0&limit=${this.pageLimit}&sort=created_timestamp&order=DESC`;
      const raw = await fetchJson<PumpFunCoinRaw[]>(url, { timeoutMs: 2000, retries: 0, headers: BROWSER_HEADERS });

      if (this.consecutiveFailures > 0) {
        log.info("pump.fun endpoint recovered");
        this.consecutiveFailures = 0;
      }

      for (const rawCoin of raw) {
        if (this.seenMints.has(rawCoin.mint)) continue;
        this.markSeen(rawCoin.mint);
        this.emit("newToken", mapRawCoin(rawCoin));
      }
    } catch (err) {
      this.consecutiveFailures++;
      // Only log the first failure and then occasionally, instead of every tick.
      if (this.consecutiveFailures === 1 || this.consecutiveFailures % 20 === 0) {
        log.warn(
          { err: (err as Error).message, consecutiveFailures: this.consecutiveFailures },
          "pump.fun poll failing (endpoint may be blocking requests — see README pump.fun caveat)",
        );
      }
      this.emit("error", err as Error);
    } finally {
      this.inFlight = false;
    }
  }

  private markSeen(mint: string): void {
    this.seenMints.add(mint);
    this.seenOrder.push(mint);
    if (this.seenOrder.length > this.maxSeenMints) {
      const evicted = this.seenOrder.shift();
      if (evicted) this.seenMints.delete(evicted);
    }
  }
}
