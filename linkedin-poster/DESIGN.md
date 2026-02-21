# LinkedIn Cross-Poster — Design Document

## Overview

A Node.js CLI tool that cross-posts Nostr events to LinkedIn. Centauri (or Derek directly) provides a `nevent1...` or `naddr1...` identifier, and the tool decodes it, fetches the Nostr event, transforms the content, and publishes to LinkedIn via the Posts API.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   OpenClaw Skill                     │
│          (~/.openclaw/skills/linkedin-poster/)        │
│  SKILL.md — natural language interface for Centauri  │
└──────────────────────┬──────────────────────────────┘
                       │ invokes
                       ▼
┌─────────────────────────────────────────────────────┐
│              CLI Entry Point (bin/post.mjs)           │
│  Parses args: <nevent1...|naddr1...> [--dry-run]     │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   ┌────────────┐ ┌──────────┐ ┌──────────────┐
   │  Decoder   │ │ Fetcher  │ │  Formatter   │
   │ (nak CLI)  │ │(nak CLI) │ │ (transform)  │
   └─────┬──────┘ └────┬─────┘ └──────┬───────┘
         │              │              │
         │  id, relays, │  raw event   │  linkedin-ready
         │  kind, d-tag │  JSON        │  payload
         └──────────────┴──────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  LinkedIn API   │
              │  Publisher      │
              │  (REST client)  │
              └────────┬────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  Token Manager  │
              │ (~/.linkedin/)  │
              └─────────────────┘
```

## Components

### 1. CLI Entry Point (`bin/post.mjs`)

```
Usage: linkedin-post <nostr-identifier> [options]

Arguments:
  nostr-identifier    nevent1... or naddr1... string

Options:
  --dry-run           Show what would be posted without publishing
  --verbose           Show intermediate steps
  --auth              Run OAuth setup flow (interactive)
```

### 2. Decoder (`lib/decoder.mjs`)

Shells out to `nak decode <identifier>` and parses JSON output.

**nevent output:**
```json
{
  "id": "<64-char hex event id>",
  "relays": ["wss://relay.example.com"]
}
```

**naddr output:**
```json
{
  "kind": 30023,
  "pubkey": "<hex pubkey>",
  "identifier": "<d-tag value>",
  "relays": ["wss://relay.example.com"]
}
```

**Interface:**
```js
// Returns: { type: 'nevent'|'naddr', id?, kind?, pubkey?, identifier?, relays: string[] }
export async function decode(nostrIdentifier: string): Promise<DecodedIdentifier>
```

### 3. Fetcher (`lib/fetcher.mjs`)

Uses `nak req` to fetch the actual event from relays.

**For nevent (has event id):**
```bash
nak req -i <event-id> <relay1> <relay2> ...
```

**For naddr (has kind + pubkey + d-tag):**
```bash
echo '{"kinds":[<kind>],"authors":["<pubkey>"],"#d":["<identifier>"]}' | nak req <relay1> <relay2> ...
```

Falls back to default relays if none specified: `wss://relay.damus.io wss://relay.primal.net wss://nos.lol wss://relay.ditto.pub`

**Interface:**
```js
// Returns raw Nostr event JSON
export async function fetchEvent(decoded: DecodedIdentifier): Promise<NostrEvent>
```

**NostrEvent shape:**
```json
{
  "id": "...",
  "pubkey": "...",
  "created_at": 1234567890,
  "kind": 1,
  "tags": [["p", "..."], ["t", "bitcoin"], ...],
  "content": "Hello world #bitcoin",
  "sig": "..."
}
```

### 4. Formatter (`lib/formatter.mjs`)

Transforms Nostr event content into LinkedIn API payload.

**Interface:**
```js
export async function format(event: NostrEvent): Promise<LinkedInPayload>
```

#### Kind 1 (Short Note) → LinkedIn Text Post

Transformations:
1. **Strip Nostr mentions** — Replace `nostr:npub1...` with display name (look up kind 0 profile if possible, else drop)
2. **Adapt hashtags** — Keep `#hashtag` as-is (LinkedIn supports them natively)
3. **Strip NIP-27 references** — Remove `nostr:nevent1...`, `nostr:naddr1...` inline refs
4. **Handle image URLs** — Extract `http(s)://....(jpg|png|gif|webp)` URLs from content. First image becomes media attachment; rest stay as links
5. **Character limit** — LinkedIn posts: 3,000 chars max. Truncate with `...` + Nostr link if needed
6. **Add source link** — Append `\n\n🟣 Originally posted on Nostr` at end

**Output payload (text post):**
```json
{
  "author": "urn:li:person:{URN}",
  "commentary": "<transformed text>",
  "visibility": "PUBLIC",
  "distribution": {
    "feedDistribution": "MAIN_FEED",
    "targetEntities": [],
    "thirdPartyDistributionChannels": []
  },
  "lifecycleState": "PUBLISHED",
  "isReshareDisabledByAuthor": false
}
```

