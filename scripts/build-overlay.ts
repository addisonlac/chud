/**
 * Build the visual "overlay": a self-contained HTML dashboard that analyses each
 * stock for the day and breaks the reasoning down step by step, with an
 * annotated 1m candlestick chart (liquidity sweep, order block, FVG, structure
 * break, entry/stop/targets drawn on price).
 *
 *   npx tsx scripts/build-overlay.ts                 # all fixtures → overlay.html
 *   npx tsx scripts/build-overlay.ts NVDA TSLA       # just these
 *   npx tsx scripts/build-overlay.ts --out /path.html
 *
 * Output is a single file with no external assets (inline CSS + inline SVG), so
 * it renders anywhere and can be published as an Artifact as-is.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FixtureProvider, FIXTURE_DIR, defaultProvider } from "../src/data/stockData.js";
import { analyze } from "../src/signals/engine.js";
import { aggregateBars } from "../src/signals/candles.js";
import { sizeShares, DEFAULT_RISK_USD } from "../src/signals/sizing.js";
import type { Bar, Signal } from "../src/signals/types.js";

const SHOW_BARS = 90; // 1m bars drawn on each chart (≈1.5h of the entry timeframe)
const WARMUP = 240; // 1m bars before the first read (enough to build the 15m bias series)
const RISK_USD = Number(process.env.RISK_USD) || DEFAULT_RISK_USD; // $ risk/trade used for share sizing

/**
 * The freshest actionable read for a symbol: walk back from the latest bar to
 * the most recent bar where the engine actually fired BUY/SELL, and return that
 * analysis with the bars that produced it (so the setup sits at the chart's
 * right edge). If the engine never fired in the window, fall back to the
 * current — honestly WAIT — read on the full series.
 */
