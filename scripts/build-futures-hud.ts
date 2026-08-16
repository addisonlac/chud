/**
 * Build the futures HUD: a self-contained HTML page that draws the 1-minute
 * charts the bot actually traded (SPX for MES, NDX for MNQ) with every BUY/SELL
 * marked on price — entry, stop, TP, and win/loss outcome — plus per-day and
 * whole-week stats.
 *
 *   npx tsx scripts/build-futures-hud.ts            # → futures-hud.html
 *   npx tsx scripts/build-futures-hud.ts --out /tmp/hud.html
 *
 * Uses the SAFE preset from src/signals/futuresStrategy.ts, so the markers match
 * `npm run futures:backtest` exactly.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { FixtureProvider } from "../src/data/stockData.js";
import { getContract, DEFAULT_FUTURES_UNIVERSE } from "../src/signals/instruments.js";
import { runFutures, safePreset, type FuturesTrade } from "../src/signals/futuresStrategy.js";
import type { Bar } from "../src/signals/types.js";

const RISK_USD = Number(process.env.RISK_USD) || 250;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const f2 = (n: number) => n.toFixed(2);
const usd = (n: number) => `${n >= 0 ? "+$" : "-$"}${Math.abs(n).toFixed(0)}`;

/** Split a contiguous bar array into sessions on overnight/weekend gaps. */
function sessions(bars: Bar[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let start = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i]!.time - bars[i - 1]!.time > 5 * 60) {
      out.push({ from: start, to: i - 1 });
      start = i;
    }
  }
  out.push({ from: start, to: bars.length - 1 });
  return out;
}

const etDate = (t: number) => new Date(t * 1000).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "2-digit" });
const etTime = (t: number) => new Date(t * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });

/** One day's candlestick panel with its trades drawn on price. */
function panel(bars: Bar[], from: number, to: number, trades: FuturesTrade[]): string {
  const W = 1180, H = 300, padL = 6, padR = 58, padT = 10, padB = 16;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const seg = bars.slice(from, to + 1);
  const n = seg.length;
  const inDay = trades.filter((t) => t.fillIdx >= from && t.fillIdx <= to);

  const extra: number[] = [];
  for (const t of inDay) extra.push(t.entry, t.stop, t.tp1);
  let hi = Math.max(...seg.map((b) => b.high), ...extra);
  let lo = Math.min(...seg.map((b) => b.low), ...extra);
  const pad = (hi - lo) * 0.06 || 1;
  hi += pad; lo -= pad;

  const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (p: number) => padT + ((hi - p) / (hi - lo)) * plotH;
  const cw = Math.max(1, (plotW / n) * 0.62);
  const parts: string[] = [];

  for (let g = 0; g <= 4; g++) {
    const p = hi - ((hi - lo) * g) / 4, yy = y(p);
    parts.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" class="grid"/>`);
    parts.push(`<text x="${W - padR + 4}" y="${(yy + 3).toFixed(1)}" class="axis">${f2(p)}</text>`);
  }
  // candles
  for (let i = 0; i < n; i++) {
    const b = seg[i]!, cx = x(i), up = b.close >= b.open;
    parts.push(`<line x1="${cx.toFixed(1)}" y1="${y(b.high).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(b.low).toFixed(1)}" class="wk ${up ? "u" : "d"}"/>`);
    const top = Math.min(y(b.open), y(b.close)), hgt = Math.max(0.8, Math.abs(y(b.close) - y(b.open)));
    parts.push(`<rect x="${(cx - cw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${cw.toFixed(1)}" height="${hgt.toFixed(1)}" class="bd ${up ? "u" : "d"}"/>`);
  }
  // trades
  for (const t of inDay) {
    const win = t.realizedR > 0;
    const xi = x(t.fillIdx - from);
    const xe = x(Math.min(t.exitIdx, to) - from);
    const cls = win ? "win" : "loss";
    // stop / tp1 / entry level segments from fill → exit
    parts.push(`<line x1="${xi.toFixed(1)}" y1="${y(t.entry).toFixed(1)}" x2="${xe.toFixed(1)}" y2="${y(t.entry).toFixed(1)}" class="lvl entry"/>`);
    parts.push(`<line x1="${xi.toFixed(1)}" y1="${y(t.stop).toFixed(1)}" x2="${xe.toFixed(1)}" y2="${y(t.stop).toFixed(1)}" class="lvl stop"/>`);
    parts.push(`<line x1="${xi.toFixed(1)}" y1="${y(t.tp1).toFixed(1)}" x2="${xe.toFixed(1)}" y2="${y(t.tp1).toFixed(1)}" class="lvl tp"/>`);
    // entry marker: ▲ BUY below bar / ▼ SELL above bar
    const yb = y(t.action === "BUY" ? seg[Math.max(0, t.fillIdx - from)]!.low : seg[Math.max(0, t.fillIdx - from)]!.high);
    const tri = t.action === "BUY"
      ? `${xi.toFixed(1)},${(yb + 14).toFixed(1)} ${(xi - 5).toFixed(1)},${(yb + 22).toFixed(1)} ${(xi + 5).toFixed(1)},${(yb + 22).toFixed(1)}`
      : `${xi.toFixed(1)},${(yb - 14).toFixed(1)} ${(xi - 5).toFixed(1)},${(yb - 22).toFixed(1)} ${(xi + 5).toFixed(1)},${(yb - 22).toFixed(1)}`;
    parts.push(`<polygon points="${tri}" class="mk ${cls}"><title>${esc(t.action)} ${t.contracts}c @ ${f2(t.entry)} · ${etTime(t.entryTime)} ET · ${t.exit} ${t.realizedR >= 0 ? "+" : ""}${t.realizedR.toFixed(2)}R ${usd(t.pnlUsd)}</title></polygon>`);
    parts.push(`<text x="${xi.toFixed(1)}" y="${(t.action === "BUY" ? yb + 34 : yb - 26).toFixed(1)}" class="mklab ${cls}" text-anchor="middle">${t.action === "BUY" ? "▲" : "▼"}${t.realizedR >= 0 ? "+" : ""}${t.realizedR.toFixed(1)}R</text>`);
  }
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none" role="img" aria-label="1-minute chart">${parts.join("")}</svg>`;
}

