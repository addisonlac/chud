# CHUD Signals — AI share-trading signal bot

An "AI"/rules signal engine for **trading shares of stock**. It reads a stock the
way a Smart-Money / ICT trader does — **liquidity sweeps, market structure, order
blocks and fair-value gaps across the 1-hour and 4-hour charts** — and tells you
when to **buy** or **sell**, how many **shares** to trade, where the **stop** and
**targets** go, and *why*, broken down step by step.

It ships three faces onto the same engine:

1. **CLI analyzer** — `npm run signal NVDA` prints the full breakdown.
2. **Visual overlay** — `npm run signal:overlay` builds an HTML dashboard (annotated
   candles + reasoning) you can open or publish.
3. **TradingView overlay + webhook** — a Pine indicator that draws the same setups
   on your TradingView chart and fires alerts into the bot.

> Not financial advice. Signals come from historical price structure and can be
> wrong. Every trade is sized to a **fixed dollar risk** so a wrong call costs a
> known amount — confirm your own risk before acting.

---

## The method (top-down, the way it's meant to be traded)

The engine never trades in isolation — it works down from the higher timeframe:

1. **4h bias.** 4h market structure (and its EMA) set the *only* direction we take.
   No trading a ranging or opposing 4h — unless the 4h just printed a
   change-of-character (a fresh reversal).
2. **1h structure.** Confirm the entry timeframe agrees (or just flipped to agree).
3. **Trigger.** Two ways in:
   - **Liquidity sweep (stop hunt)** — price runs a *significant* prior high/low then
     closes back through it, trapping breakout traders. Enter **at market** on the
     rejection; stop beyond the swept wick.
   - **Break of structure** — a decisive close through the last swing. Do **not**
     chase the breakout: rest a **limit** back at the **order block / FVG** the move
     came from, stop beyond that zone. No pullback zone → no trade.
4. **Confluence.** Reacting from an order block, an unfilled FVG in the trade
   direction, RSI in a healthy (not exhausted) band, price the right side of the EMAs.
   Each factor adds weight — the **confidence is just the sum of the evidence**.
5. **Risk.** Stop respects volatility (never tighter than 0.6×ATR, so noise can't run
   it). TP1 is a realistic, hittable partial (1.5–2R at the nearest liquidity); TP2
   rides to the next pool. Anything under 1.5R is downgraded to WAIT.
6. **Shares.** Given your dollar risk budget, `shares = risk$ ÷ (entry − stop)`.

Every one of these becomes a scored `ReasoningStep`, so the output is fully
explainable — no black box.

---

## Commands

```bash
npm install

# Analyze one stock now (fixture if present, else keyless Yahoo feed)
npm run signal -- NVDA
npm run signal -- TSLA --risk 500      # size shares to risk $500 to the stop
npm run signal -- NVDA --json          # machine-readable Signal

# Build the visual overlay dashboard (all fixtures → ./overlay.html)
npm run signal:overlay
npm run signal:overlay -- NVDA TSLA --out /tmp/today.html
RISK_USD=1000 npm run signal:overlay   # size the whole board to $1k risk/trade

# Backtest the engine on the past month's top stocks (uses data/fixtures)
npm run signal:backtest

# Rebuild fixtures from raw broker JSON in data/raw/  (see "Data" below)
npm run signal:fixtures

# TradingView → bot webhook bridge
npm run webhook                        # listens on :8787/tradingview
```

Example CLI output:

```
🟢 BUY 80 shares  AMD  @ 516.42   confidence 92%
4h bias: bullish   |   1h structure: bullish
Plan: entry 511.11  stop 507.98  TP1 515.80  TP2 520.60  (1.5R)
Size: 80 shares  ≈ $40889 notional, risking $250 to the stop

Reasoning:
  1. 🟢 4h bias (+25): 4h market structure is bullish.
  2. 🟢 Break of structure (+18): Fresh 1h BOS bullish — price closed above 509.92…
  3. 🟢 Order block (+12): Demand order block at 507.98–511.11 — price is reacting from it now.
  …
```

---

## The visual overlay

