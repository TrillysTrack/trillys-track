/* Motley Fool transcript discovery and parsing, shared by the CLI scripts. Fetches pages
   directly, so it's for the terminal/server, not the browser. Each company's fool.com quote page
   embeds its transcript list; only that company's own transcripts are kept (the page also
   links other companies'). */
import { htmlToText, parseTranscript, transcriptDate } from "./terms.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// A polite fetcher: requests spaced intervalMs apart, backs off on 429/5xx.
export function makeFoolClient({ intervalMs = 700, fetchImpl = globalThis.fetch } = {}) {
  let next = 0;
  return async function foolGet(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = Date.now(), at = Math.max(now, next);
      next = at + intervalMs;
      if (at > now) await sleep(at - now);
      try {
        const res = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; TrillysTrack/1.0; transcript research)", Accept: "text/html" } });
        if (res.status === 429 || res.status >= 500) { next = Date.now() + 5000 * (attempt + 1); continue; }
        return { status: res.status, text: res.ok ? await res.text() : "" };
      } catch (e) {
        if (attempt === 2) return { status: 0, error: e.message, text: "" };
      }
    }
    return { status: 429, text: "" };
  };
}

export function transcriptLinks(html, company) {
  const own = new RegExp(`(^|-)${company.toLowerCase()}(-|$)`);
  const out = new Map();
  for (const m of String(html).matchAll(/call-transcripts\/(\d{4})\/(\d{2})\/(\d{2})\/([a-z0-9-]+)\//g)) {
    if (!own.test(m[4])) continue;
    const url = `https://www.fool.com/earnings/call-transcripts/${m[1]}/${m[2]}/${m[3]}/${m[4]}/`;
    out.set(url, { url, pubDate: `${m[1]}-${m[2]}-${m[3]}` });
  }
  return [...out.values()];
}

// The company's transcript links from its quote page (exchange unknown, so try both).
export async function findTranscriptLinks(foolGet, company) {
  for (const exchange of ["nasdaq", "nyse"]) {
    const r = await foolGet(`https://www.fool.com/quote/${exchange}/${company.toLowerCase()}/`);
    if (r.status === 200) return { exchange, links: transcriptLinks(r.text, company) };
  }
  return { exchange: null, links: [] };
}

// Fetch and parse one transcript. The call date comes from the transcript header when it's
// consistent with publication; otherwise the URL's publication date, which is never earlier
// than the call, so a misread date can't leak a call into its own prediction.
export async function loadTranscript(foolGet, link) {
  const r = await foolGet(link.url);
  if (r.status !== 200) return { error: `HTTP ${r.status}${r.error ? " " + r.error : ""}` };
  const text = htmlToText(r.text);
  const parsed = parseTranscript(text);
  if (parsed.words < 2000) return { error: `only ${parsed.words} words parsed` };
  const stated = transcriptDate(text);
  const date = stated && stated <= link.pubDate && dayDiff(stated, link.pubDate) <= 10 ? stated : link.pubDate;
  return {
    parsed, date, dateSource: date === stated ? "header" : "published", words: parsed.words,
    participants: parsed.participants, analysts: new Set(parsed.segments.filter((s) => s.role === "analyst").map((s) => s.speaker)).size,
  };
}
