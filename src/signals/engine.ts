// ---------------------------------------------------------------------------
// The signal engine.
//
// Method (a disciplined, top-down Smart-Money workflow):
//
//   1. 15m BIAS      — the higher timeframe sets the only direction we'll take.
//   2. 1m STRUCTURE — confirm the entry timeframe agrees (or just flipped to).
//   3. TRIGGER      — a liquidity sweep (stop hunt) is the primary entry; a
//                     fresh 1m break of structure is the secondary entry.
//   4. CONFLUENCE   — price reacting from an order block / FVG, plus RSI & EMA.
//   5. RISK         — entry, a stop beyond the swept extreme, and targets set at
//                     the next resting liquidity. Signals that don't clear a
//                     minimum reward:risk are downgraded to WAIT.
//
// Every contributing factor becomes a ReasoningStep with a weight, so the final
// confidence is just the sum of the evidence — fully explainable, no black box.
// ---------------------------------------------------------------------------
import type { Action, Bar, ReasoningStep, Signal, MarketTrend } from "./types.js";
import { computeStructure } from "./marketStructure.js";
import { findLiquidityPools, detectSweeps } from "./liquidity.js";
import { orderBlockForBreak, priceInOrderBlock } from "./orderBlocks.js";
import { findFvgs, latestUnfilledFvg } from "./fvg.js";
import { ema, rsi, atr, last } from "./indicators.js";
import { defaultSessionConfig, inSession, describeSession, type SessionConfig } from "./session.js";

export interface EngineConfig {
  swingStrength: number;
  triggerLookback: number; // a trigger must occur within this many bars of the last
  minConfidence: number;
  minRiskReward: number;
  atrPeriod: number;
  rsiPeriod: number;
  emaPeriod: number;
  stopAtrBuffer: number; // stop is placed this many ATRs beyond the swept extreme
  minRiskAtr: number; // floor on total risk, in ATRs — stops tighter than this get run by noise
  tp1MinR: number; // TP1 is never closer than this many R (keeps reward:risk honest)
  tp1MaxR: number; // …and never farther than this many R (a realistic, hittable partial)
  tp2R: number; // TP2 defaults here when no farther liquidity pool exists
  equalTolerancePct: number;
  session: SessionConfig; // intraday time-of-day filter (1m setups only fire in-session)
}

export function defaultEngineConfig(): EngineConfig {
  return {
    swingStrength: 2,
    triggerLookback: 3, // trigger within the last ~3 one-minute bars — keeps entries fresh
    minConfidence: 0.6,
    minRiskReward: 1.5,
    atrPeriod: 14,
    rsiPeriod: 14,
    emaPeriod: 50, // ≈50 bars: a fast trend filter on 1m entry / a session-length one on 15m bias
    stopAtrBuffer: 0.25,
    minRiskAtr: 0.6,
    tp1MinR: 1.5,
    tp1MaxR: 2.0,
    tp2R: 3.0,
    equalTolerancePct: 0.0010, // 0.10%: equal-high/low tolerance, tighter for intraday levels
    session: defaultSessionConfig(), // NY morning kill-zone by default
  };
}

/** Direction as a sign for arithmetic; long = +1, short = -1. */
type Dir = "long" | "short";