function latestActionable(symbol: string, ltf: Bar[]): { sig: Signal; bars: Bar[] } {
  for (let i = ltf.length - 1; i >= WARMUP; i--) {
    const seen = ltf.slice(0, i + 1);
    const sig = analyze(symbol, seen, aggregateBars(seen, 15));
    if (sig.action !== "WAIT") return { sig, bars: seen };
  }
  return { sig: analyze(symbol, ltf, aggregateBars(ltf, 15)), bars: ltf };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const f2 = (n: number) => n.toFixed(2);

// ---- annotated candlestick chart (inline SVG) ------------------------------
function chart(sig: Signal, ltf: Bar[]): string {
  const W = 720;
  const H = 320;
  const padL = 8;
  const padR = 62; // room for price labels on the right
  const padT = 12;
  const padB = 18;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const start = Math.max(0, ltf.length - SHOW_BARS);
  const bars = ltf.slice(start);
  const n = bars.length;

  const extra = [sig.entry, sig.stop, ...sig.targets, ...(sig.evidence.liquidityPools ?? []).map((p) => p.price)].filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  let hi = Math.max(...bars.map((b) => b.high), ...extra);
  let lo = Math.min(...bars.map((b) => b.low), ...extra);
  const pad = (hi - lo) * 0.06 || 1;
  hi += pad;
  lo -= pad;

  const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (p: number) => padT + ((hi - p) / (hi - lo)) * plotH;
  const cw = Math.max(2, (plotW / n) * 0.6);

  const parts: string[] = [];

  // grid + price ticks
  for (let g = 0; g <= 4; g++) {
    const p = hi - ((hi - lo) * g) / 4;
    const yy = y(p);
    parts.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" class="grid"/>`);
    parts.push(`<text x="${W - padR + 4}" y="${(yy + 3).toFixed(1)}" class="axis">${f2(p)}</text>`);
  }

  // order block zone
  const ob = sig.evidence.orderBlock;
  if (ob && ob.index >= start) {
    const bx = x(ob.index - start);
    parts.push(
      `<rect x="${bx.toFixed(1)}" y="${y(ob.top).toFixed(1)}" width="${(padL + plotW - bx).toFixed(1)}" height="${(y(ob.bottom) - y(ob.top)).toFixed(1)}" class="ob ${ob.side}"/>`,
    );
  }
  // fair value gap zone
  const fvg = sig.evidence.fvg;
  if (fvg && fvg.index >= start) {
    const bx = x(fvg.index - start);
    parts.push(
      `<rect x="${bx.toFixed(1)}" y="${y(fvg.top).toFixed(1)}" width="${(padL + plotW - bx).toFixed(1)}" height="${(y(fvg.bottom) - y(fvg.top)).toFixed(1)}" class="fvg"/>`,
    );
  }

  // liquidity pools
  for (const pool of sig.evidence.liquidityPools ?? []) {
    const yy = y(pool.price);
    if (yy < padT || yy > padT + plotH) continue;
    parts.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" class="pool ${pool.side}"/>`);
  }

  // candles
  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    const cx = x(i);
    const up = b.close >= b.open;
    parts.push(`<line x1="${cx.toFixed(1)}" y1="${y(b.high).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(b.low).toFixed(1)}" class="wick ${up ? "up" : "dn"}"/>`);
    const yo = y(b.open);
    const yc = y(b.close);
    const top = Math.min(yo, yc);
    const hgt = Math.max(1, Math.abs(yc - yo));
    parts.push(`<rect x="${(cx - cw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${cw.toFixed(1)}" height="${hgt.toFixed(1)}" class="body ${up ? "up" : "dn"}"/>`);
  }

  // sweep marker
  const sw = sig.evidence.sweep;
  if (sw && sw.index >= start) {
    const cx = x(sw.index - start);
    const yy = y(sw.extreme);
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${yy.toFixed(1)}" r="4" class="sweep"/>`);
    parts.push(`<text x="${cx.toFixed(1)}" y="${(sw.side === "sellside" ? yy + 16 : yy - 8).toFixed(1)}" class="mark" text-anchor="middle">sweep</text>`);
  }
  // structure break marker
  const brk = sig.evidence.structureBreak;
  if (brk && brk.index >= start) {
    const cx = x(brk.index - start);
    const yy = y(brk.price);
    parts.push(`<text x="${cx.toFixed(1)}" y="${(yy - 6).toFixed(1)}" class="mark" text-anchor="middle">${brk.event}</text>`);
  }

  // trade levels
  const level = (p: number | null, cls: string, label: string) => {
    if (p === null || !Number.isFinite(p)) return;
    const yy = y(p);
    if (yy < padT - 2 || yy > padT + plotH + 2) return;
    parts.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" class="level ${cls}"/>`);
    parts.push(`<text x="${W - padR + 4}" y="${(yy + 3).toFixed(1)}" class="levellab ${cls}">${label}</text>`);
  };
  if (sig.action !== "WAIT") {
    level(sig.entry, "entry", "entry");
    level(sig.stop, "stop", "stop");
    sig.targets.forEach((t, i) => level(t, "target", `TP${i + 1}`));
  }

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(sig.symbol)} 1m chart with annotated setup" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg>`;
}

const VERDICT_DOT: Record<string, string> = { bullish: "v-bull", bearish: "v-bear", neutral: "v-neutral", info: "v-info" };

