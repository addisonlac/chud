# CHUD Signals — TradingView overlay

`chud-signals.pine` is a Pine v5 **overlay indicator** that ports the bot's engine
(`src/signals`) onto a TradingView chart. It draws, right on price:

- **BOS / CHoCH** structure labels (continuation vs. reversal)
- **Liquidity sweeps** — stop-hunt wicks through prior swing highs/lows
- **Order blocks** — the origin candle of a structure break (demand/supply zones)
- **Fair value gaps** — 3-bar imbalances
- **BUY / SELL markers** — a liquidity sweep that agrees with the **4h bias**

It reads the higher timeframe with `request.security`, so put it on a **1-hour
chart** and it takes the **4h** as bias automatically.

## Install

1. TradingView → **Pine Editor** → paste the contents of `chud-signals.pine`.
2. **Add to chart**. Open a **1h** chart of the stock you want (e.g. `NVDA`).
3. Tune inputs if you like: swing strength, bias timeframe (default `240` = 4h),
   bias EMA length, and which zones to draw.

## Wire the alerts to the bot (optional)

The indicator emits a JSON payload on each BUY/SELL, ready for a webhook:

```json
{"source":"chud-signals","symbol":"NVDA","action":"BUY","price":225.3,"tf":"60"}
```

1. Start the bridge:  `npm run webhook`  (listens on `:8787`, set `WEBHOOK_SECRET`
   and `PORT` as needed; set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` to relay).
2. Expose it publicly (e.g. a tunnel) so TradingView can reach it.
3. On the chart: **Alert → Condition:** *CHUD Signals* → *Any alert() function call*.
   **Notifications → Webhook URL:** `http://<host>:8787/tradingview?token=<secret>`.
4. On each alert the bridge re-runs the local engine for that symbol so the
   notification carries the full step-by-step reasoning and the **share size**, not
   just "BUY".

> The Pine marker logic mirrors the TypeScript engine's concepts but is a separate
> implementation — treat TradingView as the chart/alerting surface and the bot
> (`npm run signal`) as the source of the full reasoning, risk plan, and share sizing.
