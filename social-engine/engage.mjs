#!/usr/bin/env node
/**
 * Engagement Monitor
 *
 * Monitors replies to Derek's tweets and engages back with contextual responses.
 *
 * Usage:
 *   node social-engine/engage.mjs [--dry-run] [--verbose]
 */

import { postTweet } from '../x-poster/lib/x.mjs';
import { readCredentials } from '../x-poster/lib/token.mjs';
import { oauthHeader } from '../x-poster/lib/oauth.mjs';
import {
  loadState, saveState, ensureDailyCounts, canActNow,
  fitsInTweet, log,
} from './utils.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_ENGAGEMENT_PER_DAY = 10;
const MIN_MINUTES_BETWEEN = 10;
const MIN_FOLLOWER_COUNT = 10;

// ─── Engagement reply templates ─────────────────────────────────────
const THANK_REPLIES = [
  "Appreciate you. This is the conversation that matters. 🤝",
  "Exactly. More builders thinking this way = faster progress.",
  "This. The signal-to-noise ratio is everything.",
  "Based take. The builders get it.",
  "Welcome to the freedom stack. It only gets better from here.",
  "This is the energy. Let's keep building. 🔥",
  "Glad this resonates. The work speaks for itself.",
  "Nailed it. Protocol > platform. Always.",
];

const FOLLOW_UP_TEMPLATES = {
  question: [
    "Great question. Short answer: open protocols + sovereign identity. Happy to go deeper.",
    "Been thinking about this a lot. The answer is always: remove the gatekeepers.",
  ],
  agreement: [
    "We're on the same page. The builders who get this early will define the next decade.",
    "Exactly right. Now multiply this by every AI agent that needs identity and payments.",
  ],
  skepticism: [
    "Fair pushback. The best way to see it is to try it — generate a Nostr keypair, post a note, experience it.",
    "I get the skepticism. I had it too. Then I built on it for 3 years and the doubts disappeared.",
  ],
};

async function fetchMyUserId(creds) {
  const url = 'https://api.twitter.com/2/users/me';
  const auth = oauthHeader('GET', url, {}, creds);
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`Failed to fetch user: ${res.status}`);
  const data = await res.json();
  return data.data.id;
}

