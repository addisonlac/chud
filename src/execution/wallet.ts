import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("wallet");

let cachedKeypair: Keypair | null | undefined;
let cachedConnection: Connection | null = null;

export function getConnection(): Connection {
  if (!cachedConnection) {
    cachedConnection = new Connection(env.SOLANA_RPC_URL, "confirmed");
  }
  return cachedConnection;
}

/**
 * Returns null when no private key is configured (expected in paper mode).
 * Callers in live mode must handle null explicitly rather than this
 * throwing, so paper trading never requires a wallet at all.
 */
export function getWalletKeypair(): Keypair | null {
  if (cachedKeypair !== undefined) return cachedKeypair;

  if (!env.WALLET_PRIVATE_KEY) {
    cachedKeypair = null;
    return cachedKeypair;
  }

  try {
    const secretKey = bs58.decode(env.WALLET_PRIVATE_KEY);
    cachedKeypair = Keypair.fromSecretKey(secretKey);
    log.info({ publicKey: cachedKeypair.publicKey.toBase58() }, "wallet loaded");
  } catch (err) {
    log.error({ err: (err as Error).message }, "failed to decode WALLET_PRIVATE_KEY");
    cachedKeypair = null;
  }

  return cachedKeypair;
}

export async function getSolBalance(publicKey: PublicKey): Promise<number> {
  const lamports = await getConnection().getBalance(publicKey);
  return lamports / LAMPORTS_PER_SOL;
}
