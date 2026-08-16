import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ema, rsi, atr } from "../src/signals/indicators.js";
import { findSwings, computeStructure } from "../src/signals/marketStructure.js";
import { findLiquidityPools, detectSweeps } from "../src/signals/liquidity.js";
import { findFvgs, latestUnfilledFvg } from "../src/signals/fvg.js";
import { orderBlockForBreak } from "../src/signals/orderBlocks.js";
import { aggregateBars } from "../src/signals/candles.js";
import { analyze } from "../src/signals/engine.js";
import { sizeShares } from "../src/signals/sizing.js";
import { inSession, defaultSessionConfig } from "../src/signals/session.js";
import { sizeContracts } from "../src/signals/sizing.js";
import { getContract } from "../src/signals/instruments.js";
import { SessionGuard, defaultGuardConfig } from "../src/signals/sessionGuard.js";
import type { Bar, Signal } from "../src/signals/types.js";

/** Build bars from compact [high, low, close?] rows at 1m spacing. */
function bars(rows: Array<[number, number] | [number, number, number]>, start = 1_700_000_000): Bar[] {
  return rows.map((r, i) => {
    const [high, low, close] = r;
    const c = close ?? (high + low) / 2;
    return { time: start + i * 60, open: (high + low) / 2, high, low, close: c, volume: 1000 };
  });
}

describe("indicators", () => {
  it("EMA is null until seeded, then tracks a rising series", () => {
    const e = ema([1, 2, 3, 4, 5, 6], 3);
    expect(e[0]).toBeNull();
    expect(e[1]).toBeNull();
    expect(e[2]).toBeCloseTo(2, 5); // seed = mean(1,2,3)
    expect(e[5]!).toBeGreaterThan(e[2]!);
  });

  it("RSI is 100 for a monotonically rising series", () => {
    const r = rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14);
    expect(r[15]).toBeCloseTo(100, 5);
  });

  it("ATR is positive and reflects range", () => {
    const b = bars(Array.from({ length: 20 }, (_, i) => [100 + i + 1, 100 + i] as [number, number]));
    const a = atr(b, 14);
    expect(a[19]!).toBeGreaterThan(0);
  });
});

describe("market structure", () => {
  it("finds an obvious swing high and swing low", () => {
    // up-up-PEAK-down-down then down-down-TROUGH-up-up
    const b = bars([
      [10, 9],
      [11, 10],
      [15, 13], // swing high at idx 2
      [12, 10],
      [11, 9],
      [10, 8],
      [7, 5], // swing low at idx 6
      [9, 7],
      [11, 9],
    ]);
    const swings = findSwings(b, 2);
    expect(swings.some((s) => s.kind === "high" && s.index === 2)).toBe(true);
    expect(swings.some((s) => s.kind === "low" && s.index === 6)).toBe(true);
  });

  it("classifies a bullish break of the prior swing high as bullish structure", () => {
    const b = bars([
      [10, 9, 9.5],
      [11, 10, 10.5],
      [15, 13, 13.5], // swing high 15 at idx 2
      [12, 10, 10.5],
      [11, 9, 9.5], // pullback (confirms the swing high)
      [14, 11, 13],
      [17, 15, 16.5], // close 16.5 > 15 → bullish break
    ]);
    const s = computeStructure(b, 2);
    expect(s.trend).toBe("bullish");
    expect(s.breaks.some((x) => x.direction === "bullish")).toBe(true);
  });
});

describe("liquidity", () => {
  it("clusters equal highs into a buyside pool with 2 touches", () => {
    const swings = [
      { index: 2, time: 1, price: 100.0, kind: "high" as const },
      { index: 8, time: 2, price: 100.05, kind: "high" as const }, // within 0.15%
      { index: 5, time: 3, price: 90.0, kind: "low" as const },
    ];
    const pools = findLiquidityPools(swings, { equalTolerancePct: 0.0015 });
    const buyside = pools.find((p) => p.side === "buyside");
    expect(buyside?.touches).toBe(2);
    expect(buyside!.price).toBeCloseTo(100.05, 2);
  });

  it("detects a sell-side sweep: wick below a swing low that closes back above", () => {
    // swing low at idx 2 (price 8), later a bar spikes to 7 but closes 9.5 (back above)
    const b = bars([
      [12, 10, 11],
      [11, 9, 10],
      [10, 8, 8.2], // swing low 8 at idx 2
      [11, 9, 10.5],
      [12, 10, 11],
      [11.5, 9.5, 11], // confirms swing low
      [11, 7, 10.8], // low 7 < 8 swept, close 10.8 > 8, big lower wick → sell-side sweep
    ]);
    const swings = findSwings(b, 2);
    const sweeps = detectSweeps(b, swings, 2);
    expect(sweeps.some((s) => s.side === "sellside" && s.index === 6)).toBe(true);
  });
});

