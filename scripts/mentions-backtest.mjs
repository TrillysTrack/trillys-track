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
import { countTerm } from "../lib/mentions/terms.mjs";
import { makeFoolClient, findTranscriptLinks, loadTranscript } from "../lib/mentions/fool.mjs";
import { walkForward } from "../lib/mentions/model.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };

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
  // --incremental starts from the cached rows and skips events already synced (settled events
  // never change), checkpointing to disk every 10 series — so an interrupted run resumes
  // cheaply instead of starting over.
  const incremental = flag("incremental") && fs.existsSync(CACHE);
  const prior = incremental ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : null;
  const rows = prior ? [...prior.rows] : [];
  const knownBySeries = new Map();
  for (const r of rows) { const s = r.eventTicker.split("-")[0]; (knownBySeries.get(s) || knownBySeries.set(s, new Set()).get(s)).add(r.eventTicker); }
  console.log(`Syncing ${tickers.length} series (${flag("live-only") ? "live only" : "live + archived markets"})${prior ? `, starting from ${rows.length} cached markets` : ""}…`);
  const stats = { failedSeries: [], ...(prior?.stats ? Object.fromEntries(Object.entries(prior.stats).filter(([k]) => k !== "failedSeries")) : {}) };
  const lim = pLimit(2);
  let done = 0, added = 0;
  const checkpoint = () => save(CACHE, { syncedAt: new Date().toISOString(), partial: true, series: tickers.length, stats, retries, rows });
  await Promise.all(tickers.map((t) => lim(async () => {
    try {
      const fresh = await syncSeriesHistory(get, t, { withPrices: !flag("no-prices"), stats, historical: !flag("live-only"), known: knownBySeries.get(t) || new Set() });
      rows.push(...fresh); added += fresh.length;
    } catch (e) { stats.failedSeries.push(`${t}: ${e.message}`); console.log(`  ${t}: ${e.message}`); }
    done++;
    if (done % 10 === 0 || done === tickers.length) {
      console.log(`  ${done}/${tickers.length} series, ${rows.length} settled markets (+${added} this run)`);
      if (incremental) checkpoint();
    }
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
const foolGet = makeFoolClient({ intervalMs: Number(opt("fool-interval-ms", 700)) });

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
      const found = await findTranscriptLinks(foolGet, co);
      entry.links = found.links; entry.exchange = found.exchange;
      if (!found.exchange) entry.noQuotePage = true;
    }
    const wanted = entry.links.filter((l) => l.pubDate >= from && l.pubDate <= shift(to, 10)).sort((a, b) => b.pubDate.localeCompare(a.pubDate)).slice(0, maxPerCompany);
    for (const l of wanted) {
      const have = entry.calls.find((c) => c.url === l.url);
      if (have && [...terms.keys()].every((k) => k in have.counts)) continue;
      if (entry.failures.some((f) => f.url === l.url)) continue;
      const t = await loadTranscript(foolGet, l);
      if (t.error) { entry.failures.push({ url: l.url, reason: t.error }); continue; }
      const counts = Object.fromEntries([...terms].map(([k, term]) => [k, countTerm(t.parsed, term).count]));
      entry.calls = entry.calls.filter((c) => c.url !== l.url);
      entry.calls.push({ url: l.url, pubDate: l.pubDate, date: t.date, dateSource: t.dateSource, words: t.words, participants: t.participants, analysts: t.analysts, counts });
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

// Terms within one call move together, so uncertainty is estimated by resampling whole calls.
function callBootstrap(res, B = 2000) {
  const calls = new Map();
  const cell = (ev) => calls.get(ev) || calls.set(ev, { d: [], pnl: 0, cost: 0 }).get(ev);
  for (const p of res.preds) {
    if (p.pM == null || p.nHist < res.params.minHistory) continue;
    if ((res.params.scoreFrom && p.date < res.params.scoreFrom) || (res.params.scoreTo && p.date > res.params.scoreTo)) continue;
    const q = Math.min(0.995, Math.max(0.005, p.pFinal)), m = Math.min(0.995, Math.max(0.005, p.pM));
    cell(p.eventTicker).d.push((q - p.y) ** 2 - (m - p.y) ** 2);
  }
  for (const b of res.bets) { const c = calls.get(b.ticker.split("-").slice(0, 2).join("-")); if (c) { c.pnl += b.flat; c.cost += res.params.flatContracts * b.price; } }
  const keys = [...calls.keys()];
  if (!keys.length) return null;
  const stat = (ks) => { let s = 0, n = 0, pnl = 0, cost = 0; for (const k of ks) { const c = calls.get(k); for (const d of c.d) { s += d; n++; } pnl += c.pnl; cost += c.cost; } return { diff: s / n, roi: cost ? pnl / cost : null }; };
  let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const boots = Array.from({ length: B }, () => stat(keys.map(() => keys[Math.floor(rnd() * keys.length)])));
  const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(f * (s.length - 1))]; };
  const diffs = boots.map((b) => b.diff), rois = boots.map((b) => b.roi).filter((v) => v != null);
  return { calls: keys.length, diff: stat(keys).diff, diffCI: [q(diffs, 0.025), q(diffs, 0.975)], beatShare: diffs.filter((v) => v < 0).length / diffs.length, roi: stat(keys).roi, roiCI: rois.length ? [q(rois, 0.025), q(rois, 0.975)] : null };
}

function byQuarter(res) {
  const out = new Map();
  for (const p of res.preds) {
    if (p.pM == null || p.nHist < res.params.minHistory) continue;
    const k = `${p.date.slice(0, 4)}-Q${Math.floor((+p.date.slice(5, 7) - 1) / 3) + 1}`;
    const o = out.get(k) || out.set(k, { calls: new Set(), n: 0, bf: 0, bm: 0, bets: 0, pnl: 0, cost: 0 }).get(k);
    const q = Math.min(0.995, Math.max(0.005, p.pFinal)), m = Math.min(0.995, Math.max(0.005, p.pM));
    o.calls.add(p.eventTicker); o.n++; o.bf += (q - p.y) ** 2; o.bm += (m - p.y) ** 2;
  }
  for (const b of res.bets) { const k = `${b.date.slice(0, 4)}-Q${Math.floor((+b.date.slice(5, 7) - 1) / 3) + 1}`; const o = out.get(k); if (o) { o.bets++; o.pnl += b.flat; o.cost += res.params.flatContracts * b.price; } }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b));
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
  console.log(`  ${res.params.kellyFraction}× Kelly from $${res.params.bankroll} (day exposure ≤ ${res.params.maxDayExposure}× bankroll): P&L $${fmt(trading.kellyPnl, 2)}  ROI ${pct(trading.kellyRoi)}`);
  if (trading.naiveNo) console.log(`  reference — buy NO on every priced market: ${trading.naiveNo.bets} bets, flat ROI ${pct(trading.naiveNo.roi)}`);
  const bs = callBootstrap(res);
  if (bs) {
    console.log(`\n== Uncertainty (resampling whole calls, ${bs.calls} priced calls) ==`);
    console.log(`  Brier(final) − Brier(market) = ${fmt(bs.diff)}  95% CI [${fmt(bs.diffCI[0])}, ${fmt(bs.diffCI[1])}]  · model beats market in ${pct(bs.beatShare)} of resamples`);
    if (bs.roi != null) console.log(`  flat-stake ROI = ${pct(bs.roi)}  95% CI [${pct(bs.roiCI[0])}, ${pct(bs.roiCI[1])}]`);
    res.bootstrap = bs;
  }
  console.log(`\n== By quarter (priced, scored) ==`);
  console.log(`  quarter   calls  markets  Brier final  Brier market   bets   flat ROI`);
  res.quarters = byQuarter(res).map(([k, o]) => {
    console.log(`  ${k}  ${String(o.calls.size).padStart(5)}  ${String(o.n).padStart(7)}   ${fmt(o.bf / o.n)}       ${fmt(o.bm / o.n)}    ${String(o.bets).padStart(5)}   ${o.cost ? pct(o.pnl / o.cost) : "—"}`);
    return { quarter: k, calls: o.calls.size, markets: o.n, brierFinal: o.bf / o.n, brierMarket: o.bm / o.n, bets: o.bets, flatRoi: o.cost ? o.pnl / o.cost : null };
  });
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
