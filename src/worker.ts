// Replies to Instagram DMs from ONE allowlisted person with an ElevenLabs voice
// note. Fully on Cloudflare: a webhook in, a few fetches out, KV for state.
//
// Two ways in, same reply pipeline:
//   /webhook   Meta delivers the DM directly (Instagram API, Facebook Login route).
//              Only reaches people who hold a role on the Meta app while the app
//              is on Standard Access, so in practice: the owner's own test account.
//   /chatwoot  Chatwoot Cloud delivers the DM. Chatwoot's own reviewed Meta app
//              receives everyone's messages, and its API relays an audio
//              attachment back to Instagram as a voice note. This is the route
//              that reaches the actual friend. See src/chatwoot.ts.
//
// Token model for the Meta route: a Facebook PAGE access token for the Page linked
// to the Instagram account. Derived from a long-lived user token, it never
// expires, so there is no refresh code and no cron. /health confirms it is still
// valid with a live call. The Chatwoot route uses a Chatwoot API access token.
import type Anthropic from "@anthropic-ai/sdk";
import { pcmToWav } from "./wav.ts";
import { verifyMetaSignature } from "./verify.ts";
import { istDate, decideBudget } from "./budget.ts";
import { generateReply } from "./llm.ts";
import {
  type ChatwootEvent, verifyChatwootSignature, safeEqual, isIncomingMessage, contactOf, instagramUsername,
  contactMatches, describeContact, sendChatwootAudio, sendChatwootNote, chatwootTokenCheck,
} from "./chatwoot.ts";

interface Env {
  KV: KVNamespace;
  // vars (wrangler.jsonc)
  PUBLIC_ORIGIN: string;
  GRAPH_API_VERSION: string;
  ELEVENLABS_MODEL_ID: string;
  REPLY_COOLDOWN_MINUTES: string;
  ANTHROPIC_MODEL: string;
  DAILY_CREDIT_LIMIT: string; // ElevenLabs credits per IST day; 0 disables
  MAX_REPLY_CHARS: string;
  SIGNOFF_TEXT: string; // spoken once when the day's budget is nearly used up
  REFUSAL_TEXT: string; // spoken when Claude declines the topic
  FALLBACK_TEXT: string; // spoken when Claude is unavailable
  CHATWOOT_BASE_URL: string; // e.g. https://app.chatwoot.com
  CHATWOOT_ACCOUNT_ID: string; // the number in the Chatwoot URL, /app/accounts/<id>/
  CHATWOOT_INBOX_ID: string; // optional: only act on this inbox
  // secrets (wrangler secret put)
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  META_APP_SECRET?: string;
  WEBHOOK_VERIFY_TOKEN?: string;
  IG_ACCESS_TOKEN?: string; // Page access token, permanent
  IG_PAGE_ID?: string; // the Facebook Page linked to the Instagram account; sends go via it
  IG_USER_ID?: string; // the Instagram business account; webhook entries carry this id
  ALLOWED_IGSID?: string; // Meta route: the one person, by Instagram-scoped id
  CHATWOOT_API_TOKEN?: string; // Profile settings -> Access Token
  CHATWOOT_WEBHOOK_TOKEN?: string; // unguessable path segment: POST /chatwoot/<token>
  CHATWOOT_WEBHOOK_SECRET?: string; // optional: the webhook's signing secret, if Chatwoot offers one
  CHATWOOT_ALLOWED_CONTACT?: string; // Chatwoot route: the one person, by Instagram username or contact id
}

