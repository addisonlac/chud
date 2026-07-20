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
export class PumpFunScanner extends EventEmitter {
  private readonly baseUrl: string;
  private readonly intervalMs: number;
  private readonly pageLimit: number;
  private readonly maxSeenMints: number;

  private seenMints = new Set<string>();
  private seenOrder: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

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
    this.inFlight = true;
    try {
      const url = `${this.baseUrl}/coins?offset=0&limit=${this.pageLimit}&sort=created_timestamp&order=DESC`;
      const raw = await fetchJson<PumpFunCoinRaw[]>(url, { timeoutMs: 2000, retries: 0 });

      for (const rawCoin of raw) {
        if (this.seenMints.has(rawCoin.mint)) continue;
        this.markSeen(rawCoin.mint);
        this.emit("newToken", mapRawCoin(rawCoin));
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, "pump.fun poll failed");
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
