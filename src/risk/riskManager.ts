import { env } from "../config/env.js";
import type { ExitReason, PortfolioSnapshot, Position } from "../types/index.js";

export interface RiskConfig {
  maxRiskPctPerTrade: number;
  stopLossPct: number;
  maxPositionAgeHours: number;
  minSolReserve: number;
  confidenceThreshold: number;
}

export function defaultRiskConfig(): RiskConfig {
  return {
    maxRiskPctPerTrade: env.MAX_RISK_PCT_PER_TRADE,
    stopLossPct: env.STOP_LOSS_PCT,
    maxPositionAgeHours: env.MAX_POSITION_AGE_HOURS,
    minSolReserve: env.MIN_SOL_RESERVE,
    confidenceThreshold: env.CONFIDENCE_THRESHOLD,
  };
}

export type SizingResult =
  | {
      approved: true;
      quantityTokens: number;
      costBasisUsd: number;
      costBasisSol: number;
      stopLossPriceUsd: number;
    }
  | { approved: false; reason: string };

/**
 * Fixed-fractional position sizing: risking `maxRiskPctPerTrade` of the
 * portfolio against a `stopLossPct` stop means the position notional is
 * (riskPct / stopLossPct) of the portfolio (e.g. 2% risk / 20% stop = 10%
 * of portfolio per trade). The 0.5 SOL reserve is enforced as a hard floor
 * on top of that — a trade is trimmed or rejected before it would ever
 * dip the wallet below the reserve.
 */
export function sizePosition(
  portfolio: PortfolioSnapshot,
  entryPriceUsd: number,
  solPriceUsd: number,
  config: RiskConfig = defaultRiskConfig(),
): SizingResult {
  if (entryPriceUsd <= 0 || solPriceUsd <= 0) {
    return { approved: false, reason: "invalid price data" };
  }

  const riskAmountUsd = portfolio.totalValueUsd * config.maxRiskPctPerTrade;
  const desiredPositionUsd = riskAmountUsd / config.stopLossPct;

  const spendableSol = Math.max(0, portfolio.solBalance - config.minSolReserve);
  const spendableUsd = spendableSol * solPriceUsd;

  const positionValueUsd = Math.min(desiredPositionUsd, portfolio.availableForTradingUsd, spendableUsd);

  if (positionValueUsd <= 0) {
    return { approved: false, reason: "insufficient funds above the 0.5 SOL reserve" };
  }

  const costBasisSol = positionValueUsd / solPriceUsd;
  if (portfolio.solBalance - costBasisSol < config.minSolReserve) {
    return { approved: false, reason: "trade would breach minimum SOL reserve" };
  }

  return {
    approved: true,
    quantityTokens: positionValueUsd / entryPriceUsd,
    costBasisUsd: positionValueUsd,
    costBasisSol,
    stopLossPriceUsd: entryPriceUsd * (1 - config.stopLossPct),
  };
}

export function meetsConfidenceThreshold(confidence: number, config: RiskConfig = defaultRiskConfig()): boolean {
  return confidence > config.confidenceThreshold;
}

export interface ExitCheck {
  shouldExit: boolean;
  reason?: ExitReason;
}

/**
 * Only two exit triggers by design: stop loss and max age. There is
 * deliberately no take-profit rule ("let winners ride" per the strategy).
 */
export function checkExitConditions(
  position: Position,
  currentPriceUsd: number,
  now: number = Date.now(),
  config: RiskConfig = defaultRiskConfig(),
): ExitCheck {
  if (currentPriceUsd <= position.stopLossPriceUsd) {
    return { shouldExit: true, reason: "stop_loss" };
  }

  const ageHours = (now - position.entryTimestamp) / (1000 * 60 * 60);
  if (ageHours >= (position.maxAgeHours ?? config.maxPositionAgeHours)) {
    return { shouldExit: true, reason: "max_age" };
  }

  return { shouldExit: false };
}