const PCM_RATE = 24000; // must match output_format=pcm_24000 below
const AUDIO_TTL_S = 300; // Instagram fetches within seconds; 5 min is generous
const SEEN_TTL_S = 600; // deliveries get retried; dedupe on message id
const TOKEN_CHECK_TTL_S = 300; // /health re-validates tokens at most this often
const VERSION = "0.4.2";
const HISTORY_TURNS = 12; // messages kept per person for context
const HISTORY_TTL_S = 48 * 3600;
const USAGE_TTL_S = 2 * 86400;
const CHATWOOT_PREFIX = "/chatwoot/";

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

    if (url.pathname.startsWith(CHATWOOT_PREFIX) && req.method === "POST") {
      // Chatwoot does not sign webhooks unless a secret is configured, so the URL
      // itself carries an unguessable token. A wrong token is a plain 404: nothing
      // to probe. When a signing secret is also set, the signature must check out.
      if (!env.CHATWOOT_WEBHOOK_TOKEN) return text("CHATWOOT_WEBHOOK_TOKEN not configured", 503);
      if (!safeEqual(url.pathname.slice(CHATWOOT_PREFIX.length), env.CHATWOOT_WEBHOOK_TOKEN)) return text("not found", 404);
      const raw = await req.arrayBuffer();
      if (env.CHATWOOT_WEBHOOK_SECRET) {
        const ok = await verifyChatwootSignature(raw, req.headers.get("x-chatwoot-timestamp"), req.headers.get("x-chatwoot-signature"), env.CHATWOOT_WEBHOOK_SECRET);
        if (!ok) return text("bad signature", 401);
      }
      let evt: ChatwootEvent;
      try { evt = JSON.parse(new TextDecoder().decode(raw)); } catch { return text("bad json", 400); }
      ctx.waitUntil(handleChatwootEvent(evt, env).catch((e) => console.error("chatwoot event failed:", (e as Error).message)));
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
    llm: !!env.ANTHROPIC_API_KEY,
    meta: !!(env.META_APP_SECRET && env.WEBHOOK_VERIFY_TOKEN && env.IG_ACCESS_TOKEN && env.IG_PAGE_ID && env.IG_USER_ID),
    allowlist: !!env.ALLOWED_IGSID,
    chatwoot_webhook: !!env.CHATWOOT_WEBHOOK_TOKEN,
    chatwoot_api: !!(env.CHATWOOT_BASE_URL && env.CHATWOOT_ACCOUNT_ID && env.CHATWOOT_API_TOKEN),
    chatwoot_allowlist: !!env.CHATWOOT_ALLOWED_CONTACT,
  };
  const today = istDate();
  const usage = {
    date: today,
    credits_used: Number((await env.KV.get(`usage:${today}`)) ?? 0),
    limit: parseInt(env.DAILY_CREDIT_LIMIT || "0", 10),
    signoff_sent: !!(await env.KV.get(`signoff:${today}`)),
  };
  const notConfigured = { valid: null as boolean | null, checked_at: null as string | null, note: "not configured" };
  const token = configured.meta ? await cachedCheck(env, "health:token", () => metaTokenCheck(env)) : notConfigured;
  const chatwoot_token = configured.chatwoot_api ? await cachedCheck(env, "health:chatwoot", () => chatwootTokenCheck(env)) : notConfigured;
  // Healthy means: it can speak, and at least one route will actually reply to someone.
  const metaReady = configured.meta && configured.allowlist && token.valid === true;
  const chatwootReady = configured.chatwoot_webhook && configured.chatwoot_api && configured.chatwoot_allowlist && chatwoot_token.valid === true;
  const ok = configured.elevenlabs && configured.llm && (metaReady || chatwootReady);
  const routes = { meta: metaReady ? "replying" : "idle", chatwoot: chatwootReady ? "replying" : "idle" };
  return new Response(JSON.stringify({ ok, version: VERSION, routes, configured, token, chatwoot_token, usage_today: usage }, null, 2), {
    status: ok ? 200 : 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// ---- Meta route --------------------------------------------------------------

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
  // Reactions, read receipts and postbacks arrive without a message.
  if (!msg) return;

  // Echoes are our own API sends; replying to those loops forever. The recipient
  // id of an echo is also a way to learn someone's Instagram-scoped id, so keep
  // the latest one that is not the allowlisted person. It is the owner's own
  // outbound activity.
  if (msg.is_echo) {
    const to = evt.recipient?.id;
    if (to && to !== env.ALLOWED_IGSID) {
      console.log(`echo: you sent a message to recipient id ${to}${env.ALLOWED_IGSID ? "" : " (set ALLOWED_IGSID to reply to them)"}`);
      await env.KV.put("echo:last", JSON.stringify({ recipient: to, at: new Date().toISOString() }), { expirationTtl: 7 * 86400 });
    }
    return;
  }
  const from = evt.sender?.id;
  if (!from) return;

  // Discovery mode: until the allowlist is set, say who is writing and stop.
  // Once set, other senders are dropped silently and never logged.
  if (!env.ALLOWED_IGSID) {
    console.log(`discovery: message from sender id ${from} (set ALLOWED_IGSID to reply)`);
    await env.KV.put("discovery:last", JSON.stringify({ sender: from, at: new Date().toISOString() }), { expirationTtl: 7 * 86400 });
    return;
  }
  if (from !== env.ALLOWED_IGSID) return;

  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID || !env.IG_ACCESS_TOKEN || !env.IG_PAGE_ID) {
    console.error("not configured: need ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, IG_ACCESS_TOKEN, IG_PAGE_ID"); return;
  }
  if (msg.mid && !(await firstSighting(env, `seen:${msg.mid}`))) return;

  await replyTo(env, { key: from, label: `igsid ${from}` }, msg.text?.trim() || "[sent an attachment]", async (wav) => {
    // Instagram fetches the audio from us, so park it in KV briefly.
    const key = crypto.randomUUID();
    await env.KV.put(`audio:${key}`, wav, { expirationTtl: AUDIO_TTL_S });
    await sendAudio(env, from, `${env.PUBLIC_ORIGIN}/audio/${key}`);
  });
}

