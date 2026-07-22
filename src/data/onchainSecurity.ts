import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../execution/wallet.js";
import { childLogger } from "../utils/logger.js";
import type { TokenSecurityInfo } from "../types/index.js";

const log = childLogger("onchain-security");

const TOKEN_2022_PROGRAM = "spl-token-2022";

interface ParsedMintInfo {
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  supply?: string;
  decimals?: number;
  extensions?: { extension?: string }[];
}

export interface SecurityInputs {
  mint: string;
  program: string; // "spl-token" | "spl-token-2022"
  info: ParsedMintInfo;
  top10UiAmount: number;
  totalUiSupply: number;
}

/**
 * Pure — derives the rug/safety snapshot from on-chain mint data + the
 * largest token accounts. Kept separate from the RPC fetch so the logic is
 * unit-testable. Replaces Birdeye's paid `token_security` endpoint with
 * facts anyone can read from the free Solana RPC.
 */
export function parseTokenSecurity(inputs: SecurityInputs): TokenSecurityInfo {
  const isToken2022 = inputs.program === TOKEN_2022_PROGRAM;
  const transferFeeEnabled = isToken2022
    ? (inputs.info.extensions ?? []).some((e) => e.extension === "transferFeeConfig")
    : false;
  const top10HolderPct = inputs.totalUiSupply > 0 ? inputs.top10UiAmount / inputs.totalUiSupply : 1;

  return {
    mint: inputs.mint,
    mintAuthority: inputs.info.mintAuthority ?? null,
    freezeAuthority: inputs.info.freezeAuthority ?? null,
    top10HolderPct,
    // Which holder is "the creator" isn't determinable from on-chain data
    // alone; top-10 concentration already covers the whale-dump risk.
    creatorPct: 0,
    isToken2022,
    transferFeeEnabled,
  };
}

/**
 * Fetches token security from the free Solana RPC (mint account + largest
 * holders) instead of Birdeye's paid token_security endpoint. Throws on
 * failure so the caller fails closed (skips the token) rather than trading
 * something unvetted.
 */
export async function getTokenSecurity(mint: string): Promise<TokenSecurityInfo> {
  const connection = getConnection();
  const mintPubkey = new PublicKey(mint);

  const [accountInfo, largest] = await Promise.all([
    connection.getParsedAccountInfo(mintPubkey),
    connection.getTokenLargestAccounts(mintPubkey),
  ]);

  const data = accountInfo.value?.data;
  if (!data || data instanceof Buffer || !("parsed" in data)) {
    throw new Error(`mint ${mint} is not a parseable SPL token mint account`);
  }

  const info = (data.parsed?.info ?? {}) as ParsedMintInfo;
  const decimals = info.decimals ?? 0;
  const totalUiSupply = info.supply ? Number(info.supply) / 10 ** decimals : 0;
  const top10UiAmount = largest.value.slice(0, 10).reduce((sum, acc) => sum + (acc.uiAmount ?? 0), 0);

  const result = parseTokenSecurity({ mint, program: data.program, info, top10UiAmount, totalUiSupply });
  log.debug({ mint, mintAuthRevoked: !result.mintAuthority, top10Pct: result.top10HolderPct }, "on-chain security read");
  return result;
}
