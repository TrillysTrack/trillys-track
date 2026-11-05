#!/usr/bin/env node
/* Score one open earnings-mention event from the terminal.

   node scripts/mentions-score.mjs AAP                         # company code, or a full event ticker
   node scripts/mentions-score.mjs AAP --weights report.json   # blend weights from a backtest report
   Options: --bankroll 1000  --kelly 0.25  --min-edge 0.03  --tx-max-age-days 400  --no-transcripts  --json out.json

   History prior from .cache/mentions-history.json (run mentions-backtest first), transcripts of
   the company's prior calls from fool.com, live quotes from Kalshi. Behind an HTTPS proxy, run with
   NODE_USE_ENV_PROXY=1. */
import fs from "node:fs";
import path from "node:path";
import { makeGetter, listSeriesEvents, fetchEvent, normalizeMarket, refPrice, EARNINGS_PREFIX } from "../lib/mentions/kalshi.mjs";
import { countTerm, rulesOptions } from "../lib/mentions/terms.mjs";
import { makeFoolClient, findTranscriptLinks, loadTranscript } from "../lib/mentions/fool.mjs";
import { DEFAULTS, HistoryStats, predictRow, evaluateSides, sizeBet, priorCoefN, priorCoefM } from "../lib/mentions/model.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const VALUED = new Set(["--weights", "--bankroll", "--kelly", "--min-edge", "--json", "--tx-max-age-days"]);
const target = (args.find((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1])) || "").toUpperCase();
const c = (p) => (p == null ? "  —" : `${Math.round(p * 100)}¢`.padStart(4));
const pc = (p) => (p == null ? "  —" : `${Math.round(p * 100)}%`.padStart(4));

