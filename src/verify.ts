// Meta signs every webhook delivery: X-Hub-Signature-256 = "sha256=" + hex HMAC of
// the RAW request body with the app secret. Anything that fails this is not from
// Meta and must not reach the handler, or anyone who finds the URL can make the
// Worker send voice notes on your behalf.
export async function verifyMetaSignature(
  rawBody: BufferSource,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, rawBody);
  const expected = "sha256=" + hex(new Uint8Array(mac));
  return timingSafeEqual(expected, header);
}

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

// Constant-time compare. A plain === returns early on the first differing byte,
// which leaks how much of the MAC an attacker has right.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
