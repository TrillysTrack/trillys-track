"use client";
import { useState, useEffect, useMemo, useRef } from "react";
import {
  makeGetter, listEarningsSeries, discoverOpenEarningsEvents, fetchEvent, normalizeMarket, syncSeriesHistory,
  packHistory, unpackHistory, refPrice, isEarningsMention, EARNINGS_PREFIX, parseMarketTicker, pLimit,
} from "../../lib/mentions/kalshi.mjs";
import { parseTranscript, countTerm, rulesOptions } from "../../lib/mentions/terms.mjs";
import {
  DEFAULTS, HistoryStats, predictRow, evaluateSides, sizeBet, walkForward, priorCoefN, priorCoefM, orderFee,
} from "../../lib/mentions/model.mjs";

/* ================= STORAGE =================
   Same Postgres KV as the Saratoga desk. If the database isn't reachable (e.g. local dev with no
   POSTGRES_URL) the desk runs on browser storage and says so in a banner. */
const K = {
  settings: "km-settings-v1", series: "km-series-v1", hist: "km-hist-v1:", model: "km-model-v1",
  txIdx: "km-txidx-v1:", tx: "km-tx-v1:", claude: "km-claude-v1:", bets: "km-bets-v1",
};
const TOKEN_KEY = "km-token";
const store = { mode: "server" };

async function probeStorage() {
  try {
    const r = await fetch("/api/kv?key=km-probe");
    store.mode = r.ok || r.status === 404 ? "server" : "browser";
  } catch { store.mode = "browser"; }
  return store.mode;
}
async function loadKey(key, fallback) {
  if (store.mode === "server") {
    const r = await fetch(`/api/kv?key=${encodeURIComponent(key)}`);
    if (r.status === 404) return fallback;
    if (!r.ok) throw new Error(`Storage read failed (${r.status})`);
    try { return JSON.parse((await r.json()).value); } catch { return fallback; }
  }
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
async function saveKey(key, obj) {
  const value = JSON.stringify(obj);
  if (store.mode === "server") {
    const r = await fetch("/api/kv", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }) });
    if (!r.ok) throw new Error(`Storage write failed (${r.status})`);
    return;
  }
  localStorage.setItem(key, value);
}
async function loadPrefix(prefix) {
  if (store.mode === "server") {
    const r = await fetch(`/api/kv?prefix=${encodeURIComponent(prefix)}`);
    if (!r.ok) throw new Error(`Storage read failed (${r.status})`);
    return ((await r.json()).items || []).flatMap((it) => { try { return [[it.key, JSON.parse(it.value)]]; } catch { return []; } });
  }
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) { try { out.push([k, JSON.parse(localStorage.getItem(k))]); } catch { /* skip */ } }
  }
  return out;
}

const tokenHeaders = () => { try { const t = localStorage.getItem(TOKEN_KEY); return t ? { "x-dashboard-token": t } : {}; } catch { return {}; } };
async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...tokenHeaders() }, body: body ? JSON.stringify(body) : undefined });
  let d = null;
  try { d = await r.json(); } catch { /* non-JSON */ }
  if (!r.ok) throw new Error(d?.error?.message || d?.error || `HTTP ${r.status}`);
  return d;
}
const kget = makeGetter({ proxy: "/api/kalshi" });

/* ================= FORMAT ================= */
const cents = (p) => (p == null ? "—" : `${Math.round(p * 100)}¢`);
const pct = (p, d = 0) => (p == null ? "—" : `${(p * 100).toFixed(d)}%`);
const edgeC = (x) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}¢`);
const money = (x) => (x == null ? "—" : `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`);
const num = (x, d = 3) => (x == null ? "—" : Number(x).toFixed(d));
const fmtDate = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");
const dollarsOf = (o, f) => (o?.[`${f}_dollars`] != null ? Number(o[`${f}_dollars`]) : o?.[f] != null ? Number(o[f]) / 100 : null);
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/* ================= MODEL GLUE ================= */
// Transcript calls for a company → per-term counts. Calls with parsed text are counted fresh with
// the market's own rules; index-only calls use counts saved when the transcript was added.
function txFor(calls, m, excludeAnalysts) {
  const opts = { ...rulesOptions(`${m.rules} ${m.rules2}`), ...(excludeAnalysts == null ? {} : { excludeAnalysts }) };
  return (calls || [])
    .map((c) => ({ date: c.date, count: c.parsed ? countTerm(c.parsed, m.term, opts).count : c.counts?.[m.termKey] }))
    .filter((c) => Number.isFinite(c.count));
}

function analyzeEvent(ev, { stats, calls, claude, coefs, P, excludeAnalysts }) {
  return ev.markets.map((m) => {
    const tx = txFor(calls, m, excludeAnalysts);
    const c = claude?.probs?.[m.termKey];
    const pr = predictRow({ ...m, pMid: refPrice(m), tx, pClaude: c?.p ?? null }, stats, coefs, P);
    const { best } = evaluateSides(pr.pFinal, { bid: m.bid, ask: m.ask }, P);
    const live = best && best.edge >= P.minEdge;
    return { m, pr, best, live, contracts: live ? sizeBet(best, P.bankroll) : 0, why: c?.why || "" };
  });
}

// Counts for every term this company has ever been asked about, saved alongside each transcript
// so the backtest can use transcripts without loading their full text.
function countsForTerms(parsed, termsByKey) {
  const out = {};
  for (const [k, term] of termsByKey) out[k] = countTerm(parsed, term).count;
  return out;
}

/* ================= STYLE ================= */
const css = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
.km{
  --bg:#0f1216; --panel:#161a20; --panel2:#1c2129; --line:#2a313b; --line2:#353d49;
  --ink:#e9ecef; --ink2:#a7b0bb; --ink3:#7b8592; --accent:#f2c14e; --accentInk:#1b1405;
  --s1:#3987e5; --s2:#d95926; --good:#0ca30c; --crit:#d03b3b;
  color-scheme:dark; font-family:'Archivo',system-ui,sans-serif; color:var(--ink); background:var(--bg); min-height:100vh;
}
.km *{box-sizing:border-box}
.km .mono{font-family:'IBM Plex Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}
.km .wrap{max-width:1240px;margin:0 auto;padding:0 16px}
.km header{border-bottom:1px solid var(--line);background:linear-gradient(180deg,#141922,#0f1216)}
.km .brand{display:flex;align-items:baseline;gap:12px;padding:18px 0 6px;flex-wrap:wrap}
.km .brand h1{margin:0;font-size:22px;font-weight:700;letter-spacing:.01em}
.km .brand .sub{color:var(--ink3);font-size:12.5px}
.km .brand a{color:var(--ink2);font-size:12.5px;margin-left:auto;text-decoration:none;border-bottom:1px dotted var(--ink3)}
.km nav{display:flex;gap:22px;overflow-x:auto}
.km .tab{background:none;border:none;color:var(--ink3);padding:10px 0;font:600 12.5px 'Archivo';letter-spacing:.08em;text-transform:uppercase;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap}
.km .tab.on{color:var(--accent);border-bottom-color:var(--accent)}
.km main{padding:20px 0 60px}
.km .panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px}
.km .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.km .grid{display:grid;gap:14px}
.km .btn{background:var(--accent);color:var(--accentInk);border:none;border-radius:6px;padding:8px 14px;font:600 13px 'Archivo';cursor:pointer}
.km .btn2{background:transparent;color:var(--ink);border:1px solid var(--line2);border-radius:6px;padding:7px 12px;font:600 12.5px 'Archivo';cursor:pointer}
.km .btn3{background:transparent;color:var(--ink2);border:1px solid var(--line);border-radius:5px;padding:3px 8px;font:600 11.5px 'Archivo';cursor:pointer}
.km button:disabled{opacity:.45;cursor:default}
.km input,.km select,.km textarea{background:var(--panel2);border:1px solid var(--line2);color:var(--ink);border-radius:6px;padding:7px 9px;font:13px 'Archivo'}
.km textarea{font-family:'IBM Plex Mono',monospace;font-size:12px;width:100%}
.km input:focus,.km select:focus,.km textarea:focus,.km button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.km label.f{display:grid;gap:4px;font-size:11.5px;color:var(--ink2);letter-spacing:.03em}
.km .tbl{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
.km table{border-collapse:collapse;width:100%;font-size:13px}
.km th{font:600 10.5px 'Archivo';letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;white-space:nowrap}
.km td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle;white-space:nowrap}
.km tr:last-child td{border-bottom:none}
.km tr.click{cursor:pointer} .km tr.click:hover td{background:var(--panel2)}
.km td.num,.km th.num{text-align:right}
.km .muted{color:var(--ink3)} .km .dim{color:var(--ink2)}
.km .chip{display:inline-block;border-radius:4px;padding:2px 7px;font:600 11px 'Archivo';letter-spacing:.04em}
.km .chip.buy{background:var(--accent);color:var(--accentInk)}
.km .chip.flat{background:var(--panel2);color:var(--ink3);border:1px solid var(--line)}
.km .status{display:inline-flex;align-items:center;gap:5px;font-size:12px}
.km .status i{font-style:normal;font-weight:700}
.km .status.good i{color:var(--good)} .km .status.crit i{color:var(--crit)}
.km .banner{border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:14px;border:1px solid var(--line2);background:var(--panel2)}
.km .banner.err{border-color:#6d2a2a;background:#2a1517;color:#f3cfcf}
.km .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.km .tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.km .tile .l{font:600 10.5px 'Archivo';letter-spacing:.08em;text-transform:uppercase;color:var(--ink3)}
.km .tile .v{font:600 22px 'IBM Plex Mono';margin-top:6px}
.km .tile .s{font-size:12px;color:var(--ink2);margin-top:3px}
.km h2{font-size:15px;margin:0 0 10px;font-weight:700;letter-spacing:.02em}
.km h3{font:600 11px 'Archivo';letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);margin:0 0 8px}
.km .note{font-size:12px;color:var(--ink3);line-height:1.5}
.km details summary{cursor:pointer;color:var(--ink2);font-size:12.5px}
.km .legend{display:flex;gap:14px;font-size:12px;color:var(--ink2);margin-bottom:6px}
.km .legend span{display:inline-flex;align-items:center;gap:6px}
.km .sw{width:12px;height:3px;border-radius:2px;display:inline-block}
.km .tip{position:absolute;pointer-events:none;background:#0b0d10;border:1px solid var(--line2);border-radius:6px;padding:6px 9px;font-size:12px;color:var(--ink);white-space:nowrap;z-index:2}
.km a{color:var(--s1)}
@media (max-width:640px){ .km .brand a{margin-left:0} .km .tile .v{font-size:19px} }
`;

