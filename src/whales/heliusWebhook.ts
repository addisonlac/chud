import { env } from "../config/env.js";
import { fetchJson } from "../utils/http.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("helius-webhook");

interface HeliusWebhookConfig {
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: "enhanced";
  authHeader: string;
}

interface HeliusWebhookRecord {
  webhookID: string;
  wallet: string;
  webhookURL: string;
  accountAddresses: string[];
}

/**
 * Registers (or updates) a Helius "enhanced" webhook covering the whale
 * watchlist so SWAP/TRANSFER activity from those wallets is pushed to us
 * in real time (strategy rule #5), instead of us polling per-wallet.
 */
export async function upsertWhaleWebhook(
  addresses: string[],
  existingWebhookId?: string,
): Promise<HeliusWebhookRecord> {
  const config: HeliusWebhookConfig = {
    webhookURL: env.HELIUS_WEBHOOK_URL,
    transactionTypes: ["SWAP", "TRANSFER"],
    accountAddresses: addresses,
    webhookType: "enhanced",
    authHeader: env.HELIUS_WEBHOOK_SECRET,
  };

  const url = existingWebhookId
    ? `https://api.helius.xyz/v0/webhooks/${existingWebhookId}?api-key=${env.HELIUS_API_KEY}`
    : `https://api.helius.xyz/v0/webhooks?api-key=${env.HELIUS_API_KEY}`;

  const record = await fetchJson<HeliusWebhookRecord>(url, {
    method: existingWebhookId ? "PUT" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  });

  log.info({ webhookID: record.webhookID, wallets: addresses.length }, "whale webhook registered");
  return record;
}

/**
 * Helius doesn't sign webhook payloads by default; the convention is to
 * set a shared-secret `authHeader` on the webhook config (above) and check
 * it matches the incoming request's Authorization header.
 */
export function verifyWebhookAuth(receivedAuthHeader: string | undefined): boolean {
  if (!env.HELIUS_WEBHOOK_SECRET) {
    log.warn("HELIUS_WEBHOOK_SECRET not set — rejecting all webhook requests");
    return false;
  }
  return receivedAuthHeader === env.HELIUS_WEBHOOK_SECRET;
}

// --- Raw payload shape (subset of Helius "enhanced" transaction schema) ---

export interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  mint: string;
  tokenAmount: number;
}

export interface HeliusSwapEvent {
  tokenInputs?: { mint: string; tokenAmount: number; userAccount: string }[];
  tokenOutputs?: { mint: string; tokenAmount: number; userAccount: string }[];
  nativeInput?: { account: string; amount: string };
  nativeOutput?: { account: string; amount: string };
}

export interface HeliusEnhancedTransaction {
  signature: string;
  type: string;
  timestamp: number; // unix seconds
  feePayer: string;
  tokenTransfers?: HeliusTokenTransfer[];
  events?: { swap?: HeliusSwapEvent };
}
