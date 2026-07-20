import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getTopHolders } from "../data/birdeye.js";
import { childLogger } from "../utils/logger.js";
import { env } from "../config/env.js";
import type { WhaleWallet } from "../types/index.js";

const log = childLogger("whale-list");

const DATA_DIR = path.resolve("data");
const WATCHLIST_PATH = path.join(DATA_DIR, "whale-watchlist.json");

/**
 * Maintains the strategy's "top 50 whale wallets" watchlist. There is no
 * single authoritative "top whale" API, so the list is a curated set of
 * wallet addresses (seeded manually or via `discoverFromTrendingTokens`,
 * which pulls large holders across currently-trending tokens as a proxy)
 * persisted to disk so the watchlist (and SolanaWhalePoller's per-wallet
 * poll state) is stable across restarts.
 */
export class WhaleList {
  private wallets: WhaleWallet[] = [];

  async load(): Promise<WhaleWallet[]> {
    try {
      const raw = await readFile(WATCHLIST_PATH, "utf-8");
      this.wallets = JSON.parse(raw) as WhaleWallet[];
    } catch {
      this.wallets = [];
    }
    return this.wallets;
  }

  async save(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(WATCHLIST_PATH, JSON.stringify(this.wallets, null, 2));
  }

  get(): WhaleWallet[] {
    return this.wallets;
  }

  addresses(): string[] {
    return this.wallets.map((w) => w.address);
  }

  setManual(addresses: string[]): void {
    this.wallets = addresses.slice(0, env.WHALE_WATCHLIST_SIZE).map((address, i) => ({
      address,
      rank: i + 1,
      label: "manual",
    }));
  }

  /**
   * Best-effort discovery: aggregates top holders across a set of
   * currently-active mints, ranks wallets by how often + how large they
   * show up, and keeps the top N. Meant to seed the list before a human
   * curates it with known "smart money" addresses.
   */
  async discoverFromTrendingTokens(mints: string[], limit = env.WHALE_WATCHLIST_SIZE): Promise<WhaleWallet[]> {
    const scoreByWallet = new Map<string, number>();

    for (const mint of mints) {
      const holders = await getTopHolders(mint, 20);
      for (const holder of holders) {
        scoreByWallet.set(holder.wallet, (scoreByWallet.get(holder.wallet) ?? 0) + holder.amountUsd);
      }
    }

    const ranked = [...scoreByWallet.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([address], i): WhaleWallet => ({ address, rank: i + 1, label: "discovered" }));

    this.wallets = ranked;
    log.info({ count: ranked.length }, "discovered whale watchlist from trending tokens");
    return ranked;
  }
}
