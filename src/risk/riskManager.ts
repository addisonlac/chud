import { env } from "../config/env.js";
import type { ExitReason, PortfolioSnapshot, Position } from "../types/index.js";

export interface RiskConfig {
  maxRiskPctPerTrade: number;
  stopLossPct: number;
  trailingStopPct: number;
  maxPositionAgeHours: number;
  minSolReserve: number;
  confidenceThreshold: number;
  // Partial take-profit: sell takeProfitSizePct of the position once it's up
  // takeProfitPct. takeProfitPct <= 0 disables it.
  takeProfitPct: number;
  takeProfitSizePct: number;
  // Once the peak is up breakevenTriggerPct from entry, the floor stop moves
  // to breakeven and the trailing stop tightens to trailingStopTightPct.
  breakevenTriggerPct: number;
  trailingStopTightPct: number;
}

export function defaultRiskConfig(): RiskConfig {
  return {
    maxRiskPctPerTrade: env.MAX_RISK_PCT_PER_TRADE,
    stopLossPct: env.STOP_LOSS_PCT,
    trailingStopPct: env.TRAILING_STOP_PCT,
    maxPositionAgeHours: env.MAX_POSITION_AGE_HOURS,
    minSolReserve: env.MIN_SOL_RESERVE,
    confidenceThreshold: env.CONFIDENCE_THRESHOLD,
    takeProfitPct: env.TAKE_PROFIT_PCT,
    takeProfitSizePct: env.TAKE_PROFIT_SIZE_PCT,
    breakevenTriggerPct: env.BREAKEVEN_TRIGGER_PCT,
    trailingStopTightPct: env.TRAILING_STOP_TIGHT_PCT,
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
 * The active stop is whichever is highest of three floors, ratcheting up
 * with new peaks and never down:
 *   1. the fixed -20% floor set at entry (also raised to breakeven after a
 *      partial take-profit, via position.stopLossPriceUsd);
 *   2. a breakeven floor (entry) once the position has either banked partial
 *      profit OR run up breakevenTriggerPct — so a winner that reverses can't
 *      become a full loss;
 *   3. a trailing stop below the peak. It stays LOOSE (trailingStopPct) until
 *      partial profit is banked, then tightens to trailingStopTightPct.
 *
 * Keeping the trail loose until the take-profit fires is deliberate: a
 * memecoin routinely wicks 20-30% mid-run, so a tight trail armed early just
 * shakes you out before the token reaches the target. Once half the size is
 * banked, the remainder is house money and gets the tighter trail.
 */
export function computeEffectiveStop(position: Position, config: RiskConfig = defaultRiskConfig()): EffectiveStop {
  const entry = position.entryPriceUsd;
  const banked = position.tookPartialProfit === true;
  const peakGainPct = entry > 0 ? (position.peakPriceUsd - entry) / entry : 0;

  // Breakeven floor arms after banking partial profit or a large run-up.
  const breakevenArmed = banked || peakGainPct >= config.breakevenTriggerPct;
  // Trail only tightens after partial profit is banked.
  const trailPct = banked ? config.trailingStopTightPct : config.trailingStopPct;

  const trailingStopPrice = position.peakPriceUsd * (1 - trailPct);
  const floor = breakevenArmed ? Math.max(position.stopLossPriceUsd, entry) : position.stopLossPriceUsd;

  if (trailingStopPrice > floor) {
    return { price: trailingStopPrice, isTrailing: true };
  }
  return { price: floor, isTrailing: false };
}

export interface TakeProfitCheck {
  shouldScaleOut: boolean;
  sellFraction: number; // fraction of the *current remaining* position to sell
  targetPriceUsd: number;
}

/**
 * Partial take-profit: once (and only once) the price reaches
 * entry × (1 + takeProfitPct), signal selling takeProfitSizePct of the
 * position to bank the gain. The remainder keeps riding the trailing stop.
 * Disabled when takeProfitPct/takeProfitSizePct is 0 or the scale-out has
 * already fired for this position.
 */
export function checkTakeProfit(
  position: Position,
  currentPriceUsd: number,
  config: RiskConfig = defaultRiskConfig(),
): TakeProfitCheck {
  const targetPriceUsd = position.entryPriceUsd * (1 + config.takeProfitPct);
  const disabled = config.takeProfitPct <= 0 || config.takeProfitSizePct <= 0;

  if (disabled || position.tookPartialProfit || currentPriceUsd < targetPriceUsd) {
    return { shouldScaleOut: false, sellFraction: 0, targetPriceUsd };
  }
  return { shouldScaleOut: true, sellFraction: config.takeProfitSizePct, targetPriceUsd };
}

/**
 * Full-exit triggers: the (trailing/breakeven) stop and the max hold age.
 * The partial take-profit is handled separately by checkTakeProfit — it
 * scales out rather than fully closing, so winners keep riding.
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