function instrumentSection(root: string, dataSym: string, bars: Bar[], trades: FuturesTrade[]): string {
  const n = trades.length, w = trades.filter((t) => t.realizedR > 0).length;
  const netR = trades.reduce((s, t) => s + t.realizedR, 0), netUsd = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const winPct = n ? (100 * w) / n : 0;
  const rows = sessions(bars).map(({ from, to }) => {
    const dayTrades = trades.filter((t) => t.fillIdx >= from && t.fillIdx <= to);
    const dR = dayTrades.reduce((s, t) => s + t.realizedR, 0);
    const dW = dayTrades.filter((t) => t.realizedR > 0).length;
    const tag = dayTrades.length ? `${dayTrades.length} trades · ${dW}W/${dayTrades.length - dW}L · ${dR >= 0 ? "+" : ""}${dR.toFixed(1)}R` : "no trades";
    return `<div class="day"><div class="dayhd"><span class="daydate">${esc(etDate(bars[from]!.time))}</span><span class="daytag ${dR >= 0 && dayTrades.length ? "pos" : dayTrades.length ? "neg" : "flat"}">${tag}</span></div><div class="scroll">${panel(bars, from, to, trades)}</div></div>`;
  }).join("");
  return `<section class="inst">
    <header class="insthd">
      <div class="insttitle"><span class="root">${esc(root)}</span><span class="datasym">on ${esc(dataSym)} · 1m</span></div>
      <div class="iststats">
        <span class="stat"><b>${n}</b> trades</span>
        <span class="stat ${winPct >= 70 ? "good" : ""}"><b>${winPct.toFixed(0)}%</b> win</span>
        <span class="stat"><b>${netR >= 0 ? "+" : ""}${netR.toFixed(1)}R</b></span>
        <span class="stat ${netUsd >= 0 ? "pos" : "neg"}"><b>${usd(netUsd)}</b></span>
      </div>
    </header>
    ${rows}
  </section>`;
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1]! : path.resolve("futures-hud.html");
  const preset = safePreset();
  const provider = new FixtureProvider();

  const sections: string[] = [];
  const allTrades: FuturesTrade[] = [];
  for (const root of DEFAULT_FUTURES_UNIVERSE) {
    const c = getContract(root)!;
    const { ltf } = await provider.getSeries(c.dataSymbol);
    const trades = runFutures(root, c, ltf, { engine: preset.engine, guard: preset.guard, riskUsd: RISK_USD });
    allTrades.push(...trades);
    sections.push(instrumentSection(root, c.dataSymbol, ltf, trades));
  }

  const n = allTrades.length, w = allTrades.filter((t) => t.realizedR > 0).length;
  const netR = allTrades.reduce((s, t) => s + t.realizedR, 0), netUsd = allTrades.reduce((s, t) => s + t.pnlUsd, 0);
  const gw = allTrades.filter((t) => t.realizedR > 0).reduce((s, t) => s + t.realizedR, 0);
  const gl = Math.abs(allTrades.filter((t) => t.realizedR <= 0).reduce((s, t) => s + t.realizedR, 0));
  const winPct = n ? (100 * w) / n : 0;
  const asOf = allTrades.length ? etDate(Math.min(...allTrades.map((t) => t.entryTime))) + " → " + etDate(Math.max(...allTrades.map((t) => t.entryTime))) : "";

  const html = `<title>CHUD Futures HUD</title>
<style>${CSS}</style>
<main class="wrap">
  <header class="mast">
    <div class="brand"><span class="glyph">⧉</span> CHUD Futures HUD</div>
    <p class="sub">1-minute entry · 15-minute bias · NY morning drive · <b>safe</b> preset (with-trend, zone confluence, bank first target, one-loss lockout). Markers are the exact backtested trades on the real cash-index charts. ${esc(asOf)}.</p>
    <div class="kpis">
      <div class="kpi"><span class="kv ${winPct >= 70 ? "good" : ""}">${winPct.toFixed(0)}%</span><span class="kl">win rate</span></div>
      <div class="kpi"><span class="kv">${n}</span><span class="kl">trades</span></div>
      <div class="kpi"><span class="kv">${netR >= 0 ? "+" : ""}${netR.toFixed(1)}R</span><span class="kl">net R</span></div>
      <div class="kpi"><span class="kv ${netUsd >= 0 ? "pos" : "neg"}">${usd(netUsd)}</span><span class="kl">net $ @ $${RISK_USD}/trade</span></div>
      <div class="kpi"><span class="kv">${gl > 0 ? (gw / gl).toFixed(2) : "∞"}</span><span class="kl">profit factor</span></div>
    </div>
  </header>
  ${sections.join("\n")}
  <footer class="foot">
    <span class="lg"><span class="sw win"></span>winning trade</span>
    <span class="lg"><span class="sw loss"></span>losing trade</span>
    <span class="lg"><span class="ln entry"></span>entry</span>
    <span class="lg"><span class="ln stop"></span>stop</span>
    <span class="lg"><span class="ln tp"></span>target</span>
    <span class="note">Hover a marker for details. In-sample on one week — a demonstration of the setups, not proof of a durable edge. Not financial advice.</span>
  </footer>
</main>`;

  await writeFile(out, html);
  console.log(`Wrote ${out}  — ${n} trades, ${winPct.toFixed(1)}% win, ${netR >= 0 ? "+" : ""}${netR.toFixed(2)}R, ${usd(netUsd)}`);
}