/* ================= APP ================= */
export default function MentionsDesk() {
  const [tab, setTab] = useState("board");
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [storageMode, setStorageMode] = useState("server");
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState({});
  const [seriesIdx, setSeriesIdx] = useState({});        // ticker → {company, syncedAt, n}
  const [hist, setHist] = useState({});                  // series → rows
  const [model, setModel] = useState(null);              // adopted coefficients
  const [txIdx, setTxIdx] = useState({});                // company → {calls:[...]}
  const [claude, setClaude] = useState({});              // eventTicker → forecast
  const [bets, setBets] = useState([]);
  const [openEvents, setOpenEvents] = useState([]);
  const [openAt, setOpenAt] = useState(null);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState("");

  const P = useMemo(() => ({ ...DEFAULTS, ...settings }), [settings]);
  const coefs = useMemo(() => (model?.coefN ? model : { coefN: priorCoefN(), coefM: priorCoefM(P) }), [model, P]);
  const history = useMemo(() => Object.values(hist).flat(), [hist]);

  useEffect(() => {
    (async () => {
      try {
        setStorageMode(await probeStorage());
        api("/api/mentions/status").then(setStatus).catch(() => setStatus(null));
        const [s, idx, mdl, b, histItems, txItems, clItems] = await Promise.all([
          loadKey(K.settings, {}), loadKey(K.series, {}), loadKey(K.model, null), loadKey(K.bets, []),
          loadPrefix(K.hist), loadPrefix(K.txIdx), loadPrefix(K.claude),
        ]);
        setSettings(s); setSeriesIdx(idx); setModel(mdl); setBets(b);
        setHist(Object.fromEntries(histItems.map(([k, v]) => [k.slice(K.hist.length), unpackHistory(v.rows)])));
        setTxIdx(Object.fromEntries(txItems.map(([k, v]) => [k.slice(K.txIdx.length), v])));
        setClaude(Object.fromEntries(clItems.map(([k, v]) => [k.slice(K.claude.length), v])));
      } catch (e) { setErr(e.message); }
      setReady(true);
    })();
  }, []);

  const run = async (label, fn) => {
    setBusy(label); setErr("");
    try { await fn(); } catch (e) { setErr(e.message || String(e)); }
    setBusy("");
  };

  const refreshOpen = () => run("Loading open markets…", async () => {
    const evs = await discoverOpenEarningsEvents(kget);
    const list = evs
      .map((ev) => ({ eventTicker: ev.event_ticker, series: ev.series_ticker, title: ev.title, markets: (ev.markets || []).map((m) => normalizeMarket(m, ev)).filter((m) => m.status !== "settled") }))
      .filter((e) => e.markets.length)
      .map((e) => ({ ...e, company: e.markets[0].company, companyName: e.markets[0].companyName, date: e.markets[0].date }))
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    setOpenEvents(list); setOpenAt(new Date());
    const idx = { ...seriesIdx };
    for (const e of list) idx[e.series] = { ...(idx[e.series] || {}), company: e.company, name: e.companyName };
    setSeriesIdx(idx); await saveKey(K.series, idx);
    setMsg(`${list.length} open earnings-mention events.`);
  });

  const syncHistory = () => run("Syncing settled history…", async () => {
    let tickers = new Set(Object.keys(seriesIdx));
    for (const s of await listEarningsSeries(kget).catch(() => [])) tickers.add(s.ticker);
    for (const e of openEvents) tickers.add(e.series);
    tickers = [...tickers].filter(isEarningsMention);
    if (!tickers.length) throw new Error("No earnings-mention series found yet — load open markets first.");
    const idx = { ...seriesIdx };
    const next = { ...hist };
    let done = 0, added = 0;
    const lim = pLimit(2);
    await Promise.all(tickers.map((t) => lim(async () => {
      const prev = next[t] || [];
      const known = new Set(prev.map((r) => r.eventTicker));
      try {
        const rows = await syncSeriesHistory(kget, t, { known });
        if (rows.length || !idx[t]?.syncedAt) {
          const all = [...prev, ...rows];
          next[t] = all; added += rows.length;
          await saveKey(K.hist + t, { syncedAt: new Date().toISOString(), rows: packHistory(all) });
        }
        idx[t] = { ...(idx[t] || {}), company: t.slice(EARNINGS_PREFIX.length), syncedAt: new Date().toISOString(), n: (next[t] || []).length };
      } catch (e) { idx[t] = { ...(idx[t] || {}), error: e.message }; }
      done++;
      setBusy(`Syncing settled history… ${done}/${tickers.length} companies, +${added} markets`);
    })));
    setHist(next); setSeriesIdx(idx); await saveKey(K.series, idx);
    setMsg(`History synced: +${added} settled markets across ${tickers.length} companies.`);
  });

  const persistSettings = async (s) => { setSettings(s); await saveKey(K.settings, s); };
  const persistBets = async (b) => { setBets(b); await saveKey(K.bets, b); };
  const persistModel = async (m) => { setModel(m); await saveKey(K.model, m); };
  const persistClaude = async (ev, f) => { setClaude((c) => ({ ...c, [ev]: f })); await saveKey(K.claude + ev, f); };
  const persistTxIdx = async (co, v) => { setTxIdx((t) => ({ ...t, [co]: v })); await saveKey(K.txIdx + co, v); };

  const openEvent = (e) => { setSelected(e.eventTicker); setTab("event"); };
  const current = openEvents.find((e) => e.eventTicker === selected) || null;

  const tabs = [["board", "Board"], ["event", "Event"], ["backtest", "Backtest"], ["portfolio", "Portfolio"], ["bets", "Bets"], ["settings", "Settings"]];
  return (
    <div className="km">
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <header>
        <div className="wrap">
          <div className="brand">
            <h1>Mention Desk</h1>
            <span className="sub">Kalshi earnings-call mention markets</span>
            <a href="/">← Saratoga desk</a>
          </div>
          <nav aria-label="Sections">
            {tabs.map(([k, l]) => <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{l}</button>)}
          </nav>
        </div>
      </header>
      <main className="wrap">
        {storageMode === "browser" && <div className="banner">Database unavailable — saving to this browser only. Attach Postgres (README) to persist across devices.</div>}
        {err && <div className="banner err" role="alert">{err} <button className="btn3" onClick={() => setErr("")} style={{ marginLeft: 8 }}>Dismiss</button></div>}
        {busy && <div className="banner" aria-live="polite">{busy}</div>}
        {!busy && msg && <div className="banner" aria-live="polite">{msg}</div>}
        {!ready ? <div className="note">Loading…</div> : (
          <>
            {tab === "board" && <Board {...{ openEvents, openAt, history, seriesIdx, txIdx, claude, coefs, P, model, busy, refreshOpen, syncHistory, openEvent }} />}
            {tab === "event" && <EventView key={selected || "none"} {...{ ev: current, history, txIdx, claude, coefs, P, bets, persistBets, persistClaude, persistTxIdx, setErr, setMsg, setOpenEvents, run, busy }} />}
            {tab === "backtest" && <Backtest {...{ history, txIdx, P, model, persistModel, run, busy }} />}
            {tab === "portfolio" && <Portfolio {...{ status, openEvents, history, txIdx, claude, coefs, P, run, busy, openEvent }} />}
            {tab === "bets" && <Bets {...{ bets, persistBets, run, busy }} />}
            {tab === "settings" && <Settings {...{ settings, persistSettings, status, storageMode, setMsg }} />}
          </>
        )}
      </main>
    </div>
  );
}

