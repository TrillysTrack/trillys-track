import test from "node:test";
import assert from "node:assert/strict";
import { transcriptLinks } from "../../lib/mentions/fool.mjs";

test("transcriptLinks keeps only the company's own transcripts, deduplicated", () => {
  const html = `"url":"/earnings/call-transcripts/2026/08/20/advance-auto-parts-aap-q2-2026-earnings-call-transcript/"
    href="/earnings/call-transcripts/2026/08/20/advance-auto-parts-aap-q2-2026-earnings-call-transcript/"
    "/earnings/call-transcripts/2026/11/04/grab-holdings-grab-q3-2026-earnings-call-transcript/"
    "/earnings/call-transcripts/2026/05/21/aap-q1-2026-earnings-call-transcript/"
    "/earnings/call-transcripts/2026/05/21/snaap-q1-2026-earnings-call-transcript/"`;
  const links = transcriptLinks(html, "AAP");
  assert.deepEqual(links.map((l) => l.pubDate), ["2026-08-20", "2026-05-21"]);
  assert.match(links[0].url, /^https:\/\/www\.fool\.com\/earnings\/call-transcripts\/2026\/08\/20\//);
});
