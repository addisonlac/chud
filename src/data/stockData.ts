// ---------------------------------------------------------------------------
// Stock OHLCV data access for the signal engine.
//
// The engine works two timeframes: a 1-minute ENTRY series (ltf) and a
// 15-minute BIAS series (htf). Data access is pluggable:
//
//   • YahooProvider   — keyless public feed (query1.finance.yahoo.com). Fetches
//                        native 1m and 15m bars. Works anywhere outbound HTTPS
//                        to Yahoo is allowed; good for live use on a normal
//                        network. (TradingView has no keyless historical API, so
//                        it is the chart/alert surface — Pine + webhook — while
//                        Yahoo supplies the candles the engine reasons over.)
//   • FixtureProvider — reads pre-saved JSON candle files from data/fixtures.
//                        Deterministic, offline, and what the backtest uses so
//                        results are reproducible and don't depend on the feed.
//
// The committed fixtures were seeded once, offline, from Robinhood minute bars
// (the one intraday feed reachable where they were built); at runtime nothing
// depends on Robinhood.
// ---------------------------------------------------------------------------
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchJson } from "../utils/http.js";
import { aggregateBars, normalize } from "../signals/candles.js";
import type { Bar } from "../signals/types.js";

/** ltf = 1-minute entry series, htf = 15-minute bias series. */
export interface Series {
  ltf: Bar[];
  htf: Bar[];
}

export interface StockDataProvider {
  readonly name: string;
  getSeries(symbol: string): Promise<Series>;
}

export const FIXTURE_DIR = path.resolve("data/fixtures");

/** On-disk fixture shape (also what scripts/build-fixtures writes). */
export interface Fixture {
  symbol: string;
  fetchedAt: string;
  source: string;
  ltf: Bar[];
  htf: Bar[];
}

// --- Fixtures --------------------------------------------------------------

export class FixtureProvider implements StockDataProvider {
  readonly name = "fixture";
  constructor(private readonly dir: string = FIXTURE_DIR) {}

  async getSeries(symbol: string): Promise<Series> {
    const file = path.join(this.dir, `${symbol.toUpperCase()}.json`);
    const raw = await readFile(file, "utf-8");
    const fx = JSON.parse(raw) as Fixture;
    return { ltf: normalize(fx.ltf ?? []), htf: normalize(fx.htf ?? []) };
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
  // 1m history is capped by Yahoo at ~7 days; 15m reaches ~60 days.
  constructor(
    private readonly entryRange = "5d",
    private readonly biasRange = "1mo",
  ) {}

  async getSeries(symbol: string): Promise<Series> {
    const ltf = await this.fetchBars(symbol, "1m", this.entryRange);
    // Prefer native 15m for a longer, cleaner bias series; fall back to rolling
    // the 1m entry series up if the 15m fetch comes back empty.
    let htf = await this.fetchBars(symbol, "15m", this.biasRange).catch(() => [] as Bar[]);
    if (htf.length === 0) htf = aggregateBars(ltf, 15);
    return { ltf, htf };
  }

  private async fetchBars(symbol: string, interval: string, range: string): Promise<Bar[]> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
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
        if (fx.ltf.length > 0) return fx;
      } catch {
        /* no fixture — fall through to live */
      }
      return yahoo.getSeries(symbol);
    },
  };
}