/* ================= BOARD ================= */
function Board({ openEvents, openAt, history, seriesIdx, txIdx, claude, coefs, P, model, busy, refreshOpen, syncHistory, openEvent }) {
  const rows = useMemo(() => {
    const statsByDate = new Map();
    return openEvents.map((e) => {
      if (!statsByDate.has(e.date)) statsByDate.set(e.date, HistoryStats.from(history, e.date));
      const a = analyzeEvent(e, { stats: statsByDate.get(e.date), calls: txIdx[e.company]?.calls, claude: claude[e.eventTicker], coefs, P });
      const best = a.filter((x) => x.best).sort((x, y) => y.best.edge - x.best.edge)[0];
      return { e, a, best, live: a.filter((x) => x.live).length, vol: e.markets.reduce((s, m) => s + (m.volume || 0), 0) };
    });
  }, [openEvents, history, txIdx, claude, coefs, P]);

  const companies = new Set(history.map((r) => r.company)).size;
  return (
    <div className="grid">
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row">
            <button className="btn" onClick={refreshOpen} disabled={!!busy}>Load open markets</button>
            <button className="btn2" onClick={syncHistory} disabled={!!busy}>Sync settled history</button>
          </div>
          <div className="note mono">
            {history.length.toLocaleString()} settled markets · {companies} companies · blend {model?.coefN ? `fitted on ${model.nM?.toLocaleString()} rows` : "default weights"}
            {openAt ? ` · prices ${openAt.toLocaleTimeString()}` : ""}
          </div>
        </div>
        {!history.length && <p className="note" style={{ marginBottom: 0 }}>Start with <b>Sync settled history</b>: it trains the prior on every settled earnings-mention market. Until then each term starts from a 50/50 prior and leans on the market price.</p>}
      </div>
      {!openEvents.length ? (
        <div className="panel note">No open events loaded. Press <b>Load open markets</b>.</div>
      ) : (
        <div className="tbl">
          <table>
            <thead><tr><th>Call</th><th>Company</th><th className="num">Terms</th><th className="num">Volume</th><th>Best opportunity</th><th className="num">Edges ≥ {Math.round(P.minEdge * 100)}¢</th><th>Signals</th></tr></thead>
            <tbody>
              {rows.map(({ e, best, live, vol }) => (
                <tr key={e.eventTicker} className="click" onClick={() => openEvent(e)} tabIndex={0} onKeyDown={(k) => k.key === "Enter" && openEvent(e)}>
                  <td className="mono">{fmtDate(e.date)}</td>
                  <td><b>{e.companyName}</b> <span className="muted mono">{e.company}</span></td>
                  <td className="num mono">{e.markets.length}</td>
                  <td className="num mono">{vol.toLocaleString()}</td>
                  <td>{best?.live ? <><span className="chip buy">{best.best.side.toUpperCase()}</span> {best.m.term} <span className="mono">{edgeC(best.best.edge)}</span></> : <span className="muted">none above threshold</span>}</td>
                  <td className="num mono">{live}</td>
                  <td className="muted mono">{txIdx[e.company]?.calls?.length ? `T×${txIdx[e.company].calls.length}` : "T–"} {claude[e.eventTicker] ? "C✓" : "C–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ================= EVENT ================= */
function EventView({ ev, history, txIdx, claude, coefs, P, bets, persistBets, persistClaude, persistTxIdx, setErr, setMsg, setOpenEvents, run, busy }) {
  const [texts, setTexts] = useState({});          // date → parsed transcript
  const [exclAnalysts, setExclAnalysts] = useState(true);
  const [adding, setAdding] = useState(false);
  const [logging, setLogging] = useState(null);
  const [sort, setSort] = useState("edge");
  const company = ev?.company;
  const idx = txIdx[company] || { calls: [] };

  useEffect(() => {
    if (!company) return;
    let alive = true;
    (async () => {
      const out = {};
      for (const c of idx.calls) {
        try {
          const t = await loadKey(`${K.tx}${company}:${c.date}`, null);
          if (t?.text) out[c.date] = parseTranscript(t.text);
        } catch { /* index-only */ }
      }
      if (alive) setTexts(out);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, idx.calls.length]);

  const termsByKey = useMemo(() => {
    const m = new Map();
    for (const r of history) if (r.company === company) m.set(r.termKey, r.term);
    for (const r of ev?.markets || []) m.set(r.termKey, r.term);
    return m;
  }, [history, company, ev]);

  const stats = useMemo(() => (ev ? HistoryStats.from(history, ev.date) : null), [history, ev]);
  const calls = useMemo(() => idx.calls.map((c) => ({ ...c, parsed: texts[c.date] || null })), [idx.calls, texts]);
  const rows = useMemo(() => {
    if (!ev) return [];
    const a = analyzeEvent(ev, { stats, calls, claude: claude[ev.eventTicker], coefs, P, excludeAnalysts: exclAnalysts });
    return sort === "term" ? a.sort((x, y) => x.m.term.localeCompare(y.m.term)) : a.sort((x, y) => (y.best?.edge ?? -9) - (x.best?.edge ?? -9));
  }, [ev, stats, calls, claude, coefs, P, exclAnalysts, sort]);

  if (!ev) return <div className="panel note">Pick an event on the Board.</div>;
  const fc = claude[ev.eventTicker];

  const refresh = () => run("Refreshing prices…", async () => {
    const fresh = await fetchEvent(kget, ev.eventTicker);
    const markets = fresh.markets.map((m) => normalizeMarket(m, fresh)).filter((m) => m.status !== "settled");
    setOpenEvents((list) => list.map((e) => (e.eventTicker === ev.eventTicker ? { ...e, markets } : e)));
  });

  const saveTranscript = async ({ date, quarter, url, text }) => {
    const parsed = parseTranscript(text);
    await saveKey(`${K.tx}${company}:${date}`, { date, quarter, url, text });
    const entry = { date, quarter, url, words: parsed.words, counts: countsForTerms(parsed, termsByKey) };
    const next = { calls: [...idx.calls.filter((c) => c.date !== date), entry].sort((a, b) => b.date.localeCompare(a.date)) };
    await persistTxIdx(company, next);
    setTexts((t) => ({ ...t, [date]: parsed }));
    return parsed;
  };

  const findTranscripts = () => run("Asking Claude for transcript links…", async () => {
    const found = await api("/api/mentions/claude", { method: "POST", body: { task: "find_transcripts", companyName: ev.companyName, company, before: ev.date, n: P.txMaxCalls } });
    const have = new Set(idx.calls.map((c) => c.date));
    const todo = found.calls.filter((c) => !have.has(c.date));
    const failed = [];
    let ok = 0;
    for (const c of todo) {
      try {
        const page = await api("/api/mentions/transcript", { method: "POST", body: { url: c.url } });
        if (!page.looksLikeTranscript) throw new Error("page doesn't look like a full transcript");
        await saveTranscript({ ...c, url: page.url, text: page.text });
        ok++;
      } catch (e) { failed.push(`${c.date} (${e.message})`); }
    }
    setMsg(`Transcripts: ${ok} added${found.calls.length - todo.length ? `, ${found.calls.length - todo.length} already loaded` : ""}${failed.length ? ` · failed: ${failed.join("; ")} — use Add transcript to paste these` : ""}.`);
  });

  const askClaude = () => run("Claude is researching this call (≈1–3 min)…", async () => {
    const body = {
      task: "forecast", companyName: ev.companyName, company, date: ev.date, rules: ev.markets[0]?.rules,
      terms: rows.map(({ m, pr }) => ({ term: m.term, prior: { p: pr.pH, nCT: pr.h.nCT, yCT: pr.h.yCT }, tx: pr.t })),
    };
    const f = await api("/api/mentions/claude", { method: "POST", body });
    await persistClaude(ev.eventTicker, f);
    setMsg(`Claude forecast saved for ${Object.keys(f.probs).length} terms.`);
  });

  const logBet = async (row, side, price, contracts) => {
    const bet = { id: `${Date.now()}-${row.m.ticker}`, at: new Date().toISOString(), ticker: row.m.ticker, eventTicker: ev.eventTicker, company, term: row.m.term, side, price, contracts, p: side === "yes" ? row.pr.pFinal : 1 - row.pr.pFinal, status: "open" };
    await persistBets([bet, ...bets]);
    setLogging(null); setMsg(`Logged ${contracts} ${side.toUpperCase()} ${row.m.term} @ ${cents(price)}.`);
  };

  const liveRows = rows.filter((r) => r.live);
  return (
    <div className="grid">
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <div>
            <h2 style={{ marginBottom: 2 }}>{ev.companyName} <span className="muted mono">{company}</span></h2>
            <div className="note mono">{fmtDate(ev.date)} · {ev.eventTicker}</div>
          </div>
          <div className="row">
            <button className="btn2" onClick={refresh} disabled={!!busy}>Refresh prices</button>
            <button className="btn2" onClick={findTranscripts} disabled={!!busy}>Find transcripts</button>
            <button className="btn2" onClick={() => setAdding((a) => !a)}>Add transcript</button>
            <button className="btn" onClick={askClaude} disabled={!!busy}>Ask Claude</button>
          </div>
        </div>
        <div className="tiles" style={{ marginTop: 14 }}>
          <Tile l="Terms" v={ev.markets.length} s={`${liveRows.length} with edge ≥ ${Math.round(P.minEdge * 100)}¢`} />
          <Tile l="Transcripts" v={idx.calls.length} s={idx.calls.length ? `latest ${fmtDate(idx.calls[0].date)}` : "none loaded"} />
          <Tile l="Claude" v={fc ? "✓" : "—"} s={fc ? `${new Date(fc.at).toLocaleString()} · weight ${P.wClaude}` : "not asked yet"} />
          <Tile l="Suggested stake" v={money(liveRows.reduce((s, r) => s + r.contracts * r.best.cost, 0))} s={`${P.kellyFraction}× Kelly on ${money(P.bankroll)}`} />
        </div>
        {fc?.themes?.length ? <p className="note" style={{ marginBottom: 0 }}>Claude's themes: {fc.themes.join(" · ")}</p> : null}
      </div>

      {adding && <AddTranscript onSave={async (t) => { await saveTranscript(t); setAdding(false); setMsg(`Transcript for ${t.date} added.`); }} setErr={setErr} before={ev.date} />}

      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row note">
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={exclAnalysts} onChange={(e) => setExclAnalysts(e.target.checked)} /> Exclude analyst speech from transcript counts</label>
        </div>
        <label className="row note" style={{ gap: 6 }}>Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}><option value="edge">by edge</option><option value="term">by term</option></select>
        </label>
      </div>

      <div className="tbl">
        <table>
          <thead>
            <tr>
              <th>Term</th><th className="num">Bid / Ask</th><th className="num" title="Kalshi history prior">H</th><th className="num" title="Transcript signal">T</th>
              <th className="num" title="Claude">C</th><th className="num" title="Model without market">Model</th><th className="num">Final</th><th>Best side</th><th className="num">Edge</th><th className="num">Stake</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <FragmentRow key={r.m.ticker} r={r} P={P} logging={logging === r.m.ticker} onLog={() => setLogging(logging === r.m.ticker ? null : r.m.ticker)} onSave={logBet} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">H = Kalshi history prior (this company's record on the term / markets seen). T = transcript signal (calls mentioning it / calls loaded, avg per call). C = Claude. Final blends these with the market mid using the adopted weights; edge is after Kalshi's taker fee.</p>

      {idx.calls.length > 0 && (
        <div className="panel">
          <h3>Transcripts loaded</h3>
          <div className="tbl"><table>
            <thead><tr><th>Call date</th><th>Quarter</th><th className="num">Words</th><th>Source</th></tr></thead>
            <tbody>{idx.calls.map((c) => (
              <tr key={c.date}><td className="mono">{fmtDate(c.date)}</td><td>{c.quarter || "—"}</td><td className="num mono">{c.words?.toLocaleString() ?? "—"}</td><td>{c.url ? <a href={c.url} target="_blank" rel="noreferrer">{new URL(c.url).hostname}</a> : <span className="muted">pasted</span>}</td></tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
      {ev.markets[0]?.rules && <details className="panel"><summary>Resolution rules</summary><p className="note" style={{ whiteSpace: "pre-wrap" }}>{ev.markets[0].rules}{ev.markets[0].rules2 ? `\n\n${ev.markets[0].rules2}` : ""}</p></details>}
    </div>
  );
}

function FragmentRow({ r, P, logging, onLog, onSave }) {
  const { m, pr, best, live, contracts, why } = r;
  const [side, setSide] = useState(best?.side || "yes");
  const [price, setPrice] = useState(best ? Math.round(best.price * 100) : 50);
  const [qty, setQty] = useState(contracts || 10);
  return (
    <>
      <tr>
        <td><b>{m.term}</b></td>
        <td className="num mono">{cents(m.bid)} / {cents(m.ask)}</td>
        <td className="num mono" title={`company ${pr.h.yCT}/${pr.h.nCT} · term elsewhere ${pct(pr.h.pTerm)} (n=${pr.h.nTerm})`}>{pct(pr.pH)}<span className="muted"> {pr.h.nCT ? `${pr.h.yCT}/${pr.h.nCT}` : ""}</span></td>
        <td className="num mono" title={pr.t.calls ? `avg ${num(pr.t.mean, 1)}/call, last call ${pr.t.last}` : "no transcripts"}>{pr.t.calls ? <>{pct(pr.pT)}<span className="muted"> {pr.t.hits}/{pr.t.calls}</span></> : <span className="muted">—</span>}</td>
        <td className="num mono" title={why}>{pr.pC != null ? pct(pr.pC) : <span className="muted">—</span>}</td>
        <td className="num mono">{pct(pr.pModel)}</td>
        <td className="num mono"><b>{pct(pr.pFinal)}</b></td>
        <td>{best ? <span className={`chip ${live ? "buy" : "flat"}`}>{best.side.toUpperCase()} @ {cents(best.price)}</span> : <span className="muted">no book</span>}</td>
        <td className="num mono">{best ? edgeC(best.edge) : "—"}</td>
        <td className="num mono">{live ? `${contracts} · ${money(contracts * best.cost)}` : <span className="muted">—</span>}</td>
        <td><button className="btn3" onClick={onLog}>{logging ? "Cancel" : "Log"}</button></td>
      </tr>
      {logging && (
        <tr><td colSpan={11} style={{ background: "var(--panel2)" }}>
          <div className="row">
            <label className="f">Side<select value={side} onChange={(e) => setSide(e.target.value)}><option value="yes">YES</option><option value="no">NO</option></select></label>
            <label className="f">Price (¢)<input type="number" min={1} max={99} value={price} onChange={(e) => setPrice(+e.target.value)} style={{ width: 80 }} /></label>
            <label className="f">Contracts<input type="number" min={1} value={qty} onChange={(e) => setQty(+e.target.value)} style={{ width: 90 }} /></label>
            <span className="note" style={{ alignSelf: "end" }}>fee {money(orderFee(qty, price / 100, P.feeRate))}</span>
            <button className="btn" style={{ alignSelf: "end" }} onClick={() => onSave(r, side, price / 100, qty)} disabled={!(price > 0 && price < 100 && qty > 0)}>Save bet</button>
          </div>
        </td></tr>
      )}
    </>
  );
}

function AddTranscript({ onSave, setErr, before }) {
  const [mode, setMode] = useState("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [date, setDate] = useState("");
  const [quarter, setQuarter] = useState("");
  const [working, setWorking] = useState(false);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && date < before && (mode === "url" ? /^https?:\/\//.test(url) : text.length > 500);
  const save = async () => {
    setWorking(true); setErr("");
    try {
      let body = text;
      let src = "";
      if (mode === "url") {
        const page = await api("/api/mentions/transcript", { method: "POST", body: { url } });
        if (!page.looksLikeTranscript) throw new Error("That page doesn't look like a full transcript. Paste the text instead.");
        body = page.text; src = page.url;
      }
      await onSave({ date, quarter, url: src, text: body });
    } catch (e) { setErr(e.message); }
    setWorking(false);
  };
  return (
    <div className="panel grid">
      <div className="row">
        <h3 style={{ margin: 0 }}>Add a prior-call transcript</h3>
        <select value={mode} onChange={(e) => setMode(e.target.value)}><option value="url">From URL</option><option value="paste">Paste text</option></select>
      </div>
      <div className="row">
        <label className="f">Call date<input type="date" value={date} max={before} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="f">Quarter<input value={quarter} placeholder="Q2 FY2026" onChange={(e) => setQuarter(e.target.value)} /></label>
        {mode === "url" && <label className="f" style={{ flex: 1, minWidth: 240 }}>Transcript URL<input value={url} placeholder="https://www.fool.com/earnings/call-transcripts/…" onChange={(e) => setUrl(e.target.value)} /></label>}
      </div>
      {mode === "paste" && <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the full transcript, speaker labels included…" />}
      <div className="row"><button className="btn" onClick={save} disabled={!valid || working}>{working ? "Saving…" : "Save transcript"}</button>
        <span className="note">Only calls before {fmtDate(before)} are used, so the model never sees the call it's predicting.</span></div>
    </div>
  );
}

// Tooltips anchor away from the nearest edge so they never spill out of the panel.
const tipStyle = (left, top) => ({ left: `${left}%`, top: `${top}%`, transform: `translate(${left < 30 ? "-8%" : left > 70 ? "-92%" : "-50%"}, -112%)` });

const Tile = ({ l, v, s }) => <div className="tile"><div className="l">{l}</div><div className="v">{v}</div>{s ? <div className="s">{s}</div> : null}</div>;

/* ================= BACKTEST ================= */
function Backtest({ history, txIdx, P, model, persistModel, run, busy }) {
  const [res, setRes] = useState(null);
  const go = () => run("Running walk-forward backtest…", async () => {
    await new Promise((r) => setTimeout(r, 30)); // let the banner paint
    const rows = history.map((r) => ({ ...r, tx: (txIdx[r.company]?.calls || []).flatMap((c) => (Number.isFinite(c.counts?.[r.termKey]) ? [{ date: c.date, count: c.counts[r.termKey] }] : [])) }));
    setRes(walkForward(rows, P));
  });
  const adopt = () => run("Saving weights…", async () => {
    await persistModel({ ...res.coefs, fittedAt: new Date().toISOString(), brier: res.metrics.priced.final.brier, marketBrier: res.metrics.priced.market.brier });
  });

  if (!history.length) return <div className="panel note">Sync settled history on the Board first — the backtest replays every settled earnings-mention market in date order.</div>;
  const m = res?.metrics;
  const skill = m && m.priced.market.brier != null ? m.priced.market.brier - m.priced.final.brier : null;
  return (
    <div className="grid">
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <button className="btn" onClick={go} disabled={!!busy}>Run walk-forward backtest</button>
          <span className="note mono">{history.length.toLocaleString()} settled markets · min edge {edgeC(P.minEdge)} · {P.kellyFraction}× Kelly · current blend: {model?.fittedAt ? `fitted ${new Date(model.fittedAt).toLocaleDateString()}` : "defaults"}</span>
        </div>
        <p className="note" style={{ marginBottom: 0 }}>Each call date is predicted using only markets settled before it and transcripts of earlier calls; prices are the last quote before midnight ET on the call date. Claude is excluded here because its training data overlaps these calls.</p>
      </div>
      {res && (
        <>
          <div className="tiles">
            <Tile l="Markets scored" v={res.counts.scored.toLocaleString()} s={`${res.counts.events} calls · ${res.counts.priced.toLocaleString()} with a price`} />
            <Tile l="Brier · model + market" v={num(m.priced.final.brier, 4)} s={`market alone ${num(m.priced.market.brier, 4)}`} />
            <Tile l="Skill vs market" v={skill == null ? "—" : `${skill >= 0 ? "+" : "−"}${Math.abs(skill).toFixed(4)}`} s={skill == null ? "" : skill > 0 ? "lower Brier than price alone" : "price alone is better"} />
            <Tile l="Flat-stake ROI" v={pct(res.trading.flatRoi, 1)} s={`${res.trading.bets} bets · ${money(res.trading.flatPnl)}`} />
            <Tile l="Kelly P&L" v={money(res.trading.kellyPnl)} s={`from ${money(P.bankroll)} · ROI ${pct(res.trading.kellyRoi, 1)}`} />
          </div>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))" }}>
            <div className="panel">
              <h3>Calibration (markets with a price)</h3>
              <CalibrationChart series={[{ name: "Model + market", color: "var(--s1)", bins: res.calibration.final }, { name: "Market price", color: "var(--s2)", bins: res.calibration.market }]} />
            </div>
            <div className="panel">
              <h3>Bankroll ({P.kellyFraction}× Kelly)</h3>
              <EquityChart points={res.equity} start={P.bankroll} />
            </div>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))" }}>
            <div className="panel">
              <h3>Accuracy by signal</h3>
              <div className="tbl"><table>
                <thead><tr><th>Signal</th><th className="num">Brier</th><th className="num">Log loss</th><th className="num">n</th></tr></thead>
                <tbody>
                  {[["All markets · H (history prior)", m.all.H], ["All markets · T (transcripts)", m.all.T], ["All markets · Model (no price)", m.all.model], ["Priced · Market", m.priced.market], ["Priced · Model + market", m.priced.final]].map(([l, s]) => (
                    <tr key={l}><td>{l}</td><td className="num mono">{num(s.brier, 4)}</td><td className="num mono">{num(s.logloss, 4)}</td><td className="num mono">{s.n.toLocaleString()}</td></tr>
                  ))}
                </tbody>
              </table></div>
              <p className="note">YES base rate {pct(res.baseRate, 1)}. Always guessing the base rate scores {num(res.baseRate * (1 - res.baseRate), 4)}.</p>
            </div>
            <div className="panel">
              <h3>Fitted blend (all data)</h3>
              <div className="tbl"><table>
                <thead><tr><th>Feature</th><th className="num">No price</th><th className="num">With price</th></tr></thead>
                <tbody>
                  {["Intercept", "logit H", "logit T − logit H", "logit market"].map((f, i) => (
                    <tr key={f}><td>{f}</td><td className="num mono">{num(res.coefs.coefN[i], 3)}</td><td className="num mono">{num(res.coefs.coefM[i], 3)}</td></tr>
                  ))}
                </tbody>
              </table></div>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn" onClick={adopt} disabled={!!busy}>Use these weights live</button>
                <span className="note">fitted on {res.coefs.nM.toLocaleString()} priced rows</span>
              </div>
              {res.counts.withTx === 0 && <p className="note" style={{ marginBottom: 0 }}>No backtest market had transcripts for earlier calls, so the transcript weight stays at its default. Load transcripts for companies to let it be learned.</p>}
            </div>
          </div>
          {res.bets.length > 0 && (
            <details className="panel"><summary>Simulated bets ({res.bets.length})</summary>
              <div className="tbl" style={{ marginTop: 10, maxHeight: 420, overflowY: "auto" }}><table>
                <thead><tr><th>Date</th><th>Company</th><th>Term</th><th>Side</th><th className="num">Price</th><th className="num">p</th><th className="num">Edge</th><th>Result</th><th className="num">Flat P&L</th></tr></thead>
                <tbody>{res.bets.slice(-300).reverse().map((b) => (
                  <tr key={b.ticker}><td className="mono">{b.date}</td><td className="mono">{b.company}</td><td>{b.term}</td><td>{b.side.toUpperCase()}</td><td className="num mono">{cents(b.price)}</td><td className="num mono">{pct(b.p)}</td><td className="num mono">{edgeC(b.edge)}</td>
                    <td><span className={`status ${b.won ? "good" : "crit"}`}><i>{b.won ? "✓" : "✕"}</i>{b.won ? "won" : "lost"}</span></td><td className="num mono">{money(b.flat)}</td></tr>
                ))}</tbody>
              </table></div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/* ================= CHARTS ================= */
function CalibrationChart({ series }) {
  const [tip, setTip] = useState(null);
  const W = 360, H = 300, L = 42, R = 12, T = 12, B = 34;
  const x = (p) => L + p * (W - L - R);
  const y = (p) => T + (1 - p) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const pts = series.map((s) => ({ ...s, pts: s.bins.filter((b) => b.n >= 5) }));
  return (
    <div>
      <div className="legend">{series.map((s) => <span key={s.name}><i className="sw" style={{ background: s.color }} />{s.name}</span>)}<span><i className="sw" style={{ background: "var(--ink3)", height: 1 }} />perfect</span></div>
      <div style={{ position: "relative" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Calibration: predicted probability vs actual YES rate">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
              <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize={10.5} fill="var(--ink3)">{Math.round(t * 100)}%</text>
              <text x={x(t)} y={H - B + 16} textAnchor="middle" fontSize={10.5} fill="var(--ink3)">{Math.round(t * 100)}%</text>
            </g>
          ))}
          <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize={10.5} fill="var(--ink2)">predicted</text>
          {series[0].bins.map((b, i) => {
            const lines = series.map((s) => ({ s, c: s.bins[i] })).filter(({ c }) => c.n >= 5);
            if (!lines.length) return null;
            const top = Math.min(...lines.map(({ c }) => y(c.rate)));
            return (
              <rect key={b.lo} x={x(b.lo)} y={T} width={x(b.hi) - x(b.lo)} height={H - T - B} fill={tip?.i === i ? "var(--panel2)" : "transparent"} fillOpacity={0.5}
                onMouseEnter={() => setTip({ i, left: ((x(b.lo) + x(b.hi)) / 2 / W) * 100, top: (top / H) * 100, lines: lines.map(({ s, c }) => `${s.name}: predicted ${pct(c.meanP, 1)} → actual ${pct(c.rate, 1)} (n=${c.n})`) })}
                onMouseLeave={() => setTip(null)} />
            );
          })}
          <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--ink3)" strokeDasharray="4 4" strokeWidth={1} />
          {pts.map((s) => (
            <g key={s.name}>
              <polyline points={s.pts.map((b) => `${x(b.meanP)},${y(b.rate)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" pointerEvents="none" />
              {s.pts.map((b) => <circle key={b.lo} cx={x(b.meanP)} cy={y(b.rate)} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={2} pointerEvents="none" />)}
            </g>
          ))}
        </svg>
        {tip && <div className="tip" style={tipStyle(tip.left, tip.top)}>{tip.lines.map((l) => <div key={l}>{l}</div>)}</div>}
      </div>
      <details><summary>Table</summary>
        <div className="tbl" style={{ marginTop: 8 }}><table>
          <thead><tr><th>Bin</th>{series.map((s) => <th key={s.name} className="num">{s.name}: predicted → actual (n)</th>)}</tr></thead>
          <tbody>{series[0].bins.map((b, i) => (
            <tr key={b.lo}><td className="mono">{pct(b.lo)}–{pct(b.hi)}</td>{series.map((s) => { const c = s.bins[i]; return <td key={s.name} className="num mono">{c.n ? `${pct(c.meanP, 1)} → ${pct(c.rate, 1)} (${c.n})` : "—"}</td>; })}</tr>
          ))}</tbody>
        </table></div>
      </details>
    </div>
  );
}

function EquityChart({ points, start }) {
  const [hover, setHover] = useState(null);
  const ref = useRef(null);
  if (!points.length) return <div className="note">No bets placed.</div>;
  const W = 420, H = 260, L = 56, R = 12, T = 12, B = 30;
  const vals = points.map((p) => p.bankroll);
  let lo = Math.min(start, ...vals), hi = Math.max(start, ...vals);
  if (hi - lo < 1) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const x = (i) => L + (points.length === 1 ? 0.5 : i / (points.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = Array.from({ length: 4 }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / 4);
  const onMove = (e) => {
    const box = ref.current.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(((px - L) / (W - L - R)) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };
  const h = hover != null ? points[hover] : null;
  return (
    <div style={{ position: "relative" }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Simulated bankroll over time" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--line)" /><text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize={10.5} fill="var(--ink3)">${Math.round(t).toLocaleString()}</text></g>
        ))}
        <line x1={L} x2={W - R} y1={y(start)} y2={y(start)} stroke="var(--ink3)" strokeDasharray="4 4" />
        <text x={W - R} y={y(start) - 5} textAnchor="end" fontSize={10.5} fill="var(--ink3)">start</text>
        <text x={L} y={H - 8} fontSize={10.5} fill="var(--ink3)">{points[0].date}</text>
        <text x={W - R} y={H - 8} textAnchor="end" fontSize={10.5} fill="var(--ink3)">{points[points.length - 1].date}</text>
        <polyline points={points.map((p, i) => `${x(i)},${y(p.bankroll)}`).join(" ")} fill="none" stroke="var(--s1)" strokeWidth={2} strokeLinejoin="round" />
        {h && <><line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--ink3)" /><circle cx={x(hover)} cy={y(h.bankroll)} r={4.5} fill="var(--s1)" stroke="var(--panel)" strokeWidth={2} /></>}
      </svg>
      {h && <div className="tip" style={tipStyle((x(hover) / W) * 100, (y(h.bankroll) / H) * 100)}>{h.date} · {money(h.bankroll)} ({money(h.bankroll - start)})</div>}
    </div>
  );
}

/* ================= PORTFOLIO ================= */
function Portfolio({ status, openEvents, history, txIdx, claude, coefs, P, run, busy, openEvent }) {
  const [data, setData] = useState(null);
  const [quotes, setQuotes] = useState({});
  const [onlyMentions, setOnlyMentions] = useState(true);

  const sync = () => run("Syncing Kalshi portfolio…", async () => {
    const d = await api("/api/kalshi/portfolio?resource=summary");
    setData(d);
    const tickers = (d.market_positions || []).filter((p) => Number(p.position ?? p.position_fp ?? 0) !== 0).map((p) => p.ticker);
    const q = {};
    for (let i = 0; i < tickers.length; i += 50) {
      const res = await kget("/markets", { tickers: tickers.slice(i, i + 50).join(","), limit: 100 });
      for (const m of res?.markets || []) q[m.ticker] = normalizeMarket(m);
    }
    setQuotes(q);
  });

  // Model probability for any position whose event is loaded on the Board.
  const modelP = useMemo(() => {
    const out = {};
    const statsByDate = new Map();
    for (const e of openEvents) {
      if (!statsByDate.has(e.date)) statsByDate.set(e.date, HistoryStats.from(history, e.date));
      for (const a of analyzeEvent(e, { stats: statsByDate.get(e.date), calls: txIdx[e.company]?.calls, claude: claude[e.eventTicker], coefs, P })) out[a.m.ticker] = a.pr.pFinal;
    }
    return out;
  }, [openEvents, history, txIdx, claude, coefs, P]);

  if (status && !status.kalshiKeys) {
    return <div className="panel note">Portfolio sync is off: set <span className="mono">KALSHI_API_KEY_ID</span>, <span className="mono">KALSHI_PRIVATE_KEY</span> and <span className="mono">DASHBOARD_TOKEN</span> on the server (README → Portfolio sync), then enter the token under Settings. Sync is read-only — it can't place orders.</div>;
  }
  const positions = (data?.market_positions || []).filter((p) => Number(p.position ?? p.position_fp ?? 0) !== 0 && (!onlyMentions || isEarningsMention(p.ticker)));
  const settlements = (data?.settlements || []).filter((s) => !onlyMentions || isEarningsMention(s.ticker));
  const settledPnl = settlements.reduce((sum, s) => sum + ((dollarsOf(s, "revenue") ?? 0) - (dollarsOf(s, "yes_total_cost") ?? 0) - (dollarsOf(s, "no_total_cost") ?? 0)), 0);
  const won = settlements.filter((s) => (dollarsOf(s, "revenue") ?? 0) > (dollarsOf(s, "yes_total_cost") ?? 0) + (dollarsOf(s, "no_total_cost") ?? 0)).length;
  return (
    <div className="grid">
      <div className="panel row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          <button className="btn" onClick={sync} disabled={!!busy}>Sync portfolio</button>
          <label className="row note" style={{ gap: 6 }}><input type="checkbox" checked={onlyMentions} onChange={(e) => setOnlyMentions(e.target.checked)} /> Earnings mentions only</label>
        </div>
        {data && <span className="note mono">synced {new Date(data.fetchedAt).toLocaleTimeString()}</span>}
      </div>
      {data && (
        <>
          <div className="tiles">
            <Tile l="Cash balance" v={money(dollarsOf(data.balance, "balance"))} />
            <Tile l="Portfolio value" v={money(dollarsOf(data.balance, "portfolio_value"))} />
            <Tile l="Open positions" v={positions.length} />
            <Tile l="Settled P&L (before fees)" v={money(settledPnl)} s={`${settlements.length} settled · ${won} profitable`} />
          </div>
          <div className="tbl"><table>
            <thead><tr><th>Market</th><th className="num">Position</th><th className="num">Cost basis</th><th className="num">Bid / Ask</th><th className="num">Mark value</th><th className="num">Model p</th><th>Hold?</th></tr></thead>
            <tbody>
              {positions.length ? positions.map((p) => {
                const pos = Number(p.position ?? p.position_fp);
                const side = pos > 0 ? "yes" : "no";
                const q = quotes[p.ticker];
                const markPx = q ? (side === "yes" ? q.bid : q.ask != null ? 1 - q.ask : null) : null; // exit price
                const mp = modelP[p.ticker];
                const fair = mp == null ? null : side === "yes" ? mp : 1 - mp;
                const ev = openEvents.find((e) => e.eventTicker === parseMarketTicker(p.ticker).eventTicker);
                return (
                  <tr key={p.ticker}>
                    <td>{q?.term || p.ticker} <span className="muted mono">{q?.company || ""}</span></td>
                    <td className="num mono">{Math.abs(pos)} {side.toUpperCase()}</td>
                    <td className="num mono">{money(dollarsOf(p, "market_exposure"))}</td>
                    <td className="num mono">{q ? `${cents(q.bid)} / ${cents(q.ask)}` : "—"}</td>
                    <td className="num mono">{markPx != null ? money(markPx * Math.abs(pos)) : "—"}</td>
                    <td className="num mono">{mp != null ? pct(mp) : <span className="muted" title="Load open markets on the Board to score this position">—</span>}</td>
                    <td>{fair == null || markPx == null ? <span className="muted">—</span> : fair > markPx ? <span className="status good"><i>▲</i>hold · fair {cents(fair)}</span> : <span className="status crit"><i>▼</i>sell · fair {cents(fair)}</span>}
                      {ev && <button className="btn3" style={{ marginLeft: 8 }} onClick={() => openEvent(ev)}>Open</button>}</td>
                  </tr>
                );
              }) : <tr><td colSpan={7} className="muted">No open positions.</td></tr>}
            </tbody>
          </table></div>
          {settlements.length > 0 && (
            <details className="panel"><summary>Settlements ({settlements.length})</summary>
              <div className="tbl" style={{ marginTop: 8 }}><table>
                <thead><tr><th>Settled</th><th>Market</th><th>Result</th><th className="num">Cost</th><th className="num">Revenue</th><th className="num">P&L</th></tr></thead>
                <tbody>{settlements.slice(0, 300).map((s) => {
                  const cost = (dollarsOf(s, "yes_total_cost") ?? 0) + (dollarsOf(s, "no_total_cost") ?? 0);
                  const rev = dollarsOf(s, "revenue") ?? 0;
                  return <tr key={`${s.ticker}-${s.settled_time}`}><td className="mono">{String(s.settled_time || "").slice(0, 10)}</td><td className="mono">{s.ticker}</td><td>{String(s.market_result || "").toUpperCase()}</td><td className="num mono">{money(cost)}</td><td className="num mono">{money(rev)}</td><td className="num mono">{money(rev - cost)}</td></tr>;
                })}</tbody>
              </table></div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/* ================= BETS (paper log) ================= */
function Bets({ bets, persistBets, run, busy }) {
  const grade = () => run("Grading open bets…", async () => {
    const open = bets.filter((b) => b.status === "open");
    const results = {};
    for (let i = 0; i < open.length; i += 50) {
      const res = await kget("/markets", { tickers: open.slice(i, i + 50).map((b) => b.ticker).join(","), limit: 100 });
      for (const m of res?.markets || []) results[m.ticker] = normalizeMarket(m).y;
    }
    await persistBets(bets.map((b) => {
      const y = results[b.ticker];
      if (b.status !== "open" || y == null) return b;
      const won = b.side === "yes" ? y === 1 : y === 0;
      const fee = orderFee(b.contracts, b.price);
      return { ...b, status: won ? "won" : "lost", pnl: (won ? b.contracts : 0) - b.contracts * b.price - fee };
    }));
  });
  const settled = bets.filter((b) => b.status !== "open");
  const pnl = settled.reduce((s, b) => s + (b.pnl || 0), 0);
  const staked = settled.reduce((s, b) => s + b.contracts * b.price, 0);
  return (
    <div className="grid">
      <div className="tiles">
        <Tile l="Open" v={bets.length - settled.length} />
        <Tile l="Settled" v={settled.length} s={`${settled.filter((b) => b.status === "won").length} won`} />
        <Tile l="P&L (after fees)" v={money(pnl)} />
        <Tile l="ROI" v={staked ? pct(pnl / staked, 1) : "—"} s={`on ${money(staked)} staked`} />
      </div>
      <div className="row"><button className="btn" onClick={grade} disabled={!!busy || !bets.some((b) => b.status === "open")}>Grade open bets</button>
        <span className="note">Paper log: bets you record from the Event view, graded against Kalshi's settlement.</span></div>
      <div className="tbl"><table>
        <thead><tr><th>Logged</th><th>Company</th><th>Term</th><th>Side</th><th className="num">Price</th><th className="num">Qty</th><th className="num">p at bet</th><th>Status</th><th className="num">P&L</th><th></th></tr></thead>
        <tbody>{bets.length ? bets.map((b) => (
          <tr key={b.id}><td className="mono">{b.at.slice(0, 10)}</td><td className="mono">{b.company}</td><td>{b.term}</td><td>{b.side.toUpperCase()}</td><td className="num mono">{cents(b.price)}</td><td className="num mono">{b.contracts}</td><td className="num mono">{pct(b.p)}</td>
            <td>{b.status === "open" ? <span className="muted">open</span> : <span className={`status ${b.status === "won" ? "good" : "crit"}`}><i>{b.status === "won" ? "✓" : "✕"}</i>{b.status}</span>}</td>
            <td className="num mono">{b.pnl != null ? money(b.pnl) : "—"}</td>
            <td><button className="btn3" onClick={() => persistBets(bets.filter((x) => x.id !== b.id))} aria-label={`Delete bet on ${b.term}`}>Delete</button></td></tr>
        )) : <tr><td colSpan={10} className="muted">No bets logged yet.</td></tr>}</tbody>
      </table></div>
    </div>
  );
}

/* ================= SETTINGS ================= */
const FIELDS = [
  ["bankroll", "Bankroll ($)", 1], ["kellyFraction", "Kelly fraction", 0.05], ["maxBetPct", "Max bet (% of bankroll, 0–1)", 0.01],
  ["minEdge", "Min edge to bet (probability, e.g. 0.03)", 0.005], ["feeRate", "Taker fee rate", 0.005], ["wClaude", "Claude weight (0–1)", 0.05],
  ["wMarket", "Default market weight before fitting (0–1)", 0.05], ["txMaxCalls", "Transcripts per company (max)", 1],
  ["kCompanyTerm", "Prior strength: company × term", 0.5], ["kTerm", "Prior strength: term across companies", 0.5], ["kCompany", "Prior strength: company", 0.5],
];
function Settings({ settings, persistSettings, status, storageMode, setMsg }) {
  const [draft, setDraft] = useState(() => ({ ...Object.fromEntries(FIELDS.map(([k]) => [k, DEFAULTS[k]])), ...settings }));
  const [token, setToken] = useState(() => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } });
  const save = async () => {
    const clean = Object.fromEntries(FIELDS.map(([k]) => [k, Number(draft[k])]).filter(([, v]) => Number.isFinite(v)));
    await persistSettings(clean);
    try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
    setMsg("Settings saved.");
  };
  const flag = (ok, label) => <span className={`status ${ok ? "good" : "crit"}`}><i>{ok ? "✓" : "✕"}</i>{label}</span>;
  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))" }}>
      <div className="panel grid">
        <h2>Model & sizing</h2>
        {FIELDS.map(([k, l, step]) => (
          <label key={k} className="f">{l}<input type="number" step={step} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} /></label>
        ))}
        <div className="row"><button className="btn" onClick={save}>Save</button><button className="btn2" onClick={() => setDraft(Object.fromEntries(FIELDS.map(([k]) => [k, DEFAULTS[k]])))}>Reset to defaults</button></div>
      </div>
      <div className="grid" style={{ alignContent: "start" }}>
        <div className="panel grid">
          <h2>Server</h2>
          {status ? (
            <div className="grid" style={{ gap: 8 }}>
              {flag(status.db && storageMode === "server", "Postgres storage")}
              {flag(status.claude, "Claude (ANTHROPIC_API_KEY)")}
              {flag(status.kalshiKeys, "Kalshi portfolio keys")}
              {flag(status.tokenRequired, "Dashboard token set")}
            </div>
          ) : <div className="note">Status unavailable.</div>}
          <label className="f">Dashboard token (stored in this browser)<input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></label>
          <p className="note" style={{ margin: 0 }}>Must match <span className="mono">DASHBOARD_TOKEN</span> on the server. Required for portfolio sync; also gates Claude and transcript fetching when set.</p>
        </div>
        <div className="panel note">
          Prices are probabilities (0.42 = 42¢). Edge = your probability − price − fee. Stake = Kelly fraction × full-Kelly, capped at the max-bet share of bankroll.
        </div>
      </div>
    </div>
  );
}
