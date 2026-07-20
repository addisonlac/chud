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
    position.realizedPnlUsd = (exitPriceUsd - position.entryPriceUsd) * position.quantityTokens;

    await this.persist();
    log.info(
      { mint: position.mint, symbol: position.symbol, exitReason, realizedPnlUsd: position.realizedPnlUsd },
      "position closed",
    );
    return position;
  }
}
