import { PublicKey, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { getConnection } from "../execution/wallet.js";
import { childLogger } from "../utils/logger.js";
import { env } from "../config/env.js";
import type { WhaleTracker } from "./whaleTracker.js";
import type { WhaleTransaction, WhaleTxType } from "../types/index.js";

const log = childLogger("whale-poller");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT]);

/**
 * Minimal shape the pure parser actually needs, decoupled from
 * @solana/web3.js's full ParsedTransactionWithMeta so it's easy to
 * construct in tests. toWalletTxBalances() adapts a real RPC response
 * into this.
 */
export interface WalletTxBalances {
  signature: string;
  blockTimeSeconds: number | null;
  walletSolDeltaLamports: number;
  tokenBalanceDeltas: { mint: string; uiAmountDelta: number }[];
}

/**
 * Decides buy/sell/amountUsd from a wallet's balance changes in one
 * transaction. Heuristic, not a full swap-instruction decoder: it picks
 * the largest-magnitude non-quote-mint balance change as "the" token
 * involved, which covers simple swaps well but can misread complex
 * multi-hop routes. This is the tradeoff for polling raw balance diffs
 * off the free public RPC instead of paying for Helius's pre-parsed swap
 * events.
 */
export function parseWhaleTransaction(
  tx: WalletTxBalances,
  wallet: string,
  solPriceUsd: number,
): WhaleTransaction | null {
  const nonQuoteDeltas = tx.tokenBalanceDeltas.filter((d) => !QUOTE_MINTS.has(d.mint) && d.uiAmountDelta !== 0);
  if (nonQuoteDeltas.length === 0) return null;

  const largest = nonQuoteDeltas.reduce((a, b) => (Math.abs(b.uiAmountDelta) > Math.abs(a.uiAmountDelta) ? b : a));

  const amountUsd = Math.abs(tx.walletSolDeltaLamports / 1e9) * solPriceUsd;
  const type: WhaleTxType = largest.uiAmountDelta > 0 ? "buy" : "sell";

  return {
    signature: tx.signature,
    wallet,
    mint: largest.mint,
    type,
    amountUsd,
    timestamp: (tx.blockTimeSeconds ?? Math.floor(Date.now() / 1000)) * 1000,
  };
}

function toWalletTxBalances(tx: ParsedTransactionWithMeta, wallet: string): WalletTxBalances | null {
  if (!tx.meta) return null;

  const accountKeys = tx.transaction.message.accountKeys;
  const walletIndex = accountKeys.findIndex((k) => k.pubkey.toBase58() === wallet);
  if (walletIndex === -1) return null;

  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];
  const deltaByMint = new Map<string, number>();

  for (const balance of post) {
    if (balance.owner !== wallet) continue;
    const preMatch = pre.find((p) => p.accountIndex === balance.accountIndex);
    const preAmount = preMatch?.uiTokenAmount.uiAmount ?? 0;
    const postAmount = balance.uiTokenAmount.uiAmount ?? 0;
    deltaByMint.set(balance.mint, (deltaByMint.get(balance.mint) ?? 0) + (postAmount - preAmount));
  }
  for (const balance of pre) {
    if (balance.owner !== wallet) continue;
    if (post.some((p) => p.accountIndex === balance.accountIndex)) continue; // already counted above
    const preAmount = balance.uiTokenAmount.uiAmount ?? 0;
    deltaByMint.set(balance.mint, (deltaByMint.get(balance.mint) ?? 0) - preAmount);
  }

  return {
    signature: tx.transaction.signatures[0] ?? "unknown",
    blockTimeSeconds: tx.blockTime ?? null,
    walletSolDeltaLamports: (tx.meta.postBalances[walletIndex] ?? 0) - (tx.meta.preBalances[walletIndex] ?? 0),
    tokenBalanceDeltas: [...deltaByMint.entries()].map(([mint, uiAmountDelta]) => ({ mint, uiAmountDelta })),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the free public Solana RPC per watched wallet instead of
 * registering Helius webhooks — no signup, no cost, but the public
 * endpoint is shared/rate-limited, so whale activity lags by up to
 * intervalMs and can silently miss data under load. Requests are staggered
 * across the interval (not fired all at once) specifically to stay under
 * public-RPC rate limits with a 50-wallet watchlist.
 */
export class SolanaWhalePoller {
  private readonly connection: Connection;
  private readonly lastSeenSignature = new Map<string, string>();
  private wallets: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly whaleTracker: WhaleTracker,
    private readonly getSolPriceUsd: () => Promise<number>,
    private readonly intervalMs: number = env.WHALE_POLL_INTERVAL_MS,
  ) {
    this.connection = getConnection();
  }

  setWatchlist(wallets: string[]): void {
    this.wallets = wallets;
  }

  start(): void {
    if (this.timer || this.wallets.length === 0) return;
    log.info(
      { wallets: this.wallets.length, intervalMs: this.intervalMs },
      "starting whale poller (free public Solana RPC — see README free-tier tradeoffs)",
    );
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const solPriceUsd = await this.getSolPriceUsd();
    const gapMs = Math.max(50, Math.floor(this.intervalMs / Math.max(this.wallets.length, 1)));

    for (const wallet of this.wallets) {
      try {
        await this.pollWallet(wallet, solPriceUsd);
      } catch (err) {
        log.debug({ wallet, err: (err as Error).message }, "whale poll failed for wallet");
      }
      await sleep(gapMs);
    }
  }

  private async pollWallet(wallet: string, solPriceUsd: number): Promise<void> {
    const pubkey = new PublicKey(wallet);
    const signatures = await this.connection.getSignaturesForAddress(pubkey, { limit: 10 }, "confirmed");
    if (signatures.length === 0) return;

    const lastSeen = this.lastSeenSignature.get(wallet);
    let newSignatures = signatures;
    if (lastSeen) {
      const idx = signatures.findIndex((s) => s.signature === lastSeen);
      newSignatures = idx === -1 ? signatures : signatures.slice(0, idx);
    } else {
      newSignatures = signatures.slice(0, 3); // first run: don't backfill full history
    }

    this.lastSeenSignature.set(wallet, signatures[0]!.signature);
    if (newSignatures.length === 0) return;

    const transactions: WhaleTransaction[] = [];
    for (const sigInfo of newSignatures) {
      const tx = await this.connection.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      const balances = toWalletTxBalances(tx, wallet);
      if (!balances) continue;
      const parsed = parseWhaleTransaction(balances, wallet, solPriceUsd);
      if (parsed) transactions.push(parsed);
    }

    if (transactions.length > 0) this.whaleTracker.ingest(transactions);
  }
}