export function analyze(symbol: string, entryBars: Bar[], biasBars: Bar[], cfgIn: Partial<EngineConfig> = {}): Signal {
  const cfg = { ...defaultEngineConfig(), ...cfgIn };
  const closesEntry = entryBars.map((b) => b.close);

  const lastBar = entryBars[entryBars.length - 1];
  const price = lastBar ? lastBar.close : 0;
  const generatedAt = lastBar ? lastBar.time : 0;

  // ---- Not enough data to say anything responsibly ----------------------
  if (entryBars.length < 30 || biasBars.length < 15 || !lastBar) {
    return blankSignal(symbol, price, generatedAt, "Insufficient history to analyse (need ≥30×1m and ≥15×15m bars).");
  }

  // ---- 1. Higher-timeframe (15m) bias ------------------------------------
  const htf = computeStructure(biasBars, cfg.swingStrength);
  const htfEma = last(ema(biasBars.map((b) => b.close), Math.min(cfg.emaPeriod, Math.floor(biasBars.length / 2))));
  const htfTrend: MarketTrend = htf.trend;
  const htfFreshChoch = htf.lastBreak?.event === "CHoCH" && htf.lastBreak.index >= biasBars.length - 3;

  // ---- 2. Entry-timeframe (1m) structure --------------------------------
  const ltf = computeStructure(entryBars, cfg.swingStrength);
  const pools = findLiquidityPools(ltf.swings, { equalTolerancePct: cfg.equalTolerancePct });
  const sweeps = detectSweeps(entryBars, ltf.swings, cfg.swingStrength, { equalTolerancePct: cfg.equalTolerancePct });
  const fvgs = findFvgs(entryBars);

  const atrSeries = atr(entryBars, cfg.atrPeriod);
  const atrNow = last(atrSeries) ?? price * 0.01;
  const rsiNow = last(rsi(closesEntry, cfg.rsiPeriod));
  const emaNow = last(ema(closesEntry, cfg.emaPeriod));

  // ---- 3. Pick the trigger + candidate direction ------------------------
  // A sweep only counts if it took *significant* liquidity — the extreme of the
  // recent range — not just any minor fractal wick. That's where stops actually
  // pile up and where smart money sources liquidity.
  const significant = (s: (typeof sweeps)[number]): boolean => {
    const from = Math.max(0, s.index - 20);
    const prior = entryBars.slice(from, s.index);
    if (prior.length === 0) return false;
    return s.side === "buyside"
      ? s.sweptPrice >= Math.max(...prior.map((b) => b.high)) * 0.999
      : s.sweptPrice <= Math.min(...prior.map((b) => b.low)) * 1.001;
  };
  const minTriggerIdx = entryBars.length - 1 - cfg.triggerLookback;
  const recentSweep = [...sweeps].reverse().find((s) => s.index >= minTriggerIdx && significant(s)) ?? null;
  const recentBreak = ltf.lastBreak && ltf.lastBreak.index >= minTriggerIdx ? ltf.lastBreak : null;

  let dir: Dir | null = null;
  let triggerKind: "sweep" | "bos" | null = null;
  if (recentSweep) {
    dir = recentSweep.side === "sellside" ? "long" : "short"; // sellside sweep = bullish
    triggerKind = "sweep";
  } else if (recentBreak) {
    dir = recentBreak.direction === "bullish" ? "long" : "short";
    triggerKind = "bos";
  }

  // No fresh trigger → stand aside, but still report the bias context.
  if (!dir) {
    const steps: ReasoningStep[] = [
      biasStep(htfTrend, htfFreshChoch),
      { label: "1m trigger", detail: "No liquidity sweep or break of structure in the last few bars — nothing to act on.", verdict: "neutral", weight: 0 },
    ];
    return { ...blankSignal(symbol, price, generatedAt, "No entry trigger — waiting for a sweep or 1m break of structure."), htfTrend, ltfTrend: ltf.trend, reasoning: steps, evidence: { sweep: null, orderBlock: null, fvg: null, structureBreak: ltf.lastBreak, liquidityPools: pools.slice(0, 6) } };
  }

  const isLong = dir === "long";
  const reasoning: ReasoningStep[] = [];
  let score = 0;
  const add = (s: ReasoningStep, contributes: boolean) => {
    reasoning.push(s);
    if (contributes) score += s.weight;
  };

  // ---- 4. Score the confluence -----------------------------------------
  // 4a. Bias alignment
  const biasAligned = (isLong && htfTrend === "bullish") || (!isLong && htfTrend === "bearish");
  const biasCounter = (isLong && htfTrend === "bearish") || (!isLong && htfTrend === "bullish");
  add(biasStep(htfTrend, htfFreshChoch), biasAligned);
  let counterTrendPenalty = 0;
  if (biasCounter && !htfFreshChoch) {
    counterTrendPenalty = 0.25;
    reasoning.push({ label: "Counter-trend", detail: `Setup fights the 15m ${htfTrend} bias with no 15m change-of-character yet — confidence penalised.`, verdict: "neutral", weight: 0 });
  }
  if (htfEma !== null) {
    const emaOk = (isLong && price >= htfEma) || (!isLong && price <= htfEma);
    add({ label: "15m EMA", detail: `Price ${price >= htfEma ? "above" : "below"} the 15m trend EMA (${htfEma.toFixed(2)}) — ${emaOk ? "supports" : "argues against"} the ${isLong ? "long" : "short"}.`, verdict: emaOk ? (isLong ? "bullish" : "bearish") : "neutral", weight: 0.08 }, emaOk);
  }

  // 4b. Trigger
  if (triggerKind === "sweep" && recentSweep) {
    add({ label: "Liquidity sweep", detail: `${recentSweep.side === "sellside" ? "Sell-side" : "Buy-side"} liquidity swept at ${recentSweep.sweptPrice.toFixed(2)} (wick to ${recentSweep.extreme.toFixed(2)}) then closed back at ${recentSweep.close.toFixed(2)} — a stop hunt that traps ${isLong ? "sellers" : "buyers"}.`, verdict: isLong ? "bullish" : "bearish", weight: 0.3 }, true);
  } else if (recentBreak) {
    add({ label: "Break of structure", detail: `Fresh 1m ${recentBreak.event} ${recentBreak.direction} — price closed ${isLong ? "above" : "below"} ${recentBreak.brokenSwingPrice.toFixed(2)}, confirming ${isLong ? "upside" : "downside"} intent.`, verdict: isLong ? "bullish" : "bearish", weight: 0.18 }, true);
  }

  // 4c. 1m structure agreement
  const ltfAgrees = (isLong && ltf.trend === "bullish") || (!isLong && ltf.trend === "bearish");
  add({ label: "1m structure", detail: `Entry timeframe is ${ltf.trend}${ltfAgrees ? " — aligned with the trade." : "."}`, verdict: ltf.trend === "ranging" ? "neutral" : ltf.trend === (isLong ? "bullish" : "bearish") ? (isLong ? "bullish" : "bearish") : "neutral", weight: 0.12 }, ltfAgrees);

  // 4d. Order block reaction
  const obBreak = ltf.lastBreak ?? recentBreak;
  const ob = obBreak ? orderBlockForBreak(entryBars, obBreak) : null;
  const obUsable = ob && ((isLong && ob.side === "bullish") || (!isLong && ob.side === "bearish"));
  if (obUsable && ob) {
    const reacting = priceInOrderBlock(price, ob, 0.002);
    add({ label: "Order block", detail: `${ob.side === "bullish" ? "Demand" : "Supply"} order block at ${ob.bottom.toFixed(2)}–${ob.top.toFixed(2)}${reacting ? " — price is reacting from it now." : " sits nearby as the origin of the move."}`, verdict: isLong ? "bullish" : "bearish", weight: reacting ? 0.12 : 0.06 }, true);
  }

  // 4e. FVG confluence
  const fvg = latestUnfilledFvg(entryBars, fvgs, isLong ? "bullish" : "bearish");
  if (fvg) {
    add({ label: "Fair value gap", detail: `Unfilled ${fvg.side} FVG at ${fvg.bottom.toFixed(2)}–${fvg.top.toFixed(2)} in the trade direction — an imbalance that supports continuation.`, verdict: isLong ? "bullish" : "bearish", weight: 0.08 }, true);
  }

  // 4f. Momentum (RSI + EMA on 1m)
  if (rsiNow !== null) {
    const rsiOk = isLong ? rsiNow > 45 && rsiNow < 72 : rsiNow < 55 && rsiNow > 28;
    const extreme = isLong ? rsiNow >= 72 : rsiNow <= 28;
    add({ label: "RSI", detail: `1m RSI ${rsiNow.toFixed(0)} — ${extreme ? (isLong ? "overbought, chase risk" : "oversold, chase risk") : rsiOk ? "healthy momentum for the entry" : "momentum not yet confirming"}.`, verdict: rsiOk ? (isLong ? "bullish" : "bearish") : "neutral", weight: 0.1 }, rsiOk);
  }
  if (emaNow !== null) {
    const emaOk = (isLong && price >= emaNow) || (!isLong && price <= emaNow);
    add({ label: "1m EMA", detail: `Price ${price >= emaNow ? "above" : "below"} the 1m EMA (${emaNow.toFixed(2)}).`, verdict: emaOk ? (isLong ? "bullish" : "bearish") : "neutral", weight: 0.05 }, emaOk);
  }

  score = Math.max(0, Math.min(1, score - counterTrendPenalty));

  // ---- 5. Risk model: entry / stop / targets ----------------------------
  const swingLow = ltf.lastSwingLow?.price ?? Math.min(...entryBars.slice(-10).map((b) => b.low));
  const swingHigh = ltf.lastSwingHigh?.price ?? Math.max(...entryBars.slice(-10).map((b) => b.high));
  const buffer = atrNow * cfg.stopAtrBuffer;

  // Entry model — this is where discipline lives:
  //   • Sweep  → MARKET on the rejection close, stop beyond the swept wick. A
  //     stop hunt reverses immediately; there's nothing to wait for.
  //   • Break  → LIMIT pullback into the order block (or FVG) that produced the
  //     move, stop beyond that zone. You do NOT chase a breakout close.
  //   • Break with no pullback zone → no trade. Chasing bare breaks is what
  //     bleeds a strategy out.
  let entry = price;
  let stop = isLong ? swingLow - buffer : swingHigh + buffer;
  let entryType: "market" | "limit" = "market";
  let validEntry = true;

  if (triggerKind === "sweep" && recentSweep) {
    entryType = "market";
    entry = price;
    stop = isLong ? recentSweep.extreme - buffer : recentSweep.extreme + buffer;
  } else if (obUsable && ob) {
    entryType = "limit";
    entry = isLong ? ob.top : ob.bottom; // proximal edge of the zone
    stop = isLong ? ob.bottom - buffer : ob.top + buffer;
  } else if (fvg) {
    entryType = "limit";
    entry = isLong ? fvg.top : fvg.bottom;
    stop = isLong ? fvg.bottom - buffer : fvg.top + buffer;
  } else {
    validEntry = false; // bare break of structure, nowhere disciplined to enter
  }

  // Never let the stop sit inside the noise floor — a stop tighter than
  // minRiskAtr ATRs gets run by ordinary wiggle.
  const minRisk = atrNow * cfg.minRiskAtr;
  let risk = Math.abs(entry - stop);
  if (risk < minRisk) {
    risk = minRisk;
    stop = isLong ? entry - minRisk : entry + minRisk;
  }

  const targets = buildTargets(isLong, entry, risk, pools, cfg);
  const riskReward = targets.length > 0 && risk > 0 ? (isLong ? targets[0]! - entry : entry - targets[0]!) / risk : null;

  add({ label: "Reward:risk", detail: riskReward !== null ? `First target offers ${riskReward.toFixed(2)}R (entry ${entry.toFixed(2)}, stop ${stop.toFixed(2)}, TP1 ${targets[0]!.toFixed(2)}).` : "Could not locate a target beyond entry.", verdict: riskReward !== null && riskReward >= cfg.minRiskReward ? (isLong ? "bullish" : "bearish") : "neutral", weight: 0 }, false);

  if (!validEntry) {
    reasoning.push({ label: "Entry", detail: "Break of structure with no order block or FVG to pull back into — standing aside rather than chasing.", verdict: "neutral", weight: 0 });
  }

  // ---- 6. Decision ------------------------------------------------------
  // Top-down discipline: only take a trade WITH a clear 15m trend behind it, or
  // on a just-formed 15m change-of-character (a reversal). No trading a ranging
  // or opposing higher timeframe — that's where these setups go to die. And on a
  // 1-minute entry, WHEN matters as much as what: only fire inside the session's
  // high-liquidity window (default NY morning kill-zone).
  const sessionOk = inSession(generatedAt, cfg.session);
  if (cfg.session.enabled) {
    add(
      {
        label: "Session",
        detail: sessionOk
          ? `Entry bar is inside the ${describeSession(cfg.session)} trading window — where 1m flow is real.`
          : `Entry bar is outside the ${describeSession(cfg.session)} window — 1m setups here are low-probability; standing aside.`,
        verdict: sessionOk ? (isLong ? "bullish" : "bearish") : "neutral",
        weight: 0,
      },
      false,
    );
  }

  let action: Action = "WAIT";
  const rrOk = riskReward !== null && riskReward >= cfg.minRiskReward;
  const biasOk = biasAligned || htfFreshChoch;
  const gatesOk = score >= cfg.minConfidence && rrOk && validEntry && biasOk && sessionOk;
  if (gatesOk) action = isLong ? "BUY" : "SELL";

  return {
    symbol,
    action,
    confidence: Number(score.toFixed(3)),
    price,
    generatedAt,
    entry: action === "WAIT" ? null : entry,
    entryType,
    stop: action === "WAIT" ? null : stop,
    targets: action === "WAIT" ? [] : targets,
    riskReward: riskReward !== null ? Number(riskReward.toFixed(2)) : null,
    htfTrend,
    ltfTrend: ltf.trend,
    reasoning,
    evidence: {
      sweep: recentSweep,
      orderBlock: obUsable ? ob : null,
      fvg,
      structureBreak: ltf.lastBreak,
      liquidityPools: pools.slice(0, 6),
    },
  };
}

