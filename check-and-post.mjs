#!/usr/bin/env node
/**
 * Social Cross-Post Checker
 *
 * Fetches Derek's recent Nostr posts, scores engagement, filters content,
 * and cross-posts qualifying posts to X and LinkedIn with platform-specific formatting.
 * Also supports native drafts from social-strategy/drafts/ directory.
 *
 * Usage:
 *   node check-and-post.mjs [--dry-run] [--verbose] [--drafts-only]
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = resolve(__dirname, '..');
const STATE_FILE = resolve(__dirname, '../../memory/crosspost-state.json');
const DRAFTS_DIR = resolve(__dirname, '../../social-strategy/drafts');

// --- Config ---
const DEREK_PUBKEY = '3f770d65d3a764a9c5cb503ae123e62ec7598ad035d836e2a810f3877a745b24';
// Centauri's pubkey — filter out posts that were already cross-posted by the agent
const CENTAURI_PUBKEY = '90d8d48925ea3fbb2e3310775268d1581f4d01d7a3348ca8ca415d632bd2a1d1';
const RELAYS = ['wss://relay.ditto.pub', 'wss://relay.primal.net', 'wss://nos.lol'];
const DITTO_RELAY = 'wss://relay.ditto.pub';
const MIN_AGE_SECONDS = 3600; // 1 hour — post must be at least this old
const LOOKBACK_SECONDS = 86400; // 24 hours
const MIN_CONTENT_LENGTH = 50; // skip very short posts

// Platform-specific engagement thresholds (higher = more selective)
const THRESHOLD_X = 40;
const THRESHOLD_LINKEDIN = 60;

const DAILY_CAP_X = 3;
const DAILY_CAP_LINKEDIN = 1;

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const DRAFTS_ONLY = process.argv.includes('--drafts-only');

// --- Content Blocklist ---
// Posts matching these patterns should NEVER be cross-posted
const BLOCKLIST_PATTERNS = [
  // Personal finance / trading
  /\bbuy order\b/i, /\bsell order\b/i, /\bsetting.*(buy|sell)\b/i,
  /\bposition\b.*\b(long|short)\b/i, /\btrad(e|ing)\b.*\border\b/i,
  /\bdca\b/i,
  // Bot/agent commands and internal stuff
  /\bstop openclaw\b/i, /\bheartbeat\b/i, /\bheartbeat_ok\b/i,
  // Pure memes with no substance
  /^[A-Z\s!?.]{1,30}$/,  // ALL CAPS short posts
  // Personal/family (reinforced)
  /\bfamily\b/i, /\bkids?\b/i, /\bwife\b/i, /\bkatie\b/i, /\blogan\b/i, /\bhalee\b/i,
  /\btherapy\b/i, /\bdoctor\b/i, /\bappointment\b/i,
  // Conversations / replies to specific people
  /^@\w+/,
  // Just an image URL with no real text
  /^\s*https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)\S*\s*$/i,
  // Shitposting indicators
  /\bshitpost/i, /\bcopium\b/i, /\blet'?s\s+go\s*!*$/i,
];

// --- Helpers ---

function nak(args, timeout = 15000) {
  try {
    const result = execSync(`nak ${args}`, {
      timeout,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (e) {
    if (VERBOSE) console.error(`nak error: ${e.message?.slice(0, 200)}`);
    return '';
  }
}

function nakLines(args, timeout = 15000) {
  const raw = nak(args, timeout);
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { lastCheck: 0, posted: {}, skipped: {}, dailyCounts: {}, draftsPosted: [] };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { lastCheck: 0, posted: {}, skipped: {}, dailyCounts: {}, draftsPosted: [] };
  }
}

function saveState(state) {
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getDailyCounts(state) {
  const key = todayKey();
  if (!state.dailyCounts || state.dailyCounts._date !== key) {
    state.dailyCounts = { _date: key, x: 0, linkedin: 0 };
  }
  return state.dailyCounts;
}

function eventToNevent(id, relays) {
  const relayArgs = relays.slice(0, 2).map(r => `--relay ${r}`).join(' ');
  const result = nak(`encode nevent ${id} --author ${DEREK_PUBKEY} ${relayArgs}`);
  return result || `nevent1${id}`;
}

// --- Platform-Specific Formatting ---

function stripNostrArtifacts(text) {
  return text
    .replace(/https?:\/\/njump\.me\/\S+/gi, '')
    .replace(/(?:🟣\s*)?(?:originally )?posted (?:via|on) nostr\b[^\n]*/gi, '')
    .replace(/\n*🟣\s*/g, '')
    .replace(/nostr:npub1[a-z0-9]+/gi, '')
    .replace(/nostr:(?:nevent1|naddr1|note1|nprofile1)[a-z0-9]+/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function formatForX(content) {
  let text = stripNostrArtifacts(content);
  text = text.replace(/https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?/gi, '').trim();

  if (text.length > 280) {
    const cut = text.lastIndexOf('. ', 277);
    if (cut > 140) {
      text = text.slice(0, cut + 1);
    } else {
      const wordCut = text.lastIndexOf(' ', 277);
      text = text.slice(0, wordCut > 0 ? wordCut : 277) + '…';
    }
  }

  return text;
}

function formatForLinkedIn(content) {
  let text = stripNostrArtifacts(content);
  text = text.replace(/https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp)(?:\?\S*)?/gi, '').trim();

  const lowerText = text.toLowerCase();
  const tags = new Set();
  const tagMap = {
    bitcoin: '#Bitcoin', nostr: '#Nostr', ai: '#AI',
    'open source': '#OpenSource', privacy: '#Privacy',
    decentrali: '#Decentralization', freedom: '#FreedomTech',
    lightning: '#Lightning', community: '#Community',
    protocol: '#OpenProtocol',
  };

  for (const [keyword, tag] of Object.entries(tagMap)) {
    if (lowerText.includes(keyword)) tags.add(tag);
    if (tags.size >= 4) break;
  }

  if (tags.size > 0) {
    text += '\n\n' + [...tags].join(' ');
  }

  return text;
}

