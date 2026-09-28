import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyChatwootSignature, safeEqual, isIncomingMessage, contactOf, contactMatches, instagramUsername, audioForm, type ChatwootEvent } from "./chatwoot.ts";

const secret = "whsec_test";
const body = JSON.stringify({ event: "message_created", id: 1, content: "hi" });
const raw = new TextEncoder().encode(body);
const nowMs = 1_760_000_000_000;
const ts = String(Math.floor(nowMs / 1000));
const sign = (t: string, b: string, s = secret) => `sha256=${createHmac("sha256", s).update(`${t}.${b}`).digest("hex")}`;

test("accepts a signature Chatwoot would produce", async () => {
  assert.equal(await verifyChatwootSignature(raw, ts, sign(ts, body), secret, nowMs), true);
});
test("accepts an upper-case hex digest", async () => {
  assert.equal(await verifyChatwootSignature(raw, ts, sign(ts, body).toUpperCase(), secret, nowMs), true);
});
test("rejects a tampered body", async () => {
  const other = new TextEncoder().encode(body.replace("hi", "ho"));
  assert.equal(await verifyChatwootSignature(other, ts, sign(ts, body), secret, nowMs), false);
});
test("rejects a signature over a different timestamp than the header", async () => {
  assert.equal(await verifyChatwootSignature(raw, ts, sign(String(Number(ts) - 1), body), secret, nowMs), false);
});
test("rejects a stale timestamp (replay)", async () => {
  const old = String(Number(ts) - 3600);
  assert.equal(await verifyChatwootSignature(raw, old, sign(old, body), secret, nowMs), false);
});
test("rejects a missing header, a bad timestamp, and the wrong secret", async () => {
  assert.equal(await verifyChatwootSignature(raw, ts, null, secret, nowMs), false);
  assert.equal(await verifyChatwootSignature(raw, null, sign(ts, body), secret, nowMs), false);
  assert.equal(await verifyChatwootSignature(raw, "yesterday", sign("yesterday", body), secret, nowMs), false);
  assert.equal(await verifyChatwootSignature(raw, ts, sign(ts, body, "other"), secret, nowMs), false);
});

test("safeEqual", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
});

const contact = { id: 42, name: "Raagul", additional_attributes: { social_profiles: { instagram: "RaagulRockzz" }, social_instagram_user_name: "RaagulRockzz" } };
const incoming: ChatwootEvent = { event: "message_created", id: 7, content: "hey", message_type: "incoming", private: false, sender: contact, conversation: { id: 3, inbox_id: 1, contact_inbox: { source_id: "1234567890" } } };

test("only real incoming messages are handled", () => {
  assert.equal(isIncomingMessage(incoming), true);
  assert.equal(isIncomingMessage({ ...incoming, message_type: 0 }), true);
  assert.equal(isIncomingMessage({ ...incoming, message_type: "outgoing" }), false);
  assert.equal(isIncomingMessage({ ...incoming, private: true }), false);
  assert.equal(isIncomingMessage({ ...incoming, event: "message_updated" }), false);
  assert.equal(isIncomingMessage({ ...incoming, event: "conversation_created" }), false);
});

test("contact comes from sender, else from the conversation", () => {
  assert.equal(contactOf(incoming)?.id, 42);
  assert.equal(contactOf({ ...incoming, sender: undefined, conversation: { id: 3, meta: { sender: { id: 9 } } } })?.id, 9);
});

test("username is read from either key Chatwoot writes", () => {
  assert.equal(instagramUsername(contact), "RaagulRockzz");
  assert.equal(instagramUsername({ id: 1, additional_attributes: { social_profiles: { instagram: "x" } } }), "x");
  assert.equal(instagramUsername({ id: 1, additional_attributes: { social_instagram_user_name: "y" } }), "y");
  assert.equal(instagramUsername({ id: 1 }), undefined);
});

test("allowlist matches by id or username, case-insensitively, with or without @", () => {
  assert.equal(contactMatches(contact, "42"), true);
  assert.equal(contactMatches(contact, "raagulrockzz"), true);
  assert.equal(contactMatches(contact, "@RaagulRockzz"), true);
  assert.equal(contactMatches(contact, "43"), false);
  assert.equal(contactMatches(contact, "someoneelse"), false);
  assert.equal(contactMatches(contact, ""), false);
  assert.equal(contactMatches(undefined, "42"), false);
  assert.equal(contactMatches({ id: 42 }, "raagulrockzz"), false); // no username on record: id only
});

test("the multipart body names the file field the way Rails expects", () => {
  const fd = audioForm(new Uint8Array([82, 73, 70, 70]).buffer);
  assert.equal(fd.get("message_type"), "outgoing");
  assert.equal(fd.get("private"), "false");
  assert.equal(fd.get("is_voice_message"), "true");
  const file = fd.get("attachments[]");
  assert.ok(file instanceof Blob);
  assert.equal(file.type, "audio/wav");
  assert.equal((file as File).name, "reply.wav");
  assert.equal(file.size, 4);
});
