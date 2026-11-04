#!/usr/bin/env node
/* Walk-forward backtest of the earnings-mention model against real Kalshi history.

   node scripts/mentions-backtest.mjs                    # all earnings-mention series
   node scripts/mentions-backtest.mjs --series NVDA,TSLA # specific companies
   node scripts/mentions-backtest.mjs --transcripts      # also backfill prior-call transcripts
   node scripts/mentions-backtest.mjs --probe            # print raw API shapes and exit
   node scripts/mentions-backtest.mjs --refresh --live-only --merge-cache --score-days 14 --transcripts --tx-window-only
                                                         # quick: score only the last 14 days of calls
   Options: --limit N  --refresh  --live-only  --merge-cache  --refresh-transcripts  --no-prices
            --score-days N  --tx-window-only  --tx-max 4  --min-edge 0.03  --kelly 0.25
            --interval-ms 125  --fool-interval-ms 700  --out report.json

   Synced history is cached in .cache/mentions-history.json and transcript counts in
   .cache/mentions-transcripts.json, so reruns don't refetch. Behind an HTTPS proxy, run with
   NODE_USE_ENV_PROXY=1 (Node's fetch ignores HTTPS_PROXY otherwise). */
import fs from "node:fs";
import path from "node:path";
import {
  makeGetter, listEarningsSeries, discoverOpenEarningsEvents, syncSeriesHistory, listSeriesEvents, pLimit, EARNINGS_PREFIX,
} from "../lib/mentions/kalshi.mjs";
import { htmlToText, parseTranscript, countTerm, transcriptDate } from "../lib/mentions/terms.mjs";
import { walkForward } from "../lib/mentions/model.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CACHE = path.resolve(".cache/mentions-history.json");
const TX_CACHE = path.resolve(".cache/mentions-transcripts.json");
let retries = 0;
const get = makeGetter({
  base: process.env.KALSHI_API_BASE || undefined,
  minIntervalMs: Number(opt("interval-ms", 125)), // ≈8 req/s, under Kalshi's basic read limit
  onRetry: ({ status, wait }) => { retries++; if (retries % 10 === 1) console.log(`  (Kalshi ${status}, backing off ${wait} ms; ${retries} retries so far)`); },
});
const fmt = (x, d = 4) => (x == null ? "—" : Number(x).toFixed(d));
const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const shift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const save = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); };

async function probe() {
  const series = await listEarningsSeries(get).catch((e) => { console.log("series list failed:", e.message); return []; });
  console.log(`earnings-mention series via /series: ${series.length}`, series.slice(0, 5));
  const s = series[0]?.ticker || opt("series", "KXEARNINGSMENTIONNVDA");
  for (const status of ["open", "settled"]) {
    const evs = await listSeriesEvents(get, s, status).catch((e) => { console.log(`${status} events failed:`, e.message); return []; });
    console.log(`\n${s} ${status} events: ${evs.length}`);
    if (evs[0]) {
      const { markets, ...ev } = evs[0];
      console.log("event keys:", Object.keys(ev).join(", "));
      console.log("event:", JSON.stringify(ev).slice(0, 600));
      if (markets?.[0]) { console.log("market keys:", Object.keys(markets[0]).join(", ")); console.log("market:", JSON.stringify(markets[0]).slice(0, 1500)); }
    }
  }
  console.log("\nhistorical cutoff:", JSON.stringify(await get("/historical/cutoff").catch((e) => e.message)));
}