// --- Native Drafts Support ---

function loadDrafts() {
  if (!existsSync(DRAFTS_DIR)) return [];

  const files = readdirSync(DRAFTS_DIR).filter(f => f.endsWith('.json') || f.endsWith('.txt'));
  const drafts = [];

  for (const file of files) {
    const filePath = join(DRAFTS_DIR, file);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      if (file.endsWith('.json')) {
        const draft = JSON.parse(raw);
        draft._file = file;
        draft._path = filePath;
        drafts.push(draft);
      } else {
        drafts.push({
          platforms: ['x'],
          x: raw.trim(),
          content: raw.trim(),
          _file: file,
          _path: filePath,
        });
      }
    } catch (e) {
      if (VERBOSE) console.error(`Failed to read draft ${file}: ${e.message}`);
    }
  }

  return drafts;
}

function processDrafts(state, counts) {
  const drafts = loadDrafts();
  const results = [];
  const now = Date.now();

  for (const draft of drafts) {
    if (draft.scheduledFor && new Date(draft.scheduledFor).getTime() > now) {
      if (VERBOSE) console.error(`Draft ${draft._file} scheduled for later, skipping`);
      continue;
    }

    const posted = {};

    if (draft.platforms?.includes('x') && counts.x < DAILY_CAP_X) {
      const xText = draft.x || draft.content;
      if (xText) {
        const result = postNativeContent('x', xText);
        if (result.success) {
          if (!DRY_RUN) counts.x++;
          posted.x = { at: Math.floor(now / 1000), dryRun: DRY_RUN, ...result };
        }
      }
    }

    if (draft.platforms?.includes('linkedin') && counts.linkedin < DAILY_CAP_LINKEDIN) {
      const liText = draft.linkedin || draft.content;
      if (liText) {
        const result = postNativeContent('linkedin', liText);
        if (result.success) {
          if (!DRY_RUN) counts.linkedin++;
          posted.linkedin = { at: Math.floor(now / 1000), dryRun: DRY_RUN, ...result };
        }
      }
    }

    if (Object.keys(posted).length > 0) {
      results.push({ file: draft._file, platforms: posted });

      if (!DRY_RUN) {
        const postedDir = join(DRAFTS_DIR, 'posted');
        if (!existsSync(postedDir)) mkdirSync(postedDir, { recursive: true });
        try {
          renameSync(draft._path, join(postedDir, draft._file));
        } catch { /* ignore */ }
      }

      if (!state.draftsPosted) state.draftsPosted = [];
      state.draftsPosted.push({
        file: draft._file,
        at: Math.floor(now / 1000),
        platforms: Object.keys(posted),
        dryRun: DRY_RUN,
      });
    }
  }

  return results;
}