// ---- Chatwoot route ----------------------------------------------------------

async function handleChatwootEvent(evt: ChatwootEvent, env: Env): Promise<void> {
  // Our own sends come back as message_created too (message_type outgoing), as
  // do private notes and everything the owner types in Chatwoot or in the
  // Instagram app. Only what the other person wrote is a prompt.
  if (!isIncomingMessage(evt)) return;
  const inboxId = evt.inbox?.id ?? evt.conversation?.inbox_id;
  if (env.CHATWOOT_INBOX_ID && String(inboxId) !== env.CHATWOOT_INBOX_ID) return;
  const contact = contactOf(evt);
  const conversationId = evt.conversation?.id;
  if (!contact?.id || !conversationId) return;

  // Discovery mode, same idea as the Meta route: until CHATWOOT_ALLOWED_CONTACT is
  // set, say who wrote and stop. Chatwoot knows the Instagram username, so the
  // allowlist can simply be that username; the log is here for confirmation.
  const who = describeContact(contact, evt);
  if (!env.CHATWOOT_ALLOWED_CONTACT) {
    console.log(`discovery (chatwoot): message from ${who} (set CHATWOOT_ALLOWED_CONTACT to their username or contact id to reply)`);
    await env.KV.put("discovery:chatwoot", JSON.stringify({ contact: contact.id, username: instagramUsername(contact) ?? null, name: contact.name ?? null, igsid: evt.conversation?.contact_inbox?.source_id ?? null, conversation: conversationId, at: new Date().toISOString() }), { expirationTtl: 7 * 86400 });
    return;
  }
  if (!contactMatches(contact, env.CHATWOOT_ALLOWED_CONTACT)) return;

  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID || !env.CHATWOOT_API_TOKEN || !env.CHATWOOT_BASE_URL || !env.CHATWOOT_ACCOUNT_ID) {
    console.error("not configured: need ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, CHATWOOT_API_TOKEN, CHATWOOT_BASE_URL, CHATWOOT_ACCOUNT_ID"); return;
  }
  if (evt.id !== undefined && !(await firstSighting(env, `seen:cw:${evt.id}`))) return;

  const incoming = evt.content?.trim() || (evt.attachments?.length ? "[sent an attachment]" : "[sent a message]");
  await replyTo(env, { key: `cw:${contact.id}`, label: who }, incoming, async (wav, said) => {
    // Chatwoot stores the file and hands Instagram a URL to it; nothing for us to host.
    await sendChatwootAudio(env, conversationId, wav);
    // Leave the words next to the voice note, for the owner reading the thread
    // in Chatwoot. Private, so Instagram never sees it. Not worth failing over.
    try { await sendChatwootNote(env, conversationId, `🔊 ${said}`); }
    catch (e) { console.warn("chatwoot note failed:", (e as Error).message); }
  });
}

// ---- the reply pipeline, shared by both routes -------------------------------

interface Person { key: string; label: string } // key: KV suffix for history/cooldown; label: for logs
type Deliver = (wav: ArrayBuffer, said: string, kind: string) => Promise<void>;

