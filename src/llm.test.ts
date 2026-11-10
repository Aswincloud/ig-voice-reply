import { test } from "node:test";
import assert from "node:assert/strict";
import { trimToSentence, completeSentences, accessHeaders, generateReply } from "./llm.ts";

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

test("when a VPC binding is present, Claude calls go through it", async () => {
  const seen: string[] = [];
  const vpc = { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(String(input instanceof Request ? input.url : input)); void init;
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "வணக்கம்." }] }), { headers: { "content-type": "application/json" } });
  } };
  const r = await generateReply({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://litellm.aswincloud.com", ANTHROPIC_MODEL: "claude-opus-5-5",
    REFUSAL_TEXT: "R", FALLBACK_TEXT: "F", LITELLM_VPC: vpc }, [{ role: "user", content: "hi" }], 180);
  assert.equal(r.text, "வணக்கம்.");
  assert.equal(seen.length, 1);
  assert.ok(seen[0].startsWith("https://litellm.aswincloud.com/"));
});
