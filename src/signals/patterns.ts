// ---------------------------------------------------------------------------
// Pattern recognition — the "calls" the bot makes for a human to trade.
//
// The engine's job here is not to place orders; it is to RECOGNISE a handful of
// high-probability, named futures setups on the 1-minute chart and say "here is
// a buy / sell, and here's why." Each detector is built on the same SMC
// primitives (swings, structure breaks, sweeps, order blocks, FVGs) and returns
// causal hits — a hit at bar i uses only information available by bar i — so the
// same code recognises setups live and can be scored honestly in a backtest.
//
// Patterns, roughly in ascending conviction:
//   • Liquidity Sweep   — a stop-hunt wick through a prior swing that rejects.
//   • Equal-Level Raid  — a sweep of an *equal highs/lows* pool (double top/bottom).
//   • Order Block Retest— price returns to a fresh demand/supply block and reacts.
//   • FVG Displacement  — a strong displacement candle's imbalance gets refilled.
//   • Breaker Block     — a failed order block flips and rejects from the far side.
//   • Sweep + MSS       — a sweep immediately followed by a market-structure shift
//                          (the classic confirmed reversal — highest conviction).
// ---------------------------------------------------------------------------
import type { Bar } from "./types.js";
import { findSwings, computeStructure } from "./marketStructure.js";
import { findLiquidityPools, detectSweeps } from "./liquidity.js";
import { orderBlockForBreak } from "./orderBlocks.js";
import { findFvgs } from "./fvg.js";
import { atr } from "./indicators.js";

export type PatternName =
  | "Liquidity Sweep"
  | "Equal-Level Raid"
  | "Order Block Retest"
  | "FVG Displacement"
  | "Breaker Block"
  | "Sweep + MSS";

export interface PatternHit {
  name: PatternName;
  direction: "long" | "short";
  index: number; // bar the pattern is confirmed on (entry bar)
  time: number;
  confidence: number; // 0..1 base strength of the pattern
  entry: number;
  stop: number;
  note: string;
}

export interface PatternConfig {
  swingStrength: number;
  equalTolerancePct: number;
  minRejectionWick: number;
  mssWindow: number; // bars a structure shift may follow a sweep within
  retestWindow: number; // bars an OB/FVG/breaker retest may occur within
  displaceAtr: number; // body ≥ this × ATR counts as displacement
  atrPeriod: number;
  stopBufferAtr: number;
  significanceLookback: number; // a sweep is "significant" if it took the extreme of this many bars
}

export function defaultPatternConfig(): PatternConfig {
  return {
    swingStrength: 2,
    equalTolerancePct: 0.001,
    minRejectionWick: 0.3,
    mssWindow: 8,
    retestWindow: 20,
    displaceAtr: 1.5,
    atrPeriod: 14,
    stopBufferAtr: 0.25,
    significanceLookback: 20,
  };
}

