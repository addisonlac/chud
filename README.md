# SOL Memecoin Quant Bot

Autonomous trading bot for Solana pump.fun memecoins: scans for new tokens,
enriches them with market data, news sentiment, and whale activity, scores
the trade with Claude, and (optionally) auto-executes via Jupiter under a
fixed set of risk rules.

> ⚠️ **This trades real money if you turn it on.** Memecoin trading is
> extremely high risk — most pump.fun tokens go to zero. Read the
> [Safety defaults](#safety-defaults) section before setting
> `LIVE_TRADING=true`. Nothing here is financial advice.

## Strategy

1. **Scan** — poll pump.fun for newly created tokens every 500ms.
2. **Filter** — only tokens with market cap > $50k move forward.
3. **Rug/safety gate** — reject anything with an un-revoked mint/freeze
   authority, excessive holder/creator concentration, a Token-2022
   transfer-fee extension, or thin liquidity, *before* spending any
   candle/news/AI budget on it.
4. **Market data** — pull 5m / 1h / 1d candles from Birdeye.
5. **Sentiment** — pull recent crypto news and run sentiment analysis with
   Claude Sonnet.
6. **Whale tracking** — track the top 50 watched wallets via Helius
   webhooks in real time (buys/sells, net flow, per token).
7. **Scoring** — merge token + security + candles + sentiment + whale
   activity + portfolio state into one payload and score it with Claude
   Opus.
8. **Execute** — if confidence > 72%, generate a signal and auto-execute a
   buy via Jupiter, sized by the risk manager.

### Risk rules (enforced in `src/risk/riskManager.ts`)

- Max **2%** portfolio risk per trade, sized against a **20%** stop loss
  (fixed-fractional sizing → 10% of portfolio notional per trade).
- Fixed stop loss at **-20%** from entry, protecting the 2%-risk sizing.
- **Trailing stop**: once a position has run up enough that
  `peak price × (1 - TRAILING_STOP_PCT)` clears the fixed stop, the stop
  ratchets up to trail that far below the highest price seen since entry
  (never back down). This is what actually lets winners "ride" — without
  it, a token that pumps 5x and round-trips back down would exit at the
  original -20% loss instead of locking in any of the gain.
- Any position older than **48h** is force-closed regardless of price.
- **0.5 SOL** reserve is never spent, on every trade.

### Rug/safety gate (`src/safety/rugCheck.ts`)

A hard pre-trade filter, checked via Birdeye's token-security data before
any candle/news/AI spend:

- Mint authority must be revoked (`REQUIRE_MINT_AUTHORITY_REVOKED`) — an
  active mint authority means supply can be inflated at will.
- Freeze authority must be revoked (`REQUIRE_FREEZE_AUTHORITY_REVOKED`) —
  an active one means holder accounts can be frozen so they can't sell.
- Top-10 holder concentration capped (`MAX_TOP10_HOLDER_PCT`, default 60%).
- Creator wallet concentration capped (`MAX_CREATOR_PCT`, default 15%).
- Token-2022 transfer-fee extension blocked by default
  (`BLOCK_TOKEN2022_TRANSFER_FEE`) — can silently tax or block trades.
- Minimum liquidity floor (`MIN_LIQUIDITY_USD`, default $10k) — thin
  liquidity means high slippage and easy manipulation.

A failed security lookup fails **closed** (the token is skipped, not
assumed safe) — see the comment on `getTokenSecurity` in
`src/data/birdeye.ts`. These checks catch the mechanical rug vectors; they
don't catch every scam (e.g. a social-engineered "safe-looking" token can
still just be a bad trade) — this is a floor, not a guarantee.

## Safety defaults

The bot defaults to **paper trading** (`LIVE_TRADING=false`): the full
pipeline runs against real market data and produces real signals, but buys
and sells are simulated (via a real Jupiter quote, so fills are realistic)
instead of signed and submitted. Nothing leaves your wallet.

To go live:

1. Run in paper mode first and watch `/status` and the logs for a while.
2. Set `WALLET_PRIVATE_KEY` (base58 secret key) in `.env`.
3. Set `LIVE_TRADING=true`.
4. Fund the wallet with only what you're willing to lose, plus the 0.5 SOL
   reserve.

There is no undo on a live signed transaction. Treat the private key like
what it is — direct, irreversible access to the funds.

## Win/loss ledger + AI confidence calibration

Every closed position (win or loss) is appended to a persisted ledger
(`data/trade-log.json`, via `src/state/tradeLog.ts`), recording entry/exit
price, PnL, exit reason, hold time, and — critically — the AI's confidence
score *at the time the trade was entered*. `GET /stats` computes:

- Win rate, average win/loss %, expectancy, total realized PnL.
- **Brier score**: mean squared error between predicted confidence and
  realized outcome (0 = perfect, 0.25 = no better than always guessing
  50/50, 1 = worst possible). This is the actual answer to "is the AI's
  confidence score informative, or just a confident-sounding number?" —
  check it before trusting the >72% gate with real size.