function postNativeContent(platform, text) {
  if (platform === 'x') {
    if (DRY_RUN) {
      console.error(`[DRY RUN] Would post to X: ${text.slice(0, 100)}...`);
      return { success: true, dryRun: true };
    }

    try {
      const script = `
        import { postTweet } from '${TOOLS_DIR}/x-poster/lib/x.mjs';
        const result = await postTweet(${JSON.stringify(text)});
        console.log(JSON.stringify(result));
      `;
      const output = execSync(`node --input-type=module -e ${JSON.stringify(script)}`, {
        encoding: 'utf-8', timeout: 30000
      });
      return { success: true, output: output.trim() };
    } catch (e) {
      return { success: false, error: e.message?.slice(0, 200) };
    }
  }

  if (platform === 'linkedin') {
    if (DRY_RUN) {
      console.error(`[DRY RUN] Would post to LinkedIn: ${text.slice(0, 100)}...`);
      return { success: true, dryRun: true };
    }

    try {
      const script = `
        import { publish } from '${TOOLS_DIR}/linkedin-poster/lib/linkedin.mjs';
        const payload = {
          commentary: ${JSON.stringify(text)},
          visibility: 'PUBLIC',
          distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
        };
        const result = await publish(payload);
        console.log(JSON.stringify(result));
      `;
      const output = execSync(`node --input-type=module -e ${JSON.stringify(script)}`, {
        encoding: 'utf-8', timeout: 30000
      });
      return { success: true, output: output.trim() };
    } catch (e) {
      return { success: false, error: e.message?.slice(0, 200) };
    }
  }

  return { success: false, error: `Unknown platform: ${platform}` };
}

// --- Content Classification ---

const SKIP_PATTERNS = [
  /^gm\b/i, /good morning/i, /good night/i, /gn\b/i,
  /pura vida/i,
  /^lol\b/i, /^ha+\b/i, /^nice\b/i, /^yes\b/i, /^no\b/i, /^this\b/i,
  /^😂/, /^🤣/, /^💀/,
  /^nostr:n(pub|profile)1/,
];

const XWORTHY_PATTERNS = [
  /\bbitcoin\b/i, /\bbtc\b/i, /\bnostr\b/i, /\bai\b/i, /\bartificial intelligence\b/i,
  /\bdecentraliz/i, /\bcensorship/i, /\bfreedom\b/i, /\bprivacy\b/i,
  /\bopen.?source\b/i, /\bfoss\b/i, /\bprotocol\b/i,
  /\bconference\b/i, /\bsummit\b/i, /\bhackathon\b/i, /\bevent\b/i,
  /\bshakespeare\b/i, /\bagora\b/i, /\bonyx\b/i, /\bopenclaw\b/i, /\bditto\b/i,
  /\bcommunity\b/i, /\bcommunities\b/i, /\bmoderat/i, /\bweb.?of.?trust\b/i, /\bwot\b/i,
  /\brelay\b/i, /\balgorithm\b/i, /\bdoomscroll/i, /\bbloomscroll/i,
  /\bsocial.?media\b/i, /\bsocial.?network/i, /\bplatform\b/i,
  /\bagent\b/i, /\bsovereign/i, /\bself.?custod/i, /\blightning\b/i, /\bzap/i,
  /\btech\b/i, /\bsoftware\b/i, /\bopen\b/i, /\bbuild/i,
  /\bdev\b/i, /\bdeveloper/i, /\bbuilding\b/i, /\bshipped\b/i, /\blaunch/i,
  /\bnip-?\d/i, /\bfreedom.?tech\b/i,
];

