// ---------------------------------------------------------------------------
// Plain technical indicators used as *confluence* on top of the structural
// (Smart Money) read. Kept dependency-free and pure so they're trivial to
// unit-test and reuse in the backtester.
// ---------------------------------------------------------------------------
import type { Bar } from "./types.js";

/**
 * Exponential moving average over `closes`. Returns an array the same length
 * as the input; the first `period-1` entries are `null` (not enough history).
 * The seed is a simple average of the first `period` closes (standard TA).
 */
export function ema(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i]!;
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < closes.length; i++) {
    prev = closes[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's RSI. Returns same-length array with `null` until the first value is
 * available at index `period`. Values are 0..100.
 */
export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    const g = diff >= 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Average True Range (Wilder). Same-length array, `null` until index `period`.
 * Used to size stops and to distinguish an impulsive break from noise.
 */
export function atr(bars: Bar[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;

  const trueRanges: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const prevClose = bars[i - 1]!.close;
    trueRanges.push(Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose)));
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trueRanges[i]!;
  let prev = sum / period;
  out[period] = prev;

  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + trueRanges[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** Last non-null value of an indicator series, or null if none. */
export function last<T>(series: (T | null)[]): T | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return series[i] as T;
  }
  return null;
}
