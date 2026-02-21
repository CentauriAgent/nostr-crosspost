const MAX_CHARS = 3000;
const NOSTR_FOOTER = '\n\n🟣 Originally posted on Nostr';
const IMAGE_RE = /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?/gi;
const NOSTR_MENTION_RE = /nostr:npub1[a-z0-9]+/gi;
const NOSTR_REF_RE = /nostr:(?:nevent1|naddr1|note1|nprofile1)[a-z0-9]+/gi;

/**
 * Format a Nostr event into a LinkedIn API payload.
 * @param {object} event - Raw Nostr event
 * @param {string} originalIdentifier - The original nevent1.../naddr1... string (for njump links)
 * @returns {{payload: object, images: string[]}} LinkedIn payload + extracted image URLs
 */
export function format(event, originalIdentifier) {
  if (!event || typeof event !== 'object') {
    throw new Error('Invalid event');
  }

  const kind = event.kind;
  if (kind === 1) return formatKind1(event, originalIdentifier);
  if (kind === 30023) return formatKind30023(event, originalIdentifier);
  throw new Error(`Only kind 1 and 30023 supported. Got kind ${kind}`);
}

function formatKind1(event, originalIdentifier) {
  let text = event.content || '';

  // Extract image URLs before stripping
  const images = [...text.matchAll(IMAGE_RE)].map(m => m[0]);

  // Remove first image URL from text (it'll become a media attachment)
  if (images.length > 0) {
    text = text.replace(images[0], '').trim();
  }

  // Strip nostr:npub mentions
  text = text.replace(NOSTR_MENTION_RE, '').trim();

  // Strip nostr: references (nevent, naddr, note, nprofile)
  text = text.replace(NOSTR_REF_RE, '').trim();

  // Collapse multiple whitespace/newlines from removals
  text = text.replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();

  // Append footer
  const njumpLink = originalIdentifier ? `https://njump.me/${originalIdentifier}` : '';
  const footer = njumpLink ? `${NOSTR_FOOTER}\n${njumpLink}` : NOSTR_FOOTER;

  // Truncate if needed (reserve space for footer)
  text = smartTruncate(text, MAX_CHARS - footer.length);
  const commentary = text + footer;

  const payload = makeBasePayload(commentary);
  return { payload, images };
}

function formatKind30023(event, originalIdentifier) {
  const tags = event.tags || [];
  const getTag = (name) => tags.find(t => t[0] === name)?.[1] || '';

  const title = getTag('title');
  const summary = getTag('summary');
  const image = getTag('image');
  const hashtags = tags.filter(t => t[0] === 't').map(t => `#${t[1]}`);

  // Commentary: full article content stripped of markdown, up to LinkedIn's limit
  let commentaryText = stripMarkdown(event.content || '');
  const njumpLink = originalIdentifier ? `https://njump.me/${originalIdentifier}` : '';
  const footerText = njumpLink ? `${NOSTR_FOOTER}\n\nRead the full article: ${njumpLink}` : NOSTR_FOOTER;
  // Reserve space for hashtags, footer, and title
  const reservedSpace = (hashtags.length > 0 ? hashtags.join(' ').length + 2 : 0) + footerText.length + (title ? title.length + 2 : 0);
  commentaryText = smartTruncate(commentaryText, MAX_CHARS - reservedSpace);

  // Prepend title as bold-style header if available
  if (title) {
    commentaryText = title + '\n\n' + commentaryText;
  }

  // Append hashtags
  if (hashtags.length > 0) {
    commentaryText += '\n\n' + hashtags.join(' ');
  }

  commentaryText += footerText;

  const payload = makeBasePayload(commentaryText);

  // Add article content
  payload.content = {
    article: {
      source: njumpLink,
      title: title || 'Nostr Article',
      description: summary || smartTruncate(stripMarkdown(event.content || ''), 200),
    },
  };

  // Image will be set by the publisher after upload; return it separately
  const images = image ? [image] : [];
  return { payload, images };
}

function makeBasePayload(commentary) {
  return {
    author: 'urn:li:person:{URN}',
    commentary,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
}

/**
 * Truncate text at a word boundary to fit maxLen, adding "..." if truncated.
 */
function smartTruncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen - 3);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.5 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

/**
 * Strip basic markdown formatting for plain text output.
 */
function stripMarkdown(md) {
  return md
    .replace(/^#{1,6}\s+/gm, '')       // headers
    .replace(/\*\*(.+?)\*\*/g, '$1')    // bold
    .replace(/\*(.+?)\*/g, '$1')        // italic
    .replace(/_(.+?)_/g, '$1')          // italic alt
    .replace(/`(.+?)`/g, '$1')          // inline code
    .replace(/```[\s\S]*?```/g, '')     // code blocks
    .replace(/!\[.*?\]\(.*?\)/g, '')    // images
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)') // links
    .replace(/^\s*[-*+]\s+/gm, '• ')   // list items
    .replace(/^\s*>\s+/gm, '')          // blockquotes
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
