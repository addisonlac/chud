import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import type { PumpFunToken } from "../types/index.js";
import type { TokenScanner } from "./types.js";

const log = childLogger("pumpportal-scanner");

/**
 * A "create" event from PumpPortal's data WebSocket (subscribeNewToken).
 * marketCapSol / vSol* / vTokens* describe the bonding curve at creation
 * time. Fields are optional/defensive since it's a third-party stream.
 */
interface PumpPortalCreateEvent {
  txType?: string;
  mint?: string;
  name?: string;
  symbol?: string;
  traderPublicKey?: string;
  marketCapSol?: number;
  vSolInBondingCurve?: number;
  vTokensInBondingCurve?: number;
  uri?: string;
}

/**
 * Maps a PumpPortal create event to the PumpFunToken shape the rest of the
 * pipeline consumes. marketCapSol and the SOL price give USD market cap
 * (needed for the >$50k filter, rule #2); price is derived from the
 * bonding-curve reserves. Returns null for anything that isn't a valid new
 * token creation.
 */
// pump.fun tokens have a fixed 1B total supply, so market cap can be
// recomputed from the bonding-curve reserves if marketCapSol is missing.
const PUMPFUN_TOTAL_SUPPLY = 1_000_000_000;

export function mapCreateEvent(event: PumpPortalCreateEvent, solPriceUsd: number): PumpFunToken | null {
  if (event.txType !== "create" || !event.mint || !event.symbol) return null;

  const priceSol =
    event.vSolInBondingCurve && event.vTokensInBondingCurve
      ? event.vSolInBondingCurve / event.vTokensInBondingCurve
      : 0;

  // Prefer the reported marketCapSol; fall back to price × total supply so a
  // missing field doesn't silently zero out the market cap (which would
  // make every token fail the >$50k filter).
  const marketCapSol = event.marketCapSol ?? priceSol * PUMPFUN_TOTAL_SUPPLY;

  return {
    mint: event.mint,
    symbol: event.symbol,
    name: event.name ?? event.symbol,
    createdAt: Date.now(),
    creator: event.traderPublicKey ?? "",
    marketCapUsd: marketCapSol * solPriceUsd,
    priceUsd: priceSol * solPriceUsd,
  };
}

/**
 * A "migration" event from PumpPortal's subscribeMigration stream — fired
 * when a token completes its bonding curve and graduates to a DEX
 * (~$69k market cap). These are the established "runners" the >$50k
 * strategy targets. Event metadata is sparse, so real market data is
 * fetched from Birdeye downstream in the pipeline.
 */
interface PumpPortalMigrationEvent {
  txType?: string;
  mint?: string;
  symbol?: string;
  name?: string;
  marketCapSol?: number;
  pool?: string;
}

// pump.fun tokens graduate at roughly this market cap; used as a sentinel
// so migrated tokens clear the >$50k filter when the event omits mcap. The
// real value is fetched from Birdeye during evaluation.
const GRADUATION_MCAP_USD_SENTINEL = 69_000;

export function mapMigrationEvent(event: PumpPortalMigrationEvent, solPriceUsd: number): PumpFunToken | null {
  if (!event.mint) return null;

  const marketCapUsd = event.marketCapSol ? event.marketCapSol * solPriceUsd : GRADUATION_MCAP_USD_SENTINEL;
  const symbol = event.symbol ?? event.mint.slice(0, 6);

  return {
    mint: event.mint,
    symbol,
    name: event.name ?? symbol,
    createdAt: Date.now(),
    creator: "",
    marketCapUsd,
    priceUsd: 0, // real price comes from Birdeye during evaluation
  };
}

const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;

/** "new" = brand-new token creations; "migration" = tokens graduating to a DEX (~$69k). */
export type PumpPortalMode = "new" | "migration";

export interface PumpPortalScannerOptions {
  url?: string;
  maxSeenMints?: number;
  mode?: PumpPortalMode;
}

export declare interface PumpPortalScanner {
  on(event: "newToken", listener: (token: PumpFunToken) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

/**
 * Streams pump.fun tokens from PumpPortal's free WebSocket
 * (wss://pumpportal.fun/api/data), either brand-new creations
 * (mode "new", subscribeNewToken) or tokens graduating to a DEX
 * (mode "migration", subscribeMigration — the established >$50k "runners").
 * Auto-reconnects with exponential backoff and re-subscribes on every
 * (re)connect since the subscription is per-connection.
 */
export class PumpPortalScanner extends EventEmitter implements TokenScanner {
  private readonly url: string;
  private readonly maxSeenMints: number;
  private readonly mode: PumpPortalMode;
  private ws: WebSocket | null = null;
  private seenMints = new Set<string>();
  private seenOrder: string[] = [];
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private solPriceUsd = 150;

  constructor(
    private readonly getSolPriceUsd: () => Promise<number>,
    options: PumpPortalScannerOptions = {},
  ) {
    super();
    this.url = options.url ?? env.PUMPPORTAL_WS_URL;
    this.maxSeenMints = options.maxSeenMints ?? 5000;
    this.mode = options.mode ?? "new";
  }

  start(): void {
    this.stopped = false;
    void this.refreshSolPrice();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  private async refreshSolPrice(): Promise<void> {
    try {
      this.solPriceUsd = await this.getSolPriceUsd();
    } catch {
      // keep the last known price; a stale SOL price only slightly skews
      // the pre-filter market cap, and Birdeye re-checks it downstream.
    }
  }

  private connect(): void {
    if (this.stopped) return;
    log.info({ url: this.url, mode: this.mode }, "connecting to PumpPortal stream");

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelay = INITIAL_RECONNECT_MS;
      const method = this.mode === "migration" ? "subscribeMigration" : "subscribeNewToken";
      ws.send(JSON.stringify({ method }));
      log.info({ mode: this.mode }, `subscribed to PumpPortal ${method} stream`);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      void this.handleMessage(data.toString());
    });

    ws.on("error", (err: Error) => {
      log.warn({ err: err.message }, "PumpPortal websocket error");
      this.emit("error", err);
    });

    ws.on("close", () => {
      this.ws = null;
      if (this.stopped) return;
      log.warn({ reconnectInMs: this.reconnectDelay }, "PumpPortal websocket closed, reconnecting");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
  }

  private async handleMessage(raw: string): Promise<void> {
    let event: PumpPortalCreateEvent & PumpPortalMigrationEvent;
    try {
      event = JSON.parse(raw) as PumpPortalCreateEvent & PumpPortalMigrationEvent;
    } catch {
      return; // ignore non-JSON frames (e.g. the initial subscribe ack)
    }

    if (!event.mint || this.seenMints.has(event.mint)) return;

    // Refresh SOL price opportunistically (cached upstream, so this is cheap)
    // so USD market caps stay roughly current across a long-lived connection.
    await this.refreshSolPrice();

    const token =
      this.mode === "migration"
        ? mapMigrationEvent(event, this.solPriceUsd)
        : mapCreateEvent(event, this.solPriceUsd);
    if (!token) return;

    this.markSeen(token.mint);
    this.emit("newToken", token);
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
