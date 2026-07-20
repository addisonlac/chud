import type { WhaleActivitySummary, WhaleTransaction } from "../types/index.js";

const RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Maintains a rolling per-mint activity log from already-parsed whale
 * transactions (produced by SolanaWhalePoller), so the scorer payload
 * (rule #6) can ask "have whales been buying this mint recently?" The
 * watchlist filter and USD estimation both happen upstream in the poller
 * now — this class is just the rolling window + summary.
 */
export class WhaleTracker {
  private whaleSet: Set<string> = new Set();
  private byMint = new Map<string, WhaleTransaction[]>();

  setWatchlist(addresses: string[]): void {
    this.whaleSet = new Set(addresses);
  }

  ingest(transactions: WhaleTransaction[]): void {
    for (const tx of transactions) {
      if (!this.whaleSet.has(tx.wallet)) continue;

      const list = this.byMint.get(tx.mint) ?? [];
      list.push(tx);
      this.byMint.set(tx.mint, list);
    }
    this.prune();
  }

  private prune(): void {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [mint, txs] of this.byMint) {
      const kept = txs.filter((t) => t.timestamp >= cutoff);
      if (kept.length === 0) this.byMint.delete(mint);
      else this.byMint.set(mint, kept);
    }
  }

  getActivity(mint: string, windowMinutes = 60): WhaleActivitySummary {
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    const txs = (this.byMint.get(mint) ?? []).filter((t) => t.timestamp >= cutoff);

    const buyCount = txs.filter((t) => t.type === "buy").length;
    const sellCount = txs.filter((t) => t.type === "sell").length;
    const netFlowUsd = txs.reduce((sum, t) => sum + (t.type === "buy" ? t.amountUsd : t.type === "sell" ? -t.amountUsd : 0), 0);

    return {
      mint,
      windowMinutes,
      buyCount,
      sellCount,
      netFlowUsd,
      distinctWhales: new Set(txs.map((t) => t.wallet)).size,
      recentTransactions: txs.slice(-20),
    };
  }
}
