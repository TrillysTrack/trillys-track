import test from "node:test";
import assert from "node:assert/strict";
import { buildMatcher, countMatches, parseTranscript, countTerm, htmlToText, rulesOptions, titleOf } from "../../lib/mentions/terms.mjs";

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