/** All pattern hits across `bars`, in bar order. Causal by construction. */
export function detectPatterns(bars: Bar[], cfgIn: Partial<PatternConfig> = {}): PatternHit[] {
  const cfg = { ...defaultPatternConfig(), ...cfgIn };
  const hits: PatternHit[] = [];
  if (bars.length < cfg.swingStrength * 2 + 5) return hits;

  const swings = findSwings(bars, cfg.swingStrength);
  const { breaks } = computeStructure(bars, cfg.swingStrength);
  const sweeps = detectSweeps(bars, swings, cfg.swingStrength, { equalTolerancePct: cfg.equalTolerancePct, minRejectionWick: cfg.minRejectionWick });
  const pools = findLiquidityPools(swings, { equalTolerancePct: cfg.equalTolerancePct });
  const fvgs = findFvgs(bars);
  const atrSeries = atr(bars, cfg.atrPeriod);
  const atrAt = (i: number) => atrSeries[i] ?? bars[i]!.close * 0.001;
  const buf = (i: number) => atrAt(i) * cfg.stopBufferAtr;

  const significant = (side: "buyside" | "sellside", price: number, i: number): boolean => {
    const from = Math.max(0, i - cfg.significanceLookback);
    const prior = bars.slice(from, i);
    if (!prior.length) return false;
    return side === "buyside" ? price >= Math.max(...prior.map((b) => b.high)) * 0.999 : price <= Math.min(...prior.map((b) => b.low)) * 1.001;
  };

  // --- Liquidity Sweep + Equal-Level Raid ---------------------------------
  for (const s of sweeps) {
    const dir = s.side === "sellside" ? "long" : "short";
    const poolSide = s.side; // buyside pool sits above (raided by buyside sweep), sellside below
    const raid = pools.some((p) => p.side === poolSide && p.touches >= 2 && Math.abs(p.price - s.sweptPrice) <= s.sweptPrice * cfg.equalTolerancePct * 2);
    const sig = significant(s.side, s.sweptPrice, s.index);
    const name: PatternName = raid ? "Equal-Level Raid" : "Liquidity Sweep";
    const confidence = raid ? 0.8 : sig ? 0.72 : 0.6;
    hits.push({
      name,
      direction: dir,
      index: s.index,
      time: s.time,
      confidence,
      entry: s.close,
      stop: dir === "long" ? s.extreme - buf(s.index) : s.extreme + buf(s.index),
      note: `${s.side === "sellside" ? "Sell-side" : "Buy-side"} liquidity swept at ${s.sweptPrice.toFixed(2)}${raid ? " (equal-level pool)" : ""}, rejected to close ${s.close.toFixed(2)}.`,
    });

    // --- Sweep + MSS (a break in the trade direction shortly after) -------
    const wantDir = dir === "long" ? "bullish" : "bearish";
    const mss = breaks.find((b) => b.index > s.index && b.index <= s.index + cfg.mssWindow && b.direction === wantDir);
    if (mss) {
      hits.push({
        name: "Sweep + MSS",
        direction: dir,
        index: mss.index,
        time: bars[mss.index]!.time,
        confidence: 0.85,
        entry: bars[mss.index]!.close,
        stop: dir === "long" ? s.extreme - buf(mss.index) : s.extreme + buf(mss.index),
        note: `Sweep of ${s.sweptPrice.toFixed(2)} then a ${wantDir} ${mss.event} — market-structure shift confirms the reversal.`,
      });
    }
  }

  // --- Order Block Retest (continuation with the break) -------------------
  for (const brk of breaks) {
    const ob = orderBlockForBreak(bars, brk);
    if (!ob) continue;
    const dir = brk.direction === "bullish" ? "long" : "short";
    const end = Math.min(bars.length - 1, brk.index + cfg.retestWindow);
    for (let j = brk.index + 1; j <= end; j++) {
      const b = bars[j]!;
      if (dir === "long") {
        const touched = b.low <= ob.top && b.low >= ob.bottom - buf(j);
        if (touched && b.close > ob.top) {
          hits.push({ name: "Order Block Retest", direction: "long", index: j, time: b.time, confidence: 0.7, entry: b.close, stop: ob.bottom - buf(j), note: `Price retested the demand order block ${ob.bottom.toFixed(2)}–${ob.top.toFixed(2)} and rejected higher.` });
          break;
        }
      } else {
        const touched = b.high >= ob.bottom && b.high <= ob.top + buf(j);
        if (touched && b.close < ob.bottom) {
          hits.push({ name: "Order Block Retest", direction: "short", index: j, time: b.time, confidence: 0.7, entry: b.close, stop: ob.top + buf(j), note: `Price retested the supply order block ${ob.bottom.toFixed(2)}–${ob.top.toFixed(2)} and rejected lower.` });
          break;
        }
      }
    }
  }

  // --- FVG Displacement (imbalance from a strong candle gets refilled) ----
  for (const g of fvgs) {
    const mid = g.index;
    const body = Math.abs(bars[mid]!.close - bars[mid]!.open);
    if (body < cfg.displaceAtr * atrAt(mid)) continue; // not a displacement
    const dir = g.side === "bullish" ? "long" : "short";
    const end = Math.min(bars.length - 1, mid + cfg.retestWindow);
    for (let j = mid + 2; j <= end; j++) {
      const b = bars[j]!;
      const inGap = b.low <= g.top && b.high >= g.bottom;
      if (!inGap) continue;
      const continues = dir === "long" ? b.close > g.top : b.close < g.bottom;
      if (continues) {
        hits.push({ name: "FVG Displacement", direction: dir, index: j, time: b.time, confidence: 0.7, entry: b.close, stop: dir === "long" ? g.bottom - buf(j) : g.top + buf(j), note: `Displacement ${g.side} FVG ${g.bottom.toFixed(2)}–${g.top.toFixed(2)} refilled and price continued.` });
        break;
      }
    }
  }

  // --- Breaker Block (a failed order block flips) -------------------------
  for (const brk of breaks) {
    const ob = orderBlockForBreak(bars, brk);
    if (!ob) continue;
    // find where this OB is invalidated (close through its far side), then a retest from the other side
    const end = Math.min(bars.length - 1, brk.index + cfg.retestWindow * 2);
    let failIdx = -1;
    for (let j = brk.index + 1; j <= end; j++) {
      const b = bars[j]!;
      if (brk.direction === "bullish" && b.close < ob.bottom) { failIdx = j; break; }
      if (brk.direction === "bearish" && b.close > ob.top) { failIdx = j; break; }
    }
    if (failIdx < 0) continue;
    const dir = brk.direction === "bullish" ? "short" : "long"; // flipped
    const rend = Math.min(bars.length - 1, failIdx + cfg.retestWindow);
    for (let j = failIdx + 1; j <= rend; j++) {
      const b = bars[j]!;
      if (dir === "short") {
        if (b.high >= ob.bottom && b.high <= ob.top + buf(j) && b.close < ob.bottom) {
          hits.push({ name: "Breaker Block", direction: "short", index: j, time: b.time, confidence: 0.75, entry: b.close, stop: ob.top + buf(j), note: `Broken demand block flipped to a bearish breaker at ${ob.bottom.toFixed(2)}–${ob.top.toFixed(2)} and rejected.` });
          break;
        }
      } else {
        if (b.low <= ob.top && b.low >= ob.bottom - buf(j) && b.close > ob.top) {
          hits.push({ name: "Breaker Block", direction: "long", index: j, time: b.time, confidence: 0.75, entry: b.close, stop: ob.bottom - buf(j), note: `Broken supply block flipped to a bullish breaker at ${ob.bottom.toFixed(2)}–${ob.top.toFixed(2)} and rejected.` });
          break;
        }
      }
    }
  }

  return hits.sort((a, b) => a.index - b.index || b.confidence - a.confidence);
}

/**
 * The freshest actionable pattern at (or within `lookback` bars of) the last
 * bar — what the live scanner calls out. Returns the highest-confidence recent
 * hit, or null if nothing qualifies.
 */
export function latestPattern(bars: Bar[], lookback = 3, cfgIn: Partial<PatternConfig> = {}): PatternHit | null {
  const hits = detectPatterns(bars, cfgIn);
  const minIdx = bars.length - 1 - lookback;
  const recent = hits.filter((h) => h.index >= minIdx);
  if (!recent.length) return null;
  return recent.sort((a, b) => b.confidence - a.confidence || b.index - a.index)[0]!;
}
