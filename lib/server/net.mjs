// Server-only SSRF guard for fetching user/Claude-supplied transcript URLs: public http(s)
// hosts only, every redirect hop re-checked, bounded size and time.
import dns from "node:dns/promises";
import net from "node:net";

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true;
}

export async function assertPublicUrl(raw, lookup = dns.lookup) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("Not a valid URL"); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) URLs are allowed");
  if (u.username || u.password) throw new Error("URLs with credentials are not allowed");
  if (u.port && !["80", "443"].includes(u.port)) throw new Error("Only ports 80/443 are allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("That host resolves to a private address");
  return u;
}

export async function safeFetchText(raw, { maxBytes = 6_000_000, timeoutMs = 20000, maxRedirects = 4, fetchImpl = fetch, lookup } = {}) {
  let url = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = await assertPublicUrl(url, lookup);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(u.toString(), {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; TrillysTrack/1.0; +transcript-fetch)",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
      });
    } finally { clearTimeout(timer); }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), u).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
    const reader = res.body?.getReader?.();
    if (!reader) return { url: u.toString(), body: await res.text(), contentType: res.headers.get("content-type") || "" };
    const chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { reader.cancel(); throw new Error("Page too large"); }
      chunks.push(value);
    }
    const body = new TextDecoder("utf-8").decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
    return { url: u.toString(), body, contentType: res.headers.get("content-type") || "" };
  }
  throw new Error("Too many redirects");
}