function card(sig: Signal, ltf: Bar[]): string {
  const conf = Math.round(sig.confidence * 100);
  const actionClass = sig.action === "BUY" ? "buy" : sig.action === "SELL" ? "sell" : "wait";
  const size = sizeShares(sig, RISK_USD);
  const plan =
    sig.action === "WAIT"
      ? `<div class="plan wait-plan">No trade — waiting for a valid, higher-timeframe-aligned setup.</div>`
      : `<div class="plan">
          ${planItem("Shares", `<span class="shares ${actionClass}">${sig.action} ${size.shares}</span>`)}
          ${planItem("Entry", `${f2(sig.entry!)} <span class="etype">${sig.entryType}</span>`)}
          ${planItem("Stop", f2(sig.stop!))}
          ${sig.targets.map((t, i) => planItem(`TP${i + 1}`, f2(t))).join("")}
          ${planItem("R:R", sig.riskReward !== null ? `${sig.riskReward}R` : "—")}
        </div>
        <div class="sizenote">≈ $${size.notionalUsd.toFixed(0)} notional · risking $${size.riskUsd.toFixed(0)} to the stop${size.targetPnlUsd[0] !== undefined ? ` · +$${size.targetPnlUsd[0].toFixed(0)} at TP1` : ""}</div>`;

  const steps = sig.reasoning
    .map(
      (r, i) => `<li class="step">
        <span class="dot ${VERDICT_DOT[r.verdict] ?? "v-info"}"></span>
        <div class="step-body">
          <span class="step-label">${esc(r.label)}${r.weight > 0 ? `<span class="w">+${Math.round(r.weight * 100)}</span>` : ""}</span>
          <span class="step-detail">${esc(r.detail)}</span>
        </div>
      </li>`,
    )
    .join("");

  return `<article class="cardx">
    <header class="cardhd">
      <div class="sym">${esc(sig.symbol)}</div>
      <div class="pill ${actionClass}">${sig.action}</div>
      <div class="spacer"></div>
      <div class="price">${f2(sig.price)}</div>
    </header>
    <div class="subhd">
      <div class="conf">
        <div class="confbar"><span style="width:${conf}%"></span></div>
        <span class="confnum">${conf}%</span>
      </div>
      <div class="biaschips">
        <span class="bchip t-${sig.htfTrend}">15m ${sig.htfTrend}</span>
        <span class="bchip t-${sig.ltfTrend}">1m ${sig.ltfTrend}</span>
      </div>
    </div>
    <div class="when">⏱ ${esc(new Date(sig.generatedAt * 1000).toISOString().slice(0, 16).replace("T", " "))} UTC</div>
    ${chart(sig, ltf)}
    ${plan}
    <ol class="steps">${steps}</ol>
  </article>`;
}

const planItem = (k: string, v: string) => `<div class="pitem"><span class="pk">${k}</span><span class="pv">${v}</span></div>`;

function page(cards: string, meta: { asOf: string; count: number; buys: number; sells: number; waits: number }): string {
  return `<title>CHUD Signals</title>
<style>${CSS}</style>
<main class="wrap">
  <header class="masthead">
    <div class="brand"><span class="glyph">⧉</span> CHUD Signals</div>
    <p class="tagline">Liquidity-sweep + market-structure read on the 1-minute entry chart with a 15-minute bias, gated to the session's high-liquidity window. Each card shows a stock's most recent actionable signal — the setup drawn on price, the trade plan, and the reasoning scored step by step. The timestamp is when the signal fired.</p>
    <div class="summary">
      <div class="scard"><span class="snum">${meta.count}</span><span class="slab">stocks</span></div>
      <div class="scard buy"><span class="snum">${meta.buys}</span><span class="slab">buy</span></div>
      <div class="scard sell"><span class="snum">${meta.sells}</span><span class="slab">sell</span></div>
      <div class="scard wait"><span class="snum">${meta.waits}</span><span class="slab">wait</span></div>
      <div class="asof">as of ${esc(meta.asOf)}</div>
    </div>
  </header>
  <section class="grid">${cards}</section>
  <footer class="foot">
    Trades are sized in whole <strong>shares</strong> to risk ~$${RISK_USD} to the stop (set RISK_USD to change).
    Entry model: sweeps enter at market on the rejection; breaks wait for a pullback into the order block / FVG.
    Not financial advice — signals come from historical price structure and can be wrong; confirm your own risk before trading.
  </footer>
</main>`;
}