- **Calibration buckets**: realized win rate grouped by confidence range
  (0.72-0.80, 0.80-0.90, 0.90-1.00). If win rate isn't meaningfully higher
  in the higher-confidence buckets, the model isn't actually discriminating
  good trades from bad ones — it's decoration.

Nothing in the pipeline auto-reacts to a bad Brier score or flat
calibration curve; it's there for you to read (`GET /stats`, or raw
entries via `GET /trades`) and decide whether to keep trusting the gate,
raise `CONFIDENCE_THRESHOLD`, or stop. Stats aren't meaningful below ~30
closed trades — `/stats` flags this via `sampleSizeWarning`.

## Architecture

```
src/
  config/env.ts          env var loading + validation (zod)
  types/index.ts          shared types across the pipeline
  scanners/
    pumpfun.ts             500ms poller for new pump.fun tokens
    filters.ts              market-cap filter (rule #2)
  data/
    birdeye.ts               candles (5m/1h/1d), token overview, top holders, token security
    marketContext.ts          cached SOL price + crypto news (shared across evals)
  safety/rugCheck.ts        hard pre-trade rug/safety gate (rule #3)
  news/newsApi.ts            NewsAPI client
  ai/
    anthropicClient.ts         shared Anthropic SDK client
    sentiment.ts                 Claude Sonnet news sentiment
    scorer.ts                     Claude Opus trade scoring
  whales/
    whaleList.ts                top-50 whale wallet watchlist (persisted)
    heliusWebhook.ts              Helius webhook registration + payload types
    whaleTracker.ts                 rolling per-mint whale buy/sell activity
  risk/riskManager.ts            position sizing, fixed + trailing stop, max-age exit
  notify/telegram.ts             read-only trade notifications (opened/closed/errors)
  execution/
    wallet.ts                     keypair + RPC connection
    jupiterExecutor.ts             Jupiter quote/swap, paper or live
  state/
    portfolio.ts                   SOL balance / portfolio value tracking
    positionStore.ts                open/closed positions + trailing peak, persisted to disk
    tradeLog.ts                      win/loss ledger + Brier score / calibration stats
  pipeline/orchestrator.ts       wires scan -> filter -> safety -> enrich -> score -> execute
  server/webhookServer.ts       Express app: Helius webhook + /status + /positions + /stats + /trades
  index.ts                     entrypoint
```

### Data flow

```
PumpFunScanner (500ms poll)
  -> passesMarketCapFilter (>$50k)
  -> [Birdeye overview + token_security] -> assessTokenSafety (hard gate, fails closed)
  -> [Birdeye candles] + [NewsAPI -> Sentiment(Sonnet)] + [WhaleTracker activity]
  -> merged ScoringPayload (incl. security snapshot)
  -> scoreTrade (Opus) -> confidence, direction
  -> if confidence > 72% && direction == long:
       -> sizePosition (risk manager)
       -> executeBuy (Jupiter, paper|live)
       -> PositionStore.openPosition (peakPriceUsd = entryPriceUsd)
       -> Telegram: "OPENED $SYMBOL ..."

Position monitor (every 30s, independent loop):
  for each open position:
    -> Birdeye current price
    -> PositionStore.updatePeakPrice (trailing-stop input)
    -> checkExitConditions (fixed -20% stop, trailing stop off the peak, OR age >= 48h)
    -> executeSell + PositionStore.closePosition + TradeLog.recordClosedPosition
    -> Telegram: "WIN/LOSS $SYMBOL ..."
```

Concurrency is capped at 3 simultaneous token evaluations
(`src/utils/semaphore.ts`) so the 500ms scan loop can't fan out into an
unbounded number of paid Birdeye/NewsAPI/Anthropic calls.

## Setup

```bash
npm install
cp .env.example .env
# fill in ANTHROPIC_API_KEY, BIRDEYE_API_KEY, HELIUS_API_KEY, NEWSAPI_KEY at minimum
npm run dev
```

Required accounts/keys:

| Service   | Used for                              | Get a key at                          |
|-----------|----------------------------------------|----------------------------------------|
| Anthropic | Sentiment (Sonnet) + scoring (Opus)    | console.anthropic.com                  |
| Birdeye   | Candles, token overview, top holders   | birdeye.so/find-more (API plans)       |
| Helius    | RPC + whale-wallet webhooks            | helius.dev                             |
| NewsAPI   | Crypto news headlines                  | newsapi.org                            |
| Jupiter   | Swap execution                         | no key required (public v6 API)        |

### Seeding the whale watchlist

Rule #5 needs a list of wallet addresses to watch. There's no single
authoritative "top 50 whale" API, so seed `data/whale-watchlist.json`
yourself, e.g.:

```json
[
  { "address": "SomeKnownSmartMoneyWallet...", "rank": 1, "label": "manual" }
]
```

or call `WhaleList.discoverFromTrendingTokens([...mints])` (see
`src/whales/whaleList.ts`) to seed it from large holders of currently
trending tokens as a starting point, then curate by hand. On startup, if a
watchlist exists and `HELIUS_WEBHOOK_URL` + `HELIUS_API_KEY` are set, the
bot registers/updates a Helius enhanced webhook covering those addresses.
`HELIUS_WEBHOOK_URL` must be a publicly reachable URL pointing at this
service's `/webhooks/helius` endpoint (e.g. via a reverse proxy or tunnel
in local dev).

### Connecting Telegram notifications

The bot can post trade activity to a Telegram chat: `OPENED $SYMBOL ...`,
`WIN/LOSS $SYMBOL ...` on close, and execution errors. It's read-only —
there are no bot commands and it can't control trading — see
`src/notify/telegram.ts`. Setup:

1. **Create/reuse a bot token.** Message [@BotFather](https://t.me/BotFather)
   on Telegram, send `/newbot` (or reuse an existing bot you already
   control), and copy the token it gives you (looks like
   `123456789:AAH...`).
2. **Get your chat ID.** Send any message to your new bot first (Telegram
   won't deliver to a chat it hasn't seen you in), then open:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   in a browser — the JSON response includes `"chat":{"id": ...}`. Use that
   number as `TELEGRAM_CHAT_ID`. (For a group chat, add the bot to the
   group first and send a message there instead; group chat IDs are
   negative numbers, which is expected.)
3. Set both in `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456789:AAH...
   TELEGRAM_CHAT_ID=987654321
   ```
4. Restart the bot. You should see the startup message
   (`🤖 Bot started in PAPER mode...`) land in the chat immediately — that
   confirms the token/chat ID are correct before you wait for a real
   signal.

If either var is unset, the notifier just logs a warning once at startup
and no-ops for the rest of the run — trading is unaffected either way, and
nothing about this integration touches `LIVE_TRADING`.

### pump.fun endpoint caveat

`src/scanners/pumpfun.ts` polls pump.fun's unofficial `frontend-api`
endpoint, which is what most community bots use since there's no official
public REST API. It's undocumented and can change or rate-limit without
notice. If it becomes unreliable, swap the scanner's fetch for
[PumpPortal](https://pumpportal.fun)'s free real-time WebSocket API for
new-token events — the rest of the pipeline (`PumpFunToken` shape and
downstream consumers) doesn't need to change.

## Running

```bash
npm run dev      # ts-node style dev run with auto-reload
npm run build    # compile to dist/
npm start        # run compiled output
npm test         # run the unit test suite (pure logic, no network/API keys needed)
npm run typecheck
```

Endpoints exposed on `PORT` (default 3000):

- `GET /health` — liveness + current mode (paper/live)
- `GET /status` — portfolio snapshot, open positions, SOL price
- `GET /positions` — full position history (open + closed)
- `GET /stats` — win rate, expectancy, Brier score, confidence calibration
  buckets (see [Win/loss ledger](#winloss-ledger--ai-confidence-calibration))
- `GET /trades` — raw closed-trade ledger entries
- `POST /webhooks/helius` — Helius whale-wallet webhook receiver (requires
  `Authorization: <HELIUS_WEBHOOK_SECRET>` header)

## Known limitations / next steps

- The pump.fun, Birdeye `token_security`, and Helius webhook payload shapes
  here follow their documented/observed conventions as of this writing;
  verify against a live payload before trusting them in production, since
  all are subject to change without notice.
- The rug/safety gate catches the *mechanical* rug vectors (un-revoked
  authorities, holder concentration, thin liquidity, Token-2022 transfer
  fees). It does not catch every scam — a token can pass every check here
  and still be a bad trade for reasons the AI scorer (or nothing) catches.
  Treat it as a floor, not a guarantee.
- `WhaleTracker`'s USD estimate for whale trades is derived from the SOL
  leg of the swap × cached SOL price — approximate, not exchange-exact.
- No backtesting harness is included; `/stats` gives you real calibration
  data once you've paper-traded long enough to accumulate closed trades
  (30+ recommended), but there's no way to evaluate the strategy against
  historical data before that.
- Latency is REST-polling-class (seconds), not sniper-bot-class
  (sub-100ms via direct Geyser/mempool feeds). By the time this bot acts,
  dedicated latency-optimized bots have often already captured much of a
  new token's early price discovery.
- `npm audit` flags transitive `esbuild`/`uuid` advisories via
  `vitest`→`vite` (dev-only) and `@solana/web3.js`→`jayson` (RPC client).
  Both are upstream ecosystem issues with no non-breaking fix available at
  time of writing; they don't affect this repo's own code.
