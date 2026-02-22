#!/usr/bin/env node
/**
 * Social Cross-Post Checker
 *
 * Fetches Derek's recent Nostr posts, scores engagement, filters content,
 * and cross-posts qualifying posts to X and LinkedIn.
 *
 * Usage:
 *   node check-and-post.mjs [--dry-run] [--verbose]
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = resolve(__dirname, '..');
const STATE_FILE = resolve(__dirname, '../../memory/crosspost-state.json');

// --- Config ---
const DEREK_PUBKEY = '3f770d65d3a764a9c5cb503ae123e62ec7598ad035d836e2a810f3877a745b24';
const RELAYS = ['wss://relay.ditto.pub', 'wss://relay.primal.net', 'wss://nos.lol'];
const DITTO_RELAY = 'wss://relay.ditto.pub';
const MIN_AGE_SECONDS = 3600; // 1 hour
const LOOKBACK_SECONDS = 86400; // 24 hours
const ENGAGEMENT_THRESHOLD = 10;
const DAILY_CAP_X = 3;
const DAILY_CAP_LINKEDIN = 1;

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

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
    return { lastCheck: 0, posted: {}, skipped: {}, dailyCounts: {} };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { lastCheck: 0, posted: {}, skipped: {}, dailyCounts: {} };
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
  // Use nak encode to create nevent
  const relayArgs = relays.slice(0, 2).map(r => `--relay ${r}`).join(' ');
  const result = nak(`encode nevent ${id} --author ${DEREK_PUBKEY} ${relayArgs}`);
  return result || `nevent1${id}`;
}

// --- Content Classification ---

const SKIP_PATTERNS = [
  /^gm\b/i, /good morning/i, /good night/i, /gn\b/i,
  /pura vida/i,
  /\bfamily\b/i, /\bkids?\b/i, /\bwife\b/i, /\bkatie\b/i, /\blogan\b/i, /\bhalee\b/i,
  /^lol\b/i, /^ha+\b/i, /^nice\b/i, /^yes\b/i, /^no\b/i, /^this\b/i,
  /^😂/, /^🤣/, /^💀/,
  /^nostr:n(pub|profile)1/,  // just tagging someone
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
  /\bzap/i, /\brelay\b/i, /\bnip-?\d/i, /\bweb.?of.?trust\b/i,
  /\bfreedom.?tech\b/i, /\bsovereign/i,
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
  /\bshitpost/i, /\blmao\b/i, /\blol\b/i, /\bbruh\b/i, /\bfam\b/i,
  /😂|🤣|💀|🫡|🔥/, /\baf\b/i, /\bdegen\b/i, /\blfg\b/i, /\bhaha/i,
];

function classifyContent(content) {
  // Check skip patterns
  for (const pat of SKIP_PATTERNS) {
    if (pat.test(content)) return { skip: true, reason: 'casual/personal content' };
  }

  // Too short (< 30 chars) is likely casual
  if (content.length < 30) return { skip: true, reason: 'too short' };

  const isXWorthy = XWORTHY_PATTERNS.some(p => p.test(content));
  const isLinkedInWorthy = LINKEDIN_PATTERNS.some(p => p.test(content));
  const isCasualTone = CASUAL_TONE_PATTERNS.some(p => p.test(content));

  if (!isXWorthy && !isLinkedInWorthy) {
    return { skip: true, reason: 'off-topic for cross-posting' };
  }

  return {
    skip: false,
    x: isXWorthy,
    linkedin: isLinkedInWorthy || (isXWorthy && content.length > 200),
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
  // Extract key terms and check NIP-50 hot search
  const words = content.replace(/nostr:\S+/g, '').replace(/https?:\S+/g, '')
    .split(/\s+/).filter(w => w.length > 4).slice(0, 3).join(' ');
  if (!words) return 0;

  const results = nakLines(`req -k 1 --search "sort:hot ${words}" -l 5 ${DITTO_RELAY}`, 10000);
  // If Derek's post shows up in hot results, bonus points
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
  const results = { timestamp: new Date().toISOString(), dryRun: DRY_RUN, actions: [], skipped: [] };

  // Fetch Derek's recent root posts (kind 1 + kind 30023)
  const relayStr = RELAYS.join(' ');
  const posts = [
    ...nakLines(`req -k 1 -a ${DEREK_PUBKEY} --since ${since} -l 50 ${relayStr}`, 30000),
    ...nakLines(`req -k 30023 -a ${DEREK_PUBKEY} --since ${since} -l 10 ${relayStr}`, 30000),
  ];

  // Deduplicate by id
  const seen = new Set();
  const uniquePosts = posts.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  if (VERBOSE) console.error(`Fetched ${uniquePosts.length} unique posts from last 24h`);

  for (const post of uniquePosts) {
    const eventId = post.id;

    // Skip already processed (but only if real posts, not dry-runs)
    if (state.skipped[eventId]) {
      continue;
    }
    if (state.posted[eventId]) {
      // Never repost deleted/rejected content
      if (state.posted[eventId].deleted) continue;
      const prev = state.posted[eventId].crossPosted || {};
      const alreadyPostedX = prev.x && !prev.x.dryRun;
      const alreadyPostedLinkedin = prev.linkedin && !prev.linkedin.dryRun;
      if (alreadyPostedX && alreadyPostedLinkedin) continue;
      // If only partially posted (or dry-run), fall through to check remaining platforms
    }

    // Skip replies (has "e" tag with "reply" marker)
    const isReply = post.tags?.some(t => t[0] === 'e' && (t[3] === 'reply' || t[3] === 'root'));
    if (isReply) {
      state.skipped[eventId] = { reason: 'reply', at: now };
      results.skipped.push({ id: eventId, reason: 'reply' });
      continue;
    }

    // Skip reposts (kind 6)
    if (post.kind === 6) continue;

    // Skip quoted posts (contain nostr:note1 or nostr:nevent1 references — context lost on X/LinkedIn)
    const hasQuote = /nostr:(note1|nevent1)[a-z0-9]+/i.test(post.content || '');
    if (hasQuote) {
      state.skipped[eventId] = { reason: 'quoted post (context lost on other platforms)', at: now };
      results.skipped.push({ id: eventId, reason: 'quoted post' });
      continue;
    }

    // Must be old enough
    const age = now - post.created_at;
    if (age < MIN_AGE_SECONDS) {
      if (VERBOSE) console.error(`Skipping ${eventId.slice(0,8)}... too young (${Math.round(age/60)}m)`);
      continue; // Don't mark as skipped — check again next run
    }

    // Content classification
    const classification = classifyContent(post.content || '');
    if (classification.skip) {
      state.skipped[eventId] = { reason: classification.reason, at: now };
      results.skipped.push({ id: eventId, reason: classification.reason, content: post.content?.slice(0, 80) });
      continue;
    }

    // Engagement scoring
    const engagement = getEngagement(eventId);
    const trendingBonus = checkTrending(post.content || '');
    const totalScore = engagement.score + trendingBonus;

    if (VERBOSE) {
      console.error(`Post ${eventId.slice(0,8)}... score=${totalScore} (base=${engagement.score} trend=${trendingBonus})`);
      console.error(`  Content: ${post.content?.slice(0, 100)}`);
    }

    if (totalScore < ENGAGEMENT_THRESHOLD) {
      state.skipped[eventId] = { reason: `low engagement (score=${totalScore})`, at: now };
      results.skipped.push({ id: eventId, reason: `low engagement (${totalScore})`, content: post.content?.slice(0, 80) });
      continue;
    }

    // Generate nevent
    const nevent = eventToNevent(eventId, RELAYS);

    // Platform routing
    const posted = {};

    // Check what's already been posted (non-dry-run) for this event
    const prevPosted = state.posted[eventId]?.crossPosted || {};
    const alreadyOnX = prevPosted.x && !prevPosted.x.dryRun;
    const alreadyOnLinkedin = prevPosted.linkedin && !prevPosted.linkedin.dryRun;

    if (classification.x && counts.x < DAILY_CAP_X && !alreadyOnX) {
      const result = crossPost('x', nevent);
      if (result.success) {
        counts.x++;
        posted.x = { at: now, dryRun: DRY_RUN, ...result };
      }
    }

    if (classification.linkedin && counts.linkedin < DAILY_CAP_LINKEDIN && !alreadyOnLinkedin) {
      const needsRewrite = classification.needsRewrite;
      if (needsRewrite) {
        posted.linkedin = { flagged: true, reason: 'needs professional rewrite', nevent, at: now };
      } else {
        const result = crossPost('linkedin', nevent);
        if (result.success) {
          counts.linkedin++;
          posted.linkedin = { at: now, dryRun: DRY_RUN, ...result };
        }
      }
    }

    if (Object.keys(posted).length > 0 || DRY_RUN) {
      // Merge with existing record (preserve prior real posts)
      const existingCrossPosted = state.posted[eventId]?.crossPosted || {};
      const mergedCrossPosted = { ...existingCrossPosted };
      for (const [platform, data] of Object.entries(posted)) {
        // Only overwrite if new is real or old was dry-run
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
        kind: post.kind,
      };
      results.actions.push({
        id: eventId,
        nevent,
        score: totalScore,
        engagement,
        platforms: posted,
        content: post.content?.slice(0, 120),
        needsRewrite: classification.needsRewrite || false,
      });
    }
  }

  state.lastCheck = now;
  state.dailyCounts = counts;
  saveState(state);

  // Summary
  results.summary = {
    postsChecked: uniquePosts.length,
    actioned: results.actions.length,
    skipped: results.skipped.length,
    dailyCounts: { x: counts.x, linkedin: counts.linkedin },
    capsRemaining: { x: DAILY_CAP_X - counts.x, linkedin: DAILY_CAP_LINKEDIN - counts.linkedin },
  };

  console.log(JSON.stringify(results, null, 2));
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
