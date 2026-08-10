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

1. **Scan** — stream pump.fun tokens graduating to a DEX (`SCANNER_SOURCE=
   graduated`, default — the tokens with real Birdeye data that can actually
   be evaluated), brand-new creations (`pumpportal`), or the HTTP endpoint
   (`pumpfun`), all via PumpPortal's free WebSocket.
2. **Filter** — only tokens above `MIN_MARKET_CAP_USD` move forward.
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
8. **Execute** — if confidence > `CONFIDENCE_THRESHOLD`, generate a signal
   and auto-execute a buy via Jupiter, sized by the risk manager.

> **Default posture is permissive paper data-collection.** The shipped
> defaults (`SCANNER_SOURCE=graduated`, `MIN_MARKET_CAP_USD=25000`,
> `CONFIDENCE_THRESHOLD=0.60`, `MIN_LIQUIDITY_USD=4000`) are deliberately
> loose so the bot actually takes trades and `/stats` accumulates real
> calibration data. The point is *exposure to learn from*, not paper profit.
> The hard rug checks (authorities revoked, holder/creator concentration)
> stay strict. Tighten the gates (e.g. `50000` / `0.72`) before going live.

### Risk rules (enforced in `src/risk/riskManager.ts`)

- Max **2%** portfolio risk per trade, sized against a **20%** stop loss
  (fixed-fractional sizing → 10% of portfolio notional per trade).
- Fixed stop loss at **-20%** from entry, protecting the 2%-risk sizing.
- **Partial take-profit** (`TAKE_PROFIT_PCT` / `TAKE_PROFIT_SIZE_PCT`,
  default +60% / sell 50%): once a position hits the target, half the size
  is sold to bank the gain and the rest keeps riding. This adds the win-side
  asymmetry the original "no take-profit" rules lacked — backtests of the
  old rules had negative expectancy because stops took full losses while
  winners got clipped small by the max-hold clock.
- **Breakeven floor** (`BREAKEVEN_TRIGGER_PCT`, default +30%): after banking
  partial profit — or after a large run-up — the floor stop rises to
  breakeven, so a winner that reverses can no longer become a full loss.
- **Trailing stop**: trails `peak × (1 - TRAILING_STOP_PCT)` below the
  highest price since entry (never back down), letting winners "ride." It
  stays **loose** (default 25%) until partial profit is banked, then
  **tightens** (`TRAILING_STOP_TIGHT_PCT`, default 15%) on the runner.
  Keeping it loose until the take-profit fires is deliberate — a memecoin
  routinely wicks 20-30% mid-run, and a tight trail armed early just shakes
  you out before the token reaches the target.
- Any position older than **48h** is force-closed regardless of price.
- **0.5 SOL** reserve is never spent, on every trade.

Validate these rules two ways without any API key:
`npm run demo:exits` runs the old vs. new exit rules over archetypal price
paths and prints the expectancy difference; `npm run backtest` (needs a
Birdeye key) runs the same rules against real historical candles.

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
    pumpportal.ts          PumpPortal websocket: graduated (default) or new-token stream
    pumpfun.ts             HTTP poller for new pump.fun tokens (fallback)
    types.ts                shared TokenScanner interface
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
  risk/riskManager.ts            position sizing, take-profit scale-out, breakeven + trailing stop, max-age exit
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
PumpPortalScanner (websocket stream)  [or PumpFunScanner HTTP poll]
  -> passesMarketCapFilter (> MIN_MARKET_CAP_USD, default $25k)
  -> [Birdeye overview + token_security] -> assessTokenSafety (hard gate, fails closed)
  -> [Birdeye candles] + [NewsAPI -> Sentiment(Groq)] + [WhaleTracker activity]
  -> merged ScoringPayload (incl. security snapshot)
  -> scoreTrade (Groq) -> confidence, direction
  -> if confidence > CONFIDENCE_THRESHOLD (default 0.60) && direction == long:
       -> sizePosition (risk manager)
       -> executeBuy (Jupiter, paper|live)
       -> PositionStore.openPosition (peakPriceUsd = entryPriceUsd)
       -> Telegram: "OPENED $SYMBOL ..."

Position monitor (every 30s, independent loop):
  for each open position:
    -> Birdeye current price
    -> PositionStore.updatePeakPrice (trailing-stop input)
    -> checkTakeProfit: at +60%, sell half + raise floor to breakeven
       -> executeSell(partial) + PositionStore.scaleOutPosition
       -> Telegram: "TOOK PROFIT $SYMBOL ..."
    -> checkExitConditions (breakeven/trailing stop off the peak, OR age >= 48h)
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

Rule #5 watches a list of wallet addresses. **You don't have to configure
anything** — on first startup, if `data/whale-watchlist.json` doesn't
exist and a `BIRDEYE_API_KEY` is set, the bot auto-seeds it from the large
holders of currently-trending Solana tokens (a documented proxy for "smart
money") and saves it to disk. Whale tracking is also fully optional: it's
one signal among several, and the bot trades fine without it.

To curate the list by hand instead, edit `data/whale-watchlist.json`:

```json
[
  { "address": "SomeKnownSmartMoneyWallet...", "rank": 1, "label": "manual" }
]
```

The auto-seed is just a starting point — large holders of trending tokens
aren't necessarily *profitable* traders. For a real edge, replace it with
wallets you've verified have a track record (e.g. via Dune/on-chain
analysis).

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

### Token discovery sources