async function fetchMyRecentTweets(creds, userId) {
  const url = `https://api.twitter.com/2/users/${userId}/tweets`;
  const params = {
    max_results: '10',
    'tweet.fields': 'created_at,public_metrics,conversation_id',
    exclude: 'retweets',
  };
  const fullUrl = new URL(url);
  for (const [k, v] of Object.entries(params)) fullUrl.searchParams.set(k, v);
  const auth = oauthHeader('GET', url, params, creds);
  const res = await fetch(fullUrl.toString(), { headers: { Authorization: auth } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.data || [];
}

async function fetchReplies(creds, conversationId) {
  const url = 'https://api.twitter.com/2/tweets/search/recent';
  const params = {
    query: `conversation_id:${conversationId}`,
    max_results: '20',
    'tweet.fields': 'created_at,author_id,in_reply_to_user_id,public_metrics',
    'user.fields': 'public_metrics,profile_image_url',
    expansions: 'author_id',
  };
  const fullUrl = new URL(url);
  for (const [k, v] of Object.entries(params)) fullUrl.searchParams.set(k, v);
  const auth = oauthHeader('GET', url, params, creds);

  try {
    const res = await fetch(fullUrl.toString(), { headers: { Authorization: auth } });
    if (res.status === 429) return { tweets: [], users: [] };
    if (!res.ok) return { tweets: [], users: [] };
    const data = await res.json();
    return {
      tweets: data.data || [],
      users: data.includes?.users || [],
    };
  } catch {
    return { tweets: [], users: [] };
  }
}

function classifyReply(text) {
  const lower = text.toLowerCase();
  if (lower.includes('?')) return 'question';
  if (lower.match(/\b(disagree|but|however|doubt|skeptic|really\?|prove)\b/)) return 'skepticism';
  return 'agreement';
}

function pickEngagementReply(replyType) {
  const templates = FOLLOW_UP_TEMPLATES[replyType] || THANK_REPLIES;
  const pool = [...templates, ...THANK_REPLIES];
  return pool[Math.floor(Math.random() * pool.length)];
}

function isBot(user) {
  if (!user) return true;
  const metrics = user.public_metrics || {};
  if ((metrics.followers_count || 0) < MIN_FOLLOWER_COUNT) return true;
  if (!user.profile_image_url || user.profile_image_url.includes('default_profile')) return true;
  return false;
}

export async function runEngagement(options = {}) {
  const dryRun = options.dryRun ?? DRY_RUN;
  const verbose = options.verbose ?? process.argv.includes('--verbose');

  let state = loadState();
  state = ensureDailyCounts(state);

  if (state.dailyCounts.engagement >= MAX_ENGAGEMENT_PER_DAY) {
    log(`Already sent ${MAX_ENGAGEMENT_PER_DAY} engagement replies today`, true);
    return { posted: 0, reason: 'daily limit' };
  }

  let creds;
  try {
    creds = await readCredentials();
  } catch (e) {
    log(`Credentials error: ${e.message}`, true);
    return { posted: 0, error: e.message };
  }

  const userId = await fetchMyUserId(creds);
  const myTweets = await fetchMyRecentTweets(creds, userId);

  if (myTweets.length === 0) {
    log('No recent tweets found', verbose);
    return { posted: 0, reason: 'no tweets' };
  }

  const alreadyRepliedTo = new Set(state.engagementReplies.map(r => r.inReplyTo));
  let posted = 0;

  for (const tweet of myTweets) {
    if (posted + state.dailyCounts.engagement >= MAX_ENGAGEMENT_PER_DAY) break;

    const replyCount = tweet.public_metrics?.reply_count || 0;
    if (replyCount === 0) continue;

    log(`Checking replies to tweet ${tweet.id} (${replyCount} replies)`, verbose);

    const { tweets: replies, users } = await fetchReplies(creds, tweet.conversation_id || tweet.id);
    const userMap = new Map(users.map(u => [u.id, u]));

    for (const reply of replies) {
      if (posted + state.dailyCounts.engagement >= MAX_ENGAGEMENT_PER_DAY) break;
      if (reply.author_id === userId) continue; // Skip our own replies
      if (alreadyRepliedTo.has(reply.id)) continue;

      // Check if it's a bot/spam
      const author = userMap.get(reply.author_id);
      if (isBot(author)) {
        log(`Skipping bot/spam reply ${reply.id}`, verbose);
        continue;
      }

      // Rate limit
      if (!canActNow(state.engagementReplies, MIN_MINUTES_BETWEEN)) {
        log('Rate limit: waiting between engagement replies', verbose);
        break;
      }

      const replyType = classifyReply(reply.text || '');
      const responseText = pickEngagementReply(replyType);

      if (!fitsInTweet(responseText)) continue;

      log(`Engage → reply to ${reply.id} (${replyType}): "${responseText.slice(0, 60)}..."`, true);

      if (!dryRun) {
        try {
          const result = await postTweet(responseText, { replyTo: reply.id });
          state.engagementReplies.push({
            id: result.id,
            inReplyTo: reply.id,
            at: new Date().toISOString(),
            type: replyType,
          });
          state.dailyCounts.engagement++;
          alreadyRepliedTo.add(reply.id);
          posted++;
          log(`✅ Posted engagement reply ${result.id}`, true);
          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          if (e.message.includes('429')) {
            log('⚠️ Rate limited. Stopping engagement.', true);
            break;
          }
          log(`❌ Failed: ${e.message}`, true);
        }
      } else {
        log(`[DRY RUN] Would reply to ${reply.id}: "${responseText}"`, true);
        state.engagementReplies.push({
          id: `dry-${Date.now()}`,
          inReplyTo: reply.id,
          at: new Date().toISOString(),
          type: replyType,
        });
        state.dailyCounts.engagement++;
        posted++;
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }

  state.lastRun = new Date().toISOString();
  saveState(state);
  return { posted };
}

if (process.argv[1]?.endsWith('engage.mjs')) {
  runEngagement().then(r => {
    console.log(JSON.stringify(r, null, 2));
  }).catch(e => {
    console.error(`Fatal: ${e.message}`);
    process.exit(1);
  });
}
