import { NextRequest, NextResponse } from "next/server";
import { KALSHI_BASE } from "../../../lib/mentions/kalshi.mjs";

// Read-only proxy for Kalshi's public market-data endpoints (the browser can't call Kalshi
// directly because of CORS). Only GETs to market-data paths are forwarded — never portfolio
// or order endpoints, which live behind /api/kalshi/portfolio with server-side signing.
const ALLOWED = /^\/(series|events|markets|historical)(\/[A-Za-z0-9._-]+)*$/;
const base = () => process.env.KALSHI_API_BASE || KALSHI_BASE;

export async function GET(req: NextRequest) {
  const params = new URLSearchParams(req.nextUrl.searchParams);
  const path = params.get("path") || "";
  if (!ALLOWED.test(path)) return NextResponse.json({ error: "Path not allowed" }, { status: 400 });
  params.delete("path");
  // `prefix` is ours, not Kalshi's: filter the (large) /series list server-side.
  const prefix = params.get("prefix");
  params.delete("prefix");

  const qs = params.toString();
  try {
    const upstream = await fetch(`${base()}${path}${qs ? "?" + qs : ""}`, { headers: { Accept: "application/json" }, cache: "no-store" });
    const text = await upstream.text();
    if (prefix && path === "/series" && upstream.ok) {
      const data = JSON.parse(text);
      data.series = (data.series || []).filter((s: any) => String(s.ticker || "").startsWith(prefix));
      return NextResponse.json(data, { headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=3600" } });
    }
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": upstream.ok ? "s-maxage=10, stale-while-revalidate=30" : "no-store" },
    });
  } catch (err: any) {
    console.error("kalshi proxy failed", err);
    return NextResponse.json({ error: err?.message || "Upstream request failed" }, { status: 502 });
  }
}
