import { sql } from "@vercel/postgres";
import { NextRequest, NextResponse } from "next/server";

// Lazily ensure the table exists. Cheap no-op after the first call per cold start.
let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await sql`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;
  ensured = true;
}

export async function GET(req: NextRequest) {
  // ?prefix= returns every key under a namespace in one round trip (the mentions dashboard
  // stores settled history per company series and loads it all at once).
  const prefix = req.nextUrl.searchParams.get("prefix");
  if (prefix) {
    if (prefix.length < 3) return NextResponse.json({ error: "Prefix too short" }, { status: 400 });
    const pattern = prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    try {
      await ensureTable();
      const { rows } = await sql`SELECT key, value FROM kv_store WHERE key LIKE ${pattern} ESCAPE '\\' ORDER BY key;`;
      return NextResponse.json({ items: rows }, { status: 200 });
    } catch (err: any) {
      console.error("kv prefix GET failed", err);
      return NextResponse.json({ error: err?.message || "Database error" }, { status: 500 });
    }
  }

  const key = req.nextUrl.searchParams.get("key");
  if (!key) return NextResponse.json({ error: "Missing ?key=" }, { status: 400 });

  try {
    await ensureTable();
    const { rows } = await sql`SELECT value FROM kv_store WHERE key = ${key} LIMIT 1;`;
    if (!rows.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ key, value: rows[0].value }, { status: 200 });
  } catch (err: any) {
    console.error("kv GET failed", err);
    return NextResponse.json({ error: err?.message || "Database error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { key, value } = body || {};
  if (!key || typeof key !== "string") return NextResponse.json({ error: "Missing key" }, { status: 400 });
  if (typeof value !== "string") return NextResponse.json({ error: "value must be a string" }, { status: 400 });

  try {
    await ensureTable();
    await sql`
      INSERT INTO kv_store (key, value, updated_at)
      VALUES (${key}, ${value}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
    `;
    return NextResponse.json({ key, saved: true }, { status: 200 });
  } catch (err: any) {
    console.error("kv POST failed", err);
    return NextResponse.json({ error: err?.message || "Database error" }, { status: 500 });
  }
}
