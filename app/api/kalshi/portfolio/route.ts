import { NextRequest, NextResponse } from "next/server";
import { KALSHI_BASE } from "../../../../lib/mentions/kalshi.mjs";
import { kalshiAuthHeaders } from "../../../../lib/server/kalshiAuth.mjs";
import { checkToken } from "../../../../lib/server/guard.mjs";

// Read-only, signed Kalshi portfolio sync. Requires KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY
// (RSA PEM) and DASHBOARD_TOKEN. Nothing here can place or cancel orders.
const RESOURCES: Record<string, { path: string; key: string; params?: Record<string, string> }> = {
  balance: { path: "/portfolio/balance", key: "" },
  positions: { path: "/portfolio/positions", key: "market_positions", params: { limit: "1000" } },
  fills: { path: "/portfolio/fills", key: "fills", params: { limit: "1000" } },
  settlements: { path: "/portfolio/settlements", key: "settlements", params: { limit: "1000" } },
};

async function signedGet(path: string, params: Record<string, string>) {
  const keyId = process.env.KALSHI_API_KEY_ID;
  const pem = process.env.KALSHI_PRIVATE_KEY;
  if (!keyId || !pem) throw Object.assign(new Error("KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY are not set on the server. See README → Portfolio sync."), { status: 500 });
  const base = new URL(process.env.KALSHI_API_BASE || KALSHI_BASE);
  const fullPath = `${base.pathname.replace(/\/$/, "")}${path}`;
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${base.origin}${fullPath}${qs ? "?" + qs : ""}`, {
    headers: { Accept: "application/json", ...kalshiAuthHeaders({ keyId, privateKeyPem: pem, method: "GET", path: fullPath }) },
    cache: "no-store",
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw Object.assign(new Error(`Kalshi ${res.status}: ${data?.error?.message || data?.message || text.slice(0, 200)}`), { status: res.status });
  return data;
}

async function fetchResource(name: string, extra: Record<string, string>) {
  const r = RESOURCES[name];
  if (!r.key) return signedGet(r.path, { ...r.params, ...extra });
  const items: any[] = [];
  let cursor = "";
  let pages = 0;
  for (; pages < 20; pages++) {
    const data = await signedGet(r.path, { ...r.params, ...extra, ...(cursor ? { cursor } : {}) });
    items.push(...(data?.[r.key] || []));
    cursor = data?.cursor || "";
    if (!cursor) break;
  }
  return { [r.key]: items, truncated: !!cursor };
}

export async function GET(req: NextRequest) {
  const gate = checkToken(req, { required: true });
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const resource = req.nextUrl.searchParams.get("resource") || "summary";
  const extra: Record<string, string> = {};
  for (const k of ["ticker", "event_ticker", "min_ts", "max_ts"]) {
    const v = req.nextUrl.searchParams.get(k);
    if (v) extra[k] = v;
  }
  try {
    if (resource === "summary") {
      const [balance, positions, settlements] = await Promise.all([
        fetchResource("balance", {}), fetchResource("positions", {}), fetchResource("settlements", {}),
      ]);
      return NextResponse.json({ balance, ...positions, ...settlements, fetchedAt: new Date().toISOString() });
    }
    if (!RESOURCES[resource]) return NextResponse.json({ error: "Unknown resource" }, { status: 400 });
    return NextResponse.json(await fetchResource(resource, extra));
  } catch (err: any) {
    console.error("kalshi portfolio failed", err);
    return NextResponse.json({ error: err?.message || "Portfolio request failed" }, { status: err?.status && err.status < 600 ? err.status : 502 });
  }
}
