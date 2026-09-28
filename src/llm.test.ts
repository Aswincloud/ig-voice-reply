import { test } from "node:test";
import assert from "node:assert/strict";
import { trimToSentence } from "./llm.ts";

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
