import { childLogger } from "../utils/logger.js";
import type { HeliusEnhancedTransaction } from "./heliusWebhook.js";
import type { WhaleActivitySummary, WhaleTransaction, WhaleTxType } from "../types/index.js";

const log = childLogger("whale-tracker");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT]);

const RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Ingests Helius enhanced-transaction webhook payloads for the whale
 * watchlist and maintains a rolling per-mint activity log, so the scorer
 * payload (rule #6) can ask "have whales been buying this mint recently?"
 */
export class WhaleTracker {
  private whaleSet: Set<string> = new Set();
  private byMint = new Map<string, WhaleTransaction[]>();
  private solPriceUsd = 150; // overridden via setSolPriceUsd() from live market data

  setWatchlist(addresses: string[]): void {
    this.whaleSet = new Set(addresses);
  }

  setSolPriceUsd(price: number): void {
    if (price > 0) this.solPriceUsd = price;
  }

  ingest(transactions: HeliusEnhancedTransaction[]): void {
    for (const tx of transactions) {
      const parsed = this.parseTransaction(tx);
      if (!parsed) continue;

      const list = this.byMint.get(parsed.mint) ?? [];
      list.push(parsed);
      this.byMint.set(parsed.mint, list);
    }
    this.prune();
  }

  private parseTransaction(tx: HeliusEnhancedTransaction): WhaleTransaction | null {
    const whale = [tx.feePayer, ...(tx.events?.swap?.tokenInputs?.map((t) => t.userAccount) ?? [])].find((addr) =>
      this.whaleSet.has(addr),
    );
    if (!whale) return null;

    const swap = tx.events?.swap;
    if (swap) {
      const boughtLeg = swap.tokenOutputs?.find((t) => !QUOTE_MINTS.has(t.mint));
      const soldLeg = swap.tokenInputs?.find((t) => !QUOTE_MINTS.has(t.mint));

      if (boughtLeg) {
        return {
          signature: tx.signature,
          wallet: whale,
          mint: boughtLeg.mint,
          type: "buy",
          amountUsd: this.estimateUsd(swap.nativeInput?.amount),
          timestamp: tx.timestamp * 1000,
        };
      }
      if (soldLeg) {
        return {
          signature: tx.signature,
          wallet: whale,
          mint: soldLeg.mint,
          type: "sell",
          amountUsd: this.estimateUsd(swap.nativeOutput?.amount),
          timestamp: tx.timestamp * 1000,
        };
      }
    }

    const transfer = tx.tokenTransfers?.find((t) => t.fromUserAccount === whale || t.toUserAccount === whale);
    if (transfer) {
      const type: WhaleTxType = transfer.toUserAccount === whale ? "transfer" : "transfer";
      return {
        signature: tx.signature,
        wallet: whale,
        mint: transfer.mint,
        type,
        amountUsd: 0,
        timestamp: tx.timestamp * 1000,
      };
    }

    return null;
  }

  private estimateUsd(lamportsStr: string | undefined): number {
    if (!lamportsStr) return 0;
    const lamports = Number(lamportsStr);
    if (!Number.isFinite(lamports)) return 0;
    return (lamports / 1e9) * this.solPriceUsd;
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
