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
3. **Market data** — pull 5m / 1h / 1d candles from Birdeye.
4. **Sentiment** — pull recent crypto news and run sentiment analysis with
   Claude Sonnet.
5. **Whale tracking** — track the top 50 watched wallets via Helius
   webhooks in real time (buys/sells, net flow, per token).
6. **Scoring** — merge token + candles + sentiment + whale activity +
   portfolio state into one payload and score it with Claude Opus.
7. **Execute** — if confidence > 72%, generate a signal and auto-execute a
   buy via Jupiter, sized by the risk manager.

### Risk rules (enforced in `src/risk/riskManager.ts`)

- Max **2%** portfolio risk per trade, sized against a **20%** stop loss
  (fixed-fractional sizing → 10% of portfolio notional per trade).
- Stop loss at **-20%** from entry.
- **No take-profit** — winners are allowed to run.
- Any position older than **48h** is force-closed regardless of price.
- **0.5 SOL** reserve is never spent, on every trade.

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

## Architecture

```
src/
  config/env.ts          env var loading + validation (zod)
  types/index.ts          shared types across the pipeline
  scanners/
    pumpfun.ts             500ms poller for new pump.fun tokens
    filters.ts              market-cap filter (rule #2)
  data/
    birdeye.ts               candles (5m/1h/1d), token overview, top holders
    marketContext.ts          cached SOL price + crypto news (shared across evals)
  news/newsApi.ts            NewsAPI client
  ai/
    anthropicClient.ts         shared Anthropic SDK client
    sentiment.ts                 Claude Sonnet news sentiment (rule #4)
    scorer.ts                     Claude Opus trade scoring (rules #6-7)
  whales/
    whaleList.ts                top-50 whale wallet watchlist (persisted)
    heliusWebhook.ts              Helius webhook registration + payload types
    whaleTracker.ts                 rolling per-mint whale buy/sell activity
  risk/riskManager.ts            position sizing, stop loss, max-age exit
  execution/
    wallet.ts                     keypair + RPC connection
    jupiterExecutor.ts             Jupiter quote/swap, paper or live
  state/
    portfolio.ts                   SOL balance / portfolio value tracking
    positionStore.ts                open/closed positions, persisted to disk
  pipeline/orchestrator.ts       wires scan -> filter -> enrich -> score -> execute
  server/webhookServer.ts       Express app: Helius webhook + /status + /positions
  index.ts                     entrypoint
```

### Data flow

```
PumpFunScanner (500ms poll)
  -> passesMarketCapFilter (>$50k)
  -> [Birdeye candles + overview] + [NewsAPI -> Sentiment(Sonnet)] + [WhaleTracker activity]
  -> merged ScoringPayload
  -> scoreTrade (Opus) -> confidence, direction
  -> if confidence > 72% && direction == long:
       -> sizePosition (risk manager)
       -> executeBuy (Jupiter, paper|live)
       -> PositionStore.openPosition

Position monitor (every 30s, independent loop):
  for each open position:
    -> Birdeye current price
    -> checkExitConditions (stop loss -20% OR age >= 48h)
    -> executeSell + PositionStore.closePosition
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
- `POST /webhooks/helius` — Helius whale-wallet webhook receiver (requires
  `Authorization: <HELIUS_WEBHOOK_SECRET>` header)

## Known limitations / next steps

- The pump.fun and Helius webhook payload shapes here follow their
  documented/observed conventions as of this writing; verify against a live
  payload before trusting it in production, since both are subject to
  change without notice.
- `WhaleTracker`'s USD estimate for whale trades is derived from the SOL
  leg of the swap × cached SOL price — approximate, not exchange-exact.
- No backtesting harness is included; the risk rules and scoring prompt are
  the two levers worth tuning before running with real size.
- `npm audit` flags transitive `esbuild`/`uuid` advisories via
  `vitest`→`vite` (dev-only) and `@solana/web3.js`→`jayson` (RPC client).
  Both are upstream ecosystem issues with no non-breaking fix available at
  time of writing; they don't affect this repo's own code.