#### Kind 30023 (Long-Form Blog) → LinkedIn Article Post

Transformations:
1. **Extract metadata from tags:**
   - `["title", "..."]` → article title
   - `["summary", "..."]` → article description
   - `["image", "..."]` → article thumbnail (upload via Images API first)
   - `["published_at", "..."]` → informational only
2. **Content is Markdown** — Convert to plain text summary for `commentary` field (first ~500 chars)
3. **Article link** — Use a Nostr web viewer URL (e.g., `https://habla.news/a/naddr1...` or `https://njump.me/naddr1...`) as the article source
4. **Hashtags** — Extract from `["t", "..."]` tags

**Output payload (article post):**
```json
{
  "author": "urn:li:person:{URN}",
  "commentary": "<summary text with hashtags>",
  "visibility": "PUBLIC",
  "distribution": {
    "feedDistribution": "MAIN_FEED",
    "targetEntities": [],
    "thirdPartyDistributionChannels": []
  },
  "content": {
    "article": {
      "source": "https://njump.me/<original-naddr>",
      "title": "<title from tags>",
      "description": "<summary or first 200 chars>"
    }
  },
  "lifecycleState": "PUBLISHED",
  "isReshareDisabledByAuthor": false
}
```

### 5. LinkedIn API Publisher (`lib/linkedin.mjs`)

**Interface:**
```js
export async function publish(payload: LinkedInPayload): Promise<{ postId: string, url: string }>
export async function getUserInfo(): Promise<{ sub: string, name: string }>
```

**API Details:**
- **Endpoint:** `POST https://api.linkedin.com/rest/posts`
- **Headers:**
  - `Authorization: Bearer {access_token}`
  - `LinkedIn-Version: 202501` (YYYYMM format)
  - `X-Restli-Protocol-Version: 2.0.0`
  - `Content-Type: application/json`
- **User info:** `GET https://api.linkedin.com/v2/userinfo` → returns `sub` (the person URN ID)
- **Success:** 201 with `x-restli-id` header containing post URN

**For image uploads (kind 30023 thumbnails or kind 1 inline images):**
- Use Images API: `POST https://api.linkedin.com/rest/images?action=initializeUpload`
- Upload binary to returned URL
- Use resulting `urn:li:image:{id}` in post payload

### 6. Token Manager (`lib/token.mjs`)

**Storage:** `~/.linkedin/`
```
~/.linkedin/
├── credentials.json    # { clientId, clientSecret } — encrypted or 600 perms
├── token.json          # { accessToken, expiresAt, refreshToken, personUrn }
└── .gitignore          # *
```

**OAuth 2.0 Flow (initial setup — `linkedin-post --auth`):**

1. Read `clientId` and `clientSecret` from `~/.linkedin/credentials.json`
2. Open browser to LinkedIn authorization URL:
   ```
   https://www.linkedin.com/oauth/v2/authorization?
     response_type=code&
     client_id={clientId}&
     redirect_uri=http://localhost:3847/callback&
     scope=openid%20profile%20w_member_social
   ```
3. Start temporary local HTTP server on port 3847 to receive callback
4. Exchange authorization code for tokens:
   ```
   POST https://www.linkedin.com/oauth/v2/accessToken
   grant_type=authorization_code&code={code}&client_id={clientId}&
   client_secret={clientSecret}&redirect_uri=http://localhost:3847/callback
   ```
5. Store tokens in `~/.linkedin/token.json` (file mode 600)
6. Fetch and store person URN via `/v2/userinfo`

**Token Refresh Strategy:**
- LinkedIn access tokens expire in 60 days; refresh tokens in 365 days
- Before each API call, check `expiresAt` — if within 24h of expiry, refresh:
  ```
  POST https://www.linkedin.com/oauth/v2/accessToken
  grant_type=refresh_token&refresh_token={refreshToken}&
  client_id={clientId}&client_secret={clientSecret}
  ```
- If refresh fails (expired), print error with instructions to re-run `--auth`
- **Alternative:** LinkedIn also provides a manual token generator at `https://www.linkedin.com/developers/tools/oauth/token-generator` — document this as fallback for initial setup if the local server approach is problematic

**Interface:**
```js
export async function getAccessToken(): Promise<string>  // auto-refreshes
export async function getPersonUrn(): Promise<string>
export async function setupAuth(): Promise<void>         // interactive OAuth flow
```

## Data Flow

### Kind 1 (Short Note)

```
nevent1... → decode → {id, relays}
  → fetch event from relays → {kind:1, content:"Hello #bitcoin nostr:npub1..."}
  → format:
    - Replace nostr:npub1... → "@DisplayName" or remove
    - Keep #bitcoin
    - Extract image URLs → separate for media upload
    - Append "\n\n🟣 Originally posted on Nostr"
    - Truncate to 3000 chars if needed
  → publish text post to LinkedIn
  → return post URL
```

