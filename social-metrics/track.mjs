#!/usr/bin/env node
/**
 * Social Metrics Tracker
 *
 * Tracks X follower count, engagement rate, top posts.
 * Saves weekly snapshots to social-strategy/metrics/.
 *
 * Usage:
 *   node track.mjs [--verbose]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { oauthHeader } from '../x-poster/lib/oauth.mjs';
import { readCredentials } from '../x-poster/lib/token.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || '/home/moltbot';
const METRICS_DIR = resolve(HOME, 'clawd/social-strategy/metrics');
const LATEST_FILE = join(METRICS_DIR, 'latest.json');

const VERBOSE = process.argv.includes('--verbose');

async function fetchMyProfile(creds) {
  const url = 'https://api.twitter.com/2/users/me';
  const params = { 'user.fields': 'public_metrics,created_at,description' };

  const fullUrl = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    fullUrl.searchParams.set(k, v);
  }

  const auth = oauthHeader('GET', url, params, creds);

  const res = await fetch(fullUrl.toString(), {
    headers: { Authorization: auth },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch profile (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.data;
}

async function fetchRecentTweets(creds, userId) {
  const url = `https://api.twitter.com/2/users/${userId}/tweets`;
  const params = {
    max_results: '20',
    'tweet.fields': 'created_at,public_metrics',
    exclude: 'retweets,replies',
  };

  const fullUrl = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    fullUrl.searchParams.set(k, v);
  }

  const auth = oauthHeader('GET', url, params, creds);

  const res = await fetch(fullUrl.toString(), {
    headers: { Authorization: auth },
  });

  if (!res.ok) {
    if (VERBOSE) console.error(`Failed to fetch tweets: ${res.status}`);
    return [];
  }

  const data = await res.json();
  return data.data || [];
}

function calculateEngagement(tweets, followerCount) {
  if (!tweets.length || !followerCount) return { rate: 0, avgLikes: 0, avgRetweets: 0, avgReplies: 0 };

  let totalLikes = 0, totalRetweets = 0, totalReplies = 0;

  for (const tweet of tweets) {
    const m = tweet.public_metrics || {};
    totalLikes += m.like_count || 0;
    totalRetweets += m.retweet_count || 0;
    totalReplies += m.reply_count || 0;
  }

  const totalEngagement = totalLikes + totalRetweets + totalReplies;
  const rate = ((totalEngagement / tweets.length) / followerCount) * 100;

  return {
    rate: Math.round(rate * 100) / 100,
    avgLikes: Math.round(totalLikes / tweets.length),
    avgRetweets: Math.round(totalRetweets / tweets.length),
    avgReplies: Math.round(totalReplies / tweets.length),
    totalEngagement,
    tweetsAnalyzed: tweets.length,
  };
}

function getTopPosts(tweets, count = 5) {
  return tweets
    .map(t => ({
      id: t.id,
      text: t.text?.slice(0, 120),
      url: `https://x.com/i/status/${t.id}`,
      metrics: t.public_metrics,
      score: (t.public_metrics?.like_count || 0) +
             (t.public_metrics?.retweet_count || 0) * 2 +
             (t.public_metrics?.reply_count || 0),
      createdAt: t.created_at,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}

async function main() {
  let creds;
  try {
    creds = await readCredentials();
  } catch (e) {
    console.error(`X credentials not configured: ${e.message}`);
    process.exit(1);
  }

  if (VERBOSE) console.error('Fetching profile...');
  const profile = await fetchMyProfile(creds);
  const metrics = profile.public_metrics || {};

  if (VERBOSE) console.error('Fetching recent tweets...');
  const tweets = await fetchRecentTweets(creds, profile.id);

  const engagement = calculateEngagement(tweets, metrics.followers_count);
  const topPosts = getTopPosts(tweets);

  const snapshot = {
    timestamp: new Date().toISOString(),
    profile: {
      id: profile.id,
      username: profile.username,
      name: profile.name,
    },
    followers: metrics.followers_count,
    following: metrics.following_count,
    tweetCount: metrics.tweet_count,
    engagement,
    topPosts,
  };

  // Save to metrics dir
  if (!existsSync(METRICS_DIR)) mkdirSync(METRICS_DIR, { recursive: true });

  // Weekly snapshot
  const weekKey = getWeekKey();
  const weekFile = join(METRICS_DIR, `week-${weekKey}.json`);
  writeFileSync(weekFile, JSON.stringify(snapshot, null, 2));

  // Latest
  writeFileSync(LATEST_FILE, JSON.stringify(snapshot, null, 2));

  // Load history for trend
  const prevLatest = loadPrevious();
  if (prevLatest) {
    snapshot.trends = {
      followerChange: metrics.followers_count - (prevLatest.followers || 0),
      engagementChange: engagement.rate - (prevLatest.engagement?.rate || 0),
      previousSnapshot: prevLatest.timestamp,
    };
  }

  // Re-save with trends
  writeFileSync(LATEST_FILE, JSON.stringify(snapshot, null, 2));

  console.log(JSON.stringify(snapshot, null, 2));
}

function getWeekKey() {
  const d = new Date();
  const year = d.getFullYear();
  const oneJan = new Date(year, 0, 1);
  const week = Math.ceil(((d - oneJan) / 86400000 + oneJan.getDay() + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function loadPrevious() {
  if (!existsSync(LATEST_FILE)) return null;
  try { return JSON.parse(readFileSync(LATEST_FILE, 'utf-8')); }
  catch { return null; }
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