const CSS = `
:root{
  --bg:#f5f6f8; --surface:#ffffff; --surface2:#eef0f4; --border:#dfe3ea;
  --ink:#1a1f2b; --ink2:#5b6472; --muted:#8a93a3;
  --accent:#4f6bed; --bull:#0f9d8f; --bear:#e04352; --wait:#c08a2d;
  --grid:#e9ecf1; --shadow:0 1px 2px rgba(20,25,40,.06),0 8px 24px rgba(20,25,40,.06);
}
:root:not([data-theme="light"]){}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#0d1017; --surface:#141924; --surface2:#1b2130; --border:#28303f;
    --ink:#e7ebf2; --ink2:#a3adbd; --muted:#6d7788;
    --accent:#7d92f5; --bull:#22c2ad; --bear:#f76d78; --wait:#e0b25a;
    --grid:#20283544; --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35);
  }
}
:root[data-theme="dark"]{
  --bg:#0d1017; --surface:#141924; --surface2:#1b2130; --border:#28303f;
  --ink:#e7ebf2; --ink2:#a3adbd; --muted:#6d7788;
  --accent:#7d92f5; --bull:#22c2ad; --bear:#f76d78; --wait:#e0b25a;
  --grid:#20283544; --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-feature-settings:"cv02","cv03";-webkit-font-smoothing:antialiased;line-height:1.5}
.wrap{max-width:1180px;margin:0 auto;padding:32px 20px 64px}
.masthead{margin-bottom:26px}
.brand{font-size:26px;font-weight:700;letter-spacing:-.02em;display:flex;align-items:center;gap:10px}
.glyph{color:var(--accent)}
.tagline{max-width:64ch;color:var(--ink2);margin:8px 0 18px;font-size:14.5px}
.summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.scard{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:8px 14px;display:flex;flex-direction:column;min-width:64px;box-shadow:var(--shadow)}
.scard .snum{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}
.scard .slab{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.scard.buy .snum{color:var(--bull)} .scard.sell .snum{color:var(--bear)} .scard.wait .snum{color:var(--wait)}
.asof{margin-left:auto;color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:18px}
@media(max-width:520px){.grid{grid-template-columns:1fr}}
.cardx{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:16px 16px 8px;box-shadow:var(--shadow);display:flex;flex-direction:column}
.cardhd{display:flex;align-items:center;gap:10px}
.sym{font-size:19px;font-weight:700;letter-spacing:-.01em}
.spacer{flex:1}
.price{font-size:16px;font-variant-numeric:tabular-nums;color:var(--ink2)}
.pill{font-size:12px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:999px;border:1px solid transparent}
.pill.buy{color:#fff;background:var(--bull)} .pill.sell{color:#fff;background:var(--bear)}
.pill.wait{color:var(--wait);background:transparent;border-color:var(--border)}
.subhd{display:flex;align-items:center;gap:14px;margin:10px 0 12px}
.conf{display:flex;align-items:center;gap:8px;flex:1}
.confbar{flex:1;height:6px;border-radius:99px;background:var(--surface2);overflow:hidden}
.confbar span{display:block;height:100%;background:var(--accent)}
.confnum{font-size:12.5px;font-variant-numeric:tabular-nums;color:var(--ink2);min-width:34px;text-align:right}
.biaschips{display:flex;gap:6px}
.bchip{font-size:11px;padding:2px 8px;border-radius:6px;background:var(--surface2);color:var(--ink2);white-space:nowrap}
.bchip.t-bullish{color:var(--bull)} .bchip.t-bearish{color:var(--bear)} .bchip.t-ranging{color:var(--muted)}
.when{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;margin:-4px 0 8px}
.chart{width:100%;height:auto;display:block;margin:2px 0 6px;background:transparent;border-radius:10px;overflow:visible}
.chart .grid{stroke:var(--grid);stroke-width:1}
.chart .axis{fill:var(--muted);font-size:9px;font-family:ui-monospace,monospace}
.chart .wick{stroke-width:1}
.chart .wick.up,.chart .body.up{stroke:var(--bull)} .chart .body.up{fill:var(--bull)}
.chart .wick.dn,.chart .body.dn{stroke:var(--bear)} .chart .body.dn{fill:var(--bear)}
.chart .ob{opacity:.16} .chart .ob.bullish{fill:var(--bull)} .chart .ob.bearish{fill:var(--bear)}
.chart .fvg{fill:var(--wait);opacity:.14}
.chart .pool{stroke:var(--muted);stroke-width:1;stroke-dasharray:2 3;opacity:.55}
.chart .sweep{fill:var(--accent);stroke:var(--surface);stroke-width:1}
.chart .mark{fill:var(--ink2);font-size:9px;font-weight:600}
.chart .level{stroke-width:1.4}
.chart .level.entry{stroke:var(--accent)} .chart .level.stop{stroke:var(--bear);stroke-dasharray:4 3} .chart .level.target{stroke:var(--bull);stroke-dasharray:4 3}
.chart .levellab{font-size:9px;font-weight:700;font-family:ui-monospace,monospace}
.chart .levellab.entry{fill:var(--accent)} .chart .levellab.stop{fill:var(--bear)} .chart .levellab.target{fill:var(--bull)}
.plan{display:flex;flex-wrap:wrap;gap:8px;background:var(--surface2);border-radius:10px;padding:9px 11px;margin:4px 0 12px}
.plan.wait-plan{color:var(--ink2);font-size:13px}
.shares.buy{color:var(--bull)} .shares.sell{color:var(--bear)}
.sizenote{font-size:11.5px;color:var(--muted);margin:-6px 0 12px;font-variant-numeric:tabular-nums}
.pitem{display:flex;flex-direction:column;min-width:56px}
.pk{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.pv{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
.etype{font-size:10px;font-weight:500;color:var(--muted)}
.steps{list-style:none;margin:0;padding:0 0 8px;display:flex;flex-direction:column;gap:9px}
.step{display:flex;gap:10px}
.dot{flex:none;width:9px;height:9px;border-radius:99px;margin-top:5px}
.v-bull{background:var(--bull)} .v-bear{background:var(--bear)} .v-neutral{background:var(--muted)} .v-info{background:var(--accent)}
.step-body{display:flex;flex-direction:column}
.step-label{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:7px}
.step-label .w{font-size:10px;font-weight:700;color:var(--accent);background:color-mix(in srgb,var(--accent) 15%,transparent);padding:0 5px;border-radius:5px;font-variant-numeric:tabular-nums}
.step-detail{font-size:12.5px;color:var(--ink2)}
.foot{margin-top:26px;color:var(--muted);font-size:12px;max-width:74ch;line-height:1.6}
`;

