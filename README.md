# Social Cross-Post Automation

Monitors Derek's Nostr posts, scores engagement, and cross-posts qualifying content to X and LinkedIn.

## How It Works

1. **Fetches** Derek's kind 1 and kind 30023 posts from the last 24 hours
2. **Filters** out replies, reposts, personal/casual content, and off-topic posts
3. **Scores** engagement on posts older than 1 hour: `reactions×1 + reposts×3 + zaps×5 + replies×2`
4. **Checks** NIP-50 trending on Ditto for bonus points
5. **Routes** qualifying posts (score ≥ 10) to platforms:
   - **X**: Punchy takes, Bitcoin/Nostr/AI/freedom tech content
   - **LinkedIn**: Professional/educational content, conference announcements
6. **Caps**: Max 3 X posts/day, max 1 LinkedIn post/day
7. **Tracks** state in `memory/crosspost-state.json`

## Usage

```bash
# Dry run (no actual posting)
node tools/social-crosspost/check-and-post.mjs --dry-run

# Verbose dry run
node tools/social-crosspost/check-and-post.mjs --dry-run --verbose

# Live posting
node tools/social-crosspost/check-and-post.mjs
```

## Output

JSON with:
- `actions`: Posts that were cross-posted (or flagged for rewrite)
- `skipped`: Posts that were filtered out with reasons
- `summary`: Counts and remaining daily caps

## LinkedIn Rewrites

If a post is LinkedIn-worthy but has casual tone, it's flagged with `needsRewrite: true` for Centauri to rewrite before posting.

## Dependencies

- `nak` CLI (installed globally)
- `tools/x-poster/bin/post.mjs`
- `tools/linkedin-poster/bin/post.mjs`

## State File

`memory/crosspost-state.json` tracks:
- Last check timestamp
- Posted events with engagement scores
- Skipped events with reasons
- Daily post counts (reset each day)
