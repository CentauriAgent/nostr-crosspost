#!/usr/bin/env node
/**
 * Reply Scanner — finds reply opportunities on X for Derek
 *
 * Scans target accounts for tweets about Bitcoin, Nostr, freedom tech, AI.
 * Generates suggested reply opportunities saved to social-strategy/reply-opportunities.json.
 *
 * Usage:
 *   node scan.mjs [--verbose] [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { oauthHeader } from '../x-poster/lib/oauth.mjs';
import { readCredentials } from '../x-poster/lib/token.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || '/home/moltbot';
const TARGETS_FILE = resolve(HOME, 'clawd/social-strategy/REPLY-TARGETS.md');
const OPPORTUNITIES_FILE = resolve(HOME, 'clawd/social-strategy/reply-opportunities.json');
const STATE_FILE = resolve(HOME, 'clawd/social-strategy/scanner-state.json');

const VERBOSE = process.argv.includes('--verbose');
const DRY_RUN = process.argv.includes('--dry-run');

// Topics Derek engages with
const TOPIC_PATTERNS = [
  { topic: 'Bitcoin', patterns: [/\bbitcoin\b/i, /\bbtc\b/i, /\bsatoshi\b/i, /\blightning\b/i, /\bsats\b/i] },
  { topic: 'Nostr', patterns: [/\bnostr\b/i, /\bnip-?\d/i, /\brelay\b/i, /\bzap\b/i] },
  { topic: 'Freedom Tech', patterns: [/\bcensorship/i, /\bfreedom\b/i, /\bprivacy\b/i, /\bsovereignty/i, /\bself.?custod/i, /\bdecentraliz/i] },
  { topic: 'AI', patterns: [/\bai\b/i, /\bartificial intelligence\b/i, /\bllm\b/i, /\bmachine learning\b/i, /\bagent\b/i] },
  { topic: 'Open Source', patterns: [/\bopen.?source\b/i, /\bfoss\b/i, /\bgithub\b/i] },
];

function parseTargets() {
  if (!existsSync(TARGETS_FILE)) {
    console.error(`No targets file found at ${TARGETS_FILE}`);
    return [];
  }

  const content = readFileSync(TARGETS_FILE, 'utf-8');
  const handles = [];

  for (const line of content.split('\n')) {
    const match = line.match(/@(\w+)/);
    if (match) handles.push(match[1]);
  }

  return [...new Set(handles)];
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { lastScan: 0, seenTweets: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); }
  catch { return { lastScan: 0, seenTweets: {} }; }
}

function saveState(state) {
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadOpportunities() {
  if (!existsSync(OPPORTUNITIES_FILE)) return { opportunities: [], lastUpdated: null };
  try { return JSON.parse(readFileSync(OPPORTUNITIES_FILE, 'utf-8')); }
  catch { return { opportunities: [], lastUpdated: null }; }
}

function saveOpportunities(data) {
  const dir = dirname(OPPORTUNITIES_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(OPPORTUNITIES_FILE, JSON.stringify(data, null, 2));
}

function classifyTweet(text) {
  const matches = [];
  for (const { topic, patterns } of TOPIC_PATTERNS) {
    if (patterns.some(p => p.test(text))) {
      matches.push(topic);
    }
  }
  return matches;
}

function generateReplySuggestion(tweet, topics) {
  // Generate contextual reply hints (not full text — Derek/agent will craft the actual reply)
  const hints = [];

  if (topics.includes('Nostr')) {
    hints.push('Share Nostr perspective or community insight');
  }
  if (topics.includes('Bitcoin')) {
    hints.push('Connect to freedom tech / self-custody angle');
  }
  if (topics.includes('AI')) {
    hints.push('Mention sovereign AI agents / OpenClaw angle');
  }
  if (topics.includes('Freedom Tech')) {
    hints.push('Relate to Nostr as censorship-resistant infrastructure');
  }
  if (topics.includes('Open Source')) {
    hints.push('Connect to Nostr open protocol ecosystem');
  }

  return hints.join('; ') || 'Engage with relevant perspective';
}

async function fetchUserTweets(username, creds, sinceId) {
  // Use X API v2 search (recent) to find tweets from user
  const query = `from:${username}`;
  const params = {
    query,
    max_results: '10',
    'tweet.fields': 'created_at,public_metrics,conversation_id',
  };
  if (sinceId) params.since_id = sinceId;

  const url = new URL('https://api.twitter.com/2/tweets/search/recent');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const auth = oauthHeader('GET', 'https://api.twitter.com/2/tweets/search/recent', params, creds);

  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: auth },
    });

    if (res.status === 429) {
      if (VERBOSE) console.error(`Rate limited fetching @${username}`);
      return [];
    }

    if (!res.ok) {
      if (VERBOSE) console.error(`Failed to fetch @${username}: ${res.status}`);
      return [];
    }

    const data = await res.json();
    return data.data || [];
  } catch (e) {
    if (VERBOSE) console.error(`Error fetching @${username}: ${e.message}`);
    return [];
  }
}

async function main() {
  const handles = parseTargets();
  if (handles.length === 0) {
    console.log('No target handles found');
    return;
  }

  if (VERBOSE) console.error(`Scanning ${handles.length} target accounts...`);

  let creds;
  try {
    creds = await readCredentials();
  } catch (e) {
    console.error(`X credentials not configured: ${e.message}`);
    process.exit(1);
  }

  const state = loadState();
  const existingOpps = loadOpportunities();
  const newOpportunities = [];

  for (const handle of handles) {
    if (VERBOSE) console.error(`  Scanning @${handle}...`);

    const lastSeenId = state.seenTweets[handle];
    const tweets = await fetchUserTweets(handle, creds, lastSeenId);

    // Track highest tweet ID
    let maxId = lastSeenId;

    for (const tweet of tweets) {
      if (state.seenTweets[handle] && tweet.id <= state.seenTweets[handle]) continue;

      if (!maxId || tweet.id > maxId) maxId = tweet.id;

      const topics = classifyTweet(tweet.text);
      if (topics.length === 0) continue;

      const metrics = tweet.public_metrics || {};
      // Prioritize tweets with engagement (more visibility for reply)
      const engagementScore = (metrics.like_count || 0) + (metrics.retweet_count || 0) * 2 + (metrics.reply_count || 0);

      newOpportunities.push({
        id: tweet.id,
        author: handle,
        text: tweet.text,
        topics,
        engagementScore,
        suggestion: generateReplySuggestion(tweet, topics),
        url: `https://x.com/${handle}/status/${tweet.id}`,
        createdAt: tweet.created_at,
        scannedAt: new Date().toISOString(),
        actedOn: false,
      });
    }

    if (maxId) state.seenTweets[handle] = maxId;

    // Small delay between requests to be nice to the API
    await new Promise(r => setTimeout(r, 500));
  }

  // Sort by engagement score (highest first)
  newOpportunities.sort((a, b) => b.engagementScore - a.engagementScore);

  // Merge with existing (keep last 50 total, preserve actedOn status)
  const actedOnIds = new Set(
    existingOpps.opportunities?.filter(o => o.actedOn).map(o => o.id) || []
  );

  const merged = [
    ...newOpportunities,
    ...(existingOpps.opportunities || []).filter(o => !newOpportunities.find(n => n.id === o.id)),
  ].slice(0, 50);

  // Preserve actedOn status
  for (const opp of merged) {
    if (actedOnIds.has(opp.id)) opp.actedOn = true;
  }

  state.lastScan = Date.now();
  saveState(state);

  const output = {
    lastUpdated: new Date().toISOString(),
    newCount: newOpportunities.length,
    totalCount: merged.length,
    opportunities: merged,
  };

  saveOpportunities(output);

  console.log(JSON.stringify({
    scanned: handles.length,
    newOpportunities: newOpportunities.length,
    total: merged.length,
    topOpportunities: newOpportunities.slice(0, 5).map(o => ({
      author: o.author,
      topics: o.topics,
      text: o.text.slice(0, 100),
      url: o.url,
    })),
  }, null, 2));
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
