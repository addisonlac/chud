import { VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { env } from "../config/env.js";
import { fetchJson } from "../utils/http.js";
import { childLogger } from "../utils/logger.js";
import { getConnection, getWalletKeypair } from "./wallet.js";
import type { ExecutionResult } from "../types/index.js";

const log = childLogger("jupiter");

const SOL_MINT = "So11111111111111111111111111111111111111112";
// pump.fun SPL tokens are minted with 6 decimals by convention.
const DEFAULT_TOKEN_DECIMALS = 6;
const DEFAULT_SLIPPAGE_BPS = 300; // 3% — memecoin liquidity is thin, tight slippage just fails the swap

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  [key: string]: unknown;
}

interface JupiterSwapResponse {
  swapTransaction: string; // base64
}

/**
 * The price a PAPER exit actually realizes after execution friction (Jupiter
 * route fees + slippage on thin liquidity + priority fees), so paper P&L
 * isn't the fantasy of a perfect quoted fill. Applied per sell leg. Pure and
 * unit-testable. Live fills carry these costs for real, so they're not
 * modeled here — only paper needs the simulation.
 */
export function applyPaperExitCost(idealPriceUsd: number, costPct: number = env.PAPER_TRADING_COST_PCT): number {
  return idealPriceUsd * (1 - Math.max(0, costPct));
}

async function getQuote(inputMint: string, outputMint: string, amountRaw: number, slippageBps = DEFAULT_SLIPPAGE_BPS) {
  const url =
    `${env.JUPITER_BASE_URL}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${Math.floor(amountRaw)}&slippageBps=${slippageBps}`;
  return fetchJson<JupiterQuoteResponse>(url, { timeoutMs: 8000, retries: 1 });
}

async function submitSwap(quote: JupiterQuoteResponse, userPublicKey: string): Promise<string> {
  const swapRes = await fetchJson<JupiterSwapResponse>(`${env.JUPITER_BASE_URL}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });

  const keypair = getWalletKeypair();
  if (!keypair) throw new Error("cannot submit a live swap without a wallet keypair");

  const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, "base64"));
  tx.sign([keypair]);

  const connection = getConnection();
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction(signature, "confirmed");

  return signature;
}

async function execute(
  inputMint: string,
  outputMint: string,
  amountRaw: number,
  outputDecimals: number,
  mode: "paper" | "live",
): Promise<ExecutionResult> {
  try {
    const quote = await getQuote(inputMint, outputMint, amountRaw);
    const filledQuantityTokens = Number(quote.outAmount) / 10 ** outputDecimals;
    const filledPriceUsd = 0; // caller fills in USD pricing from the overview/candle data it already has

    if (mode === "paper") {
      log.info({ inputMint, outputMint, amountRaw, filledQuantityTokens }, "[paper] simulated fill");
      return { success: true, mode: "paper", filledPriceUsd, filledQuantityTokens };
    }

    const keypair = getWalletKeypair();
    if (!keypair) {
      return {
        success: false,
        mode: "live",
        filledPriceUsd: 0,
        filledQuantityTokens: 0,
        error: "LIVE_TRADING is enabled but no wallet keypair is configured",
      };
    }

    const signature = await submitSwap(quote, keypair.publicKey.toBase58());
    log.info({ signature, inputMint, outputMint }, "live swap submitted");
    return { success: true, mode: "live", txSignature: signature, filledPriceUsd, filledQuantityTokens };
  } catch (err) {
    log.error({ err: (err as Error).message, inputMint, outputMint }, "swap failed");
    return { success: false, mode, filledPriceUsd: 0, filledQuantityTokens: 0, error: (err as Error).message };
  }
}

export async function executeBuy(mint: string, solAmount: number, mode: "paper" | "live"): Promise<ExecutionResult> {
  const amountLamports = solAmount * LAMPORTS_PER_SOL;
  return execute(SOL_MINT, mint, amountLamports, DEFAULT_TOKEN_DECIMALS, mode);
}

export async function executeSell(
  mint: string,
  tokenAmount: number,
  mode: "paper" | "live",
  tokenDecimals = DEFAULT_TOKEN_DECIMALS,
): Promise<ExecutionResult> {
  const amountRaw = tokenAmount * 10 ** tokenDecimals;
  return execute(mint, SOL_MINT, amountRaw, 9, mode);
}
