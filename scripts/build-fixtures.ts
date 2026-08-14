/**
 * Turn raw Robinhood `get_equity_historicals` responses (saved under
 * data/raw/<SYMBOL>.json) into clean, reproducible engine fixtures under
 * data/fixtures/<SYMBOL>.json.
 *
 *   npx tsx scripts/build-fixtures.ts
 *
 * Each raw file is the verbatim tool JSON: { data: { results: [ { symbol,
 * bars: [ { begins_at, open_price, ... } ] } ] } }. We keep only regular-hours,
 * non-interpolated bars, convert to the engine's Bar shape (unix seconds), and
 * roll the 1h series up to 4h so every fixture carries both timeframes the
 * engine expects. Using aggregated 4h (rather than the broker's native 4h)
 * matches the keyless live path, so backtest and live behave identically.
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
    const h1 = toBars(result.bars);
    const h4 = aggregateBars(h1, 4);
    if (h1.length < 30) {
      console.log(`  ${symbol}: only ${h1.length} 1h bars — skipped (need ≥30)`);
      continue;
    }
    const fixture = {
      symbol,
      fetchedAt: new Date().toISOString(),
      source: "robinhood:get_equity_historicals(hour)",
      h1,
      h4,
    };
    await writeFile(path.join(OUT_DIR, `${symbol}.json`), JSON.stringify(fixture));
    console.log(`  ${symbol}: ${h1.length} 1h → ${h4.length} 4h bars`);
    built.push(symbol);
  }

  await writeFile(path.join(OUT_DIR, "universe.json"), JSON.stringify(built.sort()));
  console.log(`\nBuilt ${built.length} fixtures + universe.json`);
}

void main();
