#!/usr/bin/env node
/* Walk-forward backtest of the earnings-mention model against real Kalshi history.

   node scripts/mentions-backtest.mjs                    # all earnings-mention series
   node scripts/mentions-backtest.mjs --series NVDA,TSLA # specific companies
   node scripts/mentions-backtest.mjs --probe            # print raw API shapes and exit
   Options: --limit N  --refresh  --no-prices  --min-edge 0.03  --kelly 0.25  --out report.json

   Synced history is cached in .cache/mentions-history.json so reruns don't refetch. */
import fs from "node:fs";
import path from "node:path";
import {
  makeGetter, listEarningsSeries, discoverOpenEarningsEvents, syncSeriesHistory, listSeriesEvents, pLimit, EARNINGS_PREFIX,
} from "../lib/mentions/kalshi.mjs";
import { walkForward } from "../lib/mentions/model.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };

const CACHE = path.resolve(".cache/mentions-history.json");
const get = makeGetter({ base: process.env.KALSHI_API_BASE || undefined });
const fmt = (x, d = 4) => (x == null ? "—" : Number(x).toFixed(d));
const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);

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
}

async function loadHistory() {
  if (!flag("refresh") && fs.existsSync(CACHE)) {
    const cached = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    console.log(`Using cached history (${cached.rows.length} markets, synced ${cached.syncedAt}). --refresh to resync.`);
    return cached.rows;
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
  console.log(`Syncing ${tickers.length} series…`);
  const rows = [];
  const lim = pLimit(2);
  let done = 0;
  await Promise.all(tickers.map((t) => lim(async () => {
    try { rows.push(...(await syncSeriesHistory(get, t, { withPrices: !flag("no-prices") }))); }
    catch (e) { console.log(`  ${t}: ${e.message}`); }
    done++;
    if (done % 10 === 0 || done === tickers.length) console.log(`  ${done}/${tickers.length} series, ${rows.length} settled markets`);
  })));
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify({ syncedAt: new Date().toISOString(), rows }));
  return rows;
}

async function main() {
  if (flag("probe")) return probe();
  const rows = await loadHistory();
  if (!rows.length) { console.log("No settled markets found."); process.exitCode = 1; return; }
  const res = walkForward(rows, {
    minEdge: Number(opt("min-edge", 0.03)), kellyFraction: Number(opt("kelly", 0.25)),
    minHistory: Number(opt("min-history", 200)),
  });
  const { counts, metrics, trading, coefs } = res;
  console.log(`\n== Data ==\n${counts.rows} settled markets · ${counts.events} calls · ${counts.dates} call dates · scored ${counts.scored} · with pre-call price ${counts.priced}`);
  console.log(`YES base rate (scored): ${pct(res.baseRate)}`);
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
  console.log(`  no-market [1, logit H, logit T−H]:          ${coefs.coefN.map((c) => fmt(c, 3)).join(", ")}  (n=${coefs.nN})`);
  console.log(`  with market [1, logit H, logit T−H, logit M]: ${coefs.coefM.map((c) => fmt(c, 3)).join(", ")}  (n=${coefs.nM})`);
  const out = opt("out", "");
  if (out) { const { preds, ...slim } = res; fs.writeFileSync(out, JSON.stringify(slim, null, 2)); console.log(`\nReport written to ${out}`); }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