async function pickSymbols(positional: string[]): Promise<string[]> {
  if (positional.length > 0) return positional.map((s) => s.toUpperCase());
  try {
    return JSON.parse(await readFile(path.join(FIXTURE_DIR, "universe.json"), "utf-8")) as string[];
  } catch {
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1]! : path.resolve("overlay.html");
  // Positional tokens = args that aren't a flag and aren't the value of --out.
  const positional = args.filter((a, i) => !a.startsWith("--") && !(outIdx >= 0 && i === outIdx + 1));
  const symbols = await pickSymbols(positional);
  if (symbols.length === 0) {
    console.error("No symbols. Build fixtures first (npm run signal:fixtures) or pass symbols.");
    process.exit(1);
  }

  const cards: string[] = [];
  let buys = 0;
  let sells = 0;
  let waits = 0;
  let asOf = "";

  let latestBarTime = 0;
  for (const symbol of symbols) {
    let ltf: Bar[];
    try {
      ({ ltf } = await new FixtureProvider().getSeries(symbol));
    } catch {
      ({ ltf } = await defaultProvider().getSeries(symbol));
    }
    if (ltf.length === 0) {
      console.warn(`skip ${symbol}: no data`);
      continue;
    }
    latestBarTime = Math.max(latestBarTime, ltf[ltf.length - 1]!.time);
    const { sig, bars } = latestActionable(symbol, ltf);
    if (sig.action === "BUY") buys++;
    else if (sig.action === "SELL") sells++;
    else waits++;
    cards.push(card(sig, bars));
  }
  asOf = new Date(latestBarTime * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

  const html = page(cards.join("\n"), { asOf, count: cards.length, buys, sells, waits });
  await writeFile(out, html);
  console.log(`Wrote ${out}  (${cards.length} cards)`);
}

void main();
