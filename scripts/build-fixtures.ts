/**
 * Turn raw Robinhood `get_equity_historicals` responses (saved under
 * data/raw/<SYMBOL>.json) into clean, reproducible engine fixtures under
 * data/fixtures/<SYMBOL>.json.
 *
 *   npx tsx scripts/build-fixtures.ts
 *
 * Each raw file is the verbatim tool JSON: { data: { results: [ { symbol,
 * bars: [ { begins_at, open_price, ... } ] } ] } } from a MINUTE-interval
 * historicals pull. We keep only regular-hours, non-interpolated bars, convert
 * to the engine's Bar shape (unix seconds), and roll the 1m series up to 15m so
 * every fixture carries both timeframes the engine expects (ltf = 1m entry,
 * htf = 15m bias). Rolling to 15m (rather than a broker's native 15m) matches
 * the keyless live path, so backtest and live behave identically.
 */
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { aggregateBars, normalize } from "../src/signals/candles.js";
import type { Bar } from "../src/signals/types.js";

const RAW_DIR = path.resolve("data/raw");
const OUT_DIR = path.resolve("data/fixtures");

interface RawBar {
  begins_at: string;
  open_price: string;
  high_price: string;
  low_price: string;
  close_price: string;
  volume: number;
  session?: string;
  interpolated?: boolean;
}
interface RawResponse {
  data: { results: Array<{ symbol: string; bars: RawBar[] }> };
}

function toBars(raw: RawBar[]): Bar[] {
  const bars: Bar[] = [];
  for (const r of raw) {
    if (r.interpolated) continue;
    const time = Math.floor(new Date(r.begins_at).getTime() / 1000);
    const open = Number(r.open_price);
    const high = Number(r.high_price);
    const low = Number(r.low_price);
    const close = Number(r.close_price);
    if (![time, open, high, low, close].every(Number.isFinite)) continue;
    bars.push({ time, open, high, low, close, volume: Number(r.volume) || 0 });
  }
  return normalize(bars);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const files = (await readdir(RAW_DIR)).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log(`No raw files in ${RAW_DIR}. Save Robinhood historicals JSON there first.`);
    process.exit(1);
  }

  const built: string[] = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(path.join(RAW_DIR, file), "utf-8")) as RawResponse;
    const result = raw.data?.results?.[0];
    if (!result) {
      console.log(`  ${file}: no results — skipped`);
      continue;
    }
    const symbol = result.symbol.toUpperCase();
    const ltf = toBars(result.bars);
    const htf = aggregateBars(ltf, 15);
    if (ltf.length < 60) {
      console.log(`  ${symbol}: only ${ltf.length} 1m bars — skipped (need ≥60)`);
      continue;
    }
    const fixture = {
      symbol,
      fetchedAt: new Date().toISOString(),
      source: "robinhood:get_equity_historicals(minute)→15m",
      ltf,
      htf,
    };
    await writeFile(path.join(OUT_DIR, `${symbol}.json`), JSON.stringify(fixture));
    console.log(`  ${symbol}: ${ltf.length} 1m → ${htf.length} 15m bars`);
    built.push(symbol);
  }

  await writeFile(path.join(OUT_DIR, "universe.json"), JSON.stringify(built.sort()));
  console.log(`\nBuilt ${built.length} fixtures + universe.json`);
}

void main();
