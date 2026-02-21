# LinkedIn Cross-Poster

Cross-posts Nostr content (kind 1 notes and kind 30023 long-form articles) to LinkedIn. Given a `nevent1...` or `naddr1...` identifier, it fetches the event from Nostr relays, formats the content for LinkedIn's API, and publishes it as a LinkedIn post.

## Prerequisites

- **Node.js** v18+
- **nak CLI** — installed at `/usr/local/bin/nak` ([github.com/fiatjaf/nak](https://github.com/fiatjaf/nak))
- **LinkedIn Developer App** with the `w_member_social`, `openid`, and `profile` OAuth scopes

## Setup

### 1. Create a LinkedIn Developer App

1. Go to [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps/) and create an app
2. Under **Auth**, add `http://localhost:3847/callback` as an authorized redirect URL
3. Request the **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect** products
4. Note your **Client ID** and **Client Secret**

### 2. Store Credentials

```bash
mkdir -p ~/.linkedin && chmod 700 ~/.linkedin
cat > ~/.linkedin/credentials.json << 'EOF'
{"clientId": "YOUR_CLIENT_ID", "clientSecret": "YOUR_CLIENT_SECRET"}
EOF
chmod 600 ~/.linkedin/credentials.json
```

### 3. Authenticate

```bash
node /home/moltbot/clawd/tools/linkedin-poster/bin/post.mjs --auth
```

This starts a local server on port 3847, opens the LinkedIn OAuth flow in your browser, and stores the token at `~/.linkedin/token.json`. Tokens auto-refresh when within 24 hours of expiry.

## Usage

```bash
# Post a kind 1 note
node tools/linkedin-poster/bin/post.mjs nevent1...

# Post a kind 30023 long-form article
node tools/linkedin-poster/bin/post.mjs naddr1...

# Preview without posting
node tools/linkedin-poster/bin/post.mjs nevent1... --dry-run

# Show intermediate steps
node tools/linkedin-poster/bin/post.mjs nevent1... --verbose
```

## Content Formatting

### Kind 1 (Notes)
- Full text is used as the LinkedIn post commentary
- Image URLs (jpg/png/gif/webp) are extracted; first one removed from text body
- `nostr:npub...` mentions and `nostr:nevent...` references are stripped
- A footer is appended: `🟣 Originally posted on Nostr` + njump.me link
- Truncated at 3000 characters with smart word-boundary truncation

### Kind 30023 (Long-form Articles)
- Title and summary from event tags become the LinkedIn article card
- First ~500 chars of content (markdown stripped) used as commentary
- Hashtags from `t` tags are appended
- Article links to `njump.me/<identifier>` as the source URL
- Featured image from the `image` tag is used for the article card

## Troubleshooting

| Error | Fix |
|-------|-----|
| `Not authenticated` | Run `--auth` to complete OAuth flow |
| `Missing credentials` | Create `~/.linkedin/credentials.json` with clientId/clientSecret |
| `Token expired and no refresh token` | Re-run `--auth` |
| `LinkedIn API 401` | Token invalid — re-run `--auth` |
| `Rate limited` | Wait the indicated seconds and retry |
| `nak CLI not found` | Install nak: `go install github.com/fiatjaf/nak@latest` |
| `Event not found on any relay` | Check the identifier is valid; try adding relay hints |
| `Unsupported event kind` | Only kind 1 and kind 30023 are supported |

## File Structure

```
tools/linkedin-poster/
├── bin/post.mjs        # CLI entry point
├── lib/
│   ├── decoder.mjs     # nevent/naddr decoding via nak
│   ├── fetcher.mjs     # Fetch events from Nostr relays
│   ├── formatter.mjs   # Format content for LinkedIn API
│   ├── linkedin.mjs    # LinkedIn API client (publish, image upload)
│   └── token.mjs       # OAuth token management
├── test/               # Tests
└── package.json
```

## Storage

- `~/.linkedin/credentials.json` — OAuth client ID/secret (mode 600)
- `~/.linkedin/token.json` — Access/refresh tokens + person URN (mode 600)
