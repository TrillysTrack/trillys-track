import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDateCode, parseEventTicker, parseMarketTicker, priceField, quoteOf, refPrice, termOf, termKey,
  normalizeMarket, packHistory, unpackHistory, etMidnightTs, priceAtFromCandles, paginate, makeGetter,
  syncSeriesHistory, companyNameOf, discoverOpenEarningsEvents,
} from "../../lib/mentions/kalshi.mjs";

test("ticker parsing", () => {
  assert.equal(parseDateCode("26MAY11"), "2026-05-11");
  assert.equal(parseDateCode("25OCT28"), "2025-10-28");
  assert.equal(parseDateCode("26XYZ11"), null);
  assert.deepEqual(parseEventTicker("KXEARNINGSMENTIONCRCL-26MAY11"), { series: "KXEARNINGSMENTIONCRCL", company: "CRCL", date: "2026-05-11" });
  const m = parseMarketTicker("KXEARNINGSMENTIONCRCL-26MAY11-KRAK");
  assert.equal(m.eventTicker, "KXEARNINGSMENTIONCRCL-26MAY11");
  assert.equal(m.termCode, "KRAK");
  assert.equal(m.company, "CRCL");
});

test("prices: dollar fields win over cents, one-sided books are not mids", () => {
  assert.equal(priceField({ yes_bid: 45 }, "yes_bid"), 0.45);
  assert.equal(priceField({ yes_bid: 45, yes_bid_dollars: "0.4600" }, "yes_bid"), 0.46);
  assert.equal(priceField({}, "yes_bid"), null);
  const q = quoteOf({ yes_bid: 0, yes_ask: 100, last_price: 30 });
  assert.equal(q.bid, null); assert.equal(q.ask, null); assert.equal(q.mid, null);
  assert.equal(refPrice(q), 0.3);
  const q2 = quoteOf({ yes_bid_dollars: "0.40", yes_ask_dollars: "0.44" });
  assert.ok(Math.abs(q2.mid - 0.42) < 1e-12);
  assert.ok(Math.abs(refPrice(q2) - 0.42) < 1e-12);
});

test("term extraction + canonical keys", () => {
  assert.equal(termOf({ custom_strike: { Word: "Tariff" }, yes_sub_title: "x" }), "Tariff");
  assert.equal(termOf({ yes_sub_title: "Kraken" }), "Kraken");
  assert.equal(termOf({ title: 'Will Circle say "Mastercard" during the call?' }), "Mastercard");
  assert.equal(termOf({ title: "Will Circle say Treasury during their earnings call?" }), "Treasury");
  assert.equal(termKey("Tariffs / Tariff"), termKey("tariff/tariffs"));
  assert.equal(termKey("AI & ML"), "ai and ml");
  assert.equal(companyNameOf({ title: "What will Chewy say during their next earnings call?" }), "Chewy");
});

test("normalizeMarket maps result and ids", () => {
  const r = normalizeMarket(
    { ticker: "KXEARNINGSMENTIONHOOD-26JUL17-SPAC", event_ticker: "KXEARNINGSMENTIONHOOD-26JUL17", yes_sub_title: "SpaceX", result: "yes", yes_bid: 90, yes_ask: 94, volume: 1200, status: "settled" },
    { title: "What will Robinhood say during their next earnings call?" });
  assert.equal(r.y, 1); assert.equal(r.company, "HOOD"); assert.equal(r.date, "2026-07-17");
  assert.equal(r.companyName, "Robinhood"); assert.equal(r.volume, 1200); assert.equal(r.termKey, "spacex");
  assert.equal(normalizeMarket({ ticker: "KXEARNINGSMENTIONHOOD-26JUL17-X", result: "" }).y, null);
});

test("history pack/unpack round-trips", () => {
  const rows = [{ ticker: "A", eventTicker: "E", company: "C", date: "2026-01-01", term: "t", termKey: "t", y: 1, pBid: 0.4, pAsk: 0.45, pMid: 0.425, volume: 5 }];
  assert.deepEqual(unpackHistory(packHistory(rows)), rows);
});

test("ET midnight handles DST", () => {
  assert.equal(etMidnightTs("2026-05-11"), Date.UTC(2026, 4, 11, 4) / 1000); // EDT
  assert.equal(etMidnightTs("2026-01-15"), Date.UTC(2026, 0, 15, 5) / 1000); // EST
});

test("pre-call price = last quoted candle at/before ref time", () => {
  const ref = 1_000_000;
  const candles = [
    { end_period_ts: ref - 7200, yes_bid: { close: 30 }, yes_ask: { close: 34 } },
    { end_period_ts: ref - 3600, yes_bid: { close_dollars: "0.40" }, yes_ask: { close_dollars: "0.44" } },
    { end_period_ts: ref + 3600, yes_bid: { close: 90 }, yes_ask: { close: 95 } }, // after the call starts: ignored
  ];
  const p = priceAtFromCandles(candles, ref);
  assert.equal(p.pBid, 0.4); assert.equal(p.pAsk, 0.44); assert.ok(Math.abs(p.pMid - 0.42) < 1e-12);
  assert.deepEqual(priceAtFromCandles([], ref), { pBid: null, pAsk: null, pMid: null });
});

