import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { checkToken } from "../../../../lib/server/guard.mjs";
import { termKey } from "../../../../lib/mentions/kalshi.mjs";

// Claude-backed steps for the mentions model. Prompts are assembled here (not in the browser)
// so this route can only run these two tasks:
//   forecast          — per-term probability that the company says each term on its call
//   find_transcripts  — URLs of the company's recent full earnings-call transcripts
// Uses web search; the server-side `fallbacks: "default"` retries a declined request on
// Anthropic's recommended fallback model instead of failing.
export const maxDuration = 300;

const MODEL = "claude-opus-5-5";
let client: Anthropic | null = null; // created on first request so builds don't need the key

type Effort = "low" | "medium" | "high";

async function ask(prompt: string, effort: Effort, maxSearches: number) {
  client ??= new Anthropic();
  let messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
  for (let hop = 0; hop < 5; hop++) {
    const msg = await client.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort },
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxSearches }],
        messages,
      })
      .finalMessage();
    if (msg.stop_reason === "refusal") throw Object.assign(new Error("Claude declined this request."), { status: 422 });
    // Server-side search loop hit its iteration cap: send the turn back and it resumes.
    if (msg.stop_reason === "pause_turn") {
      messages = [...messages, { role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] }];
      continue;
    }
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (!text && msg.stop_reason === "max_tokens") throw new Error("Claude hit the token cap before answering.");
    return { text, model: msg.model, usage: msg.usage };
  }
  throw new Error("Claude kept pausing mid-search — try again.");
}

function extractJSON(text: string) {
  const clean = text.replace(/```(?:json)?/g, "");
  const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("Claude's answer had no JSON object.");
  return JSON.parse(clean.slice(a, b + 1));
}

const pct = (p: number | null | undefined) => (p == null ? "n/a" : `${Math.round(p * 100)}%`);

function forecastPrompt(b: any) {
  const lines = (b.terms || []).map((t: any) => {
    const h = t.prior || {};
    const tx = t.tx || {};
    const hist = h.nCT ? `listed ${h.nCT}x for this company before, said ${h.yCT}x` : "never listed for this company before";
    const trans = tx.calls ? `in ${tx.hits}/${tx.calls} prior call transcripts (avg ${Number(tx.mean ?? 0).toFixed(1)}/call, last call ${tx.last})` : "no transcripts loaded";
    return `- "${t.term}" — Kalshi history: ${hist}; base-rate prior ${pct(h.p)}; ${trans}`;
  });
  return `You are forecasting Kalshi "mention" markets for ${b.companyName} (${b.company}) earnings call on or around ${b.date}.
Each market resolves YES if a company representative (executives, IR, or the call operator) says the term during the call, prepared remarks or Q&A. Analyst questions generally do not count.${b.rules ? `\nResolution rules excerpt: ${String(b.rules).slice(0, 700)}` : ""}

Use web search to understand what this call is likely to cover: the company's latest results and guidance, recent news, product launches, acquisitions, litigation, macro themes it has been discussing (tariffs, AI, consumer, rates, etc.), and how its executives usually talk. Do NOT look up prediction-market or betting prices for these terms — we need your independent estimate.

Statistical context from our model (use it, but adjust for what's new this quarter):
${lines.join("\n")}

For each term give a calibrated probability (0.01–0.99) that it is said at least once. Reserve values above 0.95 or below 0.05 for near-certainties.
Respond with ONLY a JSON object, no markdown:
{"callDate":"YYYY-MM-DD or null","themes":["up to 5 short themes"],"terms":[{"term":"exact term as given","p":0.0,"why":"<=140 chars"}]}`;
}

function findPrompt(b: any) {
  return `Find URLs for complete, free-to-read earnings call transcripts of ${b.companyName} (stock ticker ${b.company}) for its ${b.n || 6} most recent earnings calls held BEFORE ${b.before}.
Prefer The Motley Fool (fool.com/earnings/call-transcripts/...). Other acceptable sources publish the full transcript text without a paywall or login. Avoid Seeking Alpha and other paywalled sites, summaries, and audio-only pages.
Respond with ONLY a JSON object, no markdown:
{"calls":[{"date":"YYYY-MM-DD (call date)","quarter":"e.g. Q2 FY2026","url":"https://..."}]}
Only include URLs you actually found in search results. Omit a quarter rather than guessing a URL.`;
}

export async function POST(req: NextRequest) {
  const gate = checkToken(req);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set on the server. Add it in Vercel → Settings → Environment Variables. See README." }, { status: 500 });
  }
  let b: any;
  try { b = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  try {
    if (b.task === "forecast") {
      if (!b.companyName || !Array.isArray(b.terms) || !b.terms.length) return NextResponse.json({ error: "Missing company or terms" }, { status: 400 });
      const r = await ask(forecastPrompt(b), "high", 8);
      const data = extractJSON(r.text);
      const probs: Record<string, { p: number; why: string }> = {};
      for (const t of data.terms || []) {
        const p = Number(t.p);
        if (!t.term || !Number.isFinite(p)) continue;
        probs[termKey(t.term)] = { p: Math.min(0.99, Math.max(0.01, p)), why: String(t.why || "").slice(0, 200) };
      }
      return NextResponse.json({ probs, themes: data.themes || [], callDate: data.callDate || null, model: r.model, usage: r.usage, at: new Date().toISOString() });
    }
    if (b.task === "find_transcripts") {
      if (!b.companyName || !b.before) return NextResponse.json({ error: "Missing company or date" }, { status: 400 });
      const r = await ask(findPrompt(b), "low", 6);
      const data = extractJSON(r.text);
      const calls = (data.calls || [])
        .filter((c: any) => /^https?:\/\//.test(c?.url || "") && /^\d{4}-\d{2}-\d{2}$/.test(c?.date || "") && c.date < b.before)
        .map((c: any) => ({ date: c.date, quarter: String(c.quarter || ""), url: c.url }));
      return NextResponse.json({ calls, model: r.model, usage: r.usage });
    }
    return NextResponse.json({ error: "Unknown task" }, { status: 400 });
  } catch (err: any) {
    console.error("mentions claude failed", err);
    const status = err instanceof Anthropic.APIError ? err.status ?? 502 : err?.status ?? 502;
    return NextResponse.json({ error: err?.message || "Claude request failed" }, { status });
  }
}
