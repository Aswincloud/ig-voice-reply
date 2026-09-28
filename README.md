# ig-voice-reply

Replies to Instagram DMs from **one allowlisted person** with a voice note: Claude
writes a short, friendly line in spoken Tamil, in Tamil script, whatever language the
friend used; ElevenLabs speaks it. A daily credit budget caps the spend and signs off
politely when it's nearly used. Runs entirely on Cloudflare Workers; no server, no
ffmpeg.

```
that person DMs your Instagram account
  → Meta webhook → this Worker (signature verified)
  → sender is the allowlisted IGSID?   no → drop
  → daily credit budget: room? / sign off once / stay quiet
  → Claude writes the reply from the last few turns   (persona: src/prompt.ts)
  → ElevenLabs eleven_v3 TTS  (raw PCM)
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

Create an API key at <https://elevenlabs.io/app/settings/api-keys>. Scope it to
**Text to Speech** only; that is all the Worker needs, and a leaked key then cannot
list or clone voices. The trade is that the Worker cannot read your credit balance,
which is why the budget is counted locally.

Pick a voice id: Voices → the voice → ⋯ → **Copy voice ID**. A Voice Library voice
must be added to *My Voices* first or the API will not accept its id. To reply in your
own voice, Instant Voice Clone on the Starter plan needs about a minute of clean audio.

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
npx wrangler secret put ANTHROPIC_API_KEY      # console.anthropic.com/settings/keys
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
sender id of each incoming message and does nothing else. Separately, and in every
mode, the recipient id of any message *you* send to someone other than the
allowlisted person is logged (`echo: you sent a message to recipient id …`). So to
switch to a new person, message them once from the Instagram app, read the id, and
`wrangler secret put ALLOWED_IGSID`; nothing needs clearing first.

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

## Reaching people who hold no role on the Meta app (Chatwoot route)

A Meta app on **Standard Access** receives Instagram messages only from accounts
that hold a role on the app (admin, developer, tester). Everyone else's DMs are
never delivered, so the Meta route above reaches your own accounts and nobody
else, until App Review grants Advanced Access.

Chatwoot Cloud already holds that access: it connects your Instagram account
through Chatwoot's own reviewed Meta app, receives everyone's messages, and its
API can reply to anyone. So the Worker has a second door. Chatwoot sends each new
message to `POST /chatwoot/<token>`; the Worker runs the same pipeline (Claude,
ElevenLabs, WAV) and posts the audio to the conversation through Chatwoot's API;
Chatwoot stores the file and relays it to Instagram as a voice note. Nothing
about the Meta app changes, and nobody has to accept an invitation.

```
Instagram ──> Chatwoot Cloud ──webhook──> Worker ──> Claude ──> ElevenLabs
Instagram <── Chatwoot Cloud <──API (audio/wav)── Worker
```

### Setup

1. In Chatwoot Cloud, add an **Instagram** inbox and connect the account
   (Settings → Inboxes → Add Inbox → Instagram). Send it a DM from any account
   and confirm the conversation shows up. If it does, the access problem is over.
2. An API token for the agent the replies should come from: Profile Settings →
   Access Token. `npx wrangler secret put CHATWOOT_API_TOKEN`.
3. An unguessable path token: `openssl rand -hex 24 | npx wrangler secret put CHATWOOT_WEBHOOK_TOKEN`.
   Chatwoot does not authenticate webhook calls unless the webhook has a
   signing secret, so the URL itself is the credential. A wrong token answers
   `404`, indistinguishable from a path that does not exist.
4. Settings → Integrations → Webhooks → Add: URL
   `https://ig-reply.aswincloud.com/chatwoot/<CHATWOOT_WEBHOOK_TOKEN>`,
   event **Message created**. If the webhook shows a signing secret, also
   `wrangler secret put CHATWOOT_WEBHOOK_SECRET` and every delivery must carry a
   valid `X-Chatwoot-Signature` (HMAC-SHA256 over `"<timestamp>.<body>"`,
   timestamp within five minutes).
5. Set `CHATWOOT_ACCOUNT_ID` (the number in the Chatwoot URL) and, to be
   explicit, `CHATWOOT_INBOX_ID` in `wrangler.jsonc`.