### Kind 30023 (Long-Form Blog)

```
naddr1... → decode → {kind:30023, pubkey, identifier, relays}
  → fetch event from relays → {kind:30023, content:"# My Blog Post\n...", tags:[["title","..."],["image","..."]]}
  → format:
    - Extract title, summary, image from tags
    - If image tag present → upload to LinkedIn Images API → get image URN
    - Generate article source URL: https://njump.me/<original-naddr>
    - Create commentary: first ~500 chars of content (stripped markdown) + hashtags
  → publish article post to LinkedIn
  → return post URL
```

## Error Handling

| Error | Handling |
|-------|----------|
| Invalid nevent/naddr | Exit with clear error: "Invalid Nostr identifier" |
| nak not found | Exit: "nak CLI not found. Install: go install github.com/fiatjaf/nak@latest" |
| Event not found on relays | Retry with default relays; exit: "Event not found on any relay" |
| Unsupported kind | Exit: "Only kind 1 and 30023 supported. Got kind {N}" |
| Token expired, refresh fails | Exit: "LinkedIn token expired. Run: linkedin-post --auth" |
| LinkedIn API 429 (rate limit) | Log rate limit headers, exit: "Rate limited. Try again in {N} seconds" |
| LinkedIn API 401 | Attempt token refresh once, then fail with auth instructions |
| LinkedIn API 400 | Log full response, exit with parsed error message |
| Image upload fails | Skip image, post as text-only with warning |
| Content too long | Truncate to 3000 chars with "..." indicator |

**All errors exit with non-zero code and structured stderr output for programmatic consumption.**

## File Structure

```
tools/linkedin-poster/
├── package.json
├── DESIGN.md              ← this file
├── README.md              ← usage docs
├── bin/
│   └── post.mjs           ← CLI entry point (#!/usr/bin/env node)
├── lib/
│   ├── decoder.mjs        ← nak decode wrapper
│   ├── fetcher.mjs        ← nak req wrapper
│   ├── formatter.mjs      ← content transformation
│   ├── linkedin.mjs       ← LinkedIn API client
│   └── token.mjs          ← OAuth token management
└── test/
    ├── decoder.test.mjs
    ├── formatter.test.mjs
    └── fixtures/
        ├── kind1-event.json
        └── kind30023-event.json
```

**OpenClaw Skill:**
```
~/.openclaw/skills/linkedin-poster/
└── SKILL.md               ← skill definition for Centauri
```

## Dependencies

- **None at runtime for core** — uses `child_process` to call `nak`, native `fetch()` for HTTP (Node 24)
- `open` (npm) — optional, for opening browser during OAuth setup
- No build step — pure ESM `.mjs` files

## OpenClaw Skill Definition

The skill at `~/.openclaw/skills/linkedin-poster/SKILL.md` should contain:

```markdown
# LinkedIn Cross-Poster

Post Nostr content to Derek's LinkedIn profile.

## Usage

When Derek says "post this to LinkedIn" followed by a nevent1... or naddr1...:

\`\`\`bash
node /home/moltbot/clawd/tools/linkedin-poster/bin/post.mjs <nevent1...|naddr1...>
\`\`\`

## Options
- `--dry-run` — preview without posting
- `--verbose` — show details

## Setup
First-time: `node /home/moltbot/clawd/tools/linkedin-poster/bin/post.mjs --auth`
Requires ~/.linkedin/credentials.json with {clientId, clientSecret}.

## What it does
1. Decodes the Nostr identifier (nevent or naddr)
2. Fetches the event from Nostr relays
3. Formats content for LinkedIn (strips Nostr-specific markup, adapts hashtags)
4. Posts to LinkedIn via the Posts API
- kind 1 → text post
- kind 30023 → article post with link to Nostr web viewer
```

## Design Decisions

1. **Shell out to `nak` rather than implement NIP-19/Nostr in JS** — nak is already installed, battle-tested, and avoids pulling in nostr JS dependencies. The CLI overhead (~100ms) is negligible for a posting tool.

2. **ESM `.mjs` with no build step** — keeps it simple, Node 24 supports everything needed natively including top-level await and native fetch.

3. **Article posts link back to njump.me** — LinkedIn articles require a source URL. Rather than trying to render full markdown in LinkedIn's limited format, we link to a Nostr web viewer where the full post renders properly.

4. **Local OAuth server for token exchange** — the standard 3-legged flow. Alternative: Derek can use LinkedIn's manual token generator as fallback and paste the token directly.

5. **60-day token refresh** — LinkedIn tokens last 60 days. Auto-refresh before expiry avoids manual re-auth. If refresh token also expires (365 days), fall back to re-auth prompt.

6. **3,000 char limit with smart truncation** — truncate at word boundary, add ellipsis and Nostr source link.

7. **Image handling is best-effort** — upload first image found; skip on failure rather than blocking the post entirely.
