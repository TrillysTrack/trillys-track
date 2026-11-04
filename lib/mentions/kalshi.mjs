/* Kalshi earnings-mention market helpers. Pure functions + a fetch-agnostic sync layer so the
   browser (via /api/kalshi), the server, and the CLI backtest all share one implementation.

   Ticker shape (one series per company, one event per call, one market per term):
     series  KXEARNINGSMENTIONCRCL
     event   KXEARNINGSMENTIONCRCL-26MAY11
     market  KXEARNINGSMENTIONCRCL-26MAY11-KRAK
*/

export const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
export const KALSHI_PATH_PREFIX = "/trade-api/v2";
export const EARNINGS_PREFIX = "KXEARNINGSMENTION";

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const pad2 = (n) => String(n).padStart(2, "0");

// "26MAY11" → "2026-05-11". Returns null for anything that isn't a YYMONDD code.
export function parseDateCode(code) {
  const m = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(String(code || "").toUpperCase());
  if (!m || !MONTHS[m[2]]) return null;
  return `20${m[1]}-${pad2(MONTHS[m[2]])}-${m[3]}`;
}

export function parseEventTicker(eventTicker) {
  const [series, dateCode] = String(eventTicker || "").toUpperCase().split("-");
  const company = series && series.startsWith(EARNINGS_PREFIX) ? series.slice(EARNINGS_PREFIX.length) : null;
  return { series: series || null, company, date: parseDateCode(dateCode) };
}

export function parseMarketTicker(ticker) {
  const parts = String(ticker || "").toUpperCase().split("-");
  const ev = parseEventTicker(parts.slice(0, 2).join("-"));
  return { ...ev, eventTicker: parts.slice(0, 2).join("-"), termCode: parts.slice(2).join("-") || null };
}

export const isEarningsMention = (ticker) => String(ticker || "").toUpperCase().startsWith(EARNINGS_PREFIX);

/* ---------- prices ----------
   Kalshi has moved from integer-cent fields (yes_bid: 45) to dollar strings (yes_bid_dollars:
   "0.4500"). Archived (/historical) payloads go further and put dollar strings in the plain field
   names ("close": "0.4300"). So: a *_dollars field wins; otherwise a decimal string or a
   non-integer number is dollars and an integer is legacy cents. Returns a probability in [0,1]. */
export function priceField(obj, field) {
  if (!obj) return null;
  const d = obj[`${field}_dollars`];
  if (d != null && d !== "") { const v = Number(d); return Number.isFinite(v) ? v : null; }
  const c = obj[field];
  if (c == null || c === "") return null;
  const v = Number(c);
  if (!Number.isFinite(v)) return null;
  return (typeof c === "string" && c.includes(".")) || !Number.isInteger(v) ? v : v / 100;
}

