import { NextRequest, NextResponse } from "next/server";

// Proxies the dashboard's AI calls (Pull race, Enrich, Pink Sheet) to Anthropic's API,
// adding the API key server-side so it's never exposed in the browser. Requires your
// own ANTHROPIC_API_KEY (from console.anthropic.com — separate from your claude.ai
// login, billed per-token). Without it, these three features return a clear error in
// the dashboard's existing error banners instead of failing silently.
export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: { message: "ANTHROPIC_API_KEY is not set on the server. Add it in Vercel → Settings → Environment Variables to enable Pull race / Enrich / Pink Sheet. See README." } },
      { status: 500 },
    );
  }

  let body: string;
  try {
    body = await req.text();
  } catch {
    return NextResponse.json({ error: { message: "Invalid request body" } }, { status: 400 });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  const beta = req.headers.get("anthropic-beta");
  if (beta) headers["anthropic-beta"] = beta;

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body,
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("claude proxy failed", err);
    return NextResponse.json({ error: { message: err?.message || "Upstream request failed" } }, { status: 502 });
  }
}