const LINKEDIN_PATTERNS = [
  /\bindustry\b/i, /\bbusiness\b/i, /\benterprise\b/i, /\bprofessional\b/i,
  /\bleadership\b/i, /\bstrategy\b/i, /\binnovation\b/i,
  /\bconference\b/i, /\bspeaking\b/i, /\bpresent/i, /\bkeynote\b/i,
  /\beducation/i, /\blearning\b/i, /\bworkshop\b/i,
  /\bthought.?leader/i, /\becosystem\b/i,
  /\bdevrel\b/i, /\bdeveloper.?relations/i,
];

const CASUAL_TONE_PATTERNS = [
  /\blmao\b/i, /\bbruh\b/i, /\bfam\b/i,
  /😂|🤣|💀/, /\baf\b/i, /\bdegen\b/i, /\blfg\b/i, /\bhaha/i,
];

/**
 * Check if content matches any blocklist pattern — these NEVER get cross-posted
 */
function isBlocklisted(content) {
  for (const pat of BLOCKLIST_PATTERNS) {
    if (pat.test(content)) return true;
  }
  return false;
}

/**
 * Check if a post was already cross-posted by the agent (e.g. I posted it last night)
 * Looks for similar content in the posted state
 */
function isDuplicateContent(content, state) {
  const normalized = content.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);
  for (const [, entry] of Object.entries(state.posted || {})) {
    if (!entry.content) continue;
    const prevNormalized = entry.content.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);
    // Check for high similarity (>80% overlap)
    if (normalized === prevNormalized) return true;
    // Check if one contains the other
    if (normalized.includes(prevNormalized) || prevNormalized.includes(normalized)) return true;
  }
  return false;
}

function classifyContent(content) {
  // Blocklist check first — absolute no-go
  if (isBlocklisted(content)) return { skip: true, reason: 'blocklisted content' };

  for (const pat of SKIP_PATTERNS) {
    if (pat.test(content)) return { skip: true, reason: 'casual/personal content' };
  }

  // Strip nostr artifacts before checking length
  const cleanContent = stripNostrArtifacts(content);
  if (cleanContent.length < MIN_CONTENT_LENGTH) return { skip: true, reason: `too short (${cleanContent.length} chars, need ${MIN_CONTENT_LENGTH})` };

  const isXWorthy = XWORTHY_PATTERNS.some(p => p.test(content));
  const isLinkedInWorthy = LINKEDIN_PATTERNS.some(p => p.test(content));
  const isCasualTone = CASUAL_TONE_PATTERNS.some(p => p.test(content));

  if (!isXWorthy && !isLinkedInWorthy) {
    return { skip: true, reason: 'off-topic for cross-posting' };
  }

  return {
    skip: false,
    x: isXWorthy,
    linkedin: isLinkedInWorthy || (isXWorthy && cleanContent.length > 200),
    needsRewrite: isCasualTone && isLinkedInWorthy,
  };
}

// --- Engagement Scoring ---

function getEngagement(eventId) {
  const relayStr = RELAYS.join(' ');
  const reactions = nakLines(`req -k 7 --tag e="${eventId}" -l 200 ${relayStr}`, 20000).length;
  const reposts = nakLines(`req -k 6 --tag e="${eventId}" -l 200 ${relayStr}`, 20000).length;
  const zaps = nakLines(`req -k 9735 --tag e="${eventId}" -l 200 ${relayStr}`, 20000).length;
  const replies = nakLines(`req -k 1 --tag e="${eventId}" -l 200 ${relayStr}`, 20000).length;
  const score = (reactions * 1) + (reposts * 3) + (zaps * 5) + (replies * 2);
  return { reactions, reposts, zaps, replies, score };
}

function checkTrending(content) {
  const words = content.replace(/nostr:\S+/g, '').replace(/https?:\S+/g, '')
    .split(/\s+/).filter(w => w.length > 4).slice(0, 3).join(' ');
  if (!words) return 0;
  const results = nakLines(`req -k 1 --search "sort:hot ${words}" -l 5 ${DITTO_RELAY}`, 10000);
  return results.length > 0 ? 5 : 0;
}

// --- Post Execution ---