test("paginate follows cursors", async () => {
  const pages = { "": { items: [1, 2], cursor: "a" }, a: { items: [3], cursor: "b" }, b: { items: [4], cursor: "" } };
  const get = async (_p, params) => pages[params.cursor || ""];
  assert.deepEqual(await paginate(get, "/x", {}, "items"), [1, 2, 3, 4]);
});

test("makeGetter retries 429 and routes through a proxy", async () => {
  let calls = 0; const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url); calls++;
    if (calls === 1) return new Response("slow down", { status: 429 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const get = makeGetter({ proxy: "/api/kalshi", fetchImpl });
  const origTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => origTimeout(fn, 0);
  try { assert.deepEqual(await get("/events", { series_ticker: "S", status: "open" }), { ok: true }); }
  finally { globalThis.setTimeout = origTimeout; }
  assert.equal(calls, 2);
  assert.match(urls[0], /^\/api\/kalshi\?series_ticker=S&status=open&path=%2Fevents$/);
  const bad = makeGetter({ fetchImpl: async () => new Response(JSON.stringify({ error: { message: "nope" } }), { status: 404 }) });
  await assert.rejects(bad("/x"), /Kalshi 404 on \/x: nope/);
});

test("syncSeriesHistory joins outcomes with pre-call prices", async () => {
  const ev = {
    event_ticker: "KXEARNINGSMENTIONABC-26MAR03", series_ticker: "KXEARNINGSMENTIONABC", title: "What will ABC say during their next earnings call?",
    markets: [
      { ticker: "KXEARNINGSMENTIONABC-26MAR03-AI", yes_sub_title: "AI", result: "yes", status: "finalized" },
      { ticker: "KXEARNINGSMENTIONABC-26MAR03-TAR", yes_sub_title: "Tariff", result: "no", status: "finalized" },
      { ticker: "KXEARNINGSMENTIONABC-26MAR03-VOID", yes_sub_title: "Void", result: "", status: "finalized" },
    ],
  };
  const ref = etMidnightTs("2026-03-03");
  const get = async (path) => {
    if (path === "/events") return { events: [ev], cursor: "" };
    if (path.endsWith("/candlesticks")) return {
      market_tickers: ["KXEARNINGSMENTIONABC-26MAR03-AI", "KXEARNINGSMENTIONABC-26MAR03-TAR"],
      market_candlesticks: [[{ end_period_ts: ref - 60, yes_bid: { close: 80 }, yes_ask: { close: 84 } }], [{ end_period_ts: ref - 60, yes_bid: { close: 20 }, yes_ask: { close: 26 } }]],
    };
    throw new Error("unexpected " + path);
  };
  const rows = await syncSeriesHistory(get, "KXEARNINGSMENTIONABC");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].y, 1); assert.ok(Math.abs(rows[0].pMid - 0.82) < 1e-12);
  assert.equal(rows[1].y, 0); assert.equal(rows[1].pAsk, 0.26);
});

test("discoverOpenEarningsEvents scans without nested markets, then fetches only mention events", async () => {
  const seen = [];
  const get = async (path, params) => {
    seen.push([path, params]);
    if (path === "/events") return { events: [{ event_ticker: "KXEARNINGSMENTIONAAPL-26OCT30", series_ticker: "KXEARNINGSMENTIONAAPL" }, { event_ticker: "KXFED-26DEC", series_ticker: "KXFED" }], cursor: "" };
    if (path === "/events/KXEARNINGSMENTIONAAPL-26OCT30") return { event: { event_ticker: "KXEARNINGSMENTIONAAPL-26OCT30", title: "What will Apple say during their next earnings call?" }, markets: [{ ticker: "KXEARNINGSMENTIONAAPL-26OCT30-AI" }] };
    throw new Error("unexpected " + path);
  };
  const evs = await discoverOpenEarningsEvents(get);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].markets.length, 1);
  assert.equal(seen[0][1].with_nested_markets, undefined);
});

test("syncSeriesHistory skips events already stored", async () => {
  const get = async (path) => {
    if (path === "/events") return { events: [{ event_ticker: "KXEARNINGSMENTIONABC-26MAR03", markets: [{ ticker: "KXEARNINGSMENTIONABC-26MAR03-AI", result: "yes" }] }], cursor: "" };
    throw new Error("should not fetch prices for a known event");
  };
  assert.deepEqual(await syncSeriesHistory(get, "KXEARNINGSMENTIONABC", { known: new Set(["KXEARNINGSMENTIONABC-26MAR03"]) }), []);
});
