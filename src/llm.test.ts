import { test } from "node:test";
import assert from "node:assert/strict";
import { trimToSentence, completeSentences, accessHeaders } from "./llm.ts";

test("returns short text unchanged", () => {
  assert.equal(trimToSentence("Seri da!", 160), "Seri da!");
});

test("cuts at a sentence boundary when over the limit", () => {
  const t = "Enna da, saptiya? Naan ippo office la iruken. Night call panren, seri va?";
  assert.equal(trimToSentence(t, 50), "Enna da, saptiya? Naan ippo office la iruken.");
});

test("falls back to a word boundary when there is no sentence end", () => {
  const t = "one two three four five six seven eight nine ten eleven twelve";
  const out = trimToSentence(t, 30);
  assert.ok(out.length <= 30);
  assert.ok(!out.endsWith(" "));
  assert.ok(t.startsWith(out));
});

test("completeSentences drops an unfinished trailing sentence", () => {
  assert.equal(completeSentences("நான் தான் டா. தொண்டை கொஞ்சம் கட்"), "நான் தான் டா.");
  assert.equal(completeSentences("சரி டா! நீ என்ன பண்ற? சாப்"), "சரி டா! நீ என்ன பண்ற?");
  assert.equal(completeSentences("முடிக்கவே இல்ல"), "");
});

test("Access service-token headers are sent only when both parts are set", () => {
  assert.deepEqual(accessHeaders({ CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "s" }), { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "s" });
  assert.deepEqual(accessHeaders({ CF_ACCESS_CLIENT_ID: "id.access" }), {});
  assert.deepEqual(accessHeaders({}), {});
});
