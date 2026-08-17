# CHUD Futures — TradingView add-on setup (automated futures, no 24/7 server)

This runs the strategy **entirely on TradingView** and hands each trade to a
**futures execution bridge** that talks to your broker. Nothing of yours has to
run 24/7 — TradingView evaluates the Pine strategy on its servers and only fires
a webhook when a trade actually triggers.

```
 TradingView chart (1m MES/MNQ)
   └─ chud-futures.pine  (strategy runs on TV servers)
        └─ Alert  ──webhook JSON──▶  Execution bridge (TradersPost / PickMyTrade)
                                        └─ Futures broker (Tradovate / NinjaTrader)  ──▶  fill
```

Why a bridge? As of 2026 TradingView still does **not** route arbitrary strategy
orders to most brokers — native one-click trading exists only for a short list of
integrated brokers. For automated **futures**, the standard path everyone uses is
TradingView **alert → webhook → bridge → Tradovate/NinjaTrader**. The bridge is
the piece that authenticates to your broker and places the order.

---

## What you need

- **TradingView Pro, Pro+, or Premium** — webhook alerts are a paid-tier feature.
- A **futures broker** the bridge supports (Tradovate is the common one; NinjaTrader also works).
- An **execution bridge** account:
  - **TradersPost** — multi-broker, futures support, paper mode, clean logs (recommended).
  - **PickMyTrade** — futures-focused, flat fee, popular for Tradovate.
  - Others: WunderTrading, 3Commas, Finestel.
- Start on the broker's / bridge's **paper (demo) account**. Do not skip this.

---

## 1. Add the strategy to a chart

1. TradingView → **Pine Editor** → paste `tradingview/chud-futures.pine` → **Add to chart**.
2. Open a **1-minute** chart of your contract (e.g. **MES1!** or **MNQ1!**).
3. Open the strategy **Settings** and set:
   - **Broker symbol** — the exact ticker your bridge expects (e.g. `MES1!`, or an
     explicit month like `MESU2026`; explicit months avoid rollover surprises).
   - **$ per index point** — MES `5`, ES `50`, MNQ `2`, NQ `20`.
   - **Risk $ per trade** — position size is derived from this and the stop distance.
   - Leave the rest on the **safe** defaults (15m bias, 09:30–10:30 ET window,
     zone confluence on, 2 trades/session, stop-for-the-day-after-a-loss on).
4. Check the **Strategy Tester** tab to see its trades/stats on your data.

## 2. Connect the bridge (TradersPost example)

1. In TradersPost, create a **Strategy** and connect your **broker** (paper first).
2. Copy the strategy's **webhook URL** — it looks like
   `https://webhooks.traderspost.io/trading/webhook/<uuid>/<password>`.

## 3. Create the alert

1. On the chart, click the strategy → **Create Alert** (or **⏰ → Condition: CHUD Futures**).
2. **Condition:** the strategy itself, triggering on **Order fills only**.
3. **Notifications → Webhook URL:** paste your bridge webhook URL.
4. **Message:** set it to exactly:
   ```
   {{strategy.order.alert_message}}
   ```
   The strategy already builds the broker-ready JSON per order. On an **entry** it sends:
   ```json
   {"ticker":"MES1!","action":"buy","quantity":4,"price":7785.25,
    "stopLoss":{"type":"stop","stopPrice":7782.75},
    "takeProfit":{"limitPrice":7787.75}}
   ```
   (`action` is `buy`/`sell`; the bridge places the bracket. On the managed exit it
   sends `{"ticker":"MES1!","action":"exit"}` as a flatten safety.)
5. Save. That's it — TradingView now fires the webhook on each signal; the bridge fills it.

---

## Sanity checklist before going live

- Ran it on the **paper** broker for enough sessions to trust the plumbing end-to-end.
- Verified the **broker symbol** and **$/point** are right for your contract (wrong
  point value = wrong size).
- Confirmed the bridge’s **contract/rollover** mapping matches what you intend to trade.
- Set position size so the **worst-case per-trade loss is money you can lose.**

## Honest performance note

The `safe` preset scored **71% win in-sample** on one week but **~48% out-of-sample**
across four unseen weeks (`npm run futures:validate`) — the 71% was largely overfit.
Out-of-sample it stayed net-positive (profit factor ~1.4) on a **tiny sample**. This
is a disciplined signal engine, **not** a proven money-maker. Trade it on paper,
judge it by profit factor / expectancy over **many** weeks, and risk real money only
after it earns your trust. Not financial advice.
