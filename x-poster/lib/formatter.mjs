/**
 * Format Nostr events for X/Twitter
 *
 * Handles:
 * - 280 char limit (auto-threading for longer content)
 * - Image extraction
 * - nostr: mention/reference stripping
 * - Nostr footer with njump link
 */

const MAX_TWEET_CHARS = 280;
const NOSTR_FOOTER = '\n\n🟣 Originally posted on Nostr';
const IMAGE_RE = /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?/gi;
const NOSTR_MENTION_RE = /nostr:npub1[a-z0-9]+/gi;
const NOSTR_REF_RE = /nostr:(?:nevent1|naddr1|note1|nprofile1)[a-z0-9]+/gi;
const URL_CHAR_COUNT = 23; // X counts all URLs as 23 chars (t.co wrapping)

/**
 * Format a Nostr event for X/Twitter
 * @param {object} event - Raw Nostr event
 * @param {string} originalIdentifier - nevent1.../naddr1... string
 * @param {object} options - { noLink: boolean }
 * @returns {{ tweets: string[], images: string[] }}
 */
export function format(event, originalIdentifier, options = {}) {
  if (!event || typeof event !== 'object') {
    throw new Error('Invalid event');
  }

  const kind = event.kind;
  if (kind === 1) return formatKind1(event, originalIdentifier, options);
  if (kind === 30023) return formatKind30023(event, originalIdentifier, options);
  throw new Error(`Only kind 1 and 30023 supported. Got kind ${kind}`);
}

function formatKind1(event, originalIdentifier, options) {
  let text = event.content || '';

  // Extract images before stripping
  const images = [...text.matchAll(IMAGE_RE)].map(m => m[0]);

  // Remove image URLs from text
  for (const img of images) {
    text = text.replace(img, '').trim();
  }

  // Strip nostr: mentions and references
  text = text.replace(NOSTR_MENTION_RE, '').trim();
  text = text.replace(NOSTR_REF_RE, '').trim();

  // Collapse excess whitespace
  text = text.replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();

  // Build footer — prefer full link, fall back to just emoji if it would force threading
  if (options.noLink) {
    const tweets = threadText(text, '', 0);
    return { tweets, images };
  }

  const njumpLink = originalIdentifier ? `https://njump.me/${originalIdentifier}` : '';
  const fullFooter = njumpLink ? `${NOSTR_FOOTER}\n${njumpLink}` : NOSTR_FOOTER;
  const fullFooterEffLen = NOSTR_FOOTER.length + 1 + URL_CHAR_COUNT;

  // If full footer fits in a single tweet, use it
  if (text.length + fullFooterEffLen <= MAX_TWEET_CHARS) {
    return { tweets: [text + fullFooter], images };
  }

  // If text alone fits in one tweet with just the emoji marker, do that instead of threading
  const shortFooter = '\n\n🟣';
  if (text.length + shortFooter.length <= MAX_TWEET_CHARS) {
    return { tweets: [text + shortFooter], images };
  }

  // Otherwise thread with full footer on last tweet
  const footer = fullFooter;
  const footerEffectiveLen = fullFooterEffLen;
  const tweets = threadText(text, footer, footerEffectiveLen);

  return { tweets, images };
}

function formatKind30023(event, originalIdentifier, options) {
  const tags = event.tags || [];
  const getTag = (name) => tags.find(t => t[0] === name)?.[1] || '';

  const title = getTag('title');
  const summary = getTag('summary') || stripMarkdown(event.content || '').slice(0, 200);
  const image = getTag('image');

  const njumpLink = originalIdentifier ? `https://njump.me/${originalIdentifier}` : '';
  const footer = options.noLink ? '' : (njumpLink ? `${NOSTR_FOOTER}\n${njumpLink}` : NOSTR_FOOTER);
  const footerEffectiveLen = options.noLink ? 0 : (NOSTR_FOOTER.length + 1 + URL_CHAR_COUNT);

  let text = title ? `${title}\n\n${summary}` : summary;
  text = text.trim();

  const tweets = threadText(text, footer, footerEffectiveLen);
  const images = image ? [image] : [];

  return { tweets, images };
}

/**
 * Split text into tweet-sized chunks with footer on the last tweet.
 * If the whole thing fits in one tweet, return as single tweet.
 */
function threadText(text, footer, footerEffectiveLen) {
  const singleTweetMax = MAX_TWEET_CHARS - footerEffectiveLen;

  // Fits in one tweet
  if (text.length <= singleTweetMax) {
    return [text + footer];
  }

  // Need to thread — split by sentences/paragraphs
  const tweets = [];
  let remaining = text;
  const threadIndicatorLen = 6; // " (X/Y)" approx

  while (remaining.length > 0) {
    const isLast = remaining.length <= MAX_TWEET_CHARS - footerEffectiveLen - threadIndicatorLen;

    if (isLast) {
      tweets.push(remaining);
      break;
    }

    const maxChunk = MAX_TWEET_CHARS - threadIndicatorLen;
    let splitAt = findSplitPoint(remaining, maxChunk);
    tweets.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  // Add thread indicators and footer to last tweet
  if (tweets.length > 1) {
    tweets.forEach((t, i) => {
      const indicator = ` (${i + 1}/${tweets.length})`;
      if (i === tweets.length - 1) {
        tweets[i] = t + footer + indicator;
      } else {
        tweets[i] = t + indicator;
      }
    });
  } else {
    tweets[0] = tweets[0] + footer;
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
