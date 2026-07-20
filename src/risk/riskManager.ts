import { env } from "../config/env.js";
import type { ExitReason, PortfolioSnapshot, Position } from "../types/index.js";

export interface RiskConfig {
  maxRiskPctPerTrade: number;
  stopLossPct: number;
  trailingStopPct: number;
  maxPositionAgeHours: number;
  minSolReserve: number;
  confidenceThreshold: number;
}

export function defaultRiskConfig(): RiskConfig {
  return {
    maxRiskPctPerTrade: env.MAX_RISK_PCT_PER_TRADE,
    stopLossPct: env.STOP_LOSS_PCT,
    trailingStopPct: env.TRAILING_STOP_PCT,
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
 * Tracks the highest price seen since entry — the input the trailing stop
 * ratchets off of. Pure function; the caller is responsible for persisting
 * the result (see PositionStore.updatePeakPrice).
 */
export function updatePeakPrice(position: Position, currentPriceUsd: number): number {
  return Math.max(position.peakPriceUsd, currentPriceUsd);
}

export interface EffectiveStop {
  price: number;
  isTrailing: boolean;
}

/**
 * The active stop is whichever is higher: the original fixed -20% floor
 * set at entry, or a trailing stop trailingStopPct below the peak price
 * since entry. It only ever ratchets up as new peaks are made, never down.
 * This is what actually lets winners "ride" instead of round-tripping a
 * 5x pump back down to a full stop-loss loss — once a token has run up
 * enough that peak*(1-trailingStopPct) clears the entry stop, gains start
 * getting locked in automatically.
 */
export function computeEffectiveStop(position: Position, config: RiskConfig = defaultRiskConfig()): EffectiveStop {
  const trailingStopPrice = position.peakPriceUsd * (1 - config.trailingStopPct);
  if (trailingStopPrice > position.stopLossPriceUsd) {
    return { price: trailingStopPrice, isTrailing: true };
  }
  return { price: position.stopLossPriceUsd, isTrailing: false };
}

/**
 * Three exit triggers: the (trailing) stop, and the 48h max age. There is
 * deliberately no take-profit rule ("let winners ride" per the strategy) —
 * the trailing stop is what protects realized gains instead.
 */
export function checkExitConditions(
  position: Position,
  currentPriceUsd: number,
  now: number = Date.now(),
  config: RiskConfig = defaultRiskConfig(),
): ExitCheck {
  const stop = computeEffectiveStop(position, config);
  if (currentPriceUsd <= stop.price) {
    return { shouldExit: true, reason: stop.isTrailing ? "trailing_stop" : "stop_loss" };
  }

  const ageHours = (now - position.entryTimestamp) / (1000 * 60 * 60);
  if (ageHours >= (position.maxAgeHours ?? config.maxPositionAgeHours)) {
    return { shouldExit: true, reason: "max_age" };
  }

  return { shouldExit: false };
}
