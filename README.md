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
