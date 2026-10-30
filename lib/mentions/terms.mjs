/* Term matching + transcript parsing. Counts are deterministic (regex over text we fetched),
   never model-estimated, so the transcript signal is reproducible. */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Plural alternation for the LAST word of a phrase, per common English rules.
function pluralTail(word) {
  const w = word.toLowerCase();
  if (/[^aeiou]y$/.test(w)) return `${escapeRe(word.slice(0, -1))}(?:y|ies)`;
  if (/(s|x|z|ch|sh)$/.test(w)) return `${escapeRe(word)}(?:es)?`;
  return `${escapeRe(word)}s?`;
}

/* Build a global, case-insensitive matcher for a Kalshi term.
   - "A / B" alternatives each match.
   - Whitespace and hyphens inside a phrase are interchangeable ("e-commerce" ≈ "e commerce").
   - Kalshi's mention rules typically count plurals and possessives but not other inflections
     (tense, -ing); both are toggles so a market whose rules differ can be matched exactly. */
export function buildMatcher(term, { plural = true, possessive = true } = {}) {
  const alts = String(term || "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((alt) => {
      const words = alt.replace(/[’`]/g, "'").split(/[\s-]+/).filter(Boolean);
      if (!words.length) return null;
      const head = words.slice(0, -1).map(escapeRe);
      const last = words[words.length - 1];
      const tail = plural ? pluralTail(last) : escapeRe(last);
      const poss = possessive ? `(?:['’]s|s['’]|['’])?` : "";
      return [...head, tail].join(`[\\s\\-–]+`) + poss;
    })
    .filter(Boolean);
  if (!alts.length) return null;
  return new RegExp(`(?<![A-Za-z0-9])(?:${alts.join("|")})(?![A-Za-z0-9])`, "gi");
}

export function countMatches(text, matcher) {
  if (!matcher || !text) return 0;
  matcher.lastIndex = 0;
  let n = 0;
  while (matcher.exec(text)) n++;
  return n;
}

/* ---------- transcript structure ----------
   Handles the two common free-transcript layouts:
     1) Header line per speaker:  "Jane Doe -- Chief Financial Officer"
                                   "John Roe -- Morgan Stanley -- Analyst"
     2) Inline speaker labels:     "Operator: Good afternoon ..."
   Segments are tagged operator / analyst / company / unknown so analyst questions (which
   Kalshi's rules usually don't count) can be excluded. */
const SECTION_QA = /^(questions?\s*(?:&|and)\s*answers?|question[-\s]and[-\s]answer(?:\s+session)?)\s*:?\s*$/i;
const SECTION_PREP = /^prepared\s+remarks\s*:?\s*$/i;
const BODY_END = /^(call participants|duration:\s*\d+\s*minutes|more\s+\S{1,10}\s+analysis|all earnings call transcripts|this article is a transcript)/i;
const DASH_HEADER = /^([A-Z][\w.'’\- ]{1,60}?)\s+(?:--|—|–)\s+(.{2,140})$/;
const INLINE = /^([A-Z][A-Za-z.'’\- ]{1,48}?)\s*:\s+(\S.*)$/;

function roleOf(name, title) {
  if (/^operator$/i.test(name.trim())) return "operator";
  if (/analyst/i.test(title || "")) return "analyst";
  if (title) return "company";
  return "unknown";
}

export function parseTranscript(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim());
  // Trim to the body: from the first "Prepared Remarks"/"Operator" line to the participants list.
  let start = lines.findIndex((l) => SECTION_PREP.test(l) || /^operator\s*:?$/i.test(l) || /^operator:\s+\S/i.test(l));
  if (start < 0) start = 0;
  let end = lines.findIndex((l, i) => i > start && BODY_END.test(l));
  if (end < 0) end = lines.length;

  const segments = [];
  let section = "prepared";
  let cur = null;
  const push = () => { if (cur && cur.text.trim()) segments.push(cur); cur = null; };
  for (const line of lines.slice(start, end)) {
    if (!line) continue;
    if (SECTION_PREP.test(line)) { push(); section = "prepared"; continue; }
    if (SECTION_QA.test(line)) { push(); section = "qa"; continue; }
    const dh = line.length <= 160 && !/[.?!]$/.test(line) ? DASH_HEADER.exec(line) : null;
    if (dh) { push(); cur = { speaker: dh[1].trim(), title: dh[2].trim(), role: roleOf(dh[1], dh[2]), section, text: "" }; continue; }
    if (/^operator\s*:?$/i.test(line)) { push(); cur = { speaker: "Operator", title: "", role: "operator", section, text: "" }; continue; }
    const il = INLINE.exec(line);
    if (il && il[1].split(/\s+/).length <= 5) {
      push();
      cur = { speaker: il[1].trim(), title: "", role: roleOf(il[1], ""), section, text: il[2] + "\n" };
      continue;
    }
    if (!cur) cur = { speaker: "", title: "", role: "unknown", section, text: "" };
    cur.text += line + "\n";
  }
  push();
  // Inline-format transcripts have no titles; infer analysts as Q&A speakers who are introduced
  // by the operator ("... comes from the line of Jane Doe with Morgan Stanley").
  const introduced = new Set();
  for (const s of segments) {
    if (s.role !== "operator") continue;
    for (const m of s.text.matchAll(/(?:line of|comes from|question from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'’\-]+){1,2})/g)) introduced.add(m[1].toLowerCase());
  }
  for (const s of segments) if (s.role === "unknown" && introduced.has(s.speaker.toLowerCase())) s.role = "analyst";
  const words = segments.reduce((a, s) => a + s.text.split(/\s+/).filter(Boolean).length, 0);
  return { segments, words, hasSpeakers: segments.some((s) => s.speaker) };
}

// Count a term across a parsed transcript. By default analysts are excluded (Kalshi counts
// company representatives incl. the operator); a market's rules text can override this.
export function countTerm(parsed, term, { excludeAnalysts = true, plural = true, possessive = true } = {}) {
  const re = buildMatcher(term, { plural, possessive });
  const out = { count: 0, prepared: 0, qa: 0, analyst: 0 };
  for (const s of parsed.segments) {
    const n = countMatches(s.text, re);
    if (!n) continue;
    if (s.role === "analyst") { out.analyst += n; if (excludeAnalysts) continue; }
    out.count += n;
    if (s.section === "qa") out.qa += n; else out.prepared += n;
  }
  return out;
}

// Read the counting conventions out of a market's rules text where it's explicit.
export function rulesOptions(rules = "") {
  const r = String(rules).toLowerCase();
  const opts = { plural: true, possessive: true, excludeAnalysts: true };
  if (/plural[^.]*\b(?:not|won't|will not|do not|does not)\b[^.]*count/.test(r) || /\b(?:not|won't|will not)\b[^.]*count[^.]*plural/.test(r)) opts.plural = false;
  if (/possessive[^.]*\b(?:not|won't|will not)\b[^.]*count/.test(r)) opts.possessive = false;
  if (/\b(?:anyone|any participant|any speaker|analysts?)\b[^.]*\bcount/.test(r) && !/analysts?[^.]*\b(?:not|won't|will not)\b/.test(r)) opts.excludeAnalysts = false;
  return opts;
}

/* ---------- HTML → text ---------- */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  const s = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head|nav|footer|form|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre)>/gi, "\n")
    .replace(/<(p|div|h[1-6]|li|tr|section|article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(s)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}
