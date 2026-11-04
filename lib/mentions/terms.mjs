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
   Handles the common free-transcript layouts:
     1) Header line per speaker:  "Jane Doe -- Chief Financial Officer"
                                   "John Roe -- Morgan Stanley -- Analyst"
     2) Inline speaker labels:     "Operator: Good afternoon ..."  (current Motley Fool layout,
        which lists company reps up top under CALL PARTICIPANTS as "Title - Name")
   Segments are tagged operator / analyst / company / unknown so analyst questions (which
   Kalshi's rules don't count — only company representatives and the operator) can be excluded.
   Anything before the first speaker (e.g. a publisher's summary/takeaways) is never counted. */
const SECTION_QA = /^(questions?\s*(?:&|and)\s*answers?|question[-\s]and[-\s]answer(?:\s+session)?)\s*:?\s*$/i;
const SECTION_PREP = /^prepared\s+remarks\s*:?\s*$/i;
const BODY_END = /^(call participants|duration:\s*\d+\s*minutes|more\s+\S{1,10}\s+analysis|all earnings call transcripts|this article is a transcript|premium investing services|should you (?:buy|invest)|read next$|related articles$|read more$)/i;
const DASH_HEADER = /^([A-Z][\w.'’\- ]{1,60}?)\s+(?:--|—|–)\s+(.{2,140})$/;
// Speaker label: no space before the colon, so glossary lines ("Blackwell architecture : …") don't match.
const INLINE = /^([A-Z][A-Za-z.'’\- ]{0,47}[A-Za-z.]):\s+(\S.*)$/;
const BODY_HEADING = /^full (?:conference )?call transcript:?$/i;
const QA_START = /\b(?:first|next|our first)\s+question\b|question[-\s]and[-\s]answer|\bQ\s?&\s?A\b/i;
// An operator line that hands the floor to a questioner (operators are sometimes labelled by name).
const QUESTION_CALL = /\b(?:first|next|following|last)\s+question\b[^.]{0,60}\b(?:from|comes|is)\b|\bline of\b/i;
const normName = (n) => String(n || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

function roleOf(name, title) {
  if (/^operator$/i.test(name.trim())) return "operator";
  if (/analyst/i.test(title || "")) return "analyst";
  if (title) return "company";
  return "unknown";
}

// "CALL PARTICIPANTS" block: lines like "Chief Financial Officer - Marie Myers" (or the reverse
// "Marie Myers -- Chief Financial Officer") until the next ALL-CAPS heading.
function participantsOf(lines) {
  const i = lines.findIndex((l) => /^call participants:?$/i.test(l));
  if (i < 0) return new Map();
  const out = new Map();
  for (const l of lines.slice(i + 1, i + 40)) {
    if (!l) continue;
    if (/^[A-Z][A-Z &\-]{3,40}$/.test(l)) break;
    const m = /^(.{2,90}?)\s+(?:-|--|—|–)\s+(.{2,90})$/.exec(l);
    if (!m) continue;
    const [a, b] = [m[1].trim(), m[2].trim()];
    const titleFirst = /officer|president|chief|director|relations|treasurer|chair|head|vp|vice|founder|ceo|cfo|coo|cto/i.test(a);
    const [name, title] = titleFirst ? [b, a] : [a, b];
    out.set(normName(name), title);
  }
  return out;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
// Call date from the transcript header ("DATE\nWednesday, Sept. 2, 2026 at 4:30 p.m. ET").
export function transcriptDate(text) {
  const head = String(text || "").slice(0, 20000);
  const D = "\\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\\.?\\s+(\\d{1,2}),\\s+(20\\d{2})\\b";
  // 1) the "DATE" header block; 2) a date followed by a time ("Jan 30, 2025 , 5:00 p.m. ET");
  // never just the first date on the page, which can be a quarter-end or article date.
  const at = head.search(/^DATE\s*$/m);
  const m = (at >= 0 && new RegExp(D).exec(head.slice(at, at + 200))) || new RegExp(`${D}\\s*,?\\s*(?:at\\s+)?\\d{1,2}:\\d{2}\\s*[ap]\\.?\\s?m`, "i").exec(head);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  return mo ? `${m[3]}-${String(mo).padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

export function parseTranscript(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim());
  const participants = participantsOf(lines);
  // Find where the call itself starts. Pages put a contents list, summary or glossary first, so:
  // an explicit "Full Conference Call Transcript" heading wins; else the first "Prepared Remarks"
  // heading that is immediately followed by a speaker (not the contents-list entry); else the
  // first operator line.
  const isSpeaker = (l) => /^operator\s*:?$/i.test(l) || /^operator:\s+\S/i.test(l) || (l.length <= 160 && DASH_HEADER.test(l)) || INLINE.test(l);
  const nextText = (i) => lines.slice(i + 1).find((l) => l) || "";
  let start = lines.findIndex((l) => BODY_HEADING.test(l));
  if (start < 0) start = lines.findIndex((l, i) => SECTION_PREP.test(l) && isSpeaker(nextText(i)));
  if (start < 0) start = lines.findIndex((l) => /^operator\s*:?$/i.test(l) || /^operator:\s+\S/i.test(l));
  if (start < 0) start = 0;
  let end = lines.findIndex((l, i) => i > start && BODY_END.test(l));
  if (end < 0) end = lines.length;

  const segments = [];
  let section = "prepared";
  let explicitQA = false;
  let cur = null;
  const push = () => { if (cur && cur.text.trim()) segments.push(cur); cur = null; };
  for (const line of lines.slice(start, end)) {
    if (!line || BODY_HEADING.test(line)) continue;
    if (SECTION_PREP.test(line)) { push(); section = "prepared"; continue; }
    if (SECTION_QA.test(line)) { push(); section = "qa"; explicitQA = true; continue; }
    const dh = line.length <= 160 && !/[.?!]$/.test(line) ? DASH_HEADER.exec(line) : null;
    if (dh) { push(); cur = { speaker: dh[1].trim(), title: dh[2].trim(), role: roleOf(dh[1], dh[2]), section, text: "" }; continue; }
    if (/^operator\s*:?$/i.test(line)) { push(); cur = { speaker: "Operator", title: "", role: "operator", section, text: "" }; continue; }
    const il = INLINE.exec(line);
    if (il && il[1].split(/\s+/).length <= 5) {
      push();
      const speaker = il[1].trim();
      const title = participants.get(normName(speaker)) || "";
      // A named speaker outside the participants list who calls a question is the operator.
      const namedOperator = !title && participants.size > 0 && QUESTION_CALL.test(il[2]);
      // Without a section heading, Q&A begins when the operator calls the first question.
      if (!explicitQA && (/^operator$/i.test(speaker) || namedOperator) && QA_START.test(il[2])) section = "qa";
      cur = { speaker, title, role: namedOperator ? "operator" : roleOf(speaker, title), section, text: il[2] + "\n" };
      continue;
    }
    if (!cur) cur = { speaker: "", title: "", role: "unknown", section, text: "" };
    cur.text += line + "\n";
  }
  push();
  // Unlabelled speakers: analysts are the ones the operator introduces, or — when the
  // transcript lists its company participants — anyone not on that list who speaks in Q&A.
  const introduced = new Set();
  for (const s of segments) {
    if (s.role !== "operator") continue;
    for (const m of s.text.matchAll(/(?:line of|comes? from|question from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z'’\-]+){1,2})/g)) introduced.add(normName(m[1]));
  }
  const namedOps = new Set(segments.filter((s) => s.role === "operator").map((s) => normName(s.speaker)));
  for (const s of segments) {
    if (s.role !== "unknown" || !s.speaker) continue;
    if (namedOps.has(normName(s.speaker))) { s.role = "operator"; continue; }
    if (introduced.has(normName(s.speaker)) || (participants.size && s.section === "qa")) s.role = "analyst";
    else if (participants.size) s.role = "company";
  }
  const words = segments.reduce((a, s) => a + s.text.split(/\s+/).filter(Boolean).length, 0);
  return { segments, words, hasSpeakers: segments.some((s) => s.speaker), participants: participants.size };
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
