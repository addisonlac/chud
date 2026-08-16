/**
 * Build futures engine fixtures from raw cash-index minute data.
 *
 *   npx tsx scripts/build-futures-fixtures.ts
 *
 * Reads merged index series in data/raw-index/<SYMBOL>.json (native index shape:
 * { symbol, bars: [ { begins_at, open_value, high_value, low_value, close_value,
 * interpolated? } ] }) — SPX for ES/MES, NDX for NQ/MNQ — drops interpolated
 * (off-hours gap-fill) bars, converts to the engine's Bar shape, rolls the 1m
 * series up to 15m, and writes data/fixtures/<SYMBOL>.json (ltf 1m + htf 15m).
 * Index bars carry no volume; the SMC engine is price-structure based and does
 * not use it, so volume is set to 0.
 *
 * Also writes data/fixtures/futures-universe.json = the tradeable contract roots.
 */
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { aggregateBars, normalize } from "../src/signals/candles.js";
import { DEFAULT_FUTURES_UNIVERSE } from "../src/signals/instruments.js";
import type { Bar } from "../src/signals/types.js";

const RAW_DIR = path.resolve("data/raw-index");
const OUT_DIR = path.resolve("data/fixtures");

interface IdxBar {
  begins_at: string;
  open_value: string;
  high_value: string;
  low_value: string;
  close_value: string;
  interpolated?: boolean;
}
interface IdxFile {
  symbol: string;
  bars: IdxBar[];
}

function toBars(raw: IdxBar[]): Bar[] {
  const bars: Bar[] = [];
  for (const r of raw) {
    if (r.interpolated) continue;
    const time = Math.floor(new Date(r.begins_at).getTime() / 1000);
    const open = Number(r.open_value);
    const high = Number(r.high_value);
    const low = Number(r.low_value);
    const close = Number(r.close_value);
    if (![time, open, high, low, close].every(Number.isFinite)) continue;
    bars.push({ time, open, high, low, close, volume: 0 });
  }
  return normalize(bars);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  let files: string[] = [];
  try {
    files = (await readdir(RAW_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    console.log(`No ${RAW_DIR}. Pull index minute data first (see README).`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.log(`No raw index files in ${RAW_DIR}.`);
    process.exit(1);
  }

  const built: string[] = [];
  for (const file of files) {
    const idx = JSON.parse(await readFile(path.join(RAW_DIR, file), "utf-8")) as IdxFile;
    const symbol = idx.symbol.toUpperCase();
    const ltf = toBars(idx.bars);
    const htf = aggregateBars(ltf, 15);
    if (ltf.length < 60) {
      console.log(`  ${symbol}: only ${ltf.length} 1m bars — skipped (need ≥60)`);
      continue;
    }
    const fixture = {
      symbol,
      fetchedAt: new Date().toISOString(),
      source: "robinhood:get_index_historicals(minute)→15m",
      ltf,
      htf,
    };
    await writeFile(path.join(OUT_DIR, `${symbol}.json`), JSON.stringify(fixture));
    console.log(`  ${symbol}: ${ltf.length} 1m → ${htf.length} 15m bars`);
    built.push(symbol);
  }

  await writeFile(path.join(OUT_DIR, "futures-universe.json"), JSON.stringify(DEFAULT_FUTURES_UNIVERSE));
  console.log(`\nBuilt ${built.length} index fixtures. Futures universe: ${DEFAULT_FUTURES_UNIVERSE.join(", ")}`);
}

void main();
