# Outreach Agent

An app that runs 24/7. It finds businesses that need your help, works out exactly what's hurting them, and writes a complete, personalized email you can send with **one click**.

- **Finds leads.** It discovers Shopify stores (Brave Search + certificate logs) and businesses running Meta ads (Meta Ad Library), rotating through your niches day and night.
- **Finds the pain.** It audits each business's website, Shopify store and ads: no website, outdated or insecure sites, slow mobile pages, vintage Shopify themes, app bloat, no reviews or email capture, ads with no pixel, dead landing pages, worn-out ad creative, and more.
- **Sorts every lead into three queues:** **Website**, **Ad Management** and **Shopify CRO**, ranked by opportunity score.
- **Writes the whole sequence.** The first email names *their* specific problem, explains what it's costing them, says what you'd do about it, adds your proof line and a low-friction ask. It also writes two follow-ups. Every claim comes from what the audit actually found, and a validator rejects anything the AI made up.
- **You only approve.** Open a queue, read, tweak if you like, press **Approve & send** (or just hit `A`). It sends from your mailbox, spaced out, inside business hours, under a daily cap. Follow-ups go out automatically unless they reply, and replies stop the sequence.

## Start it

You need [Node.js 20+](https://nodejs.org) (the LTS installer).

| | |
|---|---|
| **Windows** | Double-click **`Start Outreach Agent.bat`** |
| **Mac / Linux** | Run `./start.sh` (on a Mac, copy it to `Start Outreach Agent.command` to double-click it) |
| **Terminal** | `npm install`, then `npm start` |

Your browser opens to **http://localhost:3000**. In Chrome or Edge, click the install icon in the address bar to get it as a desktop app with its own icon and window. On a phone it can be added to the home screen.

### First-time setup (Settings page)

The dashboard shows a checklist. The essentials:

1. **Your business:** name, company, mailing address (legally required in cold email) and a *real* proof line.
2. **Email sending:** for Gmail, use `smtp.gmail.com`, port `465`, your address, and an [App Password](https://myaccount.google.com/apppasswords). Then press **Send test email**.
3. **Lead sources** (free tiers):
   - **Brave Search API key** finds Shopify stores by niche (about 2,000 searches a month free).
   - **Meta Ad Library token** finds businesses running Facebook/Instagram ads. ⚠️ Meta's API only returns *commercial* ads that ran in the EU, so set the countries to the EU markets you want (IE and MT are English-speaking).
   - The **certificate-log** source needs no key and works out of the box.
4. **Groq API key** (free) lets the AI write each email fresh. Without it, the built-in template writer is used, which is also complete and grounded but less varied.
5. Optional: **Telegram** gets a ping like "12 Website · 7 Ads · 9 CRO ready to approve".

Then press **▶ Start agent**. It keeps running and picks up where it left off after a restart.

## Day to day

1. Open a queue (**Website / Ad Management / Shopify CRO**). The badges show how many drafts are waiting.
2. Each lead shows the email, its two follow-ups, and **their pain points** with the evidence (e.g. `© 2017`, `8.7s`, `Debut`, `no Meta pixel`).
3. **Approve & send** (`A`), **Skip** (`S`), **↻ Rewrite**, or **Do not contact**. Use `J`/`K` to move between leads.
4. Leads with no email but an active Facebook/Instagram page get a **DM version**. Copy it, send it from their page, then press **Mark as sent**.
5. **Sent & scheduled** shows everything that went out. **All leads** lets you search, add one by hand, or **import a CSV** (`name, website, email, facebook, niche`).

## Put it online (your own website link)

The easiest option is **Render**. It gives you a permanent `https://outreach-agent-xxxx.onrender.com` address that works from any computer or phone and runs 24/7.

1. Sign up at [render.com](https://render.com) and connect your GitHub.
2. Go to [dashboard.render.com/blueprint/new](https://dashboard.render.com/blueprint/new), pick this repo and branch, and click **Apply**.
3. When it asks, enter an **APP_PASSWORD** (what you'll log in with). You can paste a Groq key now or later in Settings.
4. When the deploy finishes, open the `.onrender.com` link. Log in with any username plus your password, then fill in Settings.

Cost: Render's Starter instance plus a 1 GB disk (about $7–8/month). The disk is what keeps your leads and settings between restarts, which the free tier can't do. Change `TZ` in Render's Environment tab if you're not on US Eastern time; it controls when emails go out.

## Run it 24/7 on your own server

A laptop that sleeps stops the agent, so for true 24/7 put it on any small server (a $5/month VPS is plenty).

**Docker** (restarts itself after crashes and reboots):

```bash
cp .env.example .env
```

Edit `.env` and set at least `APP_PASSWORD=` (required, because the app is reachable on the network). Then:

```bash
docker compose up -d
```

Open `http://YOUR-SERVER:3000` and log in with any username plus your `APP_PASSWORD`. Your data lives in `./data`. Put it behind HTTPS (Caddy, Cloudflare Tunnel, etc.) if you'll open it over the internet.

**pm2** (no Docker):

```bash
npm install && npm run build
```

```bash
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

`GET /health` (no login) is available for uptime monitors.

## How leads are judged

| Queue | What triggers it |
|---|---|
| **Website** | No website (ads point to Instagram/Facebook/WhatsApp/Linktree), parked or broken domain, no HTTPS, not mobile-friendly, `©` 3+ years old, old WordPress/jQuery, Flash, template builders, no contact path, slow mobile score |
| **Ad Management** | Running Meta ads with: no Meta pixel, a landing page that's down, one ad running 90+ days (creative fatigue), a single-ad setup, a slow landing page; or a Shopify store with no pixel for retargeting |
| **Shopify CRO** | Vintage (pre-OS 2.0) theme, 12+ app scripts, no reviews, no email capture, stale catalog, slow mobile load (Google PageSpeed), plus HTTPS/mobile issues on the store |

Each problem has a severity (1–3). The scores per queue are 0–100, and the highest one decides the queue. Leads below **Minimum opportunity score** are dropped, so you only see businesses with a real, provable problem.

## Safety and compliance (built in)

- **Nothing sends without your approval.** Follow-ups only send if you approved the sequence *and* the person hasn't replied.
- Every email carries your physical address and an opt-out line. A `List-Unsubscribe` header is set.
- Replies are detected over IMAP. "Stop"-type replies go to the **do-not-contact list** automatically, and you can add emails or whole `@domains` yourself.
- Daily send cap (default 30), business-hours window (Mon–Fri), and spacing between sends protect your mailbox's reputation. Use a separate sending domain or mailbox for cold outreach if you can.
- It only uses emails a business publishes on its own website, and respects `robots.txt`.
- **It never pitches "your site is down" because of your own connection.** It confirms it's online and re-checks before calling a site broken.
- The AI is only given the audit facts, and a validator rejects placeholders, invented numbers, missing evidence and fake sign-offs. The proof line is used verbatim, never invented.

## Command line (optional)

```bash
npm run cli -- audit https://some-store.com
```

That audits one site and prints the findings and the full email sequence. Other commands:

```bash
npm run cli -- cycle
```

```bash
npm run cli -- import leads.csv
```

```bash
npm run cli -- stats
```

## Development

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run typecheck
```

```
src/
  agent/agent.ts            24/7 loop: rotate niche → discover → audit → draft; send tick; reply check
  discover/                 shopify.ts (Brave + crt.sh), metaAdLibrary.ts, csvImport.ts
  fingerprint/platform.ts   Shopify/WordPress/Wix/… detection, pixels, parked pages
  audit/                    website.ts, shopify.ts, ads.ts, pagespeed.ts — each returns grounded findings
  contacts/extract.ts       emails/owner name/socials from the business's own pages (robots-aware, MX-checked)
  score/score.ts            per-queue 0–100 scores → which queue
  draft/compose.ts          AI writer (Groq) + validator + template fallback; signature & compliance footer
  send/mailer.ts            SMTP send with window, cap, suppression, threading
  send/replies.ts           IMAP reply/opt-out detection
  server/app.ts             JSON API + serves the app (public/)
public/                     the app UI (installable PWA)
```

If you're behind a corporate proxy, start Node with `NODE_USE_ENV_PROXY=1` so outbound requests use `HTTPS_PROXY`.