// Contract counts may arrive as integers or fixed-point strings (volume_fp) on newer payloads.
export function countField(obj, field) {
  if (!obj) return 0;
  const v = obj[field] ?? obj[`${field}_fp`];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// A bid of 0 means "no bid" and an ask of 1.00 means "no offer" — treat both as missing so a
// one-sided book doesn't masquerade as a 50¢ mid.
export function quoteOf(m) {
  let bid = priceField(m, "yes_bid");
  let ask = priceField(m, "yes_ask");
  const last = priceField(m, "last_price");
  if (bid != null && bid <= 0) bid = null;
  if (ask != null && ask >= 1) ask = null;
  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  return { bid, ask, last, mid, spread: mid != null ? ask - bid : null };
}

// Best single reference price: mid of a two-sided book, else last trade, else whichever side exists.
export function refPrice(q) {
  if (!q) return null;
  if (q.mid != null && q.spread <= 0.2) return q.mid;
  if (q.last != null && q.last > 0 && q.last < 1) return q.last;
  return q.mid ?? q.bid ?? q.ask ?? null;
}

/* ---------- terms ---------- */
// Pull the mention term out of a market. Kalshi puts it in yes_sub_title / custom_strike; older
// payloads only carry it in the title ("Will Circle say Kraken during ...").
export function termOf(m) {
  if (!m) return "";
  const cs = m.custom_strike;
  if (cs && typeof cs === "object") {
    const v = Object.values(cs).find((x) => typeof x === "string" && x.trim());
    if (v) return v.trim();
  }
  for (const f of ["yes_sub_title", "subtitle"]) {
    const v = m[f];
    if (typeof v === "string" && v.trim() && !/^yes$/i.test(v.trim())) return v.trim();
  }
  const t = String(m.title || "");
  const q = /["“']([^"”']{1,80})["”']/.exec(t);
  if (q) return q[1].trim();
  const s = /\bsay\s+(.+?)\s+(?:during|on|in|at)\b/i.exec(t);
  return s ? s[1].trim() : t.trim();
}

// Canonical key for matching the same term across companies/quarters.
// "Tariffs / Tariff" and "tariff/tariffs" both → "tariff|tariffs".
export function termKey(term) {
  return String(term || "")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/&/g, " and ")
    .split("/")
    .map((s) => s.replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .sort()
    .join("|");
}

export function companyNameOf(ev) {
  const t = String(ev?.title || "");
  const m = /what will (.+?) say\b/i.exec(t) || /will (.+?) say\b/i.exec(t);
  return m ? m[1].replace(/^the\s+/i, "").trim() : (ev?.sub_title || "").trim();
}

const MON3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// "On Aug 27, 2025" / "Feb 25, 2026" → "2025-08-27". Null for "Next earnings call", "Q4 2024", …
export function parseLooseDate(s) {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i.exec(String(s || ""));
  return m ? `${m[3]}-${pad2(MON3[m[1].toLowerCase()])}-${pad2(+m[2])}` : null;
}

const RESULT = { yes: 1, no: 0 };

// Flatten one market (with its parent event) into the row shape the model consumes.
export function normalizeMarket(m, ev = {}) {
  const ids = parseMarketTicker(m.ticker);
  const term = termOf(m);
  const q = quoteOf(m);
  const r = String(m.result || "").toLowerCase();
  return {
    ticker: m.ticker,
    eventTicker: m.event_ticker || ids.eventTicker,
    series: ids.series,
    company: ids.company,
    companyName: companyNameOf(ev) || ids.company,
    date: parseLooseDate(ev.sub_title) || ids.date || (ev.strike_date ? String(ev.strike_date).slice(0, 10) : null),
    term,
    termKey: termKey(term),
    status: m.status || null,
    y: r in RESULT ? RESULT[r] : null,
    ...q,
    volume: countField(m, "volume"),
    openInterest: countField(m, "open_interest"),
    closeTime: m.close_time || null,
    rules: m.rules_primary || "",
    rules2: m.rules_secondary || "",
  };
}

/* ---------- compact storage ----------
   Settled history is stored per series as arrays (not objects) to keep the KV payload small. */
const HCOLS = ["ticker", "eventTicker", "company", "date", "term", "termKey", "y", "pBid", "pAsk", "pMid", "volume"];
export const packHistory = (rows) => rows.map((r) => HCOLS.map((c) => r[c] ?? null));
export const unpackHistory = (packed) =>
  (packed || []).map((a) => Object.fromEntries(HCOLS.map((c, i) => [c, a[i]])));

/* ---------- time ---------- */
// Offset (minutes) of a timezone at an instant, via Intl (no tz library needed).
function tzOffsetMinutes(timeZone, utcMs) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - utcMs) / 60000;
}

// Unix seconds for 00:00 America/New_York on a YYYY-MM-DD date. The backtest prices every
// market as of this instant (end of the prior trading day), so no information from the call
// day — including a same-day earnings release — leaks into the "pre-call" price.
export function etMidnightTs(date) {
  const [y, mo, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, 5);
  const off = tzOffsetMinutes("America/New_York", guess);
  return Math.round((Date.UTC(y, mo - 1, d) - off * 60000) / 1000);
}

