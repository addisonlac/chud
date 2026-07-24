import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { childLogger } from "../utils/logger.js";
import type { ExitReason, Position, TradeSignal } from "../types/index.js";

const log = childLogger("position-store");

const DATA_DIR = path.resolve("data");
const POSITIONS_PATH = path.join(DATA_DIR, "positions.json");

export interface OpenPositionParams {
  signal: TradeSignal;
  entryPriceUsd: number;
  quantityTokens: number;
  costBasisUsd: number;
  costBasisSol: number;
  stopLossPriceUsd: number;
  maxAgeHours: number;
}

/**
 * Persists positions to disk so open positions (and their stop-loss / max
 * age clocks) survive a process restart instead of silently vanishing.
 */
export class PositionStore {
  private positions: Position[] = [];

  async load(): Promise<void> {
    try {
      const raw = await readFile(POSITIONS_PATH, "utf-8");
      this.positions = JSON.parse(raw) as Position[];
      log.info({ count: this.positions.length }, "loaded positions from disk");
    } catch {
      this.positions = [];
    }
  }

  private async persist(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(POSITIONS_PATH, JSON.stringify(this.positions, null, 2));
  }

  getOpen(): Position[] {
    return this.positions.filter((p) => p.status === "open");
  }

  getAll(): Position[] {
    return this.positions;
  }

  hasOpenPosition(mint: string): boolean {
    return this.positions.some((p) => p.mint === mint && p.status === "open");
  }

  /** Persists a new peak price for the trailing stop. No-ops (no write) if the price isn't a new high. */
  async updatePeakPrice(id: string, currentPriceUsd: number): Promise<Position | null> {
    const position = this.positions.find((p) => p.id === id);
    if (!position) return null;

    if (currentPriceUsd > position.peakPriceUsd) {
      position.peakPriceUsd = currentPriceUsd;
      await this.persist();
    }
    return position;
  }

  /**
   * Partial take-profit: sells `sellFraction` of the position's *current*
   * remaining tokens at `priceUsd`, banks the realized PnL, raises the floor
   * stop to at least breakeven, and keeps the position open so the remainder
   * rides the trailing stop. Fires at most once (tookPartialProfit guards
   * the caller). Returns the sold quantity + banked PnL, or null if the
   * position is missing/closed/empty.
   */
  async scaleOutPosition(
    id: string,
    sellFraction: number,
    priceUsd: number,
  ): Promise<{ position: Position; soldQuantityTokens: number; realizedPnlUsd: number } | null> {
    const position = this.positions.find((p) => p.id === id && p.status === "open");
    if (!position || sellFraction <= 0 || position.quantityTokens <= 0) return null;

    const soldQuantityTokens = position.quantityTokens * Math.min(sellFraction, 1);
    const realizedPnlUsd = (priceUsd - position.entryPriceUsd) * soldQuantityTokens;

    position.quantityTokens -= soldQuantityTokens;
    position.scaledOutQuantityTokens = (position.scaledOutQuantityTokens ?? 0) + soldQuantityTokens;
    position.realizedScaleOutPnlUsd = (position.realizedScaleOutPnlUsd ?? 0) + realizedPnlUsd;
    position.tookPartialProfit = true;
    // Can't give back the banked win: floor the remainder at breakeven.
    position.stopLossPriceUsd = Math.max(position.stopLossPriceUsd, position.entryPriceUsd);

    await this.persist();
    log.info(
      { mint: position.mint, symbol: position.symbol, soldQuantityTokens, realizedPnlUsd },
      "partial take-profit: scaled out, remainder rides the trailing stop",
    );
    return { position, soldQuantityTokens, realizedPnlUsd };
  }

  async openPosition(params: OpenPositionParams): Promise<Position> {
    const position: Position = {
      id: randomUUID(),
      mint: params.signal.mint,
      symbol: params.signal.symbol,
      status: "open",
      entryPriceUsd: params.entryPriceUsd,
      entryTimestamp: Date.now(),
      quantityTokens: params.quantityTokens,
      costBasisUsd: params.costBasisUsd,
      costBasisSol: params.costBasisSol,
      stopLossPriceUsd: params.stopLossPriceUsd,
      peakPriceUsd: params.entryPriceUsd,
      maxAgeHours: params.maxAgeHours,
      tookPartialProfit: false,
      scaledOutQuantityTokens: 0,
      realizedScaleOutPnlUsd: 0,
      signal: params.signal,
    };

    this.positions.push(position);
    await this.persist();
    log.info({ mint: position.mint, symbol: position.symbol, costBasisUsd: position.costBasisUsd }, "position opened");
    return position;
  }

  async closePosition(id: string, exitPriceUsd: number, exitReason: ExitReason): Promise<Position | null> {
    const position = this.positions.find((p) => p.id === id);
    if (!position) return null;

    position.status = "closed";
    position.exitPriceUsd = exitPriceUsd;
    position.exitTimestamp = Date.now();
    position.exitReason = exitReason;
    // Realized PnL on the remainder plus anything already banked via a
    // partial take-profit scale-out, so a scaled winner's full gain shows up.
    position.realizedPnlUsd =
      (exitPriceUsd - position.entryPriceUsd) * position.quantityTokens + (position.realizedScaleOutPnlUsd ?? 0);

    await this.persist();
    log.info(
      { mint: position.mint, symbol: position.symbol, exitReason, realizedPnlUsd: position.realizedPnlUsd },
      "position closed",
    );
    return position;
  }
}
