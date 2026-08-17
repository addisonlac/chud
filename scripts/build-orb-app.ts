/**
 * Build the ORB Terminal app — a self-contained, interactive web app that
 * analyses real ES/NQ (SPX/NDX) 1-minute charts with the Opening Range Breakout
 * strategy and shows the BUY/SELL call, drawn on price, per session, with
 * after-cost stats. Output: orb-app.html (publishable as an Artifact).
 *
 *   npx tsx scripts/build-orb-app.ts [--out orb-app.html]
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalize } from "../src/signals/candles.js";
import { splitSessions } from "../src/signals/orb.js";
import { getContract } from "../src/signals/instruments.js";
import type { Bar } from "../src/signals/types.js";

const OOS = path.resolve("data/oos");
const MAP: Array<[string, string]> = [["MES", "SPX"], ["MNQ", "NDX"]];

interface IdxBar { begins_at: string; open_value: string; high_value: string; low_value: string; close_value: string; interpolated?: boolean }
function toBars(raw: IdxBar[]): Bar[] {
  const bars: Bar[] = [];
  for (const r of raw) {
    if (r.interpolated) continue;
    const t = Math.floor(new Date(r.begins_at).getTime() / 1000);
    const o = +r.open_value, h = +r.high_value, l = +r.low_value, c = +r.close_value;
    if ([t, o, h, l, c].every(Number.isFinite)) bars.push({ time: t, open: o, high: h, low: l, close: c, volume: 0 });
  }
  return normalize(bars);
}
const r2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1]! : path.resolve("orb-app.html");
  const weeks = (await readdir(OOS)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();

  const DATA: Record<string, Array<{ date: string; start: number; bars: number[][] }>> = {};
  for (const [root, sym] of MAP) {
    const sessions: Array<{ date: string; start: number; bars: number[][] }> = [];
    for (const wk of weeks) {
      let raw: { bars: IdxBar[] };
      try { raw = JSON.parse(await readFile(path.join(OOS, wk, `${sym}.json`), "utf-8")); } catch { continue; }
      const bars = toBars(raw.bars);
      for (const { from, to } of splitSessions(bars)) {
        const seg = bars.slice(from, to + 1);
        sessions.push({ date: new Date(bars[from]!.time * 1000).toISOString().slice(0, 10), start: bars[from]!.time, bars: seg.map((b) => [r2(b.open), r2(b.high), r2(b.low), r2(b.close)]) });
      }
    }
    DATA[root] = sessions;
  }

  const CONTRACTS = Object.fromEntries(MAP.map(([root, sym]) => {
    const c = getContract(root)!;
    return [root, { name: c.name, dataSym: sym, pointValue: c.pointValue, tickValue: c.tickValue }];
  }));

  const html = PAGE(JSON.stringify(DATA), JSON.stringify(CONTRACTS));
  await writeFile(out, html);
  const total = Object.values(DATA).reduce((s, a) => s + a.length, 0);
  console.log(`Wrote ${out}  (${total} sessions embedded across ${MAP.map((m) => m[0]).join(", ")})`);
}

function PAGE(dataJson: string, contractsJson: string): string {
  return `<title>ORB Terminal</title>
<style>${CSS}</style>
<main id="app">
  <header class="top">
    <div class="brand"><span class="dot"></span> ORB Terminal <span class="sub">Opening Range Breakout · ES/NQ · 1‑minute</span></div>
    <div class="segs" id="symToggle"></div>
  </header>

  <section class="callcard" id="callcard"></section>

  <section class="chartwrap">
    <div class="daynav">
      <button id="prev" class="nav">‹</button>
      <div class="daylabel"><span id="dayDate">—</span><span id="dayIdx" class="muted"></span></div>
      <button id="next" class="nav">›</button>
    </div>
    <div class="scroll"><div id="chart"></div></div>
    <div class="legend">
      <span><i class="sw or"></i>opening range (first 15m)</span>
      <span><i class="ln entry"></i>entry</span>
      <span><i class="ln stop"></i>stop</span>
      <span><i class="ln tgt"></i>target (2R)</span>
      <span><i class="sw win"></i>win</span><span><i class="sw loss"></i>loss</span>
    </div>
  </section>

  <section class="stats" id="stats"></section>

  <section class="logwrap">
    <h2>Every ORB call <span class="muted" id="logsym"></span></h2>
    <div class="scroll"><table class="log" id="log"></table></div>
  </section>

  <footer class="foot">
    One trade per session: the first break of the first‑15‑minute range, in the VWAP direction. Stop = the far side of the
    range; target = 2× that risk. Net figures include commission ($1.24/contract round‑trip) + 1 tick slippage per side,
    sized to $250 risk. Real cash‑index minute data (ES↔SPX, NQ↔NDX) — a small sample, not a guarantee. Not financial advice.
  </footer>
</main>
<script>
const DATA = ${dataJson};
const CONTRACTS = ${contractsJson};
const CFG = { openMinutes:15, targetR:2, risk:250, commissionRt:1.24, slippageTicks:1, minRangeFrac:0.0004, maxRangeFrac:0.02 };
let SYM = "MES", DAY = 0;

// ---- ORB logic (mirrors src/signals/orb.ts) --------------------------------
function vwap(bars, upto){ let s=0; for(let i=0;i<=upto;i++){const b=bars[i]; s+=(b[1]+b[2]+b[3])/3;} return s/(upto+1); }
function setupFor(bars){
  const n=bars.length, m=CFG.openMinutes; if(n<m+5) return null;
  let hi=-1e9, lo=1e9; for(let i=0;i<m;i++){ hi=Math.max(hi,bars[i][1]); lo=Math.min(lo,bars[i][2]); }
  const width=hi-lo, ref=bars[m-1][3];
  if(!(width>0)||width<ref*CFG.minRangeFrac||width>ref*CFG.maxRangeFrac) return null;
  const last=Math.min(n-1, m+150);
  for(let i=m;i<=last;i++){
    const c=bars[i][3];
    const up=c>hi, dn=c<lo; if(!up&&!dn) continue;
    const dir=up?"long":"short", v=vwap(bars,i);
    if(dir==="long"&&c<v) continue; if(dir==="short"&&c>v) continue;
    const entry=c, stop=dir==="long"?lo:hi, risk=Math.abs(entry-stop); if(risk<=0) break;
    const target=dir==="long"?entry+CFG.targetR*risk:entry-CFG.targetR*risk;
    return { dir, orHigh:hi, orLow:lo, entryIdx:i, entry, stop, target, risk };
  }
  return null;
}
function simulate(bars, su){
  const c=CONTRACTS[SYM], isLong=su.dir==="long";
  const rOf=p=>(isLong?p-su.entry:su.entry-p)/su.risk;
  const contracts=Math.max(1, Math.floor(CFG.risk/(su.risk*c.pointValue)));
  const riskUsd=contracts*su.risk*c.pointValue;
  const cost=contracts*(CFG.commissionRt+2*CFG.slippageTicks*c.tickValue);
  let grossR=rOf(bars[bars.length-1][3]), exit="close", exitIdx=bars.length-1;
  for(let j=su.entryIdx+1;j<bars.length;j++){
    const b=bars[j], hs=isLong?b[2]<=su.stop:b[1]>=su.stop, ht=isLong?b[1]>=su.target:b[2]<=su.target;
    if(hs){ grossR=rOf(su.stop); exit="stop"; exitIdx=j; break; }
    if(ht){ grossR=rOf(su.target); exit="target"; exitIdx=j; break; }
  }
  return { grossR, exit, exitIdx, contracts, netUsd:grossR*riskUsd-cost };
}
function analyze(sym){ return DATA[sym].map(s=>{ const su=setupFor(s.bars); return { ...s, su, res: su?simulate(s.bars,su):null }; }); }

// ---- Rendering -------------------------------------------------------------
const $=id=>document.getElementById(id);
const f2=n=>n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const usd=n=>(n>=0?"+$":"-$")+Math.abs(n).toLocaleString(undefined,{maximumFractionDigits:0});

function chart(sess){
  const bars=sess.bars, su=sess.su, res=sess.res, W=1180,H=340,pL=6,pR=64,pT=12,pB=18,pw=W-pL-pR,ph=H-pT-pB,n=bars.length;
  const extra=su?[su.orHigh,su.orLow,su.entry,su.stop,su.target]:[];
  let hi=Math.max(...bars.map(b=>b[1]),...extra), lo=Math.min(...bars.map(b=>b[2]),...extra);
  const pad=(hi-lo)*0.06||1; hi+=pad; lo-=pad;
  const x=i=>pL+(n<=1?pw/2:i*pw/(n-1)), y=p=>pT+((hi-p)/(hi-lo))*ph, cw=Math.max(1,pw/n*0.6);
  let s="";
  for(let g=0;g<=4;g++){ const p=hi-(hi-lo)*g/4, yy=y(p); s+=\`<line x1="\${pL}" y1="\${yy}" x2="\${pL+pw}" y2="\${yy}" class="grid"/><text x="\${W-pR+4}" y="\${yy+3}" class="axis">\${f2(p)}</text>\`; }
  if(su){ const bx=x(0), bw=x(CFG.openMinutes-1)-bx; s+=\`<rect x="\${bx}" y="\${y(su.orHigh)}" width="\${Math.max(2,bw)}" height="\${y(su.orLow)-y(su.orHigh)}" class="orbox"/>\`; }
  for(let i=0;i<n;i++){ const b=bars[i],cx=x(i),up=b[3]>=b[0]; s+=\`<line x1="\${cx}" y1="\${y(b[1])}" x2="\${cx}" y2="\${y(b[2])}" class="wk \${up?'u':'d'}"/>\`; const t=Math.min(y(b[0]),y(b[3])),hh=Math.max(.7,Math.abs(y(b[3])-y(b[0]))); s+=\`<rect x="\${cx-cw/2}" y="\${t}" width="\${cw}" height="\${hh}" class="bd \${up?'u':'d'}"/>\`; }
  if(su&&res){ const win=res.netUsd>0, xi=x(su.entryIdx), xe=x(res.exitIdx), cls=win?'win':'loss';
    s+=\`<line x1="\${xi}" y1="\${y(su.entry)}" x2="\${xe}" y2="\${y(su.entry)}" class="lvl entry"/>\`;
    s+=\`<line x1="\${xi}" y1="\${y(su.stop)}" x2="\${xe}" y2="\${y(su.stop)}" class="lvl stop"/>\`;
    s+=\`<line x1="\${xi}" y1="\${y(su.target)}" x2="\${xe}" y2="\${y(su.target)}" class="lvl tgt"/>\`;
    const yb=su.dir==="long"?y(bars[su.entryIdx][2]):y(bars[su.entryIdx][1]);
    const tri=su.dir==="long"?\`\${xi},\${yb+14} \${xi-5},\${yb+22} \${xi+5},\${yb+22}\`:\`\${xi},\${yb-14} \${xi-5},\${yb-22} \${xi+5},\${yb-22}\`;
    s+=\`<polygon points="\${tri}" class="mk \${cls}"/>\`;
    s+=\`<circle cx="\${xe}" cy="\${y(res.exit==='target'?su.target:res.exit==='stop'?su.stop:bars[res.exitIdx][3])}" r="3.5" class="mk \${cls}"/>\`;
  }
  return \`<svg viewBox="0 0 \${W} \${H}" class="cv" preserveAspectRatio="none">\${s}</svg>\`;
}

function renderCall(sess){
  const su=sess.su, res=sess.res, c=CONTRACTS[SYM];
  if(!su){ $("callcard").className="callcard flat"; $("callcard").innerHTML=\`<div class="side">⚪ NO TRADE</div><div class="detail">No clean opening‑range break in the VWAP direction on \${sess.date}. Stand aside.</div>\`; return; }
  const win=res.netUsd>0, dir=su.dir==="long"?"BUY":"SELL";
  $("callcard").className="callcard "+(su.dir==="long"?"buy":"sell");
  $("callcard").innerHTML=\`
    <div class="side">\${su.dir==="long"?"🟢 BUY":"🔴 SELL"} \${SYM}</div>
    <div class="plan">
      <div class="pitem"><span class="pk">Entry</span><span class="pv">\${f2(su.entry)}</span></div>
      <div class="pitem"><span class="pk">Stop</span><span class="pv">\${f2(su.stop)}</span></div>
      <div class="pitem"><span class="pk">Target 2R</span><span class="pv">\${f2(su.target)}</span></div>
      <div class="pitem"><span class="pk">Size</span><span class="pv">\${res.contracts} \${SYM}</span></div>
      <div class="pitem"><span class="pk">Result</span><span class="pv \${win?'g':'r'}">\${res.exit} \${usd(res.netUsd)}</span></div>
    </div>
    <div class="detail">Break of the 09:30–09:45 range (\${f2(su.orLow)}–\${f2(su.orHigh)}) with VWAP. Risk the range width; take 2×. \${c.name}.</div>\`;
}

function renderStats(rows){
  const done=rows.filter(r=>r.res);
  const wins=done.filter(r=>r.res.netUsd>0);
  const net=done.reduce((s,r)=>s+r.res.netUsd,0);
  const gw=wins.reduce((s,r)=>s+r.res.netUsd,0), gl=Math.abs(done.filter(r=>r.res.netUsd<=0).reduce((s,r)=>s+r.res.netUsd,0));
  const avgW=wins.length?wins.reduce((s,r)=>s+r.res.grossR,0)/wins.length:0;
  const losers=done.filter(r=>r.res.netUsd<=0); const avgL=losers.length?losers.reduce((s,r)=>s+r.res.grossR,0)/losers.length:0;
  const winPct=done.length?100*wins.length/done.length:0;
  const kpi=(v,l,cls="")=>\`<div class="kpi"><span class="kv \${cls}">\${v}</span><span class="kl">\${l}</span></div>\`;
  $("stats").innerHTML=
    kpi(done.length, "trades")+
    kpi(winPct.toFixed(0)+"%", "win rate", winPct>=50?"g":"")+
    kpi("+"+avgW.toFixed(2)+"R", "avg win", "g")+
    kpi(avgL.toFixed(2)+"R", "avg loss", "r")+
    kpi(usd(net), "net after costs", net>=0?"g":"r")+
    kpi(gl>0?(gw/gl).toFixed(2):"∞", "profit factor", gw/gl>=1?"g":"r");
}

function renderLog(rows){
  $("logsym").textContent="· "+SYM;
  let h="<thead><tr><th>Date</th><th>Call</th><th>Entry</th><th>Stop</th><th>Target</th><th>Exit</th><th class='num'>Net</th></tr></thead><tbody>";
  rows.forEach((r,i)=>{ const sel=i===DAY?" sel":"";
    if(!r.su){ h+=\`<tr class="row\${sel}" data-i="\${i}"><td>\${r.date}</td><td class="muted">no trade</td><td>—</td><td>—</td><td>—</td><td>—</td><td class="num muted">—</td></tr>\`; return; }
    const win=r.res.netUsd>0; h+=\`<tr class="row\${sel}" data-i="\${i}"><td>\${r.date}</td><td class="\${r.su.dir==='long'?'g':'r'}">\${r.su.dir==='long'?'BUY':'SELL'}</td><td>\${f2(r.su.entry)}</td><td>\${f2(r.su.stop)}</td><td>\${f2(r.su.target)}</td><td>\${r.res.exit}</td><td class="num \${win?'g':'r'}">\${usd(r.res.netUsd)}</td></tr>\`;
  });
  $("log").innerHTML=h+"</tbody>";
  [...document.querySelectorAll(".row")].forEach(tr=>tr.onclick=()=>{ DAY=+tr.dataset.i; render(); });
}

function render(){
  const rows=analyze(SYM);
  DAY=Math.max(0,Math.min(DAY,rows.length-1));
  const sess=rows[DAY];
  $("dayDate").textContent=sess.date;
  $("dayIdx").textContent=\` · \${DAY+1}/\${rows.length}\`;
  $("chart").innerHTML=chart(sess);
  renderCall(sess); renderStats(rows); renderLog(rows);
  $("symToggle").innerHTML=Object.keys(CONTRACTS).map(k=>\`<button class="seg\${k===SYM?' on':''}" data-s="\${k}">\${k}<span class="segsub">\${CONTRACTS[k].dataSym}</span></button>\`).join("");
  [...document.querySelectorAll(".seg")].forEach(b=>b.onclick=()=>{ SYM=b.dataset.s; DAY=0; render(); });
}
$("prev").onclick=()=>{ DAY--; render(); };
$("next").onclick=()=>{ DAY++; render(); };
document.addEventListener("keydown",e=>{ if(e.key==="ArrowLeft"){DAY--;render();} if(e.key==="ArrowRight"){DAY++;render();} });
render();
</script>`;
}

const CSS = `
:root{--bg:#f5f6f9;--panel:#ffffff;--panel2:#eef1f6;--bd:#dde2ea;--ink:#151a24;--ink2:#586074;--muted:#8b93a4;--accent:#e8a13a;--bull:#0e9f7e;--bear:#e0483f;--grid:#e9edf3;--sh:0 1px 2px rgba(20,25,40,.06),0 8px 22px rgba(20,25,40,.05);}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0a0d13;--panel:#111621;--panel2:#171d2a;--bd:#232b3a;--ink:#e9edf5;--ink2:#a2acbe;--muted:#6a7488;--accent:#f0ad4e;--bull:#25c79f;--bear:#f56b62;--grid:#1c2432;--sh:0 1px 2px rgba(0,0,0,.5),0 10px 30px rgba(0,0,0,.4);}}
:root[data-theme="dark"]{--bg:#0a0d13;--panel:#111621;--panel2:#171d2a;--bd:#232b3a;--ink:#e9edf5;--ink2:#a2acbe;--muted:#6a7488;--accent:#f0ad4e;--bull:#25c79f;--bear:#f56b62;--grid:#1c2432;--sh:0 1px 2px rgba(0,0,0,.5),0 10px 30px rgba(0,0,0,.4);}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.45}
#app{max-width:1240px;margin:0 auto;padding:20px 16px 56px;display:flex;flex-direction:column;gap:16px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.brand{font-size:19px;font-weight:750;letter-spacing:-.01em;display:flex;align-items:center;gap:9px}
.brand .dot{width:9px;height:9px;border-radius:99px;background:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
.brand .sub{font-size:12px;font-weight:500;color:var(--muted);letter-spacing:0}
.segs{display:flex;gap:6px}
.seg{background:var(--panel);border:1px solid var(--bd);color:var(--ink2);border-radius:10px;padding:7px 14px;font-weight:700;font-size:13px;cursor:pointer;display:flex;flex-direction:column;line-height:1.1;box-shadow:var(--sh)}
.seg .segsub{font-size:9.5px;color:var(--muted);font-weight:500}
.seg.on{background:var(--accent);color:#1a1205;border-color:transparent}.seg.on .segsub{color:#5a4310}
.callcard{background:var(--panel);border:1px solid var(--bd);border-left:4px solid var(--muted);border-radius:14px;padding:14px 18px;box-shadow:var(--sh);display:flex;flex-direction:column;gap:10px}
.callcard.buy{border-left-color:var(--bull)}.callcard.sell{border-left-color:var(--bear)}.callcard.flat{border-left-color:var(--muted)}
.callcard .side{font-size:22px;font-weight:800;letter-spacing:-.01em}
.callcard.buy .side{color:var(--bull)}.callcard.sell .side{color:var(--bear)}
.plan{display:flex;flex-wrap:wrap;gap:8px 22px}
.pitem{display:flex;flex-direction:column}
.pk{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.pv{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}
.pv.g{color:var(--bull)}.pv.r{color:var(--bear)}
.detail{font-size:12.5px;color:var(--ink2)}
.chartwrap{background:var(--panel);border:1px solid var(--bd);border-radius:14px;padding:10px 12px;box-shadow:var(--sh)}
.daynav{display:flex;align-items:center;justify-content:center;gap:14px;margin-bottom:6px}
.nav{width:30px;height:30px;border-radius:8px;border:1px solid var(--bd);background:var(--panel2);color:var(--ink);font-size:16px;cursor:pointer}
.daylabel{font-weight:700;font-variant-numeric:tabular-nums;min-width:180px;text-align:center}
.scroll{overflow-x:auto}
.cv{width:100%;min-width:760px;height:auto;display:block}
.cv .grid{stroke:var(--grid);stroke-width:1}
.cv .axis{fill:var(--muted);font-size:8.5px;font-family:ui-monospace,monospace}
.cv .wk.u,.cv .bd.u{stroke:var(--bull)}.cv .bd.u{fill:var(--bull)}
.cv .wk.d,.cv .bd.d{stroke:var(--bear)}.cv .bd.d{fill:var(--bear)}
.cv .bd{opacity:.9}
.cv .orbox{fill:color-mix(in srgb,var(--accent) 14%,transparent);stroke:var(--accent);stroke-dasharray:3 3;stroke-width:1}
.cv .lvl{stroke-width:1.3}.cv .lvl.entry{stroke:var(--ink2)}.cv .lvl.stop{stroke:var(--bear);stroke-dasharray:4 3}.cv .lvl.tgt{stroke:var(--bull);stroke-dasharray:4 3}
.cv .mk.win{fill:var(--bull)}.cv .mk.loss{fill:var(--bear)}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;color:var(--muted);font-size:11px}
.legend i{display:inline-block;margin-right:5px;vertical-align:middle}
.legend .sw{width:11px;height:11px;border-radius:3px}.legend .sw.or{background:color-mix(in srgb,var(--accent) 30%,transparent);border:1px solid var(--accent)}
.legend .sw.win{background:var(--bull)}.legend .sw.loss{background:var(--bear)}
.legend .ln{width:16px;height:0;border-top:2px solid}.legend .ln.entry{border-color:var(--ink2)}.legend .ln.stop{border-color:var(--bear);border-top-style:dashed}.legend .ln.tgt{border-color:var(--bull);border-top-style:dashed}
.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
@media(max-width:640px){.stats{grid-template-columns:repeat(3,1fr)}}
.kpi{background:var(--panel);border:1px solid var(--bd);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;box-shadow:var(--sh)}
.kv{font-size:19px;font-weight:750;font-variant-numeric:tabular-nums}.kv.g{color:var(--bull)}.kv.r{color:var(--bear)}
.kl{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.logwrap h2{font-size:14px;margin:2px 0 8px}.logwrap .muted{color:var(--muted);font-weight:500}
.log{width:100%;min-width:640px;border-collapse:collapse;font-size:12.5px}
.log th{text-align:left;color:var(--muted);font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;padding:6px 10px;border-bottom:1px solid var(--bd)}
.log td{padding:6px 10px;border-bottom:1px solid var(--bd);font-variant-numeric:tabular-nums}
.log .num{text-align:right}.log .g{color:var(--bull);font-weight:700}.log .r{color:var(--bear);font-weight:700}
.log .row{cursor:pointer}.log .row:hover{background:var(--panel2)}.log .row.sel{background:color-mix(in srgb,var(--accent) 12%,transparent)}
.muted{color:var(--muted)}
.foot{color:var(--muted);font-size:11.5px;line-height:1.6;max-width:80ch}
`;

void main();