function crossPost(platform, nevent) {
  const tool = platform === 'x' ? 'x-poster' : 'linkedin-poster';
  const cmd = `node ${TOOLS_DIR}/${tool}/bin/post.mjs ${nevent}`;

  if (DRY_RUN) {
    console.error(`[DRY RUN] Would execute: ${cmd}`);
    return { success: true, dryRun: true };
  }

  try {
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 60000 });
    return { success: true, output: output.trim() };
  } catch (e) {
    return { success: false, error: e.message?.slice(0, 200) };
  }
}

// --- Main ---

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const since = now - LOOKBACK_SECONDS;
  const state = loadState();
  const counts = getDailyCounts(state);

  // IMPORTANT: Only count real (non-dry-run) posts toward daily caps
  // Reset counts if they include dry-run tallies from previous runs
  if (counts._includesDryRun) {
    counts.x = 0;
    counts.linkedin = 0;
    delete counts._includesDryRun;
  }

  const results = { timestamp: new Date().toISOString(), dryRun: DRY_RUN, actions: [], skipped: [], drafts: [] };

  // Process native drafts first
  const draftResults = processDrafts(state, counts);
  results.drafts = draftResults;

  if (DRAFTS_ONLY) {
    state.dailyCounts = counts;
    saveState(state);
    results.summary = {
      draftsProcessed: draftResults.length,
      dailyCounts: { x: counts.x, linkedin: counts.linkedin },
    };
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Fetch Derek's recent root posts
  const relayStr = RELAYS.join(' ');
  const posts = [
    ...nakLines(`req -k 1 -a ${DEREK_PUBKEY} --since ${since} -l 50 ${relayStr}`, 30000),
    ...nakLines(`req -k 30023 -a ${DEREK_PUBKEY} --since ${since} -l 10 ${relayStr}`, 30000),
  ];

  const seen = new Set();
  const uniquePosts = posts.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  if (VERBOSE) console.error(`Fetched ${uniquePosts.length} unique posts from last 24h`);

  for (const post of uniquePosts) {
    const eventId = post.id;

    if (state.skipped[eventId]) continue;
    if (state.posted[eventId]) {
      if (state.posted[eventId].deleted) continue;
      const prev = state.posted[eventId].crossPosted || {};
      const alreadyPostedX = prev.x && !prev.x.dryRun;
      const alreadyPostedLinkedin = prev.linkedin && !prev.linkedin.dryRun;
      if (alreadyPostedX && alreadyPostedLinkedin) continue;
    }

    // Skip replies
    const isReply = post.tags?.some(t => t[0] === 'e' && (t[3] === 'reply' || t[3] === 'root'));
    if (isReply) {
      state.skipped[eventId] = { reason: 'reply', at: now };
      results.skipped.push({ id: eventId, reason: 'reply' });
      continue;
    }

    // Skip reposts
    if (post.kind === 6) continue;

    // Skip quoted posts (lose context on other platforms)
    const hasQuote = /nostr:(note1|nevent1)[a-z0-9]+/i.test(post.content || '');
    if (hasQuote) {
      state.skipped[eventId] = { reason: 'quoted post (context lost on other platforms)', at: now };
      results.skipped.push({ id: eventId, reason: 'quoted post' });
      continue;
    }

    // Skip too-young posts
    const age = now - post.created_at;
    if (age < MIN_AGE_SECONDS) {
      if (VERBOSE) console.error(`Skipping ${eventId.slice(0,8)}... too young (${Math.round(age/60)}m)`);
      continue;
    }

    // Skip duplicate content (already cross-posted previously)
    if (isDuplicateContent(post.content || '', state)) {
      state.skipped[eventId] = { reason: 'duplicate of previously posted content', at: now };
      results.skipped.push({ id: eventId, reason: 'duplicate content' });
      if (VERBOSE) console.error(`Skipping ${eventId.slice(0,8)}... duplicate content`);
      continue;
    }

    // Classify content
    const classification = classifyContent(post.content || '');
    if (classification.skip) {
      state.skipped[eventId] = { reason: classification.reason, at: now };
      results.skipped.push({ id: eventId, reason: classification.reason, content: post.content?.slice(0, 80) });
      if (VERBOSE) console.error(`Skipping ${eventId.slice(0,8)}... ${classification.reason}`);
      continue;
    }

    // Score engagement
    const engagement = getEngagement(eventId);
    const trendingBonus = checkTrending(post.content || '');
    const totalScore = engagement.score + trendingBonus;

    if (VERBOSE) {
      console.error(`Post ${eventId.slice(0,8)}... score=${totalScore} (base=${engagement.score} trend=${trendingBonus})`);
      console.error(`  Content: ${post.content?.slice(0, 100)}`);
    }

    // Platform-specific threshold checks
    const meetsXThreshold = totalScore >= THRESHOLD_X;
    const meetsLinkedInThreshold = totalScore >= THRESHOLD_LINKEDIN;

    if (!meetsXThreshold && !meetsLinkedInThreshold) {
      state.skipped[eventId] = { reason: `below threshold (score=${totalScore}, needX=${THRESHOLD_X}, needLI=${THRESHOLD_LINKEDIN})`, at: now };
      results.skipped.push({ id: eventId, reason: `low engagement (${totalScore})`, content: post.content?.slice(0, 80) });
      if (VERBOSE) console.error(`  → Below threshold (X needs ${THRESHOLD_X}, LinkedIn needs ${THRESHOLD_LINKEDIN})`);
      continue;
    }

    const nevent = eventToNevent(eventId, RELAYS);
    const posted = {};

    const prevPosted = state.posted[eventId]?.crossPosted || {};
    const alreadyOnX = prevPosted.x && !prevPosted.x.dryRun;
    const alreadyOnLinkedin = prevPosted.linkedin && !prevPosted.linkedin.dryRun;

    const platformVersions = {
      x: formatForX(post.content || ''),
      linkedin: formatForLinkedIn(post.content || ''),
    };

    if (classification.x && meetsXThreshold && counts.x < DAILY_CAP_X && !alreadyOnX) {
      const result = crossPost('x', nevent);
      if (result.success) {
        if (!DRY_RUN) counts.x++;
        posted.x = { at: now, dryRun: DRY_RUN, ...result };
      }
    }

    if (classification.linkedin && meetsLinkedInThreshold && counts.linkedin < DAILY_CAP_LINKEDIN && !alreadyOnLinkedin) {
      if (classification.needsRewrite) {
        posted.linkedin = { flagged: true, reason: 'needs professional rewrite', nevent, at: now };
      } else {
        const result = crossPost('linkedin', nevent);
        if (result.success) {
          if (!DRY_RUN) counts.linkedin++;
          posted.linkedin = { at: now, dryRun: DRY_RUN, ...result };
        }
      }
    }

    if (Object.keys(posted).length > 0) {
      const existingCrossPosted = state.posted[eventId]?.crossPosted || {};
      const mergedCrossPosted = { ...existingCrossPosted };
      for (const [platform, data] of Object.entries(posted)) {
        if (!mergedCrossPosted[platform] || mergedCrossPosted[platform].dryRun || !data.dryRun) {
          mergedCrossPosted[platform] = data;
        }
      }
      state.posted[eventId] = {
        nevent,
        engagement,
        score: totalScore,
        trendingBonus,
        crossPosted: mergedCrossPosted,
        content: post.content?.slice(0, 200),
        platformVersions,
        kind: post.kind,
      };
      results.actions.push({
        id: eventId,
        nevent,
        score: totalScore,
        engagement,
        platforms: posted,
        platformVersions,
        content: post.content?.slice(0, 120),
        needsRewrite: classification.needsRewrite || false,
      });
    }
  }

  state.lastCheck = now;
  state.dailyCounts = counts;
  saveState(state);

  results.summary = {
    postsChecked: uniquePosts.length,
    actioned: results.actions.length,
    skipped: results.skipped.length,
    draftsProcessed: draftResults.length,
    dailyCounts: { x: counts.x, linkedin: counts.linkedin },
    capsRemaining: { x: DAILY_CAP_X - counts.x, linkedin: DAILY_CAP_LINKEDIN - counts.linkedin },
    thresholds: { x: THRESHOLD_X, linkedin: THRESHOLD_LINKEDIN },
  };

  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