export function etDateOf(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/* When did a settled call actually happen, and as of when is it safe to read a "pre-call" price?
   Kalshi's event dates are unreliable (e.g. an event ticker dated 26JUN30 that was the Feb 25
   call; a subtitle saying Mar 31 for a November call). The hard fact is the earliest close time
   of any market that resolved YES: a term can only be "said" once the call is under way, so the
   call had started by then. A stated date is trusted only if it's on/before that bound and
   within 3 days of it; otherwise the reference is pushed 48h before the bound. */
export function callTiming(ev, markets) {
  const yes = (markets || []).filter((m) => String(m.result || "").toLowerCase() === "yes" && m.close_time).map((m) => Date.parse(m.close_time)).filter(Number.isFinite);
  const bound = yes.length ? Math.min(...yes) : null;
  const stated = [parseLooseDate(ev?.sub_title), parseEventTicker(ev?.event_ticker).date].filter(Boolean);
  if (bound == null) {
    const d = stated[0] || null;
    return { date: d, refTs: d ? etMidnightTs(d) : null, source: d ? "stated-unverified" : "none" };
  }
  const boundDate = etDateOf(bound);
  const ok = stated.filter((d) => d <= boundDate && dayDiff(d, boundDate) <= 3).sort().pop();
  if (ok) return { date: ok, refTs: Math.min(etMidnightTs(ok), Math.floor(bound / 1000) - 3600), source: "stated" };
  // No trustworthy stated date: date the call a day before the bound (conservative for the
  // as-of history) and read prices 48h before it.
  return { date: etDateOf(bound - 86400000), refTs: Math.floor(bound / 1000) - 48 * 3600, source: "bound" };
}

/* ---------- fetch layer ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// get(path, params) → JSON. `base` is either the Kalshi API root (server/CLI) or a proxy URL
// builder (browser). Requests are spaced at least `minIntervalMs` apart (Kalshi rate-limits
// public reads), and 429/5xx are retried, honouring Retry-After when Kalshi sends it.
export function makeGetter({ base = KALSHI_BASE, proxy = null, fetchImpl = globalThis.fetch, headers = {}, minIntervalMs = 0, maxRetries = 6, onRetry } = {}) {
  let nextSlot = 0;
  const slot = async () => {
    if (!minIntervalMs) return;
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + minIntervalMs;
    if (at > now) await sleep(at - now);
  };
  async function get(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, String(v));
    let url;
    if (proxy) { qs.set("path", path); url = `${proxy}?${qs}`; }
    else url = `${base}${path}${qs.toString() ? "?" + qs : ""}`;
    for (let attempt = 0; ; attempt++) {
      await slot();
      const res = await fetchImpl(url, { headers: { Accept: "application/json", ...headers } });
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const ra = Number(res.headers?.get?.("retry-after"));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30000, 1000 * 2 ** attempt);
        onRetry?.({ status: res.status, path, wait });
        // Push everyone else back too, so a burst doesn't keep tripping the limit.
        nextSlot = Math.max(nextSlot, Date.now() + wait);
        await sleep(wait);
        continue;
      }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      if (!res.ok) {
        const msg = data?.error?.message || data?.error || data?.message || text.slice(0, 200);
        const err = new Error(`Kalshi ${res.status} on ${path}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
        err.status = res.status;
        throw err;
      }
      return data;
    }
  }
  get.viaProxy = !!proxy;
  return get;
}

// Walk a cursor-paginated list endpoint and concatenate `key` arrays.
export async function paginate(get, path, params, key, maxPages = 50) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i++) {
    const data = await get(path, { ...params, ...(cursor ? { cursor } : {}) });
    out.push(...(data?.[key] || []));
    cursor = data?.cursor;
    if (!cursor) break;
  }
  return out;
}

export const pLimit = (max) => {
  let active = 0; const queue = [];
  const next = () => { active--; if (queue.length) queue.shift()(); };
  return (fn) => new Promise((resolve, reject) => {
    const run = () => { active++; fn().then((v) => { next(); resolve(v); }, (e) => { next(); reject(e); }); };
    active < max ? run() : queue.push(run);
  });
};

// All earnings-mention series. /series can be large, so our proxy honours `prefix` to filter
// server-side; when hitting Kalshi directly we filter here.
export async function listEarningsSeries(get) {
  const data = await get("/series", get.viaProxy ? { prefix: EARNINGS_PREFIX } : {});
  return (data?.series || [])
    .filter((s) => isEarningsMention(s.ticker))
    .map((s) => ({ ticker: s.ticker, company: s.ticker.slice(EARNINGS_PREFIX.length), title: s.title || "" }));
}

// One event with its markets. Kalshi returns markets either nested or alongside the event.
export async function fetchEvent(get, eventTicker) {
  const d = await get(`/events/${eventTicker}`, { with_nested_markets: true });
  const ev = d?.event || {};
  return { ...ev, markets: ev.markets || d?.markets || [] };
}

// Open earnings-mention events across the exchange. The scan pages through events WITHOUT
// nested markets (all of Kalshi's open markets would blow past serverless response limits),
// then fetches markets only for the earnings-mention events it finds.
export async function discoverOpenEarningsEvents(get, maxPages = 40) {
  const events = await paginate(get, "/events", { status: "open", limit: 200 }, "events", maxPages);
  const hits = events.filter((e) => isEarningsMention(e.series_ticker || e.event_ticker));
  const limit = pLimit(4);
  return Promise.all(hits.map((e) => limit(async () => {
    try { const ev = await fetchEvent(get, e.event_ticker); return { ...e, ...ev }; }
    catch { return { ...e, markets: [] }; }
  })));
}

export async function listSeriesEvents(get, seriesTicker, status) {
  return paginate(get, "/events", { series_ticker: seriesTicker, status, with_nested_markets: true, limit: 200 }, "events");
}

// Last candle at/before refTs with a usable quote → {pBid, pAsk, pMid}.
export function priceAtFromCandles(candles, refTs) {
  let best = null;
  for (const c of candles || []) {
    const ts = Number(c.end_period_ts);
    if (!Number.isFinite(ts) || ts > refTs) continue;
    if (!best || ts > Number(best.end_period_ts)) {
      const bid = priceField(c.yes_bid, "close");
      const ask = priceField(c.yes_ask, "close");
      if ((bid != null && bid > 0) || (ask != null && ask < 1)) best = c;
    }
  }
  if (!best) return { pBid: null, pAsk: null, pMid: null };
  let pBid = priceField(best.yes_bid, "close");
  let pAsk = priceField(best.yes_ask, "close");
  if (pBid != null && pBid <= 0) pBid = null;
  if (pAsk != null && pAsk >= 1) pAsk = null;
  const pMid = pBid != null && pAsk != null ? (pBid + pAsk) / 2 : (priceField(best.price, "close") ?? pBid ?? pAsk);
  return { pBid, pAsk, pMid };
}

// Pre-call prices for every market in an event. Live markets: the event-level candlestick
// endpoint (one request per event), falling back to per-market. Archived markets (settled
// before Kalshi's historical cutoff): /historical/markets/{ticker}/candlesticks, per market.
export async function fetchPreCallPrices(get, seriesTicker, eventTicker, marketTickers, refTs, { archived = new Set(), lookbackDays = 5 } = {}) {
  const start = refTs - lookbackDays * 86400;
  const params = { start_ts: start, end_ts: refTs, period_interval: 60 };
  const out = {};
  const live = marketTickers.filter((t) => !archived.has(t));
  if (live.length) {
    try {
      const data = await get(`/series/${seriesTicker}/events/${eventTicker}/candlesticks`, params);
      (data?.market_tickers || []).forEach((t, i) => { out[t] = priceAtFromCandles(data.market_candlesticks?.[i], refTs); });
    } catch { /* fall through to per-market */ }
  }
  const limit = pLimit(3);
  await Promise.all(marketTickers.filter((t) => !out[t]).map((t) => limit(async () => {
    const path = archived.has(t) ? `/historical/markets/${t}/candlesticks` : `/series/${seriesTicker}/markets/${t}/candlesticks`;
    try { out[t] = priceAtFromCandles((await get(path, params))?.candlesticks, refTs); }
    catch { out[t] = { pBid: null, pAsk: null, pMid: null }; }
  })));
  return out;
}

