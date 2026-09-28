// Replies to Instagram DMs from ONE allowlisted person with an ElevenLabs voice
// note. Fully on Cloudflare: Meta webhook in, two fetches out, KV for the audio
// Instagram fetches back. See README for the Meta setup, which is most of the work.
//
// Token model: a Facebook PAGE access token for the Page linked to the Instagram
// account. Derived from a long-lived user token, it never expires, so there is no
// refresh code and no cron. /health confirms it is still valid with a live call.
import { pcmToWav } from "./wav.ts";
import { verifyMetaSignature } from "./verify.ts";

interface Env {
  KV: KVNamespace;
  // vars (wrangler.jsonc)
  PUBLIC_ORIGIN: string;
  GRAPH_API_VERSION: string;
  ELEVENLABS_MODEL_ID: string;
  REPLY_TEXT: string;
  REPLY_COOLDOWN_MINUTES: string;
  // secrets (wrangler secret put)
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  META_APP_SECRET?: string;
  WEBHOOK_VERIFY_TOKEN?: string;
  IG_ACCESS_TOKEN?: string; // Page access token, permanent
  IG_PAGE_ID?: string; // the Facebook Page linked to the Instagram account; sends go via it
  IG_USER_ID?: string; // the Instagram business account; webhook entries carry this id
  ALLOWED_IGSID?: string;
}

const PCM_RATE = 24000; // must match output_format=pcm_24000 below
const AUDIO_TTL_S = 300; // Instagram fetches within seconds; 5 min is generous
const SEEN_TTL_S = 600; // Meta retries a delivery it thinks failed; dedupe on mid
const TOKEN_CHECK_TTL_S = 300; // /health re-validates the token at most this often
const VERSION = "0.2.0";

// ---- Meta webhook payload (only the fields used) ----------------------------
interface MessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: { mid?: string; text?: string; is_echo?: boolean };
}
interface WebhookBody {
  object?: string;
  entry?: { id?: string; time?: number; messaging?: MessagingEvent[] }[];
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return health(env);

    if (url.pathname === "/webhook" && req.method === "GET") return verifyHandshake(url, env);

    if (url.pathname === "/webhook" && req.method === "POST") {
      // Verify BEFORE parsing. The signature is over the raw bytes, so read them
      // once and reuse.
      if (!env.META_APP_SECRET) return text("META_APP_SECRET not configured", 503);
      const raw = await req.arrayBuffer();
      const ok = await verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), env.META_APP_SECRET);
      if (!ok) return text("bad signature", 401);

      let body: WebhookBody;
      try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return text("bad json", 400); }

      // Acknowledge immediately. Meta redelivers if it does not get a 2xx within
      // a few seconds, and a redelivery would mean a second voice note. The real
      // work (TTS + send) runs after the response is on the wire.
      ctx.waitUntil(processWebhook(body, env));
      return text("ok");
    }

    if (url.pathname.startsWith("/audio/") && req.method === "GET") return serveAudio(url.pathname.slice(7), env);

    return text("not found", 404);
  },
} satisfies ExportedHandler<Env>;

// ---- routes ------------------------------------------------------------------

function verifyHandshake(url: URL, env: Env): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (!env.WEBHOOK_VERIFY_TOKEN) return text("WEBHOOK_VERIFY_TOKEN not configured", 503);
  if (mode !== "subscribe" || token !== env.WEBHOOK_VERIFY_TOKEN || !challenge) return text("forbidden", 403);
  // Meta expects the challenge echoed back as the bare body.
  return text(challenge);
}

async function serveAudio(key: string, env: Env): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/.test(key)) return text("not found", 404);
  const wav = await env.KV.get(`audio:${key}`, { type: "arrayBuffer" });
  if (!wav) return text("gone", 404);
  return new Response(wav, {
    headers: {
      "content-type": "audio/wav",
      "content-length": String(wav.byteLength),
      "cache-control": "no-store",
    },
  });
}

