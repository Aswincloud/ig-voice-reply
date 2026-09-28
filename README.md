# ig-voice-reply

Replies to Instagram DMs from **one allowlisted person** with a voice note generated
by ElevenLabs. Runs entirely on Cloudflare Workers; no server, no ffmpeg.

```
that person DMs your Instagram account
  → Meta webhook → this Worker (signature verified)
  → sender is the allowlisted IGSID?   no → drop
  → ElevenLabs TTS  (raw PCM)
  → 44-byte WAV header prepended
  → stored in KV for 5 minutes
  → Graph API: send audio attachment by URL
  → Instagram fetches the WAV and delivers it as a playable voice note
```

Everyone else who messages you is ignored and, once configured, never logged.

## Why it is shaped this way

- **WAV, not MP3.** Instagram's Messaging API accepts `aac, m4a, wav, mp4` and not MP3.
  ElevenLabs will emit raw PCM, and a WAV file is PCM plus a fixed 44-byte header. That
  is the entire transcoding step, which is what keeps this a Worker instead of a box
  with ffmpeg on it. See `src/wav.ts`.
- **Acknowledge, then work.** Meta redelivers a webhook it does not get a `2xx` for
  within a few seconds, and a redelivery is a second voice note. The handler returns
  `200` immediately and does the TTS and send in `ctx.waitUntil`. Deliveries are also
  deduplicated on the message id in case Meta retries anyway.
- **Compliant by construction.** The person always messages first, so every reply
  falls inside Meta's 24-hour window. Replying to your own account's inbound messages
  needs only Standard Access: **no App Review**.
- **Echoes are dropped.** The webhook fires for messages *you* send too, including
  ones typed in the Instagram app. Replying to those loops forever.

## Setup

### 1. ElevenLabs

Create an API key at <https://elevenlabs.io/app/settings/api-keys> and pick a voice
id. To reply in your own voice, Instant Voice Clone on the Starter plan needs about a
minute of clean audio.

### 2. Meta developer app

This is most of the work, and it is why every tool in this space is under-documented.

1. <https://developers.facebook.com/apps> → **Create App**. When asked for a use case
   or product, add **Instagram** and choose **"API setup with Instagram login"**. This
   path does not need a Facebook Page.
2. In the Instagram product, step **Generate access tokens**: add your Instagram
   professional account and generate a token. Copy the **token** and the **Instagram
   user id** shown beside it. The token is long-lived (60 days); the Worker refreshes it.
3. Step **Configure webhooks**:
   - Callback URL: `https://ig-reply.aswincloud.com/webhook`
   - Verify token: any string you invent. You will set the same value as
     `WEBHOOK_VERIFY_TOKEN`.
   - Subscribe to the **`messages`** field.
   The verify handshake will only succeed after the Worker is deployed with that secret.
4. **App settings → Basic → App Secret.** This signs every webhook delivery.
5. In the **Instagram app on your phone**: Settings → Messages and story replies →
   Message controls → **Connected tools** must be on. Without it Meta never sends the
   webhook and nothing in the logs explains why.

Leave the app in **Development mode**. For your own account that is sufficient.

### 3. Deploy

Connect the repo to **Workers Builds** in the Cloudflare dashboard and it deploys on
every push to `main`. The first deploy creates `ig-reply.aswincloud.com` and its DNS
record (custom domain, in `wrangler.jsonc`). Change that hostname if you fork this.

Then set the secrets. None of them go in git.

```sh
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put ELEVENLABS_VOICE_ID
npx wrangler secret put META_APP_SECRET
npx wrangler secret put WEBHOOK_VERIFY_TOKEN
npx wrangler secret put IG_ACCESS_TOKEN
npx wrangler secret put IG_USER_ID
```

Now complete the webhook verification on Meta's side (step 2.3). `GET /health` should
report `configured.meta: true` and `configured.elevenlabs: true`.

### 4. Find the person's IGSID

