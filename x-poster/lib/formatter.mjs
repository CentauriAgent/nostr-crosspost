/**
 * Format Nostr events for X/Twitter
 *
 * Native X formatting — no Nostr fingerprints.
 * Handles:
 * - 280 char limit (auto-threading for longer content)
 * - Image extraction
 * - nostr: mention/reference stripping
 * - Smart hashtag handling
 */

const MAX_TWEET_CHARS = 280;
const IMAGE_RE = /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?/gi;
const NOSTR_MENTION_RE = /nostr:npub1[a-z0-9]+/gi;
const NOSTR_REF_RE = /nostr:(?:nevent1|naddr1|note1|nprofile1)[a-z0-9]+/gi;
const NJUMP_RE = /https?:\/\/njump\.me\/\S+/gi;
const NOSTR_ATTRIBUTION_RE = /(?:🟣\s*)?(?:originally )?posted (?:via|on) nostr\b[^\n]*/gi;
const PURPLE_DOT_RE = /\n*🟣\s*/g;
const URL_CHAR_COUNT = 23; // X counts all URLs as 23 chars (t.co wrapping)

// Hashtags that work well on X for Derek's topics
const X_HASHTAG_MAP = {
  bitcoin: '#Bitcoin', btc: '#Bitcoin',
  nostr: '#Nostr', lightning: '#Lightning',
  ai: '#AI', privacy: '#Privacy',
  opensource: '#OpenSource', foss: '#OpenSource',
  decentralized: '#Decentralized', decentralization: '#Decentralized',
  censorship: '#FreeSpeech', freedom: '#FreedomTech',
  freedomtech: '#FreedomTech', protocol: '#Protocol',
  zap: '#Zaps', zaps: '#Zaps',
  devrel: '#DevRel', developer: '#Dev',
};

/**
 * Format a Nostr event for X/Twitter — native feel, no Nostr traces
 * @param {object} event - Raw Nostr event
 * @param {string} originalIdentifier - nevent1.../naddr1... string (unused now)
 * @param {object} options - { noLink: boolean }
 * @returns {{ tweets: string[], images: string[] }}
 */
export function format(event, originalIdentifier, options = {}) {
  if (!event || typeof event !== 'object') {
    throw new Error('Invalid event');
  }

  const kind = event.kind;
  if (kind === 1) return formatKind1(event, options);
  if (kind === 30023) return formatKind30023(event, options);
  throw new Error(`Only kind 1 and 30023 supported. Got kind ${kind}`);
}

/**
 * Format raw text for X — strips all Nostr artifacts, returns native X content
 * Can be called directly by the cross-post checker with pre-fetched content.
 */
export function formatTextForX(text, options = {}) {
  // Extract images before stripping
  const images = [...text.matchAll(IMAGE_RE)].map(m => m[0]);
  for (const img of images) {
    text = text.replace(img, '').trim();
  }

  text = stripNostrArtifacts(text);

  // Smart hashtag handling
  text = enhanceHashtags(text);

  const tweets = threadText(text);
  return { tweets, images };
}

function formatKind1(event, options) {
  let text = event.content || '';

  // Extract images before stripping
  const images = [...text.matchAll(IMAGE_RE)].map(m => m[0]);
  for (const img of images) {
    text = text.replace(img, '').trim();
  }

  text = stripNostrArtifacts(text);

  // Smart hashtag handling
  text = enhanceHashtags(text);

  const tweets = threadText(text);
  return { tweets, images };
}

function formatKind30023(event, options) {
  const tags = event.tags || [];
  const getTag = (name) => tags.find(t => t[0] === name)?.[1] || '';

  const title = getTag('title');
  const summary = getTag('summary') || stripMarkdown(event.content || '').slice(0, 200);
  const image = getTag('image');

  let text = title ? `${title}\n\n${summary}` : summary;
  text = stripNostrArtifacts(text);
  text = enhanceHashtags(text);

  const tweets = threadText(text);
  const images = image ? [image] : [];

  return { tweets, images };
}

/**
 * Remove ALL Nostr fingerprints from text
 */
function stripNostrArtifacts(text) {
  // Remove njump.me links
  text = text.replace(NJUMP_RE, '').trim();

  // Remove "posted via Nostr" / "Originally posted on Nostr" attribution
  text = text.replace(NOSTR_ATTRIBUTION_RE, '').trim();

  // Remove purple dot indicator
  text = text.replace(PURPLE_DOT_RE, '').trim();

  // Strip nostr: mentions and references
  text = text.replace(NOSTR_MENTION_RE, '').trim();
  text = text.replace(NOSTR_REF_RE, '').trim();

  // Collapse excess whitespace
  text = text.replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();

  return text;
}

/**
 * Keep existing hashtags that work on X, optionally add relevant ones
 */
function enhanceHashtags(text) {
  // Extract existing hashtags
  const existingTags = new Set(
    (text.match(/#\w+/g) || []).map(t => t.toLowerCase())
  );

  // Check if content mentions topics that could use hashtags
  const lowerText = text.toLowerCase();
  const suggestedTags = [];

  for (const [keyword, hashtag] of Object.entries(X_HASHTAG_MAP)) {
    const re = new RegExp(`\\b${keyword}\\b`, 'i');
    if (re.test(lowerText) && !existingTags.has(hashtag.toLowerCase())) {
      suggestedTags.push(hashtag);
    }
  }

  // Only add up to 2 suggested hashtags to keep it natural
  if (suggestedTags.length > 0 && existingTags.size < 3) {
    const toAdd = suggestedTags.slice(0, Math.min(2, 3 - existingTags.size));
    // Only add if they fit
    const tagStr = '\n\n' + toAdd.join(' ');
    if (text.length + tagStr.length <= MAX_TWEET_CHARS) {
      text = text + tagStr;
    }
  }

  return text;
}

/**
 * Split text into tweet-sized chunks. No Nostr footer.
 */
function threadText(text) {
  // Fits in one tweet
  if (text.length <= MAX_TWEET_CHARS) {
    return [text];
  }

  // Need to thread — split by sentences/paragraphs
  const tweets = [];
  let remaining = text;
  const threadIndicatorLen = 6; // " (X/Y)" approx

  while (remaining.length > 0) {
    const isLast = remaining.length <= MAX_TWEET_CHARS - threadIndicatorLen;

    if (isLast) {
      tweets.push(remaining);
      break;
    }

    const maxChunk = MAX_TWEET_CHARS - threadIndicatorLen;
    let splitAt = findSplitPoint(remaining, maxChunk);
    tweets.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  // Add thread indicators only if multi-tweet (no "1/" style, use (1/3) format)
  if (tweets.length > 1) {
    tweets.forEach((t, i) => {
      tweets[i] = t + ` (${i + 1}/${tweets.length})`;
    });
  }

  return tweets;
}

function findSplitPoint(text, maxLen) {
  if (text.length <= maxLen) return text.length;

  // Try paragraph break
  const paraBreak = text.lastIndexOf('\n\n', maxLen);
  if (paraBreak > maxLen * 0.5) return paraBreak;

  // Try sentence break
  const sentenceBreak = text.lastIndexOf('. ', maxLen);
  if (sentenceBreak > maxLen * 0.5) return sentenceBreak + 1;

  // Try word break
  const wordBreak = text.lastIndexOf(' ', maxLen);
  if (wordBreak > maxLen * 0.3) return wordBreak;

  // Hard cut
  return maxLen;
}

function stripMarkdown(text) {
  return text
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .trim();
}
