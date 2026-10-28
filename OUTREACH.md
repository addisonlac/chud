# Facebook Outreach Agent

An always-on agent that finds local businesses without a website, writes
personalized outreach for them, runs your Facebook Page, and answers every
message and comment on it — 24/7, with no babysitting.

```
npm run outreach:daemon      # run it forever (or use Docker below)
npm run outreach             # manual commands / help
```

## What it does on its own

| Every…            | It…                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| 2 min (or instantly with webhooks) | Reads new Page **messages + comments**, writes a reply with AI, and **sends it**. Comments that show buying intent also get one private Messenger reply. |
| 24 h              | Searches Google for the next `OUTREACH_TARGETS` niche/city and saves businesses with **no website** as prospects. |
| 1 h               | Writes a **personalized first message** for new prospects (capped at `OUTREACH_DAILY_LIMIT`/day) and **follow-ups** for anyone who hasn't answered in `OUTREACH_FOLLOWUP_DAYS`. |
| 48 h              | Writes and **publishes a Page post** aimed at local business owners (never repeats recent posts). |
| 24 h              | Sends you a **Telegram digest**: stats, plus each ready-to-send DM with a one-tap Facebook link. |
| Any hot lead      | **Telegram alert** immediately with what they want and what the agent said.                     |

State (leads, what's been answered, schedules) is saved in `data/`, so a
restart never double-replies or double-posts. Every task is isolated: if one
API is down the rest keep running and it retries next cycle.

## The one thing that can't be automated (on purpose)

Facebook's API **does not let a Page send the first message to a stranger**,
and automating cold DMs from a personal profile breaks Meta's terms — accounts
doing it get restricted or banned fast, which would kill your Page. So the
agent does everything *except* press send on cold DMs: it finds the business,
writes the message, and drops it in your Telegram with a link. Sending ~20 takes
about 5 minutes a day. Once they reply to your **Page**, the agent takes over
the conversation automatically.

If you want cold outreach that is fully hands-off, email is the channel for
that (legal with an opt-out line) — ask and it can be added to this agent.

## Setup (≈20 minutes, once)

1. **Copy config:** `cp .env.example .env`, fill the `BUSINESS_*` lines.
2. **AI (free):** create a key at console.groq.com → `GROQ_API_KEY`.
   Without it the agent uses decent built-in templates.
3. **Facebook Page token**
   1. developers.facebook.com → *Create app* → type **Business**.
   2. Add products **Messenger** and **Webhooks**; link your Page.
   3. In Graph API Explorer pick your app, add permissions
      `pages_show_list, pages_read_engagement, pages_manage_posts,
      pages_manage_engagement, pages_messaging`, generate a **User token**.
   4. Exchange it for a long-lived token (Access Token Debugger → *Extend*),
      then call `GET /me/accounts` with it — the `access_token` next to your
      Page is a **Page token that doesn't expire**. Put it in
      `FB_PAGE_ACCESS_TOKEN` and the Page `id` in `FB_PAGE_ID`.
   5. `npm run outreach -- check` should print your Page name.
   6. While your app is in *Development* mode it works for your own Page and
      people with a role on the app. To reply to the public, submit the app
      for **Advanced Access** on `pages_messaging` (App Review; usually a few days).
4. **Prospects (optional but recommended):** Google Cloud → enable
   *Places API (New)* → API key → `GOOGLE_PLACES_API_KEY`. Set
   `OUTREACH_TARGETS` like `plumbers|Austin TX;roofers|Austin TX`.
   No key? Import a spreadsheet: `npm run outreach -- import leads.csv`
   (columns `name,niche,city,facebook_url,phone,email,website,notes`).
5. **Alerts:** set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (same as the
   trading bot: create a bot with @BotFather).

## Running it 24/7

It has to live on a machine that's always on — not your laptop.

**Any VPS (DigitalOcean, Hetzner, Lightsail, Oracle free tier) with Docker:**
```
git clone <this repo> && cd chud && cp .env.example .env   # fill it in
docker compose -f docker-compose.outreach.yml up -d --build
docker compose -f docker-compose.outreach.yml logs -f        # watch it
```
`restart: unless-stopped` brings it back after crashes and reboots; `data/`
is mounted so nothing is lost on redeploy.

**Railway / Render / Fly.io:** deploy the repo with `Dockerfile.outreach`,
paste your `.env` values as environment variables, and attach a persistent
volume at `/app/data`. `/health` is the health-check path.

**Plain Node + pm2:** `npm ci && npm run build && npx pm2 start dist/outreach/daemon.js --name outreach && npx pm2 save && npx pm2 startup`.

### Instant replies (optional webhooks)

Polling already answers within `OUTREACH_POLL_INTERVAL_SEC`. For instant
replies, in the Meta app → Webhooks → *Page*: callback
`https://<your-host>/webhook`, verify token = `FB_VERIFY_TOKEN`, subscribe to
`messages` and `feed`. Set `FB_APP_SECRET` (App settings → Basic) so
signatures are verified.

## Manual commands

```
npm run outreach -- check | find "<niche>" "<city>" | import file.csv
npm run outreach -- draft | queue | sent <lead-id> | status <lead-id> won
npm run outreach -- post --dry-run | inbox | approve <id> | tick
```

Set `FB_AUTO_REPLY=false` if you'd rather approve replies before they go out
(`inbox` / `approve`); the default is fully automatic.
