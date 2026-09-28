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
- **A Page token, so nothing expires.** Sends go through the Facebook Page linked
  to the Instagram account, using a Page access token. Derived from a long-lived
  user token, that token has no expiry, so there is no refresh code and no cron.
  `/health` checks it is still valid with a live call, because it *can* be
  invalidated: resetting the app secret, removing the app from the Page, or a
  password change on the granting Facebook account all do it, silently.

## Setup

### 1. ElevenLabs

Create an API key at <https://elevenlabs.io/app/settings/api-keys> and pick a voice
id. To reply in your own voice, Instant Voice Clone on the Starter plan needs about a
minute of clean audio.

### 2. Meta developer app and the Page token

This is most of the work, and it is why every tool in this space is under-documented.
You need a Meta app with the Instagram product, a Facebook Page linked to the
Instagram account, and a **Page access token** minted with the right scopes.

**2a. App.** <https://developers.facebook.com/apps> → your app (or Create App) →
add the **Instagram** product. **App settings → Basic → App Secret** is
`META_APP_SECRET`. Leave the app in Development mode; for your own account that is
sufficient and needs no App Review.

**2b. Link.** The Instagram professional account must be linked to a Facebook Page
(Instagram app → Settings → Accounts Center, or Page settings → Linked accounts).

**2c. User token, in Graph API Explorer** (<https://developers.facebook.com/tools/explorer/>):
- **Meta App** → your app. **User or Page** → Get User Access Token.
- **Permissions**: add all five. The last two are the ones people miss, and the Page
  subscription in 2e fails without them:
  ```
  instagram_basic   instagram_manage_messages
  pages_show_list   pages_messaging   pages_manage_metadata
  ```
- **Generate Access Token**. In the popup, on the *Pages* screen tick the linked
  Page, and on the *Instagram* screen tick the account. If the Page is not offered,
  your Facebook account has no admin role on it; fix that in the Page's settings.

The result is a user token valid for about an hour.

**2d. Exchange, then ask the Page for its token.** Only a Page token derived from a
*long-lived* user token is permanent, so exchange first:

```sh
LONG=$(curl -sg "https://graph.facebook.com/v24.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_TOKEN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')
curl -sg "https://graph.facebook.com/v24.0/PAGE_ID?fields=access_token&access_token=$LONG"
```

Ask the **Page directly** rather than `/me/accounts`: that listing omits Pages held
through a business portfolio even when they are in the grant. Confirm it is permanent
with `debug_token`; `"expires_at": 0` means never.

Ids you need: the Page id is in its URL or `GET /me/accounts`; the Instagram account
id (a `17841…` number) is `GET /PAGE_ID?fields=instagram_business_account`.

**2e. Webhooks.** Two subscriptions, both by API.

App level, with an app token (`APP_ID|APP_SECRET`):
```sh
curl -X POST "https://graph.facebook.com/v24.0/APP_ID/subscriptions" \
  -d object=instagram -d fields=messages \
  -d callback_url=https://ig-reply.aswincloud.com/webhook \
  -d verify_token=YOUR_WEBHOOK_VERIFY_TOKEN -d "access_token=APP_ID|APP_SECRET"
```
Meta fetches `/webhook` to verify, so the Worker must be deployed with
`WEBHOOK_VERIFY_TOKEN` first.

Page level, with the Page token, which is what actually routes the account's DMs:
```sh
curl -X POST "https://graph.facebook.com/v24.0/PAGE_ID/subscribed_apps?subscribed_fields=messages&access_token=PAGE_TOKEN"
```

**2f. Instagram phone app** → Settings → Messages and story replies → Message
controls → **Connected tools** on. Without it Meta never sends the webhook and
nothing in the logs explains why.

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
npx wrangler secret put IG_ACCESS_TOKEN     # the Page token
npx wrangler secret put IG_PAGE_ID
npx wrangler secret put IG_USER_ID
```

Now create the two webhook subscriptions (step 2e). `GET /health` should report
`configured.meta: true`, `configured.elevenlabs: true` and `token.valid: true`.

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

**`GET /health`** returns JSON: which secret groups are configured and whether the
Page token still works. It answers `503` when anything is unconfigured or the token
is invalid, so a status page can watch it.

**Token validity.** The Page token does not expire, but it can be invalidated
(see "Why it is shaped this way"). `/health` makes a live call to Meta to check it,
cached for five minutes in KV, and reports `token.valid` with a `note` carrying
Meta's error when it is false. If it goes false, repeat 2c and 2d and
`wrangler secret put IG_ACCESS_TOKEN` again.

**Logs.** `npm run tail`. Errors from ElevenLabs and the Graph API are logged with the
first 300 characters of the response body, which is where Meta puts the useful part.

## Troubleshooting

| symptom | cause |
|---|---|
| webhook verification fails on Meta's side | Worker not deployed yet, or `WEBHOOK_VERIFY_TOKEN` differs from what you typed at Meta |
| no webhook arrives at all | **Connected tools** is off (2f); or the Page is not subscribed (2e, second call); or the message is from your own account (echo) |
| `graph send 400` mentioning the attachment | Instagram could not fetch the audio. Check `PUBLIC_ORIGIN` is reachable and returns `audio/wav` |
| `graph send 190`, or `/health` shows `token.valid: false` | token invalidated. Repeat 2c and 2d, then `wrangler secret put IG_ACCESS_TOKEN` |
| `(#200) … pages_messaging` or `pages_manage_metadata` when subscribing the Page | those two scopes were not in the Explorer grant. Repeat 2c with all five, then 2d and 2e |
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
