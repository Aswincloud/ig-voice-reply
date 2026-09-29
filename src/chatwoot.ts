// The Chatwoot side of the bridge.
//
// Why it exists: a Meta app on Standard Access only receives Instagram messages
// from people who hold a role on the app. Chatwoot Cloud connects the Instagram
// account through Chatwoot's own reviewed app, so it receives everyone's messages
// and can reply to anyone. Point a Chatwoot account webhook at this Worker and
// reply through Chatwoot's API; Chatwoot relays an `audio/*` attachment to
// Instagram as a voice note (Instagram::BaseSendService#attachment_message_params).
import { hex } from "./verify.ts";

// ---- webhook payload (only the fields used) ---------------------------------
export interface ChatwootContact {
  id?: number;
  name?: string | null;
  identifier?: string | null;
  additional_attributes?: {
    social_profiles?: { instagram?: string };
    social_instagram_user_name?: string;
    [k: string]: unknown;
  } | null;
}
export interface ChatwootAttachment {
  file_type?: string; // image | audio | video | file | ig_reel | ig_post | ig_story | story_mention | share | ...
  content_type?: string;
  data_url?: string; // for Instagram: Meta's signed CDN URL, fetchable without auth
  file_size?: number;
}
export interface ChatwootEvent {
  event?: string;
  id?: number;
  content?: string | null;
  message_type?: string | number; // "incoming" | "outgoing" | "template" (0 | 1 | 2 in older payloads)
  private?: boolean;
  content_type?: string;
  attachments?: ChatwootAttachment[];
  sender?: ChatwootContact;
  conversation?: {
    id?: number;
    inbox_id?: number;
    status?: string;
    channel?: string;
    contact_inbox?: { source_id?: string }; // for Instagram this is the IGSID
    meta?: { sender?: ChatwootContact };
  };
  inbox?: { id?: number; name?: string };
  account?: { id?: number; name?: string };
}

export interface ChatwootEnv {
  CHATWOOT_BASE_URL: string;
  CHATWOOT_ACCOUNT_ID: string;
  CHATWOOT_API_TOKEN?: string;
}

// A message someone wrote to us, as opposed to our own sends (also delivered as
// message_created, with message_type outgoing), private notes, and other events.
export function isIncomingMessage(evt: ChatwootEvent): boolean {
  if (evt.event !== "message_created") return false;
  if (evt.private) return false;
  return evt.message_type === "incoming" || evt.message_type === 0;
}

// On an incoming message the sender is the contact. Fall back to the
// conversation's contact for payload variants that omit sender.
export function contactOf(evt: ChatwootEvent): ChatwootContact | undefined {
  return evt.sender?.id !== undefined ? evt.sender : evt.conversation?.meta?.sender;
}

// Chatwoot stores the Instagram username on the contact under two keys
// (Instagram::WebhooksBaseService#instagram_attributes). Read either.
export function instagramUsername(c: ChatwootContact | undefined): string | undefined {
  const a = c?.additional_attributes;
  const u = a?.social_instagram_user_name || a?.social_profiles?.instagram;
  return typeof u === "string" && u ? u : undefined;
}

// The allowlist value is a Chatwoot contact id or an Instagram username
// (with or without a leading @, any case).
export function contactMatches(c: ChatwootContact | undefined, allowed: string): boolean {
  const want = allowed.trim().replace(/^@/, "").toLowerCase();
  if (!want || !c) return false;
  if (c.id !== undefined && String(c.id) === want) return true;
  const u = instagramUsername(c);
  return !!u && u.toLowerCase() === want;
}

export function describeContact(c: ChatwootContact | undefined, evt: ChatwootEvent): string {
  const u = instagramUsername(c);
  const igsid = evt.conversation?.contact_inbox?.source_id;
  return `contact ${c?.id ?? "?"}${u ? ` @${u}` : ""}${c?.name ? ` "${c.name}"` : ""}${igsid ? ` igsid ${igsid}` : ""}`;
}

// ---- webhook authentication --------------------------------------------------
// Chatwoot signs webhooks only when the webhook has a secret configured:
//   X-Chatwoot-Timestamp: <unix seconds>
//   X-Chatwoot-Signature: sha256=HMAC_SHA256(secret, "<timestamp>.<raw body>")
// (lib/webhooks/trigger.rb). Without a secret nothing identifies the caller, so
// the Worker also requires an unguessable path segment; see worker.ts.
export async function verifyChatwootSignature(
  rawBody: BufferSource,
  tsHeader: string | null,
  sigHeader: string | null,
  secret: string,
  nowMs: number = Date.now(),
  toleranceS = 300,
): Promise<boolean> {
  if (!tsHeader || !sigHeader || !/^\d{1,12}$/.test(tsHeader)) return false;
  if (Math.abs(nowMs / 1000 - Number(tsHeader)) > toleranceS) return false;
  const body = rawBody instanceof ArrayBuffer ? new Uint8Array(rawBody) : new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  const prefix = new TextEncoder().encode(`${tsHeader}.`);
  const data = new Uint8Array(prefix.length + body.length);
  data.set(prefix, 0);
  data.set(body, prefix.length);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
  return safeEqual(sigHeader.trim().toLowerCase(), `sha256=${mac}`);
}