`npm run signal:overlay` produces a single self-contained HTML file (inline CSS +
inline SVG, no external assets — publishes cleanly as an Artifact). Each stock gets
a card with:

- the **action pill** (BUY / SELL / WAIT) and a **confidence** meter,
- 4h / 1h **bias** chips and the signal **timestamp**,
- an **annotated 1h candlestick chart** — order block & FVG zones, liquidity pools,
  the sweep / structure-break marker, and the entry / stop / TP lines drawn on price,
- the **share plan** (BUY/SELL N shares, entry, stop, TP1/TP2, R:R, notional, $ risk),
- the **numbered reasoning** with a colored verdict dot and weight badge per step.

Cards show each stock's **most recent actionable signal** (with its timestamp), so an
all-quiet market still shows you what the last real setup looked like.

---

## TradingView integration

See [`tradingview/README.md`](tradingview/README.md). In short:

1. Add `tradingview/chud-signals.pine` as a Pine indicator on a **1h** chart. It
   draws BOS/CHoCH, sweeps, order blocks and FVGs, reads the **4h** bias with
   `request.security`, and prints **BUY/SELL** markers when a sweep agrees with the bias.
2. Create an alert on "Any alert() function call" and paste your webhook URL
   (`http://<host>:8787/tradingview?token=…`).
3. Run `npm run webhook`. On each alert it re-runs the local engine for that symbol,
   logs the full breakdown, and — if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set
   — relays it to Telegram.

---

## Data

The engine needs a 1h and a 4h series per symbol. Access is pluggable
(`src/data/stockData.ts`):

- **`YahooProvider`** — keyless public feed (`query1.finance.yahoo.com`), 4h rolled up
  from 1h. Good for live use on a normal network.
- **`FixtureProvider`** — reproducible JSON candle files in `data/fixtures/`. The
  backtest uses these so results don't depend on a live feed.
- **`defaultProvider()`** — fixture if present, else Yahoo.

Fixtures are built from raw broker responses in `data/raw/<SYMBOL>.json`
(the committed set was pulled from the Robinhood historicals API for NVDA, TSLA, AMD,
PLTR over the past month). Drop more raw files in and run `npm run signal:fixtures`,
or point `YahooProvider` at any ticker to widen the universe.

---

## Backtest — read it as a *recognition* test

`npm run signal:backtest` walks each fixture 1h bar-by-bar (re-deriving 4h from only
the bars seen so far — **no lookahead**), calls the exact live engine, "takes" every
BUY/SELL, and simulates it forward to the stop / targets with partial-profit
management. Results are reported in **R** (multiples of risk).

The point is **not** to claim a magic win rate on a handful of names in one month —
that sample is far too small to prove edge, and anyone who tells you otherwise is
selling something. The point is to show the engine only fires on **disciplined,
well-formed setups**: 4h-aligned, a real liquidity/structure trigger, a pullback
entry into a zone (for breaks), a volatility-aware stop, and ≥1.5R. Widen the fixture
set for a more meaningful read.

---

## File map

```
src/signals/
  types.ts           shared types (Bar, Signal, ReasoningStep, evidence…)
  indicators.ts      EMA / RSI / ATR (pure)
  candles.ts         normalize + 1h→4h session-aware roll-up
  marketStructure.ts swings (fractals), BOS / CHoCH
  liquidity.ts       liquidity pools (equal highs/lows) + sweeps (stop hunts)
  orderBlocks.ts     order-block detection
  fvg.ts             fair value gaps (imbalances)
  sizing.ts          risk-first share position sizing
  engine.ts          the decision engine (combines all of the above)
  format.ts          human-readable rendering
src/data/stockData.ts   pluggable data providers (Yahoo / fixtures)
scripts/
  stock-analyze.ts   CLI analyzer
  stock-backtest.ts  backtest harness
  build-overlay.ts   HTML overlay dashboard generator
  build-fixtures.ts  raw broker JSON → engine fixtures
  tv-webhook.ts      TradingView webhook bridge
tradingview/chud-signals.pine   TradingView overlay indicator
tests/signals.test.ts           deterministic detector + engine tests
```
