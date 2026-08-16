// ---------------------------------------------------------------------------
// Futures instrument registry.
//
// The signal engine is price-structure based and instrument-agnostic; what
// makes a trade a *futures* trade is the contract spec — the dollar value of a
// point and the tick — and sizing in whole CONTRACTS instead of shares.
//
// Index futures track their cash index point-for-point, so the cash index is
// the correct price series to reason over: ES/MES follow the S&P 500 (SPX),
// NQ/MNQ follow the Nasdaq-100 (NDX). `dataSymbol` names the fixture that
// carries that price series.
// ---------------------------------------------------------------------------

export interface FuturesContract {
  root: string; // "MES"
  name: string; // "Micro E-mini S&P 500"
  dataSymbol: string; // price-series fixture to trade on ("SPX", "NDX")
  pointValue: number; // USD per 1.00 index point, per contract
  tickSize: number; // minimum price increment (index points)
  tickValue: number; // USD per tick (pointValue × tickSize)
}

export const CONTRACTS: Record<string, FuturesContract> = {
  // S&P 500 (tracks SPX)
  MES: { root: "MES", name: "Micro E-mini S&P 500", dataSymbol: "SPX", pointValue: 5, tickSize: 0.25, tickValue: 1.25 },
  ES: { root: "ES", name: "E-mini S&P 500", dataSymbol: "SPX", pointValue: 50, tickSize: 0.25, tickValue: 12.5 },
  // Nasdaq-100 (tracks NDX)
  MNQ: { root: "MNQ", name: "Micro E-mini Nasdaq-100", dataSymbol: "NDX", pointValue: 2, tickSize: 0.25, tickValue: 0.5 },
  NQ: { root: "NQ", name: "E-mini Nasdaq-100", dataSymbol: "NDX", pointValue: 20, tickSize: 0.25, tickValue: 5 },
};

/** The default traded set: the micros — small contracts, retail-friendly risk. */
export const DEFAULT_FUTURES_UNIVERSE = ["MES", "MNQ"];

export function getContract(root: string): FuturesContract | undefined {
  return CONTRACTS[root.toUpperCase()];
}