// --- helpers ---------------------------------------------------------------

function biasStep(trend: MarketTrend, freshChoch: boolean): ReasoningStep {
  const detail = freshChoch
    ? `15m just printed a change-of-character to ${trend} — a potential regime shift.`
    : `15m market structure is ${trend}.`;
  return { label: "15m bias", detail, verdict: trend === "ranging" ? "neutral" : trend, weight: 0.25 };
}

/**
 * Two targets. TP1 is a realistic, hittable partial: the nearest resting
 * liquidity in the trade direction, but clamped into [tp1MinR, tp1MaxR] so it
 * neither offers a dishonest reward nor sits so far it never fills within a
 * sane hold. TP2 rides to the next liquidity pool (the real objective), or a
 * fixed tp2R multiple when no farther pool exists.
 */
function buildTargets(isLong: boolean, entry: number, risk: number, pools: { price: number }[], cfg: EngineConfig): number[] {
  const dir = isLong ? 1 : -1;
  const ahead = pools
    .map((p) => p.price)
    .filter((p) => (isLong ? p > entry : p < entry))
    .sort((a, b) => (isLong ? a - b : b - a)); // nearest first

  const clampR = (price: number) => {
    const r = (dir * (price - entry)) / risk;
    const cr = Math.min(cfg.tp1MaxR, Math.max(cfg.tp1MinR, r));
    return entry + dir * cr * risk;
  };

  const tp1 = ahead.length > 0 ? clampR(ahead[0]!) : entry + dir * cfg.tp1MaxR * risk;
  // TP2 = the next pool beyond TP1, else a fixed multiple.
  const beyond = ahead.find((p) => dir * (p - tp1) > risk * 0.25);
  const tp2 = beyond ?? entry + dir * cfg.tp2R * risk;
  return [tp1, tp2];
}

function blankSignal(symbol: string, price: number, generatedAt: number, note: string): Signal {
  return {
    symbol,
    action: "WAIT",
    confidence: 0,
    price,
    generatedAt,
    entry: null,
    entryType: "market",
    stop: null,
    targets: [],
    riskReward: null,
    htfTrend: "ranging",
    ltfTrend: "ranging",
    reasoning: [{ label: "Status", detail: note, verdict: "info", weight: 0 }],
    evidence: { sweep: null, orderBlock: null, fvg: null, structureBreak: null, liquidityPools: [] },
  };
}