async function replyTo(env: Env, person: Person, incoming: string, deliver: Deliver): Promise<void> {
  const cooldownMin = parseInt(env.REPLY_COOLDOWN_MINUTES || "0", 10);
  const lastKey = `last_reply:${person.key}`;
  if (cooldownMin > 0) {
    const last = await env.KV.get(lastKey);
    if (last && Date.now() - Number(last) < cooldownMin * 60_000) return;
  }

  // ---- daily credit budget -------------------------------------------------
  const today = istDate();
  const used = Number((await env.KV.get(`usage:${today}`)) ?? 0);
  const limit = parseInt(env.DAILY_CREDIT_LIMIT || "0", 10);
  const maxChars = parseInt(env.MAX_REPLY_CHARS || "160", 10);
  const signoffSent = !!(await env.KV.get(`signoff:${today}`));
  const decision = decideBudget(used, limit, maxChars, env.SIGNOFF_TEXT.length + 10, signoffSent);
  if (decision.kind === "stop") { console.log(`budget: ${used}/${limit} credits used today, staying quiet`); return; }

  // ---- what to say ---------------------------------------------------------
  let said: string;
  let kind: string;
  const histKey = `history:${person.key}`;
  let history = ((await env.KV.get(histKey, { type: "json" })) as Anthropic.MessageParam[] | null) ?? [];
  if (decision.kind === "signoff") {
    said = env.SIGNOFF_TEXT; kind = "signoff";
  } else {
    history.push({ role: "user", content: incoming });
    const r = await generateReply(env, history, Math.min(maxChars, decision.room));
    said = r.text; kind = r.kind;
  }
  // Log the line itself. This is a one-owner bot; seeing what it said to the one
  // person it talks to is how the persona gets tuned.
  console.log(`say (${kind}, ${said.length} chars): ${said}`);

  // ---- speak it ------------------------------------------------------------
  const { pcm, cost } = await tts(env, said);
  // ElevenLabs has charged for this the moment TTS returns, so record it now,
  // before the send. A failed send must not leave the day's budget
  // under-reporting what was actually spent.
  const nowUsed = used + cost;
  await env.KV.put(`usage:${today}`, String(nowUsed), { expirationTtl: USAGE_TTL_S });
  if (kind === "signoff") await env.KV.put(`signoff:${today}`, "1", { expirationTtl: USAGE_TTL_S });

  const wav = pcmToWav(pcm, PCM_RATE);
  await deliver(wav, said, kind);

  // ---- bookkeeping that only makes sense once the friend actually got it ----
  if (kind === "reply" || kind === "refusal") {
    history.push({ role: "assistant", content: said });
    history = history.slice(-HISTORY_TURNS);
    await env.KV.put(histKey, JSON.stringify(history), { expirationTtl: HISTORY_TTL_S });
  }
  if (cooldownMin > 0) await env.KV.put(lastKey, String(Date.now()), { expirationTtl: cooldownMin * 60 + 60 });
  console.log(`replied (${kind}) to ${person.label}: ${said.length} chars = ${cost} credits, ${wav.byteLength} bytes audio, ${nowUsed}/${limit} credits today`);
}

// True the first time a key is seen; false on a redelivery.
async function firstSighting(env: Env, key: string): Promise<boolean> {
  if (await env.KV.get(key)) return false;
  await env.KV.put(key, "1", { expirationTtl: SEEN_TTL_S });
  return true;
}

// Returns the audio and what ElevenLabs actually charged for it. The response
// carries `character-cost`; recording that instead of text.length keeps the
// daily budget exact. eleven_v3 has billed about half a credit per character
// on Tamil script, so counting characters over-charged the budget two-to-one.
async function tts(env: Env, textToSpeak: string): Promise<{ pcm: ArrayBuffer; cost: number }> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}?output_format=pcm_${PCM_RATE}`,
    {
      method: "POST",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ text: textToSpeak, model_id: env.ELEVENLABS_MODEL_ID }),
    },
  );
  if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const header = Number(res.headers.get("character-cost"));
  const cost = Number.isFinite(header) && header > 0 ? header : textToSpeak.length; // fall back to counting characters
  return { pcm: await res.arrayBuffer(), cost };
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
// works. The Chatwoot token is checked the same way. Both cached briefly so a
// status-page probe every minute stays cheap.

interface CheckResult { valid: boolean | null; checked_at: string | null; note?: string }

async function cachedCheck(env: Env, cacheKey: string, run: () => Promise<{ valid: boolean; note?: string }>): Promise<CheckResult> {
  const cached = await env.KV.get(cacheKey, { type: "json" }) as CheckResult | null;
  if (cached) return cached;
  const r = await run();
  const status: CheckResult = { valid: r.valid, checked_at: new Date().toISOString(), ...(r.note ? { note: r.note } : {}) };
  await env.KV.put(cacheKey, JSON.stringify(status), { expirationTtl: TOKEN_CHECK_TTL_S });
  return status;
}

async function metaTokenCheck(env: Env): Promise<{ valid: boolean; note?: string }> {
  try {
    const res = await fetch(`https://graph.facebook.com/${env.GRAPH_API_VERSION}/${env.IG_PAGE_ID}?fields=id`, {
      headers: { authorization: `Bearer ${env.IG_ACCESS_TOKEN}` },
    });
    return res.ok ? { valid: true } : { valid: false, note: (await res.text()).slice(0, 200) };
  } catch (e) {
    return { valid: false, note: (e as Error).message };
  }
}

// ---- helpers -----------------------------------------------------------------

function text(body: string, status = 200): Response {
  return new Response(body + (body.endsWith("\n") ? "" : "\n"), {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