describe("fair value gaps", () => {
  it("finds a bullish FVG when bar1.high < bar3.low", () => {
    const b = bars([
      [10, 9, 9.5],
      [13, 11, 12.5], // impulsive middle bar
      [15, 11.5, 14], // low 11.5 > bar1 high 10 → bullish gap 10..11.5
    ]);
    const fvgs = findFvgs(b);
    expect(fvgs.some((g) => g.side === "bullish")).toBe(true);
    expect(latestUnfilledFvg(b, fvgs, "bullish")).not.toBeNull();
  });
});

describe("order blocks", () => {
  it("bullish break's order block is the last down candle before it", () => {
    const b = bars([
      [10, 9, 9.8],
      [11, 10, 10.8],
      [15, 13, 14], // swing high
      [12, 10, 10.2], // down candle (close<open) — the OB
      [14, 11, 13.5],
      [17, 15, 16.5], // bullish break at idx 5
    ]);
    const s = computeStructure(b, 2);
    const brk = s.breaks.find((x) => x.direction === "bullish")!;
    const ob = orderBlockForBreak(b, brk);
    expect(ob?.side).toBe("bullish");
    expect(ob!.index).toBeLessThan(brk.index);
  });
});

describe("share sizing", () => {
  const longSig = {
    action: "BUY",
    entry: 100,
    stop: 95, // $5 risk/share
    targets: [110, 115],
  } as unknown as Signal;

  it("sizes whole shares to the dollar risk budget", () => {
    const s = sizeShares(longSig, 250);
    expect(s.shares).toBe(50); // 250 / 5
    expect(s.riskUsd).toBe(250);
    expect(s.notionalUsd).toBe(5000); // 50 × 100
    expect(s.targetPnlUsd[0]).toBe(500); // 50 × (110-100)
  });

  it("returns zero shares for a WAIT signal", () => {
    const wait = { action: "WAIT", entry: null, stop: null, targets: [] } as unknown as Signal;
    expect(sizeShares(wait, 250).shares).toBe(0);
  });
});

describe("futures contract sizing", () => {
  const mes = getContract("MES")!;
  const longSig = { action: "BUY", entry: 5000, stop: 4995, targets: [5010, 5020] } as unknown as Signal;

  it("sizes whole contracts to the dollar risk via point value", () => {
    const s = sizeContracts(longSig, mes, 250); // 5 pt stop × $5 = $25/contract → 10 contracts
    expect(s.contracts).toBe(10);
    expect(s.stopPoints).toBe(5);
    expect(s.riskPerContract).toBe(25);
    expect(s.riskUsd).toBe(250);
    expect(s.notionalUsd).toBe(250000); // 10 × 5000 × $5
    expect(s.targetPnlUsd[0]).toBe(500); // 10 × (5010-5000) × $5
  });

  it("micros vs minis: an ES trades 1/10th the contracts of MES for the same risk", () => {
    const es = getContract("ES")!;
    expect(sizeContracts(longSig, es, 250).contracts).toBe(1); // 5 pt × $50 = $250/contract → 1
  });

  it("returns zero contracts for a WAIT signal", () => {
    const wait = { action: "WAIT", entry: null, stop: null, targets: [] } as unknown as Signal;
    expect(sizeContracts(wait, mes, 250).contracts).toBe(0);
  });
});