6. The one person: `npx wrangler secret put CHATWOOT_ALLOWED_CONTACT` with their
   **Instagram username** (with or without `@`) or their Chatwoot contact id.
   Chatwoot records the username on the contact, so no discovery step is needed.
   Until it is set the route is in discovery mode and logs
   `discovery (chatwoot): message from contact 12 @name "Name" igsid 1784…` for
   each sender (also kept in KV as `discovery:chatwoot`).

### What it looks like from Chatwoot

Each reply appears in the conversation as an outgoing voice message from the
token's agent, followed by a **private note** with the spoken text, so the thread
reads back without playing the audio. Private notes never reach Instagram.
Anything you type in Chatwoot, or in the Instagram app, arrives at the Worker as
an outgoing message and is ignored, so there is no echo loop to guard against.

Both routes share the history, cooldown and daily budget code, but keep separate
history per person (`history:<igsid>` and `history:cw:<contact id>`).

`/health` reports `routes.chatwoot: "replying"` when the token, API access,
allowlist and a live token check all pass, and `chatwoot_token` mirrors `token`.

## Configuration

Non-secret settings live in `wrangler.jsonc` under `vars`.

| var | default | meaning |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-opus-5` | writes the reply |
| `MAX_REPLY_CHARS` | `180` | hard cap on a spoken reply; trimmed at a sentence end |
| `DAILY_CREDIT_LIMIT` | `1000` | ElevenLabs credits per IST day; `0` disables |
| `SIGNOFF_TEXT` | Tamil "I have some work, talk later" | spoken once when the budget is nearly gone |
| `REFUSAL_TEXT` | Tamil "let's not talk about that" | spoken when Claude declines |
| `FALLBACK_TEXT` | Tamil "saw your message, Aswin will reply" | spoken when Claude is unreachable |
| `REPLY_COOLDOWN_MINUTES` | `0` | `0` replies to every message; `60` behaves like an away message |
| `ELEVENLABS_MODEL_ID` | `eleven_v3` | expressive, supports tags like `[laughs]`; `eleven_flash_v2_5` is faster and half the credits |
| `GRAPH_API_VERSION` | `v24.0` | bump occasionally |
| `PUBLIC_ORIGIN` | the custom domain | where Instagram fetches audio from |
| `CHATWOOT_BASE_URL` | `https://app.chatwoot.com` | Chatwoot route: the Chatwoot installation |
| `CHATWOOT_ACCOUNT_ID` | empty | Chatwoot route: the account whose inbox is connected |
| `CHATWOOT_INBOX_ID` | empty | Chatwoot route: act on this inbox only; empty means every inbox |

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

## The reply

`src/prompt.ts` is the persona: warm, casual, always spoken Tamil in Tamil script
(Tanglish in Latin letters is pronounced like English by the TTS, Tamil script is
pronounced as Tamil), one or two sentences under `MAX_REPLY_CHARS`, no 18+ content, no commitments on the owner's
behalf, and honest about being a voice assistant if asked directly. Edit it freely; it
is plain text and a change is a reviewable commit.

The last `12` messages per person are kept in KV for 48 hours so replies follow the
conversation. If Claude declines a topic, `REFUSAL_TEXT` is spoken instead (a light
deflection, which is the intended outcome for 18+ content, so no fallback model is
configured). If Claude is unreachable, `FALLBACK_TEXT` is spoken so the friend still
hears something.

## The daily budget

`DAILY_CREDIT_LIMIT` is ElevenLabs credits per day in the owner's timezone
(Asia/Kolkata). Spend is recorded from the `character-cost` header ElevenLabs returns
with every TTS response, in KV under `usage:<date>`, so it matches what the account is
actually billed. (Observed: `eleven_v3` charges about half a credit per character on
Tamil script.) The account's own counter is not readable when the API key is scoped to
`text_to_speech` only, which is the recommended scope.

When the remainder can no longer fit another reply plus the sign-off, `SIGNOFF_TEXT`
is spoken once ("Seri, enaku konjam work iruku. Naan aprom pesuren!") and the Worker
stays quiet until the next day. `0` disables the budget. `/health` shows
`usage_today`.

Two messages arriving in the same second can both read the old counter; the budget
is a guard rail, not an accounting system.

## Not here, on purpose

- **More than one person.** `ALLOWED_IGSID` is a single id by design. A list is a
  one-line change if you want it.
- **Other channels.** The same TTS and WAV code would serve a WhatsApp Cloud API
  inbox, which wants OGG/Opus instead. Different container, same idea.