// If most of an event's markets are already pinned near 0/1 at the reference time, the
// "pre-call" quote is really post-call; such prices are dropped rather than trusted.
export function looksPostCall(prices) {
  const mids = Object.values(prices).map((p) => p?.pMid).filter((v) => v != null);
  if (mids.length < 4) return false;
  return mids.filter((v) => v <= 0.02 || v >= 0.98).length / mids.length > 0.7;
}

// Full settled history for one company series, with pre-call prices. Combines markets still in
// the live data set (nested under /events) with archived ones (/historical/markets).
// `known` = event tickers already stored; settled events never change, so they're skipped.
export async function syncSeriesHistory(get, seriesTicker, { withPrices = true, onProgress, known = new Set(), historical = true, stats } = {}) {
  const events = await listSeriesEvents(get, seriesTicker, "settled");
  const evMap = new Map(events.map((e) => [e.event_ticker, e]));
  const groups = new Map();
  const archived = new Set();
  const add = (m, isArchived) => {
    if (known.has(m.event_ticker)) return;
    const g = groups.get(m.event_ticker) || { ev: evMap.get(m.event_ticker) || { event_ticker: m.event_ticker, series_ticker: seriesTicker }, markets: [] };
    if (g.markets.some((x) => x.ticker === m.ticker)) return;
    g.markets.push(m);
    if (isArchived) archived.add(m.ticker);
    groups.set(m.event_ticker, g);
  };
  for (const ev of events) for (const m of ev.markets || []) add({ ...m, event_ticker: m.event_ticker || ev.event_ticker }, false);
  if (historical) {
    try { for (const m of await paginate(get, "/historical/markets", { series_ticker: seriesTicker, limit: 1000 }, "markets")) add(m, true); }
    catch (e) { if (e.status !== 404) throw e; }
  }
  const rows = [];
  let i = 0;
  for (const { ev, markets } of groups.values()) {
    i++;
    const timing = callTiming(ev, markets);
    const norm = markets.map((m) => normalizeMarket(m, ev)).filter((r) => r.y != null);
    if (!norm.length || !timing.date) { if (stats) stats.undated = (stats.undated || 0) + 1; continue; }
    let prices = {};
    if (withPrices && timing.refTs) {
      prices = await fetchPreCallPrices(get, seriesTicker, ev.event_ticker, norm.map((r) => r.ticker), timing.refTs, { archived });
      if (looksPostCall(prices)) { prices = {}; if (stats) stats.postCall = (stats.postCall || 0) + 1; }
    }
    if (stats) stats[timing.source] = (stats[timing.source] || 0) + 1;
    for (const r of norm) rows.push({ ...r, date: timing.date, eventDate: r.date, timing: timing.source, ...(prices[r.ticker] || { pBid: null, pAsk: null, pMid: null }) });
    onProgress?.({ series: seriesTicker, done: i, total: groups.size });
  }
  return rows;
}
