import test from "node:test";
import assert from "node:assert/strict";
import { buildMatcher, countMatches, parseTranscript, countTerm, htmlToText, rulesOptions, titleOf, transcriptDate } from "../../lib/mentions/terms.mjs";

const n = (term, text, opts) => countMatches(text, buildMatcher(term, opts));

test("matcher: plurals and possessives count, other inflections do not", () => {
  assert.equal(n("Tariff", "Tariff, tariffs, the tariff's impact, tariffs' cost"), 4);
  assert.equal(n("Tariff", "we were tariffed"), 0);
  assert.equal(n("Economy", "economies and the economy"), 2);
  assert.equal(n("Box", "boxes and a box"), 2);
  assert.equal(n("Tariff", "tariffs", { plural: false }), 0);
});

test("matcher: word boundaries, phrases, alternatives", () => {
  assert.equal(n("AI", "said AI, AI-driven, and Thai food"), 2);
  assert.equal(n("Artificial Intelligence", "artificial-intelligence and artificial  intelligence"), 2);
  assert.equal(n("AI / Artificial Intelligence", "AI and artificial intelligence"), 2);
  assert.equal(n("U.S.", "the U.S. market"), 1);
  assert.equal(buildMatcher(""), null);
});

const FOOL = `
Nav junk mentioning tariffs
Prepared Remarks:
Operator
Good afternoon and welcome. Our first question comes from the line of Joe Moore with Morgan Stanley.
Jane Doe -- Chief Financial Officer
Tariffs were a headwind. Tariff exposure is modest.
Questions & Answers:
Joe Moore -- Morgan Stanley -- Analyst
What about tariffs and tariffs?
Jane Doe -- Chief Financial Officer
Tariffs remain manageable.
Call participants:
Jane Doe -- Chief Financial Officer -- tariff policy expert
`;

test("transcript parse: Fool layout, sections and roles", () => {
  const p = parseTranscript(FOOL);
  assert.equal(p.hasSpeakers, true);
  const roles = p.segments.map((s) => `${s.role}:${s.section}`);
  assert.deepEqual(roles, ["operator:prepared", "company:prepared", "analyst:qa", "company:qa"]);
  const c = countTerm(p, "Tariff");
  assert.deepEqual(c, { count: 3, prepared: 2, qa: 1, analyst: 2 }); // nav + participants excluded
  assert.equal(countTerm(p, "Tariff", { excludeAnalysts: false }).count, 5);
});

test("transcript parse: inline labels, analysts inferred from operator intros", () => {
  const p = parseTranscript(`Operator: Our next question comes from the line of Amy Lee with Citi.
Amy Lee: Can you talk about AI demand?
Tim Cook: AI is a big part of our roadmap.`);
  const amy = p.segments.find((s) => s.speaker === "Amy Lee");
  assert.equal(amy.role, "analyst");
  assert.equal(countTerm(p, "AI").count, 1);
});

test("htmlToText strips scripts/nav and decodes entities", () => {
  const t = htmlToText(`<html><head><title>X</title></head><nav>menu</nav><script>var a="tariff"</script><p>AT&amp;T&#39;s &ldquo;AI&rdquo;</p><div>line<br>two</div>`);
  assert.equal(t, "AT&T's “AI”\n\nline\ntwo");
  assert.equal(titleOf("<title> Q3 2026 &amp; call </title>"), "Q3 2026 & call");
});

test("rulesOptions reads explicit counting conventions", () => {
  assert.deepEqual(rulesOptions("Plural and possessive forms of the word will count."), { plural: true, possessive: true, excludeAnalysts: true });
  assert.equal(rulesOptions("Plural forms will not count.").plural, false);
  assert.equal(rulesOptions("Mentions by analysts count toward resolution.").excludeAnalysts, false);
});

