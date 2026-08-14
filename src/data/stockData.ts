// ---------------------------------------------------------------------------
// Stock OHLCV data access for the signal engine.
//
// The engine needs a 1h and a 4h series per symbol. Data access is pluggable:
//
//   • YahooProvider   — keyless public feed (query1.finance.yahoo.com). Works
//                        anywhere outbound HTTPS to Yahoo is allowed; the 4h
//                        series is rolled up from 1h. Good for live use.
//   • FixtureProvider — reads pre-saved JSON candle files from data/fixtures.
//                        Deterministic, offline, and what the backtest uses so
//                        results are reproducible and don't depend on the feed.
//
// A broker feed with native 4h bars (e.g. the Robinhood MCP used to build the
// fixtures) is preferable to rolled-up 4h; FixtureProvider carries those.
// ---------------------------------------------------------------------------
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchJson } from "../utils/http.js";
import { aggregateBars, normalize } from "../signals/candles.js";
import type { Bar } from "../signals/types.js";

export interface Series {
  h1: Bar[];
  h4: Bar[];
}

export interface StockDataProvider {
  readonly name: string;
  getSeries(symbol: string): Promise<Series>;
}

export const FIXTURE_DIR = path.resolve("data/fixtures");

/** On-disk fixture shape (also what scripts/fetch-fixtures writes). */
export interface Fixture {
  symbol: string;
  fetchedAt: string;
  source: string;
  h1: Bar[];
  h4: Bar[];
}

// --- Fixtures --------------------------------------------------------------

export class FixtureProvider implements StockDataProvider {
  readonly name = "fixture";
  constructor(private readonly dir: string = FIXTURE_DIR) {}

  async getSeries(symbol: string): Promise<Series> {
    const file = path.join(this.dir, `${symbol.toUpperCase()}.json`);
    const raw = await readFile(file, "utf-8");
    const fx = JSON.parse(raw) as Fixture;
    return { h1: normalize(fx.h1 ?? []), h4: normalize(fx.h4 ?? []) };
  }
}

// --- Yahoo (keyless) -------------------------------------------------------

interface YahooChart {
  chart: {
    result?: Array<{
      timestamp?: number[];
      indicators: { quote: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }> };
    }>;
    error?: unknown;
  };
}

export class YahooProvider implements StockDataProvider {
  readonly name = "yahoo";
  constructor(private readonly range = "60d") {}

  async getSeries(symbol: string): Promise<Series> {
    const h1 = await this.fetch1h(symbol);
    return { h1, h4: aggregateBars(h1, 4) };
  }

  private async fetch1h(symbol: string): Promise<Bar[]> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${this.range}&interval=1h`;
    const data = await fetchJson<YahooChart>(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; chud-signals/1.0)" },
      timeoutMs: 12_000,
    });
    const res = data.chart.result?.[0];
    if (!res?.timestamp) return [];
    const q = res.indicators.quote[0]!;
    const bars: Bar[] = [];
    for (let i = 0; i < res.timestamp.length; i++) {
      const o = q.open?.[i];
      const h = q.high?.[i];
      const l = q.low?.[i];
      const c = q.close?.[i];
      if (o == null || h == null || l == null || c == null) continue; // skip gaps
      bars.push({ time: res.timestamp[i]!, open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
    }
    return normalize(bars);
  }
}

/**
 * Default provider: fixtures if the file exists, else Yahoo. This lets the same
 * code path serve reproducible offline analysis and live analysis without a
 * config switch — you just drop a fixture in to pin a symbol's data.
 */
export function defaultProvider(): StockDataProvider {
  const fixtures = new FixtureProvider();
  const yahoo = new YahooProvider();
  return {
    name: "auto(fixture→yahoo)",
    async getSeries(symbol: string): Promise<Series> {
      try {
        const fx = await fixtures.getSeries(symbol);
        if (fx.h1.length > 0) return fx;
      } catch {
        /* no fixture — fall through to live */
      }
      return yahoo.getSeries(symbol);
    },
  };
}