const CSS = `
:root{--bg:#f4f6f9;--surface:#fff;--surface2:#eef1f6;--border:#dde2ea;--ink:#161b26;--ink2:#57607040;--muted:#8993a4;--accent:#4f6bed;--bull:#0e9e86;--bear:#e0473f;--grid:#e9edf3;--good:#0e9e86;}
:root{--ink2:#5a6373;}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b0e14;--surface:#121722;--surface2:#1a202c;--border:#262d3b;--ink:#e8ecf3;--ink2:#a2acbd;--muted:#6b7688;--accent:#7d92f5;--bull:#22c2ad;--bear:#f76d78;--grid:#1e2632;--good:#22c2ad;}}
:root[data-theme="dark"]{--bg:#0b0e14;--surface:#121722;--surface2:#1a202c;--border:#262d3b;--ink:#e8ecf3;--ink2:#a2acbd;--muted:#6b7688;--accent:#7d92f5;--bull:#22c2ad;--bear:#f76d78;--grid:#1e2632;--good:#22c2ad;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.45}
.wrap{max-width:1260px;margin:0 auto;padding:26px 18px 60px}
.mast{margin-bottom:20px}
.brand{font-size:24px;font-weight:750;letter-spacing:-.02em;display:flex;align-items:center;gap:9px}
.glyph{color:var(--accent)}
.sub{max-width:90ch;color:var(--ink2);font-size:13.5px;margin:7px 0 16px}
.kpis{display:flex;gap:10px;flex-wrap:wrap}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:9px 15px;display:flex;flex-direction:column;min-width:96px;box-shadow:0 1px 2px rgba(20,25,40,.05)}
.kv{font-size:21px;font-weight:750;font-variant-numeric:tabular-nums}
.kv.good{color:var(--good)} .kv.pos{color:var(--bull)} .kv.neg{color:var(--bear)}
.kl{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.inst{margin-top:24px}
.insthd{display:flex;align-items:baseline;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:10px;flex-wrap:wrap}
.insttitle{display:flex;align-items:baseline;gap:8px}
.root{font-size:19px;font-weight:750;letter-spacing:-.01em}
.datasym{font-size:12px;color:var(--muted)}
.iststats{display:flex;gap:14px;flex-wrap:wrap}
.iststats .stat{font-size:12.5px;color:var(--ink2)} .iststats b{font-variant-numeric:tabular-nums;color:var(--ink)}
.iststats .good b{color:var(--good)} .iststats .pos b{color:var(--bull)} .iststats .neg b{color:var(--bear)}
.day{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:10px 10px 6px;margin-bottom:12px;box-shadow:0 1px 2px rgba(20,25,40,.05)}
.dayhd{display:flex;align-items:center;justify-content:space-between;margin:0 2px 6px}
.daydate{font-size:12.5px;font-weight:650}
.daytag{font-size:11.5px;font-variant-numeric:tabular-nums;padding:2px 8px;border-radius:999px;background:var(--surface2);color:var(--ink2)}
.daytag.pos{color:var(--bull)} .daytag.neg{color:var(--bear)}
.scroll{overflow-x:auto}
.chart{width:100%;min-width:760px;height:auto;display:block}
.chart .grid{stroke:var(--grid);stroke-width:1}
.chart .axis{fill:var(--muted);font-size:8.5px;font-family:ui-monospace,monospace}
.chart .wk{stroke-width:1} .chart .wk.u,.chart .bd.u{stroke:var(--bull)} .chart .bd.u{fill:var(--bull)}
.chart .wk.d,.chart .bd.d{stroke:var(--bear)} .chart .bd.d{fill:var(--bear)}
.chart .bd{opacity:.85}
.chart .lvl{stroke-width:1.3} .chart .lvl.entry{stroke:var(--accent)} .chart .lvl.stop{stroke:var(--bear);stroke-dasharray:4 3} .chart .lvl.tp{stroke:var(--bull);stroke-dasharray:4 3}
.chart .mk.win{fill:var(--bull)} .chart .mk.loss{fill:var(--bear)}
.chart .mklab{font-size:9px;font-weight:700;font-family:ui-monospace,monospace} .chart .mklab.win{fill:var(--bull)} .chart .mklab.loss{fill:var(--bear)}
.foot{margin-top:20px;display:flex;gap:16px;flex-wrap:wrap;align-items:center;color:var(--muted);font-size:11.5px}
.lg{display:flex;align-items:center;gap:6px}
.sw{width:10px;height:10px;border-radius:3px;display:inline-block} .sw.win{background:var(--bull)} .sw.loss{background:var(--bear)}
.ln{width:16px;height:0;border-top:2px solid;display:inline-block} .ln.entry{border-color:var(--accent)} .ln.stop{border-color:var(--bear);border-top-style:dashed} .ln.tp{border-color:var(--bull);border-top-style:dashed}
.note{flex:1;min-width:240px}
`;

void main();