async function loadHistory() {
  if (!flag("refresh") && fs.existsSync(CACHE)) {
    const cached = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    console.log(`Using cached history (${cached.rows.length} markets, synced ${cached.syncedAt}). --refresh to resync.`);
    return cached;
  }
  let tickers = (opt("series", "") || "").split(",").filter(Boolean).map((t) => (t.startsWith(EARNINGS_PREFIX) ? t : EARNINGS_PREFIX + t.toUpperCase()));
  if (!tickers.length) {
    tickers = (await listEarningsSeries(get).catch(() => [])).map((s) => s.ticker);
    if (!tickers.length) {
      console.log("/series returned nothing for the prefix; discovering from open events…");
      tickers = [...new Set((await discoverOpenEarningsEvents(get)).map((e) => e.series_ticker))];
    }
  }
  const limit = Number(opt("limit", 0));
  if (limit) tickers = tickers.slice(0, limit);
  console.log(`Syncing ${tickers.length} series (live + archived markets)…`);
  const rows = [];
  const stats = { failedSeries: [] };
  const lim = pLimit(2);
  let done = 0;
  await Promise.all(tickers.map((t) => lim(async () => {
    try { rows.push(...(await syncSeriesHistory(get, t, { withPrices: !flag("no-prices"), stats, historical: !flag("live-only") }))); }
    catch (e) { stats.failedSeries.push(`${t}: ${e.message}`); console.log(`  ${t}: ${e.message}`); }
    done++;
    if (done % 10 === 0 || done === tickers.length) console.log(`  ${done}/${tickers.length} series, ${rows.length} settled markets`);
  })));
  // --merge-cache keeps rows from an earlier sync (e.g. archived history) that this one didn't fetch.
  if (flag("merge-cache") && fs.existsSync(CACHE)) {
    const have = new Set(rows.map((r) => r.ticker));
    const prev = JSON.parse(fs.readFileSync(CACHE, "utf8")).rows.filter((r) => !have.has(r.ticker));
    console.log(`  merged ${prev.length} previously cached markets`);
    rows.push(...prev);
  }
  const cached = { syncedAt: new Date().toISOString(), series: tickers.length, stats, retries, rows };
  save(CACHE, cached);
  return cached;
}

/* ---------- transcripts (Motley Fool) ----------
   Each company's fool.com quote page embeds its transcript list. Only that company's own
   transcripts are kept (the page also links other companies'), fetched politely, parsed with
   the same deterministic matcher as the dashboard, and reduced to per-term counts. */
let foolNext = 0;
async function foolGet(url) {
  const gap = Number(opt("fool-interval-ms", 700));
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = Date.now(), at = Math.max(now, foolNext);
    foolNext = at + gap;
    if (at > now) await sleep(at - now);
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; TrillysTrack/1.0; transcript research)", Accept: "text/html" } });
      if (res.status === 429 || res.status >= 500) { foolNext = Date.now() + 5000 * (attempt + 1); continue; }
      return { status: res.status, text: res.ok ? await res.text() : "" };
    } catch (e) {
      if (attempt === 2) return { status: 0, error: e.message, text: "" };
    }
  }
  return { status: 429, text: "" };
}

