# CHUD Signals — AI share-trading signal bot

An "AI"/rules signal engine for **trading shares of stock** on the **1-minute
and 15-minute charts**. It reads a stock the way a Smart-Money / ICT intraday
trader does — **liquidity sweeps, market structure, order blocks and fair-value
gaps**, with the **15-minute** chart setting bias and the **1-minute** chart
timing the entry — and tells you when to **buy** or **sell**, how many **shares**
to trade, where the **stop** and **targets** go, and *why*, broken down step by
step. Signals only fire inside the session's **high-liquidity window** (default
the NY morning kill-zone), because a 1-minute entry outside it is mostly noise.

**TradingView is the chart/alert surface.** TradingView has no keyless public
data API, so it isn't a candle feed — instead the Pine overlay draws the same
setups on your 1-minute chart and fires alerts into the bot; a keyless feed
(Yahoo) supplies the candles the engine reasons over.

It ships three faces onto the same engine:

1. **CLI analyzer** — `npm run signal NVDA` prints the full breakdown.
2. **Visual overlay** — `npm run signal:overlay` builds an HTML dashboard (annotated
   candles + reasoning) you can open or publish.
3. **TradingView overlay + webhook** — a Pine indicator that draws the same setups
   on your 1-minute chart and fires alerts into the bot.

> Not financial advice. Signals come from historical price structure and can be
> wrong. Every trade is sized to a **fixed dollar risk** so a wrong call costs a
> known amount — confirm your own risk before acting.

---

## The method (top-down, the way it's meant to be traded)

The engine never trades in isolation — it works down from the higher timeframe:

1. **15m bias.** 15-minute market structure (and its EMA) set the *only* direction
   we take. No trading a ranging or opposing 15m — unless the 15m just printed a
   change-of-character (a fresh reversal).
2. **1m structure.** Confirm the entry timeframe agrees (or just flipped to agree).
3. **Session.** The entry bar must fall inside a trading window (default **09:30–12:00
   ET**, Mon–Fri). Outside it, stand aside — thin-liquidity 1m setups are traps.
4. **Trigger.** Two ways in:
   - **Liquidity sweep (stop hunt)** — price runs a *significant* prior high/low then
     closes back through it, trapping breakout traders. Enter **at market** on the
     rejection; stop beyond the swept wick.
   - **Break of structure** — a decisive close through the last swing. Do **not**
     chase the breakout: rest a **limit** back at the **order block / FVG** the move
     came from, stop beyond that zone. No pullback zone → no trade.
5. **Confluence.** Reacting from an order block, an unfilled FVG in the trade
   direction, RSI in a healthy (not exhausted) band, price the right side of the EMAs.
   Each factor adds weight — the **confidence is just the sum of the evidence**.
6. **Risk.** Stop respects volatility (never tighter than 0.6×ATR, so noise can't run
   it). TP1 is a realistic, hittable partial (1.5–2R at the nearest liquidity); TP2
   rides to the next pool. Anything under 1.5R is downgraded to WAIT.
7. **Shares.** Given your dollar risk budget, `shares = risk$ ÷ (entry − stop)`.

Every one of these becomes a scored `ReasoningStep`, so the output is fully
explainable — no black box.

---

## Commands

```bash
npm install

# Analyze one stock now (fixture if present, else keyless Yahoo 1m/15m feed)
npm run signal -- NVDA
npm run signal -- TSLA --risk 500      # size shares to risk $500 to the stop
npm run signal -- NVDA --json          # machine-readable Signal

# Build the visual overlay dashboard (all fixtures → ./overlay.html)
npm run signal:overlay
npm run signal:overlay -- NVDA TSLA --out /tmp/today.html
RISK_USD=1000 npm run signal:overlay   # size the whole board to $1k risk/trade

# Backtest the engine on the committed fixtures (1m walk, 15m bias, no lookahead)
npm run signal:backtest

# Regenerate the committed SYNTHETIC demo fixtures (deterministic, offline)
npm run signal:demo-fixtures

# Build REAL fixtures from raw 1-minute broker JSON in data/raw/  (see "Data")
npm run signal:fixtures

# TradingView → bot webhook bridge
npm run webhook                        # listens on :8787/tradingview

# --- Futures mode (ES/MES on SPX, NQ/MNQ on NDX) ---
npm run futures -- MES                 # analyze now, sized in CONTRACTS
npm run futures -- MNQ --risk 500
npm run futures:fixtures               # build index fixtures from data/raw-index/
npm run futures:backtest               # baseline vs. filtered vs. safe, R + $
npm run futures:sweep                  # tune: win rate across a preset ladder
npm run futures:hud                    # render futures-hud.html (trades on charts)
```

Example CLI output:

```
🟢 BUY 80 shares  AMD  @ 158.42   confidence 92%
15m bias: bullish   |   1m structure: bullish
Plan: entry 158.11  stop 157.74  TP1 158.66  TP2 159.20  (1.5R)
Size: 80 shares  ≈ $12648 notional, risking $250 to the stop

Reasoning:
  1. 🟢 15m bias (+25): 15m market structure is bullish.
  2. 🟢 Liquidity sweep (+30): Sell-side liquidity swept at 157.74 then closed back…
  3. 🟢 Order block (+12): Demand order block at 157.74–158.11 — price is reacting from it now.
  4. 🟢 Session: Entry bar is inside the 09:30–12:00 EDT trading window — where 1m flow is real.
  …
```

---

## Futures mode (ES/MES, NQ/MNQ)

The same engine trades index futures. Index futures track their cash index
point-for-point, so the engine reasons over the **cash index** as the price
series — **SPX** for ES/MES, **NDX** for NQ/MNQ — and sizes in whole
**contracts** to a fixed dollar risk (`contracts = risk$ ÷ (stopPoints ×
pointValue)`). The contract registry (`src/signals/instruments.ts`) carries the
point value and tick for each: MES $5/pt, ES $50/pt, MNQ $2/pt, NQ $20/pt.

**Discipline layer (`src/signals/sessionGuard.ts`).** A 1-minute model's biggest
leak is *overtrading* — re-firing the same idea into a session that's grinding
against it. The `SessionGuard` enforces prop-desk discipline on top of the raw
signals: a **confidence floor**, a **per-session trade cap**, a **cooldown after
a loss**, and a **two-loss-in-a-row daily lockout**. `npm run futures:backtest`
runs *baseline* (raw signals) and *filtered* (guard on) side by side so you can
see the trade-off: the guard raises win rate and profit factor and cuts trade
count hard — it's insurance for chop, and it gives some upside back in a strongly
trending week.

**The `safe` preset (win-rate tuned).** On top of the guard, a stricter preset
(`safePreset()` in `futuresStrategy.ts`) trades for win rate and consistency:
**with-trend only**, **must react from an order block / FVG**, confidence ≥ 0.85,
**bank the first target at 1R**, **opening drive only (09:30–10:30 ET)**, one loss
ends the day. `npm run futures:sweep` shows how each knob moves win rate; `npm run
futures:backtest` runs baseline / filtered / safe side by side.

> On the validation week (Aug 10–14, MES+MNQ, $250 risk): baseline 35.8% win →
> filtered 47.8% → **safe 71.4%** (14 trades, +5.51R, +$1,240, PF 2.38,
> +0.39R/trade). These preset values were chosen **in-sample**.
>
> **Out-of-sample check** (`npm run futures:validate`, frozen preset on 4 earlier
> weeks it never saw): win rate **48.4%** (31 trades), +6.45R, +$1,592, PF 1.40 —
> weeks ranged 22% → 60% win. **The 71% did NOT hold out-of-sample** — it was
> largely overfit. The approach stayed net-positive across unseen weeks (PF 1.40
> on a tiny sample), but win rate is the wrong target: chasing it overfits.
> Judge this by expectancy / profit factor over many weeks, not one week's win %.

**Visual HUD.** `npm run futures:hud` renders `futures-hud.html` — a self-contained
page drawing the safe preset's trades on the real 1m SPX/NDX charts (BUY/SELL
markers coloured by win/loss, entry/stop/target on price, per-day + week stats).

**Live automation (TradingView add-on).** `tradingview/chud-futures.pine` is a Pine
**strategy** that runs the safe preset on TradingView's servers and fires
broker-ready webhook alerts to a futures execution bridge (TradersPost /
PickMyTrade → Tradovate / NinjaTrader) — so it trades futures without any 24/7
server of your own. Full setup in [`tradingview/FUTURES-SETUP.md`](tradingview/FUTURES-SETUP.md).

**Walk-forward.** `npm run futures:walkforward` picks the preset using only past
weeks and trades the next — the honest, no-peeking estimate of live performance.

**Data.** Futures fixtures are built from real cash-index minute bars
(`npm run futures:fixtures`, reading `data/raw-index/`). At runtime `npm run
futures -- MES` uses the same default provider (fixture, else keyless feed).

## The visual overlay

`npm run signal:overlay` produces a single self-contained HTML file (inline CSS +
inline SVG, no external assets — publishes cleanly as an Artifact). Each stock gets
a card with:

- the **action pill** (BUY / SELL / WAIT) and a **confidence** meter,
- 15m / 1m **bias** chips and the signal **timestamp**,
- an **annotated 1m candlestick chart** — order block & FVG zones, liquidity pools,
  the sweep / structure-break marker, and the entry / stop / TP lines drawn on price,
- the **share plan** (BUY/SELL N shares, entry, stop, TP1/TP2, R:R, notional, $ risk),
- the **numbered reasoning** with a colored verdict dot and weight badge per step.

Cards show each stock's **most recent actionable signal** (with its timestamp), so an
all-quiet market still shows you what the last real setup looked like.

---

## TradingView integration