async function main() {
  if (!target) { console.log("usage: node scripts/mentions-score.mjs <COMPANY|EVENT_TICKER> [--weights report.json]"); process.exitCode = 1; return; }
  const P = { ...DEFAULTS, bankroll: Number(opt("bankroll", DEFAULTS.bankroll)), kellyFraction: Number(opt("kelly", DEFAULTS.kellyFraction)), minEdge: Number(opt("min-edge", DEFAULTS.minEdge)) };
  const get = makeGetter({ minIntervalMs: 150 });

  // Weights: a backtest report's fit (with-transcripts if present), else the model defaults.
  let coefs = { coefN: priorCoefN(), coefM: priorCoefM(P) }, weightSource = "model defaults (no backtest fit)";
  const wfile = opt("weights", "");
  if (wfile) {
    const rep = JSON.parse(fs.readFileSync(wfile, "utf8"));
    const fit = (!flag("no-transcripts") && rep.withTranscripts?.coefs) || rep.base?.coefs;
    if (fit) { coefs = fit; weightSource = `${wfile} (${rep.withTranscripts?.coefs && !flag("no-transcripts") ? "with transcripts" : "history + market"}, n=${fit.nM})`; }
  }

  // The event: an explicit ticker, or the company's soonest open event.
  let eventTicker = target.includes("-") ? target : null;
  if (!eventTicker) {
    const series = target.startsWith(EARNINGS_PREFIX) ? target : EARNINGS_PREFIX + target;
    const open = await listSeriesEvents(get, series, "open");
    if (!open.length) { console.log(`No open events for ${series}.`); process.exitCode = 1; return; }
    eventTicker = open.map((e) => ({ e, d: normalizeMarket(e.markets?.[0] || { ticker: e.event_ticker }, e).date || "9999" })).sort((a, b) => a.d.localeCompare(b.d))[0].e.event_ticker;
  }
  const ev = await fetchEvent(get, eventTicker);
  const markets = ev.markets.map((m) => normalizeMarket(m, ev)).filter((m) => m.status === "active" || m.status === "open");
  if (!markets.length) { console.log(`${eventTicker} has no active markets.`); process.exitCode = 1; return; }
  const { company, companyName, date } = markets[0];

  // History prior: everything settled before this call.
  const cacheFile = path.resolve(".cache/mentions-history.json");
  const history = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")).rows : [];
  const stats = HistoryStats.from(history, date);

  // Transcripts of prior calls.
  const calls = [];
  const txNotes = [];
  if (!flag("no-transcripts")) {
    const fool = makeFoolClient({ intervalMs: 700 });
    const found = await findTranscriptLinks(fool, company);
    // Same transcript window the backtest fitted its weights on: calls within ~400 days.
    const oldest = new Date(Date.parse(`${date}T00:00:00Z`) - Number(opt("tx-max-age-days", 400)) * 86400000).toISOString().slice(0, 10);
    const prior = found.links.filter((l) => l.pubDate < date && l.pubDate >= oldest).sort((a, b) => b.pubDate.localeCompare(a.pubDate)).slice(0, P.txMaxCalls);
    for (const l of prior) {
      const t = await loadTranscript(fool, l);
      if (t.error) txNotes.push(`${l.pubDate}: ${t.error}`); else calls.push({ ...t, url: l.url });
    }
    if (!found.exchange) txNotes.push(`no fool.com quote page for ${company}`);
  }

  const rows = markets.map((m) => {
    const opts = rulesOptions(`${m.rules} ${m.rules2}`);
    const counts = calls.map((t) => ({ date: t.date, count: countTerm(t.parsed, m.term, opts).count })).sort((a, b) => b.date.localeCompare(a.date));
    const pr = predictRow({ ...m, pMid: refPrice(m), tx: counts }, stats, coefs, P);
    const { best } = evaluateSides(pr.pFinal, { bid: m.bid, ask: m.ask }, P);
    const live = best && best.edge >= P.minEdge;
    return { m, pr, best, live, counts, contracts: live ? sizeBet(best, P.bankroll) : 0 };
  }).sort((a, b) => (b.best?.edge ?? -9) - (a.best?.edge ?? -9));

  console.log(`\n${companyName} (${company}) · ${eventTicker} · call ${date}`);
  console.log(`History prior: ${stats.n} settled markets before ${date} (${history.filter((r) => r.company === company && r.date < date).length} for ${company})`);
  console.log(`Transcripts: ${calls.length} prior calls${calls.length ? ` (${calls.map((t) => t.date).join(", ")})` : ""}${txNotes.length ? ` · ${txNotes.join("; ")}` : ""}`);
  console.log(`Weights: ${weightSource} · Claude: not used\n`);
  console.log(`${"Term".padEnd(20)} ${"Bid/Ask".padStart(9)}  ${"H".padStart(4)} hist  ${"T".padStart(4)} said-in/calls · counts (newest→)   Final  Best side      Edge  Stake`);
  for (const { m, pr, best, live, counts, contracts } of rows) {
    const hist = pr.h.nCT ? `${pr.h.yCT}/${pr.h.nCT}` : "–";
    const tx = counts.length ? `${pr.t.hits}/${pr.t.calls} · ${counts.map((x) => x.count).join(",")}` : "no transcripts";
    const side = best ? `${best.side.toUpperCase()} @ ${Math.round(best.price * 100)}¢` : "no book";
    const edge = best ? `${best.edge >= 0 ? "+" : "−"}${Math.abs(best.edge * 100).toFixed(1)}¢` : "—";
    const stake = live ? `${contracts} ($${(contracts * best.cost).toFixed(0)})` : "—";
    console.log(`${m.term.slice(0, 20).padEnd(20)} ${`${c(m.bid)}/${c(m.ask)}`.padStart(9)}  ${pc(pr.pH)} ${hist.padEnd(4)}  ${pc(pr.pT)} ${tx.slice(0, 30).padEnd(30)}  ${pc(pr.pFinal)}  ${side.padEnd(12)} ${edge.padStart(6)}  ${stake}${live ? "  ◀" : ""}`);
  }
  console.log(`\nEdge = model probability − price − Kalshi taker fee; ◀ marks edge ≥ ${Math.round(P.minEdge * 100)}¢. Stake = ${P.kellyFraction}× Kelly on $${P.bankroll}, capped at ${P.maxBetPct * 100}% per bet.`);
  const out = opt("json", "");
  if (out) fs.writeFileSync(out, JSON.stringify({ eventTicker, company, date, weightSource, transcripts: calls.map((t) => ({ date: t.date, url: t.url, words: t.words })), rows: rows.map(({ m, pr, best, counts, contracts }) => ({ term: m.term, bid: m.bid, ask: m.ask, pH: pr.pH, pT: pr.pT, pFinal: pr.pFinal, counts, best, contracts })) }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