describe("session guard (discipline layer)", () => {
  const t = (h: number, m: number) => Math.floor(Date.UTC(2026, 7, 13, h, m) / 1000); // Thu, ET = UTC-4

  it("blocks signals below the confidence floor", () => {
    const g = new SessionGuard(defaultGuardConfig()); // floor 0.7
    expect(g.canEnter(t(14, 0), 100, 0.6).ok).toBe(false);
    expect(g.canEnter(t(14, 0), 100, 0.9).ok).toBe(true);
  });

  it("cools down for N bars after a loss", () => {
    const g = new SessionGuard(defaultGuardConfig()); // cooldown 15
    g.record(t(14, 0), 100, -1);
    expect(g.canEnter(t(14, 5), 105, 0.9).ok).toBe(false); // 5 bars later — still cooling
    expect(g.canEnter(t(14, 20), 120, 0.9).ok).toBe(true); // 20 bars later — clear
  });

  it("locks out for the session after two losses in a row", () => {
    const g = new SessionGuard(defaultGuardConfig());
    g.record(t(14, 0), 100, -1);
    g.record(t(14, 30), 130, -1); // 2nd consecutive loss → lockout
    expect(g.canEnter(t(15, 0), 160, 1.0).ok).toBe(false);
  });

  it("caps trades per session and resets the next day", () => {
    const g = new SessionGuard(defaultGuardConfig()); // cap 3
    for (let k = 0; k < 3; k++) g.record(t(14, k), 100 + k, +1); // 3 wins, no lockout
    expect(g.canEnter(t(15, 0), 200, 1.0).ok).toBe(false); // cap reached
    expect(g.canEnter(Math.floor(Date.UTC(2026, 7, 14, 14, 0) / 1000), 1000, 1.0).ok).toBe(true); // next day resets
  });
});

describe("session filter", () => {
  const cfg = defaultSessionConfig(); // NY morning 09:30–12:00 ET, Mon–Fri
  const at = (y: number, mo: number, d: number, h: number, mi: number) => Math.floor(Date.UTC(y, mo, d, h, mi) / 1000);

  it("accepts a weekday bar inside the NY morning window", () => {
    // 2026-08-13 is a Thursday; 13:45 UTC = 09:45 ET (EDT) → in session.
    expect(inSession(at(2026, 7, 13, 13, 45), cfg)).toBe(true);
  });

  it("rejects a weekday bar after the window closes", () => {
    // 18:00 UTC = 14:00 ET → past the 12:00 cutoff.
    expect(inSession(at(2026, 7, 13, 18, 0), cfg)).toBe(false);
  });

  it("rejects weekends even inside the clock window", () => {
    // 2026-08-15 is a Saturday; 09:45 ET but not a trading day.
    expect(inSession(at(2026, 7, 15, 13, 45), cfg)).toBe(false);
  });

  it("is a no-op when disabled", () => {
    expect(inSession(at(2026, 7, 13, 18, 0), { ...cfg, enabled: false })).toBe(true);
  });
});

describe("engine", () => {
  it("returns WAIT with a reason when there isn't enough history", () => {
    const short = bars(Array.from({ length: 10 }, (_, i) => [100 + i, 99 + i] as [number, number]));
    const sig = analyze("TEST", short, aggregateBars(short, 15));
    expect(sig.action).toBe("WAIT");
    expect(sig.reasoning.length).toBeGreaterThan(0);
  });

  it("produces internally-consistent plans on real fixture data", () => {
    const universe = JSON.parse(readFileSync(path.resolve("data/fixtures/universe.json"), "utf-8")) as string[];
    expect(universe.length).toBeGreaterThan(0);
    for (const sym of universe) {
      const fx = JSON.parse(readFileSync(path.resolve(`data/fixtures/${sym}.json`), "utf-8")) as { ltf: Bar[]; htf: Bar[] };
      const sig = analyze(sym, fx.ltf, fx.htf);
      expect(["BUY", "SELL", "WAIT"]).toContain(sig.action);
      expect(sig.confidence).toBeGreaterThanOrEqual(0);
      expect(sig.confidence).toBeLessThanOrEqual(1);
      if (sig.action !== "WAIT") {
        expect(sig.entry).not.toBeNull();
        expect(sig.stop).not.toBeNull();
        expect(sig.targets.length).toBeGreaterThan(0);
        expect(sig.riskReward!).toBeGreaterThanOrEqual(1.5);
        if (sig.action === "BUY") {
          expect(sig.stop!).toBeLessThan(sig.entry!); // stop below entry for a long
          expect(sig.targets[0]!).toBeGreaterThan(sig.entry!); // target above
        } else {
          expect(sig.stop!).toBeGreaterThan(sig.entry!);
          expect(sig.targets[0]!).toBeLessThan(sig.entry!);
        }
      }
    }
  });
});
