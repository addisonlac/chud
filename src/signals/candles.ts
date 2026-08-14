// ---------------------------------------------------------------------------
// Candle helpers: normalisation and the 1m → 15m roll-up used to build the
// higher-timeframe bias series from a 1-minute entry feed. Buckets never span a
// session gap, so a "15m" bar never welds the last minute of one day to the
// first of the next.
// ---------------------------------------------------------------------------
import type { Bar } from "./types.js";

/** Sort ascending by time and drop exact-duplicate timestamps (keep the last). */
export function normalize(bars: Bar[]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const b of bars) byTime.set(b.time, b);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Roll `bars` up by `factor` (e.g. fifteen 1m bars → one 15m bar). Buckets never
 * span a session gap: when the spacing to the next bar jumps well beyond the
 * typical bar interval (overnight / weekend), the current bucket is finalised
 * so a "15m" bar never welds the close of one day to the open of the next.
 */
export function aggregateBars(bars: Bar[], factor: number): Bar[] {
  const src = normalize(bars);
  if (src.length === 0 || factor <= 1) return src;

  // Typical spacing = median of consecutive deltas; a gap > 1.5x starts a session.
  const deltas: number[] = [];
  for (let i = 1; i < src.length; i++) deltas.push(src[i]!.time - src[i - 1]!.time);
  deltas.sort((a, b) => a - b);
  const typical = deltas.length ? deltas[Math.floor(deltas.length / 2)]! : 3600;

  const out: Bar[] = [];
  let bucket: Bar[] = [];

  const flush = () => {
    if (bucket.length === 0) return;
    out.push({
      time: bucket[0]!.time,
      open: bucket[0]!.open,
      high: Math.max(...bucket.map((b) => b.high)),
      low: Math.min(...bucket.map((b) => b.low)),
      close: bucket[bucket.length - 1]!.close,
      volume: bucket.reduce((s, b) => s + b.volume, 0),
    });
    bucket = [];
  };

  for (let i = 0; i < src.length; i++) {
    bucket.push(src[i]!);
    const next = src[i + 1];
    const sessionGap = next ? next.time - src[i]!.time > typical * 1.5 : false;
    if (bucket.length >= factor || sessionGap) flush();
  }
  flush();
  return out;
}