See [`tradingview/README.md`](tradingview/README.md). In short:

1. Add `tradingview/chud-signals.pine` as a Pine indicator on a **1-minute** chart. It
   draws BOS/CHoCH, sweeps, order blocks and FVGs, reads the **15m** bias with
   `request.security`, gates to your **session window** (default 09:30–12:00 ET), and
   prints **BUY/SELL** markers when an in-session sweep agrees with the bias.
2. Create an alert on "Any alert() function call" and paste your webhook URL
   (`http://<host>:8787/tradingview?token=…`).
3. Run `npm run webhook`. On each alert it re-runs the local engine for that symbol,
   logs the full breakdown, and — if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set
   — relays it to Telegram.

---

## Data

The engine needs a **1-minute** entry series and a **15-minute** bias series per
symbol. Access is pluggable (`src/data/stockData.ts`):

- **`YahooProvider`** — keyless public feed (`query1.finance.yahoo.com`): native 1m
  (≈7-day history) and 15m (≈60-day) bars. Good for live use on a normal network.
  *(TradingView has no keyless historical API — it's the chart/alert surface, not a
  candle feed. Yahoo supplies the candles.)*
- **`FixtureProvider`** — reproducible JSON candle files in `data/fixtures/` (each
  carries an `ltf` 1m series and an `htf` 15m series). The backtest uses these so
  results don't depend on a live feed.
- **`defaultProvider()`** — fixture if present, else Yahoo.

**The committed fixtures are SYNTHETIC demo data** (`source: "synthetic-intraday-demo"`),
generated deterministically by `npm run signal:demo-fixtures`. They exist only so the
backtest and tests run out-of-the-box in any environment; they are **not real market
data and prove nothing about edge.** For a real backtest, drop real 1-minute broker
JSON into `data/raw/<SYMBOL>.json` and run `npm run signal:fixtures` (it keeps only
regular-hours, non-interpolated bars and rolls the 1m series up to 15m), or point
`YahooProvider` at any ticker for live analysis.

---

## Backtest — read it as a *recognition* test

`npm run signal:backtest` walks each fixture **1m bar-by-bar** (re-deriving the 15m
bias from only the bars seen so far — **no lookahead**), calls the exact live engine,
"takes" every BUY/SELL, and simulates it forward to the stop / targets with
partial-profit management. Results are reported in **R** (multiples of risk).

The point is **not** to claim a magic win rate — the committed fixtures are synthetic
and the sample is tiny, so anyone reading edge into it is fooling themselves. The
point is to show the engine only fires on **disciplined, well-formed setups**:
15m-aligned, in-session, a real liquidity/structure trigger, a pullback entry into a
zone (for breaks), a volatility-aware stop, and ≥1.5R. Point it at real fixtures for a
meaningful read.

---

## File map

```
src/signals/
  types.ts           shared types (Bar, Signal, ReasoningStep, evidence…)
  indicators.ts      EMA / RSI / ATR (pure)
  candles.ts         normalize + 1m→15m session-aware roll-up
  session.ts         intraday session / kill-zone filter (time-of-day gate)
  sessionGuard.ts    discipline layer (confidence floor, trade cap, cooldown, lockout)
  instruments.ts     futures contract registry (ES/MES/NQ/MNQ point values + ticks)
  futuresStrategy.ts shared futures walk + trade resolution + presets (safe/filtered)
  marketStructure.ts swings (fractals), BOS / CHoCH
  liquidity.ts       liquidity pools (equal highs/lows) + sweeps (stop hunts)
  orderBlocks.ts     order-block detection
  fvg.ts             fair value gaps (imbalances)
  sizing.ts          risk-first sizing (shares + futures contracts)
  engine.ts          the decision engine (combines all of the above)
  format.ts          human-readable rendering
src/data/stockData.ts   pluggable data providers (Yahoo 1m/15m / fixtures)
scripts/
  stock-analyze.ts     CLI analyzer (shares)
  futures-analyze.ts   CLI analyzer (futures contracts)
  stock-backtest.ts    backtest harness (1m walk, 15m bias)
  futures-backtest.ts  futures backtest — baseline vs. filtered vs. safe, R + $
  futures-sweep.ts     in-sample preset ladder to tune win rate
  futures-validate.ts  out-of-sample test: frozen preset across unseen weeks
  build-futures-hud.ts HUD: trades drawn on the real 1m charts → futures-hud.html
  build-futures-fixtures.ts  cash-index minute JSON → engine fixtures (SPX/NDX)
  build-overlay.ts     HTML overlay dashboard generator
  build-fixtures.ts    raw 1m broker JSON → engine fixtures (1m + rolled 15m)
  gen-demo-fixtures.ts deterministic SYNTHETIC intraday fixture generator
  tv-webhook.ts        TradingView webhook bridge
tradingview/chud-signals.pine   TradingView overlay indicator (1m entry / 15m bias)
tests/signals.test.ts           deterministic detector + engine + session tests
```