// Constant-time string compare (length is allowed to leak).
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---- replying through Chatwoot -----------------------------------------------

function messagesUrl(env: ChatwootEnv, conversationId: number): string {
  return `${env.CHATWOOT_BASE_URL.replace(/\/$/, "")}/api/v1/accounts/${env.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`;
}

// Multipart body for POST .../messages. `attachments[]` is the field name Rails
// needs for an array; Chatwoot types the file from its content-type, so
// audio/wav becomes file_type "audio" and is relayed to Instagram as one.
export function audioForm(wav: ArrayBuffer, filename = "reply.wav"): FormData {
  const fd = new FormData();
  fd.append("message_type", "outgoing");
  fd.append("private", "false");
  fd.append("is_voice_message", "true");
  fd.append("attachments[]", new Blob([wav], { type: "audio/wav" }), filename);
  return fd;
}

export async function sendChatwootAudio(env: ChatwootEnv, conversationId: number, wav: ArrayBuffer): Promise<void> {
  const res = await fetch(messagesUrl(env, conversationId), {
    method: "POST",
    headers: { api_access_token: env.CHATWOOT_API_TOKEN! },
    body: audioForm(wav),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`chatwoot send ${res.status}: ${bodyText.slice(0, 300)}`);
}

// A private note is visible in Chatwoot only, never relayed to Instagram. Used to
// leave the spoken text next to the voice note so the thread reads back.
export async function sendChatwootNote(env: ChatwootEnv, conversationId: number, content: string): Promise<void> {
  const res = await fetch(messagesUrl(env, conversationId), {
    method: "POST",
    headers: { api_access_token: env.CHATWOOT_API_TOKEN!, "content-type": "application/json" },
    body: JSON.stringify({ content, message_type: "outgoing", private: true }),
  });
  if (!res.ok) throw new Error(`chatwoot note ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// Cheapest authenticated call that also proves the account id is right.
export async function chatwootTokenCheck(env: ChatwootEnv): Promise<{ valid: boolean; note?: string }> {
  try {
    const res = await fetch(`${env.CHATWOOT_BASE_URL.replace(/\/$/, "")}/api/v1/accounts/${env.CHATWOOT_ACCOUNT_ID}/inboxes`, {
      headers: { api_access_token: env.CHATWOOT_API_TOKEN! },
    });
    return res.ok ? { valid: true } : { valid: false, note: `${res.status} ${(await res.text()).slice(0, 200)}` };
  } catch (e) {
    return { valid: false, note: (e as Error).message };
  }
}

// ---- attachments ---------------------------------------------------------------

// What to tell the model an attachment was, when it cannot see it.
const ATTACHMENT_WORDS: Record<string, string> = {
  image: "a photo", audio: "a voice message", video: "a video", file: "a file",
  ig_reel: "a reel", ig_post: "a post", share: "a post", ig_story: "a story", story_mention: "a story mention",
  location: "a location", contact: "a contact",
};

// The text half of an incoming message: what he typed, plus a note for each
// attachment. Photos are also sent to the model as images (imagesOf); the note is
// what stays in the stored history, so memory never carries image data.
export function describeIncoming(evt: ChatwootEvent): string {
  const typed = evt.content?.trim() ?? "";
  const notes = (evt.attachments ?? []).map((a) => `[sent ${ATTACHMENT_WORDS[a.file_type ?? ""] ?? "an attachment"}]`);
  const text = [...notes, typed].filter(Boolean).join(" ");
  return text || "[sent a message]";
}

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
// Claude accepts up to 5 MB of base64 per image; base64 is 4/3 of the raw size.
export const MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);
const MAX_IMAGES = 3;

export function imagesOf(evt: ChatwootEvent): ChatwootAttachment[] {
  return (evt.attachments ?? []).filter((a) => a.file_type === "image" && !!a.data_url).slice(0, MAX_IMAGES);
}

function normaliseImageType(ct: string | null | undefined): ImageType | undefined {
  const t = (ct ?? "").split(";")[0].trim().toLowerCase().replace("image/jpg", "image/jpeg");
  return (IMAGE_TYPES as readonly string[]).includes(t) ? (t as ImageType) : undefined;
}

// Downloads one photo for the model. Returns undefined (and the reply falls back to
// the text note) on any failure: expired CDN link, unsupported type, too large.
export async function fetchImage(a: ChatwootAttachment): Promise<{ media_type: ImageType; data: string } | undefined> {
  try {
    const res = await fetch(a.data_url!, { redirect: "follow" });
    if (!res.ok) { console.warn(`image fetch ${res.status}`); return undefined; }
    const media_type = normaliseImageType(res.headers.get("content-type")) ?? normaliseImageType(a.content_type);
    if (!media_type) { console.warn(`image type not supported: ${res.headers.get("content-type")}`); return undefined; }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) { console.warn(`image too large: ${buf.byteLength} bytes`); return undefined; }
    return { media_type, data: Buffer.from(buf).toString("base64") };
  } catch (e) {
    console.warn("image fetch failed:", (e as Error).message);
    return undefined;
  }
}