async function health(env: Env): Promise<Response> {
  const configured = {
    elevenlabs: !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID),
    meta: !!(env.META_APP_SECRET && env.WEBHOOK_VERIFY_TOKEN && env.IG_ACCESS_TOKEN && env.IG_PAGE_ID && env.IG_USER_ID),
    allowlist: !!env.ALLOWED_IGSID,
  };
  const token = configured.meta ? await tokenStatus(env) : { valid: null as boolean | null, checked_at: null as string | null, note: "not configured" };
  const ok = configured.elevenlabs && configured.meta && configured.allowlist && token.valid === true;
  return new Response(JSON.stringify({ ok, version: VERSION, configured, token }, null, 2), {
    status: ok ? 200 : 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// ---- the actual job ----------------------------------------------------------

async function processWebhook(body: WebhookBody, env: Env): Promise<void> {
  if (body.object !== "instagram") return;
  for (const entry of body.entry ?? []) {
    // The Page can be linked to exactly one Instagram account, but be explicit:
    // events for any other account are not ours to answer.
    if (env.IG_USER_ID && entry.id && entry.id !== env.IG_USER_ID) continue;
    for (const evt of entry.messaging ?? []) {
      try { await handleEvent(evt, env); }
      catch (e) { console.error("handleEvent failed:", (e as Error).message); }
    }
  }
}

async function handleEvent(evt: MessagingEvent, env: Env): Promise<void> {
  const msg = evt.message;
  // Reactions, read receipts and postbacks arrive without a message. Echoes are
  // our own sends (and anything you type in the Instagram app) — replying to
  // those loops forever.
  if (!msg || msg.is_echo) return;
  const from = evt.sender?.id;
  if (!from) return;

  // Discovery mode: until the allowlist is set, say who is writing and stop. This
  // is how you find the IGSID to put in ALLOWED_IGSID. Once set, other senders
  // are dropped silently and never logged.
  if (!env.ALLOWED_IGSID) { console.log(`discovery: message from sender id ${from} (set ALLOWED_IGSID to reply)`); return; }
  if (from !== env.ALLOWED_IGSID) return;

  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID || !env.IG_ACCESS_TOKEN || !env.IG_PAGE_ID) {
    console.error("not configured: need ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, IG_ACCESS_TOKEN, IG_PAGE_ID"); return;
  }

  if (msg.mid) {
    const seenKey = `seen:${msg.mid}`;
    if (await env.KV.get(seenKey)) return;
    await env.KV.put(seenKey, "1", { expirationTtl: SEEN_TTL_S });
  }

  const cooldownMin = parseInt(env.REPLY_COOLDOWN_MINUTES || "0", 10);
  const lastKey = `last_reply:${from}`;
  if (cooldownMin > 0) {
    const last = await env.KV.get(lastKey);
    if (last && Date.now() - Number(last) < cooldownMin * 60_000) return;
  }

  const pcm = await tts(env, env.REPLY_TEXT);
  const wav = pcmToWav(pcm, PCM_RATE);
  const key = crypto.randomUUID();
  await env.KV.put(`audio:${key}`, wav, { expirationTtl: AUDIO_TTL_S });

  await sendAudio(env, from, `${env.PUBLIC_ORIGIN}/audio/${key}`);
  if (cooldownMin > 0) await env.KV.put(lastKey, String(Date.now()), { expirationTtl: cooldownMin * 60 + 60 });
  console.log(`replied to ${from} with ${wav.byteLength} bytes of audio`);
}

async function tts(env: Env, textToSpeak: string): Promise<ArrayBuffer> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}?output_format=pcm_${PCM_RATE}`,
    {
      method: "POST",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ text: textToSpeak, model_id: env.ELEVENLABS_MODEL_ID }),
    },
  );
  if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.arrayBuffer();
}

// Instagram messaging through a linked Facebook Page uses the Messenger Platform
// endpoint on graph.facebook.com, addressed by PAGE id, with the recipient's
// Instagram-scoped id. This is the "Instagram API with Facebook Login" path.
async function sendAudio(env: Env, to: string, audioUrl: string): Promise<void> {
  const res = await fetch(`https://graph.facebook.com/${env.GRAPH_API_VERSION}/${env.IG_PAGE_ID}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.IG_ACCESS_TOKEN}` },
    body: JSON.stringify({ recipient: { id: to }, message: { attachment: { type: "audio", payload: { url: audioUrl } } } }),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`graph send ${res.status}: ${bodyText.slice(0, 300)}`);
}

// ---- token validity ----------------------------------------------------------
// The Page token has no expiry, but it can be invalidated: resetting the app
// secret, removing the app from the Page, or a password change on the granting
// Facebook account all do it, silently. /health asks Meta whether the token still
// works, cached briefly so a status-page probe every minute stays cheap.

async function tokenStatus(env: Env): Promise<{ valid: boolean | null; checked_at: string | null; note?: string }> {
  const cached = await env.KV.get("health:token", { type: "json" }) as { valid: boolean; checked_at: string } | null;
  if (cached) return cached;
  let valid: boolean;
  let note: string | undefined;
  try {
    const res = await fetch(`https://graph.facebook.com/${env.GRAPH_API_VERSION}/${env.IG_PAGE_ID}?fields=id`, {
      headers: { authorization: `Bearer ${env.IG_ACCESS_TOKEN}` },
    });
    valid = res.ok;
    if (!res.ok) note = (await res.text()).slice(0, 200);
  } catch (e) {
    valid = false; note = (e as Error).message;
  }
  const status = { valid, checked_at: new Date().toISOString(), ...(note ? { note } : {}) };
  await env.KV.put("health:token", JSON.stringify(status), { expirationTtl: TOKEN_CHECK_TTL_S });
  return status;
}

// ---- helpers -----------------------------------------------------------------

function text(body: string, status = 200): Response {
  return new Response(body + (body.endsWith("\n") ? "" : "\n"), {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