function transcriptLinks(html, company) {
  const own = new RegExp(`(^|-)${company.toLowerCase()}(-|$)`);
  const out = new Map();
  for (const m of html.matchAll(/call-transcripts\/(\d{4})\/(\d{2})\/(\d{2})\/([a-z0-9-]+)\//g)) {
    if (!own.test(m[4])) continue;
    const url = `https://www.fool.com/earnings/call-transcripts/${m[1]}/${m[2]}/${m[3]}/${m[4]}/`;
    out.set(url, { url, pubDate: `${m[1]}-${m[2]}-${m[3]}` });
  }
  return [...out.values()];
}

async function backfillTranscripts(rows, { companies = null, maxPerCompany = 12, until = null } = {}) {
  const cache = !flag("refresh-transcripts") && fs.existsSync(TX_CACHE) ? JSON.parse(fs.readFileSync(TX_CACHE, "utf8")) : {};
  const byCo = new Map();
  for (const r of rows) if (!companies || companies.has(r.company)) (byCo.get(r.company) || byCo.set(r.company, []).get(r.company)).push(r);
  console.log(`\nBackfilling transcripts for ${byCo.size} companies from fool.com…`);
  let n = 0;
  for (const [co, list] of byCo) {
    n++;
    const terms = new Map(list.map((r) => [r.termKey, r.term]));
    const dates = list.map((r) => r.date).sort();
    const to = until?.[co] || dates[dates.length - 1];
    const from = until?.[co] ? shift(to, -400) : shift(dates[0], -400);
    const entry = cache[co] || { calls: [], failures: [] };
    if (!entry.links) {
      let page = null;
      for (const ex of ["nasdaq", "nyse"]) {
        const r = await foolGet(`https://www.fool.com/quote/${ex}/${co.toLowerCase()}/`);
        if (r.status === 200) { page = r.text; entry.exchange = ex; break; }
      }
      entry.links = page ? transcriptLinks(page, co) : [];
      if (!page) entry.noQuotePage = true;
    }
    const wanted = entry.links.filter((l) => l.pubDate >= from && l.pubDate <= shift(to, 10)).sort((a, b) => b.pubDate.localeCompare(a.pubDate)).slice(0, maxPerCompany);
    for (const l of wanted) {
      const have = entry.calls.find((c) => c.url === l.url);
      if (have && [...terms.keys()].every((k) => k in have.counts)) continue;
      if (entry.failures.some((f) => f.url === l.url)) continue;
      const r = await foolGet(l.url);
      if (r.status !== 200) { entry.failures.push({ url: l.url, reason: `HTTP ${r.status}${r.error ? " " + r.error : ""}` }); continue; }
      const text = htmlToText(r.text);
      const parsed = parseTranscript(text);
      if (parsed.words < 2000) { entry.failures.push({ url: l.url, reason: `only ${parsed.words} words parsed` }); continue; }
      // Call date from the transcript header; the URL's publication date is the fallback and is
      // never earlier than the call, so it can't leak a call into its own prediction.
      const stated = transcriptDate(text);
      const date = stated && stated <= l.pubDate && dayDiff(stated, l.pubDate) <= 10 ? stated : l.pubDate;
      const counts = Object.fromEntries([...terms].map(([k, t]) => [k, countTerm(parsed, t).count]));
      entry.calls = entry.calls.filter((c) => c.url !== l.url);
      entry.calls.push({ url: l.url, pubDate: l.pubDate, date, dateSource: date === stated ? "header" : "published", words: parsed.words, participants: parsed.participants, analysts: new Set(parsed.segments.filter((s) => s.role === "analyst").map((s) => s.speaker)).size, counts });
    }
    entry.fetchedAt = new Date().toISOString();
    cache[co] = entry;
    if (n % 10 === 0 || n === byCo.size) { save(TX_CACHE, cache); console.log(`  ${n}/${byCo.size} companies · ${Object.values(cache).reduce((s, e) => s + e.calls.length, 0)} transcripts`); }
  }
  save(TX_CACHE, cache);
  return cache;
}

function attachTranscripts(rows, cache) {
  return rows.map((r) => ({
    ...r,
    tx: (cache[r.company]?.calls || []).flatMap((c) => (Number.isFinite(c.counts?.[r.termKey]) ? [{ date: c.date, count: c.counts[r.termKey] }] : [])),
  }));
}

function report(label, res) {
  const { counts, metrics, trading, coefs } = res;
  console.log(`\n================ ${label} ================`);
  console.log(`${counts.rows} settled markets · ${counts.events} calls · ${counts.dates} call dates · scored ${counts.scored} · with pre-call price ${counts.priced} · with transcripts ${counts.withTx}`);
  console.log(`YES base rate (scored): ${pct(res.baseRate)}`);
  if (res.window) {
    const w = res.window;
    console.log(`Scoring window ${res.params.scoreFrom} → ${res.params.scoreTo}: ${counts.scoredEvents} calls, ${counts.scored} markets (${counts.priced} with a pre-call price, ${counts.withTx} with transcripts)`);
    console.log(`At window start the model had ${w.histMarkets} earlier settled markets for H; blend weights: ${w.fitM ? `fitted on ${w.fitM} priced rows` : "DEFAULTS (fewer than minTrain rows of earlier data)"}${w.fitN ? "" : " / no-price model on defaults"}`);
    console.log(`  weights used at window start [1, logit H, logit T−H, logit M]: ${w.coefs.coefM.map((c) => fmt(c, 3)).join(", ")}`);
  }
  console.log(`\n== Accuracy (lower is better) ==`);
  console.log(`All scored markets      Brier      LogLoss`);
  for (const k of ["H", "T", "model"]) console.log(`  ${k.padEnd(20)} ${fmt(metrics.all[k].brier)}   ${fmt(metrics.all[k].logloss)}   n=${metrics.all[k].n}`);
  console.log(`Markets with a price`);
  for (const k of ["market", "H", "model", "final"]) console.log(`  ${k.padEnd(20)} ${fmt(metrics.priced[k].brier)}   ${fmt(metrics.priced[k].logloss)}   n=${metrics.priced[k].n}`);
  console.log(`\n== Calibration (final, priced) ==`);
  for (const b of res.calibration.final.filter((b) => b.n)) console.log(`  ${pct(b.lo).padStart(6)}–${pct(b.hi).padEnd(6)} n=${String(b.n).padStart(5)}  predicted ${pct(b.meanP)}  actual ${pct(b.rate)}`);
  console.log(`\n== Trading sim (pre-call quotes, ${pct(res.params.feeRate)} fee formula, edge ≥ ${res.params.minEdge}) ==`);
  console.log(`  bets ${trading.bets}  win ${pct(trading.bets ? trading.wins / trading.bets : null)}  avg edge ${fmt(trading.avgEdge, 3)}  YES share ${pct(trading.yesShare)}`);
  console.log(`  flat ${res.params.flatContracts}/bet: P&L $${fmt(trading.flatPnl, 2)}  ROI ${pct(trading.flatRoi)}`);
  console.log(`  ${res.params.kellyFraction}× Kelly from $${res.params.bankroll}: P&L $${fmt(trading.kellyPnl, 2)}  ROI ${pct(trading.kellyRoi)}`);
  console.log(`\n== Fitted blend (all data) ==`);
  console.log(`  no-market [1, logit H, logit T−H]:            ${coefs.coefN.map((c) => fmt(c, 3)).join(", ")}  (n=${coefs.nN})`);
  console.log(`  with market [1, logit H, logit T−H, logit M]: ${coefs.coefM.map((c) => fmt(c, 3)).join(", ")}  (n=${coefs.nM})`);
}

async function main() {
  if (flag("probe")) return probe();
  const hist = await loadHistory();
  const rows = hist.rows;
  if (!rows.length) { console.log("No settled markets found."); process.exitCode = 1; return; }

  const dates = rows.map((r) => r.date).sort();
  console.log(`\n== Coverage ==`);
  console.log(`${rows.length} settled markets · ${new Set(rows.map((r) => r.eventTicker)).size} calls · ${new Set(rows.map((r) => r.company)).size} companies · ${new Set(rows.map((r) => r.termKey)).size} distinct terms · ${dates[0]} → ${dates[dates.length - 1]}`);
  console.log(`with pre-call price: ${rows.filter((r) => r.pMid != null).length}; call dating: ${JSON.stringify(hist.stats ? Object.fromEntries(Object.entries(hist.stats).filter(([k]) => k !== "failedSeries")) : {})}; series errors: ${hist.stats?.failedSeries?.length ?? 0}; Kalshi 429/5xx retries: ${hist.retries ?? "n/a"}`);

  const scoreDays = Number(opt("score-days", 0));
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const params = {
    minEdge: Number(opt("min-edge", 0.03)), kellyFraction: Number(opt("kelly", 0.25)),
    minHistory: Number(opt("min-history", scoreDays ? 0 : 200)),
    ...(scoreDays ? { scoreFrom: shift(today, -scoreDays), scoreTo: today } : {}),
  };
  const base = walkForward(rows, params);
  report("History + market (no transcripts)", base);
  const out = { coverage: { rows: rows.length, from: dates[0], to: dates[dates.length - 1], stats: hist.stats, retries: hist.retries }, base: (({ preds, ...x }) => x)(base) };

  if (flag("transcripts")) {
    // --tx-window-only: only companies with calls in the scoring window, and only their most
    // recent prior transcripts (the call's own transcript is excluded by the model's date gap).
    let txOpts = { maxPerCompany: Number(opt("tx-max", 12)) };
    if (flag("tx-window-only") && params.scoreFrom) {
      const inWin = rows.filter((r) => r.date >= params.scoreFrom && r.date <= params.scoreTo);
      const until = {};
      for (const r of inWin) until[r.company] = until[r.company] && until[r.company] > r.date ? until[r.company] : r.date;
      txOpts = { ...txOpts, companies: new Set(Object.keys(until)), until };
    }
    const cache = await backfillTranscripts(rows, txOpts);
    const cos = Object.values(cache);
    const failures = cos.flatMap((e) => e.failures || []);
    console.log(`\nTranscripts: ${cos.reduce((s, e) => s + e.calls.length, 0)} calls for ${cos.filter((e) => e.calls.length).length}/${cos.length} companies · no fool.com quote page: ${cos.filter((e) => e.noQuotePage).length} · fetch/parse failures: ${failures.length}`);
    const withTx = walkForward(attachTranscripts(rows, cache), params);
    report("History + transcripts + market", withTx);
    out.withTranscripts = (({ preds, ...x }) => x)(withTx);
    out.transcriptCoverage = { companies: cos.length, withCalls: cos.filter((e) => e.calls.length).length, calls: cos.reduce((s, e) => s + e.calls.length, 0), noQuotePage: cos.filter((e) => e.noQuotePage).length, failures: failures.length };
  }
  const file = opt("out", "");
  if (file) { fs.writeFileSync(file, JSON.stringify(out, null, 2)); console.log(`\nReport written to ${file}`); }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
