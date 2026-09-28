import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMetaSignature, hex } from "./verify.ts";

const SECRET = "test-app-secret";
const body = new TextEncoder().encode('{"object":"instagram","entry":[]}');

async function sign(bytes: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return "sha256=" + hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes)));
}

test("accepts a correctly signed body", async () => {
  const sig = await sign(body, SECRET);
  assert.equal(await verifyMetaSignature(body, sig, SECRET), true);
});

test("rejects a tampered body", async () => {
  const sig = await sign(body, SECRET);
  const tampered = new TextEncoder().encode('{"object":"instagram","entry":[{}]}');
  assert.equal(await verifyMetaSignature(tampered, sig, SECRET), false);
});

test("rejects the wrong secret", async () => {
  const sig = await sign(body, "some-other-secret");
  assert.equal(await verifyMetaSignature(body, sig, SECRET), false);
});

test("rejects a missing or malformed header", async () => {
  assert.equal(await verifyMetaSignature(body, null, SECRET), false);
  assert.equal(await verifyMetaSignature(body, "sha1=abcd", SECRET), false);
  assert.equal(await verifyMetaSignature(body, "", SECRET), false);
});