Instagram-scoped user ids are per (person, your account) and are not visible in the
app. Until `ALLOWED_IGSID` is set the Worker is in **discovery mode**: it logs the
sender id of each incoming message and does nothing else.

```sh
npm run tail
# ask the person to send you any DM, then read:
#   discovery: message from sender id 1784… (set ALLOWED_IGSID to reply)
npx wrangler secret put ALLOWED_IGSID
```

From this point other senders are dropped without being logged.

### 5. Test

Have the person send a message. Within a few seconds a voice note appears in the
thread, from you. `npm run tail` shows `replied to … with N bytes of audio`.

`sh scripts/check.sh` smoke-tests a deployment with no secrets involved: it confirms
unsigned and wrongly signed webhook posts are refused and that nothing unexpected is
served.

## Configuration

Non-secret settings live in `wrangler.jsonc` under `vars`.

| var | default | meaning |
|---|---|---|
| `REPLY_TEXT` | a short "got your message" line | what gets spoken |
| `REPLY_COOLDOWN_MINUTES` | `0` | `0` replies to every message. `60` sends at most one voice note an hour, like an away message |
| `ELEVENLABS_MODEL_ID` | `eleven_flash_v2_5` | fast and multilingual. `eleven_multilingual_v2` is higher quality and slower |
| `GRAPH_API_VERSION` | `v24.0` | bump occasionally; Meta retires versions after roughly two years |
| `PUBLIC_ORIGIN` | the custom domain | where Instagram fetches audio from |

## Operations

**`GET /health`** returns JSON: which secret groups are configured, where the live
token comes from, and how many days it has left. It answers `503` when anything is
unconfigured or the token has under 3 days left, so a status page can watch it.

**Token refresh.** Worker secrets cannot be changed at runtime, so `IG_ACCESS_TOKEN`
is only the bootstrap. A daily cron refreshes the token when under 10 days remain and
stores the new one in KV, which the Worker prefers over the secret from then on. The
first cron run after you set the secret refreshes immediately to learn the real expiry.
Meta refuses to refresh a token younger than 24 hours; that shows in the logs as
`refresh failed` and is harmless.

**Logs.** `npm run tail`. Errors from ElevenLabs and the Graph API are logged with the
first 300 characters of the response body, which is where Meta puts the useful part.

## Troubleshooting

| symptom | cause |
|---|---|
| webhook verification fails on Meta's side | Worker not deployed yet, or `WEBHOOK_VERIFY_TOKEN` differs from what you typed at Meta |
| no webhook arrives at all | **Connected tools** is off in the Instagram app (step 2.5); or the app lacks the `messages` subscription; or the message is from your own account (echo) |
| `graph send 400` mentioning the attachment | Instagram could not fetch the audio. Check `PUBLIC_ORIGIN` is reachable and returns `audio/wav` |
| `graph send 190` | token expired or revoked. Check `/health`, regenerate at Meta, `wrangler secret put IG_ACCESS_TOKEN`, and clear `token:ig` from KV |
| voice note arrives but is silent or very short | `REPLY_TEXT` empty, or ElevenLabs returned an error body that was stored as audio. Check the tail for `elevenlabs 4xx` |
| replies twice | cooldown is `0` and the person sent two messages. Set `REPLY_COOLDOWN_MINUTES` |

## Development

```sh
cp .dev.vars.example .dev.vars   # fill in
npm run dev                      # http://localhost:8787
npm test                         # WAV header + signature verification
npm run typecheck
sh scripts/check.sh http://localhost:8787
```

## Not here, on purpose

- **Generated replies.** `REPLY_TEXT` is fixed. Sending the incoming text to an LLM
  and speaking the answer drops into `handleEvent` as one call; it is left out so the
  first version has nothing to debug but the plumbing.
- **More than one person.** `ALLOWED_IGSID` is a single id by design. A list is a
  one-line change if you want it.
- **Other channels.** The same TTS and WAV code would serve a WhatsApp Cloud API
  inbox, which wants OGG/Opus instead. Different container, same idea.
