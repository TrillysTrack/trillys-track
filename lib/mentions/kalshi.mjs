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
   Kalshi is migrating from integer-cent fields (yes_bid: 45) to dollar strings (yes_bid_dollars:
   "0.4500"). Read the dollar field when present, else cents/100. Returns a probability in [0,1]. */
export function priceField(obj, field) {
  if (!obj) return null;
  const d = obj[`${field}_dollars`];
  if (d != null && d !== "") { const v = Number(d); return Number.isFinite(v) ? v : null; }
  const c = obj[field];
  if (c != null && c !== "") { const v = Number(c); return Number.isFinite(v) ? v / 100 : null; }
  return null;
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
    date: ids.date || (ev.strike_date ? String(ev.strike_date).slice(0, 10) : null),
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

/* ---------- fetch layer ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// get(path, params) → JSON. `base` is either the Kalshi API root (server/CLI) or a proxy URL
// builder (browser). Retries 429/5xx with exponential backoff.
export function makeGetter({ base = KALSHI_BASE, proxy = null, fetchImpl = globalThis.fetch, headers = {} } = {}) {
  async function get(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, String(v));
    let url;
    if (proxy) { qs.set("path", path); url = `${proxy}?${qs}`; }
    else url = `${base}${path}${qs.toString() ? "?" + qs : ""}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { headers: { Accept: "application/json", ...headers } });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(1000 * 2 ** attempt); continue; }
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

// Pre-call prices for every market in an event. Tries the event-level candlestick endpoint
// (one request per event); falls back to per-market candlesticks.
export async function fetchPreCallPrices(get, seriesTicker, eventTicker, marketTickers, refTs, lookbackDays = 5) {
  const start = refTs - lookbackDays * 86400;
  const params = { start_ts: start, end_ts: refTs, period_interval: 60 };
  const out = {};
  try {
    const data = await get(`/series/${seriesTicker}/events/${eventTicker}/candlesticks`, params);
    const tickers = data?.market_tickers || [];
    const sets = data?.market_candlesticks || [];
    tickers.forEach((t, i) => { out[t] = priceAtFromCandles(sets[i], refTs); });
    if (tickers.length) return out;
  } catch { /* fall through to per-market */ }
  const limit = pLimit(3);
  await Promise.all(marketTickers.map((t) => limit(async () => {
    try {
      const d = await get(`/series/${seriesTicker}/markets/${t}/candlesticks`, params);
      out[t] = priceAtFromCandles(d?.candlesticks, refTs);
    } catch { out[t] = { pBid: null, pAsk: null, pMid: null }; }
  })));
  return out;
}

// Full settled history for one company series, with pre-call (prior-day close) prices.
// `known` = event tickers already stored; settled events never change, so they're skipped.
export async function syncSeriesHistory(get, seriesTicker, { withPrices = true, onProgress, known = new Set() } = {}) {
  const events = (await listSeriesEvents(get, seriesTicker, "settled")).filter((ev) => !known.has(ev.event_ticker));
  const rows = [];
  let i = 0;
  for (const ev of events) {
    i++;
    const markets = (ev.markets || []).map((m) => normalizeMarket(m, ev)).filter((r) => r.y != null && r.date);
    if (!markets.length) continue;
    let prices = {};
    if (withPrices) {
      prices = await fetchPreCallPrices(get, seriesTicker, ev.event_ticker, markets.map((r) => r.ticker), etMidnightTs(markets[0].date));
    }
    for (const r of markets) rows.push({ ...r, ...(prices[r.ticker] || { pBid: null, pAsk: null, pMid: null }) });
    onProgress?.({ series: seriesTicker, done: i, total: events.length });
  }
  return rows;
}
