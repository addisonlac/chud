// ---------------------------------------------------------------------------
// Share position sizing — turns a price-level plan into an actual "buy/sell N
// shares" order. Sizing is risk-first: you decide how many dollars you're
// willing to lose if the stop is hit, and the share count falls out of the
// distance to that stop. This is the only responsible way to size equity
// trades — never "how many shares can I afford", always "how many shares keep
// my loss at $X if I'm wrong".
// ---------------------------------------------------------------------------
import type { Signal } from "./types.js";
import type { FuturesContract } from "./instruments.js";

export const DEFAULT_RISK_USD = 250; // dollars risked per trade if the stop hits

export interface ShareSize {
  shares: number; // whole shares to trade
  perShareRisk: number; // |entry - stop|
  riskUsd: number; // dollars at risk at the chosen size (shares × perShareRisk)
  notionalUsd: number; // capital deployed (shares × entry)
  targetPnlUsd: number[]; // dollar gain per target if hit at this size
}

/**
 * Size a trade to risk ~`riskUsd` to the stop. Returns whole shares (equities
 * don't fractionally on most venues) plus the resulting real dollar risk,
 * notional, and per-target dollar outcomes. Returns 0 shares when there is no
 * actionable plan (WAIT) or the stop distance is degenerate.
 */
export function sizeShares(sig: Signal, riskBudgetUsd = DEFAULT_RISK_USD): ShareSize {
  if (sig.action === "WAIT" || sig.entry === null || sig.stop === null) {
    return { shares: 0, perShareRisk: 0, riskUsd: 0, notionalUsd: 0, targetPnlUsd: [] };
  }
  const perShareRisk = Math.abs(sig.entry - sig.stop);
  const shares = perShareRisk > 0 ? Math.floor(riskBudgetUsd / perShareRisk) : 0;
  const dir = sig.action === "BUY" ? 1 : -1;
  return {
    shares,
    perShareRisk,
    riskUsd: shares * perShareRisk,
    notionalUsd: shares * sig.entry,
    targetPnlUsd: sig.targets.map((t) => shares * dir * (t - sig.entry!)),
  };
}

export interface ContractSize {
  contracts: number; // whole futures contracts to trade
  pointValue: number; // USD per index point, per contract
  stopPoints: number; // |entry - stop| in index points
  riskPerContract: number; // stopPoints × pointValue (USD lost per contract if stopped)
  riskUsd: number; // dollars at risk at the chosen size (contracts × riskPerContract)
  notionalUsd: number; // contract notional deployed (contracts × entry × pointValue)
  targetPnlUsd: number[]; // dollar gain per target if hit at this size
}

/**
 * Size a futures trade to risk ~`riskUsd` to the stop, in whole contracts.
 * `contracts = floor(riskBudget ÷ (stopPoints × pointValue))`. Same risk-first
 * discipline as shares, but the point value — not the share price — sets the
 * dollar exposure, so a Micro (MES $5/pt) and a full E-mini (ES $50/pt) size
 * very differently for the same idea. Returns 0 contracts when there is no
 * actionable plan or the stop distance is degenerate.
 */
export function sizeContracts(sig: Signal, contract: FuturesContract, riskBudgetUsd = DEFAULT_RISK_USD): ContractSize {
  if (sig.action === "WAIT" || sig.entry === null || sig.stop === null) {
    return { contracts: 0, pointValue: contract.pointValue, stopPoints: 0, riskPerContract: 0, riskUsd: 0, notionalUsd: 0, targetPnlUsd: [] };
  }
  const stopPoints = Math.abs(sig.entry - sig.stop);
  const riskPerContract = stopPoints * contract.pointValue;
  const contracts = riskPerContract > 0 ? Math.floor(riskBudgetUsd / riskPerContract) : 0;
  const dir = sig.action === "BUY" ? 1 : -1;
  return {
    contracts,
    pointValue: contract.pointValue,
    stopPoints,
    riskPerContract,
    riskUsd: contracts * riskPerContract,
    notionalUsd: contracts * sig.entry * contract.pointValue,
    targetPnlUsd: sig.targets.map((t) => contracts * dir * (t - sig.entry!) * contract.pointValue),
  };
}
