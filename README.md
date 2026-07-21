# SOL Memecoin Quant Bot

Autonomous trading bot for Solana pump.fun memecoins: scans for new tokens,
enriches them with market data, news sentiment, and whale activity, scores
the trade with a free-tier Groq-hosted LLM, and (optionally) auto-executes
via Jupiter under a fixed set of risk rules.

> **Runs entirely on free-tier services.** Groq (AI scoring/sentiment) and
> the public Solana RPC (whale tracking) require no payment method. See
> [Free-tier tradeoffs](#free-tier-tradeoffs) for what that costs you in
> quality/reliability versus the paid alternatives (Anthropic, Helius).

> ⚠️ **This trades real money if you turn it on.** Memecoin trading is
> extremely high risk — most pump.fun tokens go to zero. Read the
> [Safety defaults](#safety-defaults) section before setting
> `LIVE_TRADING=true`. Nothing here is financial advice.

## Strategy

1. **Scan** — poll pump.fun for newly created tokens every 200ms.
2. **Filter** — only tokens with market cap > $50k move forward.
3. **Rug/safety gate** — reject anything with an un-revoked mint/freeze
   authority, excessive holder/creator concentration, a Token-2022
   transfer-fee extension, or thin liquidity, *before* spending any
   candle/news/AI budget on it.
4. **Market data** — pull 5m / 1h / 1d candles from Birdeye.
5. **Sentiment** — pull recent crypto news and run sentiment analysis with
   a free-tier Groq-hosted model (default: Llama 3.1 8B).
6. **Whale tracking** — track the top 50 watched wallets by polling the
   free public Solana RPC (buys/sells, net flow, per token).
7. **Scoring** — merge token + security + candles + sentiment + whale
   activity + portfolio state into one payload and score it with a
   free-tier Groq-hosted model (default: Llama 3.3 70B).
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

## Free-tier tradeoffs

This runs entirely on services with no payment method required — useful if
you don't want to put a card on file, but it's a real trade against
quality and reliability, not a free lunch:

- **AI scoring/sentiment (Groq instead of Anthropic).** The architecture
  is unchanged (an LLM scores every trade via forced tool-calling), but
  the model behind it is a much smaller open-weight model than Claude
  Opus/Sonnet. For a nuanced, multi-factor judgment call like "should I
  buy this memecoin," that's a meaningful capability gap, not a rounding
  error — treat the AI confidence score with *more* skepticism than
  before, not less, until `/stats` shows real calibration data. Groq's
  free tier also has request-rate caps; if you see frequent scoring
  failures in the logs, you're likely hitting them.
- **Whale tracking (public Solana RPC polling instead of Helius
  webhooks).** Helius pushed whale transactions to this bot in real time.
  Polling the free public RPC (default every 60s, see
  `WHALE_POLL_INTERVAL_MS`) means whale activity data lags by up to that
  interval, and the public endpoint is shared across everyone using it —
  under load it will silently drop or delay data rather than erroring
  loudly. See [Whale tracking](#whale-tracking-free-public-solana-rpc)
  below for the full tradeoff.

If either of these becomes the bottleneck once you have real `/stats`
data, the fix is a config change, not a rewrite: point `SOLANA_RPC_URL` at
a paid RPC provider for faster/more reliable whale data, or swap
`GROQ_BASE_URL`/model names for a stronger paid provider once you've
decided the strategy is worth paying for.

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
    pumpfun.ts             200ms poller for new pump.fun tokens
    filters.ts              market-cap filter (rule #2)
  data/
    birdeye.ts               candles (5m/1h/1d), token overview, top holders, token security
    marketContext.ts          cached SOL price + crypto news (shared across evals)
  safety/rugCheck.ts        hard pre-trade rug/safety gate (rule #3)
  news/newsApi.ts            NewsAPI client
  ai/
    groqClient.ts               shared Groq (OpenAI-compatible) tool-calling helper
    sentiment.ts                 free-tier LLM news sentiment
    scorer.ts                     free-tier LLM trade scoring
  whales/
    whaleList.ts                top-50 whale wallet watchlist (persisted)
    solanaWhalePoller.ts          polls free public Solana RPC per watched wallet
    whaleTracker.ts                 rolling per-mint whale buy/sell activity
  risk/riskManager.ts            position sizing, fixed + trailing stop, max-age exit
  notify/
    telegram.ts                   push notifications (opened/closed/errors)
    telegramCommands.ts             /status /stats /positions /help (long-polling, owner-only)
  execution/
    wallet.ts                     keypair + RPC connection
    jupiterExecutor.ts             Jupiter quote/swap, paper or live
  state/
    portfolio.ts                   SOL balance / portfolio value tracking
    positionStore.ts                open/closed positions + trailing peak, persisted to disk
    tradeLog.ts                      win/loss ledger + Brier score / calibration stats
  pipeline/orchestrator.ts       wires scan -> filter -> safety -> enrich -> score -> execute
  server/webhookServer.ts       Express app: /status + /positions + /stats + /trades
  index.ts                     entrypoint
```

### Data flow

```
PumpFunScanner (200ms poll)
  -> passesMarketCapFilter (>$50k)
  -> [Birdeye overview + token_security] -> assessTokenSafety (hard gate, fails closed)
  -> [Birdeye candles] + [NewsAPI -> Sentiment(Groq)] + [WhaleTracker activity]
  -> merged ScoringPayload (incl. security snapshot)
  -> scoreTrade (Groq) -> confidence, direction
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
(`src/utils/semaphore.ts`) so the 200ms scan loop can't fan out into an
unbounded number of Birdeye/NewsAPI/Groq calls — this matters even more
on Groq's free tier, which has meaningfully tighter rate limits than a
paid Anthropic account would.

## Setup

```bash
npm install
cp .env.example .env
# fill in GROQ_API_KEY, BIRDEYE_API_KEY, NEWSAPI_KEY at minimum
npm run dev
```

Required accounts/keys:

| Service | Used for                                   | Get a key at                     | Payment method required? |
|---------|----------------------------------------------|-----------------------------------|---------------------------|
| Groq    | Sentiment + trade scoring (free-tier LLM)     | console.groq.com                  | No                        |
| Birdeye | Candles, token overview, token security, top holders | birdeye.so/find-more (API plans) | Depends on plan/volume |
| NewsAPI | Crypto news headlines                         | newsapi.org                       | No (free tier)            |
| Jupiter | Swap execution                                | no key required (public v6 API)   | No                        |
| Solana RPC | Whale wallet polling, wallet balance, tx submission | none — public endpoint by default | No                    |

### Whale tracking (free public Solana RPC)

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
trending tokens as a starting point, then curate by hand.

On startup, if a watchlist exists, `SolanaWhalePoller`
(`src/whales/solanaWhalePoller.ts`) starts polling `SOLANA_RPC_URL` for
each watched wallet — no webhook registration, no public URL needed. It
diffs each wallet's SPL token balances before/after each new transaction
to infer buy/sell direction and size, staggering requests across
`WHALE_POLL_INTERVAL_MS` (default 60s) to stay under the free public
endpoint's rate limits. This is meaningfully slower and less reliable than
Helius's real-time pre-parsed webhook events were — see
[Free-tier tradeoffs](#free-tier-tradeoffs). If you already have (or later
get) a paid RPC endpoint (Helius, Triton, etc.), just point
`SOLANA_RPC_URL` at it — no code changes needed, and polling will
naturally get faster/more reliable since the rate limits ease up.

### Connecting Telegram

The bot posts trade activity to a Telegram chat — `OPENED $SYMBOL ...`,
`WIN/LOSS $SYMBOL ...` on close, and execution errors (`src/notify/telegram.ts`)
— and separately responds to commands you send it
(`src/notify/telegramCommands.ts`):

| Command      | Replies with                                    |
|--------------|--------------------------------------------------|
| `/status`    | Mode, SOL balance, total value, open positions    |
| `/stats`     | Win rate, expectancy, Brier score, calibration warning |
| `/positions` | Entry price + stop for each open position         |
| `/help`      | This list                                         |

Commands are read-only status queries — there's no `/pause`, `/resume`, or
manual `/buy`/`/sell`; the bot can't be remote-controlled via Telegram,
only observed. Command handling uses long-polling
(`getUpdates`), not a webhook, so it works from a laptop behind NAT with
no public URL or tunnel needed. Every incoming message is checked against
`TELEGRAM_CHAT_ID` and silently ignored if it's from any other chat —
even if someone finds your bot's username and messages it, it won't
respond or reveal that it's connected to anything. Setup:

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

If either var is unset, both the notifier and the command listener just
log a warning once at startup and no-op for the rest of the run — trading
is unaffected either way, and nothing about this integration touches
`LIVE_TRADING`.

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

## Known limitations / next steps

- The pump.fun and Birdeye `token_security` payload shapes here follow
  their documented/observed conventions as of this writing; verify against
  a live payload before trusting them in production, since both are
  subject to change without notice.
- Groq's free-tier models are a real capability gap versus Claude
  Opus/Sonnet for this kind of judgment call, and the free tier has
  request-rate caps that a paid Anthropic account wouldn't. See
  [Free-tier tradeoffs](#free-tier-tradeoffs).
- Whale tracking polls the free public Solana RPC instead of receiving
  real-time Helius webhooks, so activity data lags by up to
  `WHALE_POLL_INTERVAL_MS` and can be unreliable under the shared
  endpoint's rate limits. Its balance-diff parsing
  (`solanaWhalePoller.ts`) is also a heuristic — it picks the
  largest-magnitude token balance change per transaction, which can
  misread complex multi-hop swap routes.
- The rug/safety gate catches the *mechanical* rug vectors (un-revoked
  authorities, holder concentration, thin liquidity, Token-2022 transfer
  fees). It does not catch every scam — a token can pass every check here
  and still be a bad trade for reasons the AI scorer (or nothing) catches.
  Treat it as a floor, not a guarantee.
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
