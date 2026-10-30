# Trilly's Track

Self-hosted version of the Saratoga handicapping dashboard. Same app, same model,
same everything — the only real change is *where the data lives*: a real Postgres
database you control, instead of Claude's artifact storage (which turned out not to
persist reliably).

## What changed from the artifact version

- `loadKey`/`saveKey` now call `/api/kv` (this app's own API route, backed by Postgres)
  instead of `window.storage`.
- AI features (Pull race, Enrich, Pink Sheet) now call `/api/claude`, a server route
  that proxies to Anthropic's API with your own key. This keeps the key out of the
  browser. **These three features need `ANTHROPIC_API_KEY` set to work** — everything
  else (manual entry, CSV import, the model, bets, performance tracking) works without it.
- Nothing else changed. Same file, same 2000+ lines, same math.

## Deploy steps

1. **Push this folder to a new GitHub repo.**
   ```powershell
   cd trillys-track-app
   git init
   git add .
   git commit -m "Trilly's Track"
   git branch -M main
   git remote add origin https://github.com/<you>/trillys-track.git
   git push -u origin main
   ```
   (Create the empty repo on GitHub first — no README/license, just an empty repo —
   then use the URL it gives you.)

2. **Import into Vercel.** New Project → Continue with GitHub → pick the repo → Deploy.
   It'll fail on the first deploy or show a broken page — that's expected, there's no
   database attached yet. That's step 3.

3. **Attach a database.** In the Vercel dashboard: **Storage** tab → **Create Database**
   → Postgres → follow the prompts (it's a Neon-backed free-tier Postgres, a few
   clicks). Once created, connect it to this project — Vercel automatically adds the
   `POSTGRES_URL` environment variable for you. No manual copy-pasting.

4. **Redeploy.** Deployments tab → the three-dot menu on the latest deployment →
   Redeploy. This picks up the new environment variable.

5. **(Optional) Enable AI features.** Get a key at console.anthropic.com, then in
   Vercel: Settings → Environment Variables → add `ANTHROPIC_API_KEY` → Redeploy.

6. **Visit your URL.** It'll be something like `trillys-track.vercel.app`, shown at
   the top of the Vercel project page. Load today's card (via CSV import or the
   PowerShell NYRA scraper) and confirm it survives a refresh — that's the whole point.

## Local development (optional)

```bash
npm install
npm run dev
```

You'll need a `POSTGRES_URL` in a local `.env.local` file to test storage locally —
easiest way is to run `vercel env pull .env.local` after deploying once, which copies
your real environment variables down for local testing.

---

# Mention Desk (`/mentions`) — Kalshi earnings-call mention markets

A second dashboard in the same app for Kalshi's "What will *Company* say during their next
earnings call?" markets (`KXEARNINGSMENTION<TICKER>` series: one event per call, one market per
term). It prices every term with a model, shows edge after Kalshi's fee and a fractional-Kelly
stake, backtests itself walk-forward, logs paper bets, and syncs your real Kalshi portfolio
(read-only).

## The model

Each market (company × term × call date) gets four signals:

| | Signal | What it is |
|---|---|---|
| **H** | Kalshi history prior | Shrinkage estimate from every *earlier* settled earnings-mention market: this company's record on the term (recent calls weighted more) ← how often the term hits at other companies × how often this company's terms hit ← the global YES rate. |
| **T** | Transcripts | Gamma-Poisson model of how often the term was said in this company's *prior* calls (analyst questions excluded by default; plurals/possessives count, per Kalshi's rules). Centred on H, so with no transcripts T = H. |
| **M** | Market | Mid price (pre-call quote in the backtest). |
| **C** | Claude | Claude Opus 5.5 researches the call with web search and gives a probability per term. It never sees the market price. |

H, T and M are blended by a logistic regression fitted walk-forward, with an L2 pull toward
sensible defaults (trust the prior, lean on the market) so thin data can't produce wild weights.
C is an overlay with a weight **you** set (Settings → Claude weight). It is deliberately not
fitted, because Claude's training data overlaps historical calls and any backtested weight would
be inflated.

Edge = probability − price − fee, where the fee is `0.07 × P × (1−P)` per contract (rounded up
per order on Kalshi). Stake = Kelly fraction × full Kelly, capped at the max-bet share of bankroll.

## Workflow

1. **Board → Sync settled history.** Pulls every settled earnings-mention market plus its
   pre-call price (last quote before midnight ET on the call date). This trains H. It's
   incremental, so re-syncing only fetches new calls.
2. **Backtest → Run walk-forward backtest → Use these weights live.** Replays history in date
   order (each date only sees earlier outcomes), reports Brier/log loss against the market price,
   calibration, and simulated P&L. Adopting the weights makes the Board use them.
3. **Board → Load open markets**, then open an event. **Find transcripts** asks Claude for
   transcript URLs of the last calls; the server downloads them and counts terms exactly. For
   sites that block bots, use **Add transcript → Paste text**. **Ask Claude** adds the C signal
   (≈1–3 min, roughly $0.10–0.30 of API usage per call).
4. **Log** a bet to the paper log; **Bets → Grade open bets** settles it against Kalshi.
5. **Portfolio → Sync portfolio** shows balance, positions (with model fair value), and settled P&L.

## Environment variables

| Var | Needed for |
|---|---|
| `POSTGRES_URL` | Storage (same as the Saratoga desk). Without it the desk falls back to browser storage. |
| `ANTHROPIC_API_KEY` | Find transcripts + Ask Claude. |
| `DASHBOARD_TOKEN` | Any long random string. **Required** for portfolio sync; when set it also gates Claude and transcript fetching. Enter the same value under Settings → Dashboard token. |
| `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY` | Portfolio sync. Create an API key in Kalshi (Account → API keys); paste the private key PEM as-is (escaped `\n` also works). The desk only issues read requests. |
| `KALSHI_API_BASE` | Optional, e.g. `https://demo-api.kalshi.co/trade-api/v2` for Kalshi's demo environment. |

## Testing

```bash
npm test                                    # 35 unit tests: matcher, parser, model math, signing, SSRF guard
npm run mentions:backtest -- --probe        # print live Kalshi response shapes
npm run mentions:backtest                   # full sync + walk-forward backtest from the terminal
npm run mentions:backtest -- --series NVDA,TSLA --out report.json
```

The unit tests include a look-ahead check (flipping future outcomes must not change any earlier
prediction) and a synthetic market where the true probabilities are known.

## Known limits

- Kalshi's API is migrating price fields from integer cents to `*_dollars` strings; the parser
  reads either.
- Transcript speaker detection is heuristic (Motley Fool-style `Name -- Title` headers and
  `Name:` labels). If a transcript has no speaker labels, analyst speech can't be excluded.
- The backtest's "pre-call" price is the prior-day close, which is conservative for after-hours
  calls (it misses the same-day earnings release).
