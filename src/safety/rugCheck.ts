import { env } from "../config/env.js";
import type { TokenOverview, TokenSecurityInfo } from "../types/index.js";

export interface RugCheckConfig {
  requireMintAuthorityRevoked: boolean;
  requireFreezeAuthorityRevoked: boolean;
  maxTop10HolderPct: number;
  maxCreatorPct: number;
  blockToken2022TransferFee: boolean;
  minLiquidityUsd: number;
}

export function defaultRugCheckConfig(): RugCheckConfig {
  return {
    requireMintAuthorityRevoked: env.REQUIRE_MINT_AUTHORITY_REVOKED,
    requireFreezeAuthorityRevoked: env.REQUIRE_FREEZE_AUTHORITY_REVOKED,
    maxTop10HolderPct: env.MAX_TOP10_HOLDER_PCT,
    maxCreatorPct: env.MAX_CREATOR_PCT,
    blockToken2022TransferFee: env.BLOCK_TOKEN2022_TRANSFER_FEE,
    minLiquidityUsd: env.MIN_LIQUIDITY_USD,
  };
}

export interface SafetyAssessment {
  passed: boolean;
  reasons: string[];
}

/**
 * Hard pre-trade gate against the most common pump.fun/Solana rug vectors:
 * an un-revoked mint authority (supply can be inflated at will), an
 * un-revoked freeze authority (holder accounts can be frozen so they can't
 * sell), extreme holder/creator concentration (a handful of wallets can tank
 * price by dumping), Token-2022 transfer-fee extensions (can silently tax or
 * block trades), and thin liquidity (high slippage, easy to manipulate).
 * This runs BEFORE candles/sentiment/whale enrichment and the AI scoring
 * call, so an unsafe token is rejected cheaply instead of burning API/AI
 * spend on something that was never going to be traded.
 */
export function assessTokenSafety(
  security: TokenSecurityInfo,
  overview: TokenOverview,
  config: RugCheckConfig = defaultRugCheckConfig(),
): SafetyAssessment {
  const reasons: string[] = [];

  if (config.requireMintAuthorityRevoked && security.mintAuthority) {
    reasons.push("mint authority not revoked — supply can be inflated at will");
  }

  if (config.requireFreezeAuthorityRevoked && security.freezeAuthority) {
    reasons.push("freeze authority not revoked — holder accounts can be frozen");
  }

  if (security.top10HolderPct > config.maxTop10HolderPct) {
    reasons.push(
      `top 10 holders control ${pct(security.top10HolderPct)} of supply (max ${pct(config.maxTop10HolderPct)})`,
    );
  }

  if (security.creatorPct > config.maxCreatorPct) {
    reasons.push(`creator holds ${pct(security.creatorPct)} of supply (max ${pct(config.maxCreatorPct)})`);
  }

  if (config.blockToken2022TransferFee && security.isToken2022 && security.transferFeeEnabled) {
    reasons.push("Token-2022 transfer-fee extension enabled — can silently tax or block trades");
  }

  if (overview.liquidityUsd < config.minLiquidityUsd) {
    reasons.push(`liquidity $${overview.liquidityUsd.toLocaleString()} below minimum $${config.minLiquidityUsd.toLocaleString()}`);
  }

  return { passed: reasons.length === 0, reasons };
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}