// Shape of the current Motley Fool layout (verified against a live 2026 transcript page):
// summary sections before the body, CALL PARTICIPANTS as "Title - Name", inline speaker labels,
// Q&A starting at the operator's first-question line, analysts introduced under other names.
const FOOL_2026 = `Image source: The Motley Fool.
DATE
Wednesday, Sept. 2, 2026 at 4:30 p.m. ET
CALL PARTICIPANTS
Chief Strategy Officer - Shannon Cross
President and Chief Executive Officer - Antonio Neri
TAKEAWAYS
Revenue -- tariff headwinds were discussed in this AI-written summary.
Operator: Good afternoon and welcome.
Shannon Cross: Thanks. Tariffs remain a topic.
Antonio Neri: Our AI business grew. Tariff impact was modest.
Operator: And our first question for today will come from Katherine Murphy with Goldman Sachs.
Katherine Campagna: What about tariffs?
Antonio Neri: Tariffs are manageable.
Operator: The conference has now concluded.
Read Next
NYSE: HPE tariff stock widget
`;

test("transcript parse: current Fool layout — participants, implicit Q&A, summary excluded", () => {
  const p = parseTranscript(FOOL_2026);
  assert.equal(p.participants, 2);
  const roles = p.segments.map((s) => `${s.role}:${s.section}`);
  assert.deepEqual(roles, ["operator:prepared", "company:prepared", "company:prepared", "operator:qa", "analyst:qa", "company:qa", "operator:qa"]);
  assert.deepEqual(countTerm(p, "Tariff"), { count: 3, prepared: 2, qa: 1, analyst: 1 });
  assert.equal(transcriptDate(FOOL_2026), "2026-09-02");
  assert.equal(transcriptDate("no date here"), null);
  assert.equal(transcriptDate("Quarter ended Dec 31, 2024 with no call time"), null);
});

test("transcript parse: skips contents lists and glossaries to find the real body", () => {
  // Older layout: a contents list repeats the section names before the real sections.
  const old = `Contents:\nPrepared Remarks\nQuestions and Answers\nCall Participants\nPrepared Remarks:\nJane Roe -- Director, Investor Relations\nWelcome. Tariffs aside, thanks for joining.\nQuestions & Answers:\nOperator\nOur first question comes from Sam Poe with Citi.\nSam Poe -- Analyst\nTariffs?\nTim Cook -- Chief Executive Officer\nTariff costs were modest.\nDuration: 0 minutes\nCall participants:\nTim Cook -- Chief Executive Officer`;
  const a = parseTranscript(old);
  assert.deepEqual(countTerm(a, "Tariff"), { count: 2, prepared: 1, qa: 1, analyst: 1 });
  // Current layout: glossary lines look like "Term : definition"; the body starts at its heading.
  const cur = `INDUSTRY GLOSSARY\nAgentic AI : AI systems that act on their own.\nFull Conference Call Transcript\nToshiya Hari: Welcome. Agentic AI is here.\nColette Kress: Agentic AI drove revenue.`;
  const b = parseTranscript(cur);
  assert.equal(b.segments.length, 2);
  assert.equal(countTerm(b, "Agentic AI").count, 2);
});

test("transcript parse: operator labelled by name; dates need a time when there's no DATE header", () => {
  const t = `CALL PARTICIPANTS\nChief Financial Officer - Colette Kress\nFull Conference Call Transcript\nColette Kress: Agentic AI drove revenue.\nSarah: Your first question comes from Joe Moore with Morgan Stanley.\nJoseph Moore: Agentic AI demand?\nColette Kress: Agentic AI is strong.\nSarah: Your next question comes from Vivek Arya.`;
  const p = parseTranscript(t);
  assert.deepEqual(p.segments.map((s) => `${s.role}:${s.section}`), ["company:prepared", "operator:qa", "analyst:qa", "company:qa", "operator:qa"]);
  assert.deepEqual(countTerm(p, "Agentic AI"), { count: 2, prepared: 1, qa: 1, analyst: 1 });
  assert.equal(transcriptDate("Fiscal quarter ended Dec 31, 2024\nQ1 2025 Earnings Call\nJan 30, 2025 , 5:00 p.m. ET"), "2025-01-30");
});
