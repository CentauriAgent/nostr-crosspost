/**
 * Format Nostr events for LinkedIn — native professional feel.
 * No Nostr fingerprints. Professional tone with relevant hashtags.
 */

const MAX_CHARS = 3000;
const IMAGE_RE = /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?/gi;
const NOSTR_MENTION_RE = /nostr:npub1[a-z0-9]+/gi;
const NOSTR_REF_RE = /nostr:(?:nevent1|naddr1|note1|nprofile1)[a-z0-9]+/gi;
const NJUMP_RE = /https?:\/\/njump\.me\/\S+/gi;
const NOSTR_ATTRIBUTION_RE = /(?:🟣\s*)?(?:originally )?posted (?:via|on) nostr\b[^\n]*/gi;
const PURPLE_DOT_RE = /\n*🟣\s*/g;

// LinkedIn-appropriate hashtags by topic
const LINKEDIN_HASHTAGS = {
  bitcoin: ['#Bitcoin', '#Cryptocurrency', '#DigitalAssets'],
  nostr: ['#Nostr', '#OpenProtocol', '#Decentralization'],
  ai: ['#AI', '#ArtificialIntelligence', '#Innovation'],
  privacy: ['#Privacy', '#DataPrivacy', '#DigitalRights'],
  opensource: ['#OpenSource', '#FreeTech', '#FOSS'],
  decentralized: ['#Decentralization', '#Web3', '#DistributedSystems'],
  lightning: ['#Lightning', '#Bitcoin', '#Payments'],
  conference: ['#Conference', '#TechEvents', '#Networking'],
  community: ['#Community', '#CommunityBuilding', '#Ecosystem'],
  devrel: ['#DevRel', '#DeveloperRelations', '#DeveloperExperience'],
  censorship: ['#FreeSpeech', '#DigitalRights', '#OpenInternet'],
  freedom: ['#FreedomTech', '#DigitalFreedom'],
  protocol: ['#OpenProtocol', '#Interoperability'],
};

/**
 * Format a Nostr event into a LinkedIn API payload — native LinkedIn feel.
 */
export function format(event, originalIdentifier) {
  if (!event || typeof event !== 'object') {
    throw new Error('Invalid event');
  }

  const kind = event.kind;
  if (kind === 1) return formatKind1(event);
  if (kind === 30023) return formatKind30023(event);
  throw new Error(`Only kind 1 and 30023 supported. Got kind ${kind}`);
}

/**
 * Format raw text for LinkedIn — strips Nostr artifacts, adds professional touch.
 * Can be called directly by the cross-post checker.
 */
export function formatTextForLinkedIn(text) {
  // Extract image URLs before stripping
  const images = [...text.matchAll(IMAGE_RE)].map(m => m[0]);
  if (images.length > 0) {
    text = text.replace(images[0], '').trim();
  }

  text = stripNostrArtifacts(text);

  // Add relevant LinkedIn hashtags
  const hashtags = selectLinkedInHashtags(text);
  if (hashtags.length > 0) {
    text = smartTruncate(text, MAX_CHARS - hashtags.join(' ').length - 2);
    text += '\n\n' + hashtags.join(' ');
  } else {
    text = smartTruncate(text, MAX_CHARS);
  }

  const payload = makeBasePayload(text);
  return { payload, images };
}

function formatKind1(event) {
  let text = event.content || '';

  // Extract image URLs before stripping
  const images = [...text.matchAll(IMAGE_RE)].map(m => m[0]);
  if (images.length > 0) {
    text = text.replace(images[0], '').trim();
  }

  text = stripNostrArtifacts(text);

  // Add relevant LinkedIn hashtags
  const hashtags = selectLinkedInHashtags(text);
  if (hashtags.length > 0) {
    text = smartTruncate(text, MAX_CHARS - hashtags.join(' ').length - 2);
    text += '\n\n' + hashtags.join(' ');
  } else {
    text = smartTruncate(text, MAX_CHARS);
  }

  const payload = makeBasePayload(text);
  return { payload, images };
}

function formatKind30023(event) {
  const tags = event.tags || [];
  const getTag = (name) => tags.find(t => t[0] === name)?.[1] || '';

  const title = getTag('title');
  const summary = getTag('summary');
  const image = getTag('image');
  const eventHashtags = tags.filter(t => t[0] === 't').map(t => `#${t[1]}`);

  let commentaryText = stripMarkdown(event.content || '');
  commentaryText = stripNostrArtifacts(commentaryText);

  // Build hashtags: event tags + auto-detected LinkedIn ones
  const autoHashtags = selectLinkedInHashtags(commentaryText);
  const allHashtags = [...new Set([...eventHashtags, ...autoHashtags])].slice(0, 5);

  const reservedSpace = (allHashtags.length > 0 ? allHashtags.join(' ').length + 2 : 0) +
    (title ? title.length + 2 : 0);
  commentaryText = smartTruncate(commentaryText, MAX_CHARS - reservedSpace);

  if (title) {
    commentaryText = title + '\n\n' + commentaryText;
  }
  if (allHashtags.length > 0) {
    commentaryText += '\n\n' + allHashtags.join(' ');
  }

  const payload = makeBasePayload(commentaryText);

  // Article content (no njump link)
  if (title) {
    payload.content = {
      article: {
        title: title,
        description: summary || smartTruncate(stripMarkdown(event.content || ''), 200),
      },
    };
  }

  const images = image ? [image] : [];
  return { payload, images };
}

/**
 * Remove ALL Nostr fingerprints from text
 */
function stripNostrArtifacts(text) {
  text = text.replace(NJUMP_RE, '').trim();
  text = text.replace(NOSTR_ATTRIBUTION_RE, '').trim();
  text = text.replace(PURPLE_DOT_RE, '').trim();
  text = text.replace(NOSTR_MENTION_RE, '').trim();
  text = text.replace(NOSTR_REF_RE, '').trim();
  text = text.replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();
  return text;
}

/**
 * Select up to 4 relevant LinkedIn hashtags based on content
 */
function selectLinkedInHashtags(text) {
  const lowerText = text.toLowerCase();
  const selected = new Set();
  const existingTags = new Set((text.match(/#\w+/g) || []).map(t => t.toLowerCase()));

  for (const [keyword, tags] of Object.entries(LINKEDIN_HASHTAGS)) {
    const re = new RegExp(`\\b${keyword}\\b`, 'i');
    if (re.test(lowerText)) {
      for (const tag of tags) {
        if (!existingTags.has(tag.toLowerCase())) {
          selected.add(tag);
        }
        if (selected.size >= 4) break;
      }
    }
    if (selected.size >= 4) break;
  }

  return [...selected];
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

function smartTruncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen - 3);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.5 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

function stripMarkdown(md) {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*>\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
