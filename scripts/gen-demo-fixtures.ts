/**
 * Generate DETERMINISTIC, SYNTHETIC intraday demo fixtures for the 1m/15m
 * engine.
 *
 *   npx tsx scripts/gen-demo-fixtures.ts
 *
 * Why this exists: the engine reasons over a 1-minute entry series + a 15-minute
 * bias series, but no keyless historical feed for that granularity is reachable
 * in every environment (TradingView has no public data API; Yahoo intraday is
 * often network-blocked). To keep `npm run signal:backtest` and the fixture test
 * runnable out-of-the-box, this writes a small set of *synthetic* sessions —
 * seeded so they're byte-for-byte reproducible — that contain realistic trends,
 * pullbacks and the occasional stop-hunt wick, so the engine's recognition path
 * is genuinely exercised.
 *
 * These are NOT real market data and prove nothing about edge. For a real
 * backtest, drop real 1-minute broker JSON into data/raw/ and run
 * `npm run signal:fixtures`, or point the live Yahoo feed at any ticker.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { aggregateBars } from "../src/signals/candles.js";
import type { Bar } from "../src/signals/types.js";

const OUT_DIR = path.resolve("data/fixtures");

// Demo names + a plausible base price each (values are illustrative only).
const SYMBOLS: Array<{ symbol: string; base: number; vol: number }> = [
  { symbol: "NVDA", base: 182, vol: 0.0016 },
  { symbol: "TSLA", base: 252, vol: 0.0022 },
  { symbol: "AMD", base: 158, vol: 0.0019 },
  { symbol: "PLTR", base: 56, vol: 0.0025 },
];

const SESSIONS = 8; // trading days to synthesise
const BARS_PER_SESSION = 390; // 09:30–16:00 ET, one bar per minute

/** Deterministic PRNG (mulberry32) so fixtures are byte-for-byte reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 09:30 ET as a UTC unix time for `daysAgo` weekdays before the anchor. */
function sessionOpenUtc(daysAgo: number): number {
  // Anchor on a fixed recent weekday for reproducibility (2026-08-13, a Thursday).
  const anchor = Date.UTC(2026, 7, 13); // midnight UTC
  let remaining = daysAgo;
  const d = new Date(anchor);
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) remaining--;
  }
  // 09:30 ET ≈ 13:30 UTC during EDT (all anchor dates are summer).
  return Math.floor(d.getTime() / 1000) + 13 * 3600 + 30 * 60;
}

function genSession(base: number, vol: number, openUtc: number, rand: () => number): Bar[] {
  const bars: Bar[] = [];
  // Persistent intraday drift → gives the 15m bias something to align with.
  const trend = (rand() < 0.5 ? -1 : 1) * vol * (0.25 + rand() * 0.5);
  let price = base;
  let prevSwingExtreme = base;
  for (let i = 0; i < BARS_PER_SESSION; i++) {
    const open = price;
    const noise = (rand() - 0.5) * 2 * vol;
    let close = open * (1 + trend + noise);

    // Occasionally, in the morning window, inject a liquidity-sweep wick: poke
    // beyond the recent extreme, then close back through it (a stop hunt).
    const morning = i > 15 && i < 150;
    const sweep = morning && rand() < 0.03;
    let high = Math.max(open, close);
    let low = Math.min(open, close);
    const body = Math.abs(close - open) || open * vol * 0.2;
    if (sweep) {
      if (trend > 0) {
        low = Math.min(low, prevSwingExtreme * (1 - vol * 1.6)); // sweep sells below support
        close = Math.max(open, close); // close back up
      } else {
        high = Math.max(high, prevSwingExtreme * (1 + vol * 1.6)); // sweep buys above resistance
        close = Math.min(open, close);
      }
    }
    high = Math.max(high, open, close) + body * rand() * 0.6;
    low = Math.min(low, open, close) - body * rand() * 0.6;

    bars.push({
      time: openUtc + i * 60,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: Math.floor(50_000 + rand() * 200_000),
    });
    price = close;
    if (i % 20 === 0) prevSwingExtreme = trend > 0 ? low : high;
  }
  return bars;
}

const round = (n: number) => Math.round(n * 100) / 100;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const built: string[] = [];

  for (const { symbol, base, vol } of SYMBOLS) {
    const seed = [...symbol].reduce((s, c) => s + c.charCodeAt(0), 0) * 7919;
    const rand = rng(seed);
    const ltf: Bar[] = [];
    let carry = base;
    for (let s = SESSIONS; s >= 1; s--) {
      const openUtc = sessionOpenUtc(s);
      const gap = 1 + (rand() - 0.5) * vol * 4; // small overnight gap
      const session = genSession(carry * gap, vol, openUtc, rand);
      ltf.push(...session);
      carry = session[session.length - 1]!.close;
    }
    const htf = aggregateBars(ltf, 15);
    const fixture = {
      symbol,
      fetchedAt: new Date().toISOString(),
      source: "synthetic-intraday-demo",
      ltf,
      htf,
    };
    await writeFile(path.join(OUT_DIR, `${symbol}.json`), JSON.stringify(fixture));
    console.log(`  ${symbol}: ${ltf.length} synthetic 1m → ${htf.length} 15m bars`);
    built.push(symbol);
  }

  await writeFile(path.join(OUT_DIR, "universe.json"), JSON.stringify(built.sort()));
  console.log(`\nWrote ${built.length} SYNTHETIC demo fixtures + universe.json (not real market data).`);
}

void main();
