// ---------------------------------------------------------------------------
// Pump.fun
// ---------------------------------------------------------------------------

export interface PumpFunToken {
  mint: string;
  symbol: string;
  name: string;
  createdAt: number; // unix ms
  creator: string;
  marketCapUsd: number;
  priceUsd: number;
  virtualSolReserves?: number;
  virtualTokenReserves?: number;
  uri?: string;
}

// ---------------------------------------------------------------------------
// Birdeye
// ---------------------------------------------------------------------------

export type CandleTimeframe = "5m" | "1h" | "1d";

export interface Candle {
  timestamp: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

export interface CandleSet {
  mint: string;
  "5m": Candle[];
  "1h": Candle[];
  "1d": Candle[];
}

export interface TokenOverview {
  mint: string;
  marketCapUsd: number;
  liquidityUsd: number;
  priceUsd: number;
  priceChange24hPct: number;
  volume24hUsd: number;
  holders: number;
}

export interface TopHolder {
  wallet: string;
  amountUsd: number;
  pctOfSupply: number;
}

export interface TokenSecurityInfo {
  mint: string;
  mintAuthority: string | null; // null/empty = revoked, can't mint more supply
  freezeAuthority: string | null; // null/empty = revoked, holder accounts can't be frozen
  top10HolderPct: number; // 0..1
  creatorPct: number; // 0..1
  isToken2022: boolean;
  transferFeeEnabled: boolean; // Token-2022 extension that can silently tax/block transfers
}

// ---------------------------------------------------------------------------
// News + sentiment
// ---------------------------------------------------------------------------

export interface NewsItem {
  title: string;
  description: string | null;
  source: string;
  url: string;
  publishedAt: string;
}

export interface SentimentResult {
  score: number; // -1 (very bearish) .. 1 (very bullish)
  label: "bearish" | "neutral" | "bullish";
  summary: string;
  basedOnArticles: number;
}

// ---------------------------------------------------------------------------
// Whale tracking
// ---------------------------------------------------------------------------

export interface WhaleWallet {
  address: string;
  label?: string;
  rank: number;
}

export type WhaleTxType = "buy" | "sell" | "transfer" | "unknown";

export interface WhaleTransaction {
  signature: string;
  wallet: string;
  mint: string;
  type: WhaleTxType;
  amountUsd: number;
  timestamp: number; // unix ms
}

export interface WhaleActivitySummary {
  mint: string;
  windowMinutes: number;
  buyCount: number;
  sellCount: number;
  netFlowUsd: number;
  distinctWhales: number;
  recentTransactions: WhaleTransaction[];
}

// ---------------------------------------------------------------------------
// Scoring payload / response
// ---------------------------------------------------------------------------

export interface PortfolioSnapshot {
  solBalance: number;
  totalValueUsd: number;
  openPositionCount: number;
  reserveSol: number;
  availableForTradingUsd: number;
}

export interface ScoringPayload {
  token: PumpFunToken;
  overview: TokenOverview;
  security: TokenSecurityInfo;
  candles: CandleSet;
  sentiment: SentimentResult;
  whaleActivity: WhaleActivitySummary;
  portfolio: PortfolioSnapshot;
}

export type TradeDirection = "long" | "avoid";

export interface ScoringResponse {
  confidence: number; // 0..1
  direction: TradeDirection;
  reasoning: string;
  riskFlags: string[];
}

export interface TradeSignal {
  mint: string;
  symbol: string;
  confidence: number;
  direction: TradeDirection;
  reasoning: string;
  entryPriceUsd: number;
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// Positions / execution
// ---------------------------------------------------------------------------

export type PositionStatus = "open" | "closed";
export type ExitReason = "stop_loss" | "trailing_stop" | "take_profit" | "max_age" | "manual";

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  status: PositionStatus;
  entryPriceUsd: number;
  entryTimestamp: number;
  quantityTokens: number;
  costBasisUsd: number;
  costBasisSol: number;
  stopLossPriceUsd: number; // floor stop; set at entry, ratcheted up to breakeven after a partial take-profit
  peakPriceUsd: number; // highest price observed since entry; drives the trailing stop
  maxAgeHours: number;
  // Partial take-profit bookkeeping. A position banks part of the size at
  // the take-profit target and lets the rest ride the trailing stop, so a
  // token that pops then fades still books a realized gain instead of
  // round-tripping to breakeven/stop.
  tookPartialProfit?: boolean; // true once the take-profit scale-out has fired (fires at most once)
  scaledOutQuantityTokens?: number; // tokens sold via partial take-profit
  realizedScaleOutPnlUsd?: number; // PnL already banked from the scale-out, added to the final realized PnL
  exitPriceUsd?: number;
  exitTimestamp?: number;
  exitReason?: ExitReason;
  realizedPnlUsd?: number;
  signal: TradeSignal;
}

// ---------------------------------------------------------------------------
// Trade log (win/loss ledger + AI confidence calibration)
// ---------------------------------------------------------------------------

export interface TradeLogEntry {
  id: string;
  mint: string;
  symbol: string;
  entryPriceUsd: number;
  exitPriceUsd: number;
  entryTimestamp: number;
  exitTimestamp: number;
  holdHours: number;
  quantityTokens: number;
  costBasisUsd: number;
  realizedPnlUsd: number;
  pnlPct: number;
  exitReason: ExitReason;
  signalConfidence: number; // AI confidence (0..1) at the time the trade was entered
  won: boolean;
}

export interface ExecutionResult {
  success: boolean;
  mode: "paper" | "live";
  txSignature?: string;
  filledPriceUsd: number;
  filledQuantityTokens: number;
  error?: string;
}
