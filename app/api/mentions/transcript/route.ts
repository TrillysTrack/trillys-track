import { NextRequest, NextResponse } from "next/server";
import { safeFetchText } from "../../../../lib/server/net.mjs";
import { checkToken } from "../../../../lib/server/guard.mjs";
import { htmlToText, titleOf, parseTranscript } from "../../../../lib/mentions/terms.mjs";

export const maxDuration = 60;

// Downloads a transcript page server-side and returns plain text. Term counting happens in
// the dashboard with the same deterministic matcher the backtest uses.
export async function POST(req: NextRequest) {
  const gate = checkToken(req);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const url = String(body?.url || "");
  if (!url) return NextResponse.json({ error: "Missing url" }, { status: 400 });

  try {
    const page = await safeFetchText(url);
    const isHtml = /html|xml/i.test(page.contentType) || /^\s*</.test(page.body);
    const text = isHtml ? htmlToText(page.body) : page.body;
    const parsed = parseTranscript(text);
    const looksLikeTranscript = parsed.words > 2500 && /\boperator\b|conference call|earnings call/i.test(text);
    return NextResponse.json({
      url: page.url,
      title: isHtml ? titleOf(page.body) : "",
      text,
      words: parsed.words,
      speakers: parsed.segments.filter((s) => s.speaker).length,
      looksLikeTranscript,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Fetch failed" }, { status: 422 });
  }
}