The bot has three interchangeable ways to discover tokens, selected by
`SCANNER_SOURCE`:

- **`graduated` (default)** — `src/scanners/pumpportal.ts` in `migration`
  mode subscribes to PumpPortal's `subscribeMigration` stream: tokens that
  completed their bonding curve and graduated to a DEX (~$69k). These are
  the tokens the pipeline can actually *evaluate and trade* — they're on a
  DEX so Birdeye has real OHLCV/liquidity for them, their mint/freeze
  authorities are usually revoked, and the lower volume dodges the free
  RPC/Birdeye rate limits. Recommended.
- **`pumpportal`** — the same scanner in `new` mode
  (`subscribeNewToken`): brand-new creations (~$5k). High volume but tiny,
  no Birdeye OHLCV, mostly rugs. Use only if you specifically want new-mint
  exposure and accept that most of it can't be scored well.
- **`pumpfun`** — `src/scanners/pumpfun.ts` polls pump.fun's unofficial
  `frontend-api` HTTP endpoint. Sits behind Cloudflare and frequently
  returns **HTTP 530/403** to non-browser traffic; unreliable. Last resort.

All emit the same `PumpFunToken` shape, so the rest of the pipeline doesn't
care which is active. If you see no tokens flowing (nothing ever reaches the
market-cap filter), the discovery source is almost always the cause — check
the scanner logs.

## Running

```bash
npm run dev        # ts-node style dev run with auto-reload
npm run build      # compile to dist/
npm start          # run compiled output
npm test           # run the unit test suite (pure logic, no network/API keys needed)
npm run typecheck
npm run demo:exits # compare old vs new exit rules on archetypal paths (no API key)
npm run backtest   # simulate exit rules against real Birdeye candles (needs a key)
```

Endpoints exposed on `PORT` (default 3000):

- `GET /health` — liveness + current mode (paper/live)
- `GET /status` — portfolio snapshot, open positions, SOL price
- `GET /positions` — full position history (open + closed)
- `GET /stats` — win rate, expectancy, Brier score, confidence calibration
  buckets, **plus a `goLive` readiness gate** (see below)
- `GET /trades` — raw closed-trade ledger entries

## Is it ready for real money? (the go-live gate)

Short answer: **only when the paper stats say so, objectively.** Two pieces
make that judgment honest:

1. **Paper fills model real costs.** `PAPER_TRADING_COST_PCT` (default 4%
   round-trip) is applied to every paper exit — Jupiter fees + slippage on
   thin memecoin liquidity + priority fees. Without it, paper P&L is the
   fantasy of a perfect fill and a *losing* strategy can look profitable.
   That mirage is the single most common way people go live and lose.
2. **An objective go-live gate** (`evaluateGoLiveReadiness`, surfaced in
   `GET /stats` and the Telegram `/stats` reply). ALL of these must pass:
   - **Sample size** ≥ `GO_LIVE_MIN_TRADES` (default 30) — enough to not be luck.
   - **Expectancy after costs** ≥ `GO_LIVE_MIN_EXPECTANCY_PCT` (default +1%/trade).
   - **Net profitable** — total realized PnL > 0.
   - **Confidence is informative** — the highest-confidence calibration
     bucket wins at least as often as the lowest. If higher AI confidence
     doesn't mean a higher realized win rate, the scorer has no edge and
     nothing else matters.

The gate erring toward NOT ready is deliberate: a false "ready" costs real
money. Even when it flips to READY, that's *permission to consider live with
tiny size*, not a guarantee — memecoins remain adversarial and the edge, if
any, decays as it's crowded.

**Watching it daily.** The bar is *30 closed trades*, not a fixed number of
weeks — the gate recomputes every time you check `/stats`. Two knobs make
"daily" practical:

- `DAILY_DIGEST_ENABLED` / `DAILY_DIGEST_INTERVAL_HOURS` (default on, every
  24h): the bot pushes a Telegram digest with the gate status and how many
  more closed trades are needed — so you watch progress without polling.
- `MAX_POSITION_AGE_HOURS` (default 12): a shorter max hold closes trades
  faster, so the 30-trade sample accumulates in days rather than weeks. The
  trade-off is real — a 12h hold is a *different strategy* than the original
  48h, so you're validating that variant. Set it back to 48 to test the
  original. What you **cannot** safely shortcut is `GO_LIVE_MIN_TRADES`
  itself — lowering it to force an early "READY" just means judging on noise.

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
- The backtest (`npm run backtest`) only exercises the *mechanical exit
  rules* against historical candles — it assumes entry at candle 0 and does
  not test the AI's token-selection edge or entry timing. On Birdeye's free
  tier it also can't fetch OHLCV for most brand-new pump.fun tokens, so the
  usable universe is small and survivorship-biased toward today's winners.
  `npm run demo:exits` sidesteps the data limit with archetypal paths, and
  `/stats` gives you real calibration once you've paper-traded enough closed
  trades (30+ recommended) — the only unbiased read on the full strategy.
- Latency is REST-polling-class (seconds), not sniper-bot-class
  (sub-100ms via direct Geyser/mempool feeds). By the time this bot acts,
  dedicated latency-optimized bots have often already captured much of a
  new token's early price discovery.
- `npm audit` flags transitive `esbuild`/`uuid` advisories via
  `vitest`→`vite` (dev-only) and `@solana/web3.js`→`jayson` (RPC client).
  Both are upstream ecosystem issues with no non-breaking fix available at
  time of writing; they don't affect this repo's own code.
