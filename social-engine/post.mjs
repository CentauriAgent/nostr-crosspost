#!/usr/bin/env node
/**
 * Content Poster
 *
 * Posts original content from the content calendar. Reads CONTENT-CALENDAR.md,
 * determines current week, picks agent-draftable posts, and posts them.
 *
 * Usage:
 *   node social-engine/post.mjs [--dry-run] [--verbose]
 */

import { readFileSync, existsSync } from 'fs';
import { postTweet } from '../x-poster/lib/x.mjs';
import {
  loadState, saveState, ensureDailyCounts, canActNow,
  fitsInTweet, xCharCount, CALENDAR_FILE, log,
} from './utils.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_CONTENT_PER_DAY = 4;
const MIN_HOURS_BETWEEN = 2;

// ─── Content Bank (evergreen posts — use when calendar is exhausted) ─
const CONTENT_BANK = [
  "Bitcoin fixes money. Nostr fixes communication. Together they fix the internet.",
  "Self-custody isn't just for your sats. It's for your identity, your social graph, and your content.",
  "The best protocol is the one no company controls.",
  "If your social media account can be deleted by someone you've never met, you don't have a social media account. You have a permission slip.",
  "Zaps > likes. Sats > hearts. Value > vanity.",
  "I don't build on platforms. I build on protocols. Platforms come and go. Protocols persist.",
  "The gap between 'interested in AI' and 'building with AI' is doing the work. Start shipping.",
  "An AI agent with a Nostr keypair and a Lightning wallet needs nothing from any corporation. Think about that.",
  "Freedom tech isn't a niche. It's the future pretending to be a niche.",
  "The orange pill is monetary sovereignty. The purple pill is communication sovereignty. Take both.",
];

/**
 * Parse the content calendar and extract agent-postable singles for the current week.
 */
function parseCalendar() {
  if (!existsSync(CALENDAR_FILE)) {
    log('No content calendar found', true);
    return [];
  }

  const content = readFileSync(CALENDAR_FILE, 'utf-8');
  const posts = [];

  // Determine which week we're in (1-4 based on some reference)
  // For now, extract ALL [AGENT] [SINGLE] posts
  const lines = content.split('\n');
  let currentWeek = '';
  let currentDay = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track week
    const weekMatch = line.match(/^## WEEK (\d+)/);
    if (weekMatch) { currentWeek = `week${weekMatch[1]}`; continue; }

    // Track day
    const dayMatch = line.match(/^### (\w+)/);
    if (dayMatch) { currentDay = dayMatch[1].toLowerCase(); continue; }

    // Find agent-postable singles (not DEREK, not THREAD)
    if (line.includes('[AGENT]') && line.includes('[SINGLE]') && !line.includes('[DEREK]')) {
      // Extract the quoted text
      const textMatch = line.match(/"([^"]+)"/);
      if (textMatch) {
        const text = textMatch[1];
        const ref = `${currentWeek}-${currentDay}-post${posts.length + 1}`;
        if (fitsInTweet(text)) {
          posts.push({ text, ref, week: currentWeek, day: currentDay });
        }
      }
    }

    // Also extract [AGENT] [QRT] posts that have standalone text
    if (line.includes('[AGENT]') && line.includes('[QRT]') && !line.includes('[DEREK]')) {
      const textMatch = line.match(/"([^"]+)"/);
      if (textMatch) {
        const text = textMatch[1];
        const ref = `${currentWeek}-${currentDay}-qrt${posts.length + 1}`;
        if (fitsInTweet(text)) {
          posts.push({ text, ref, week: currentWeek, day: currentDay });
        }
      }
    }
  }

  return posts;
}

export async function runContentPoster(options = {}) {
  const dryRun = options.dryRun ?? DRY_RUN;
  const verbose = options.verbose ?? process.argv.includes('--verbose');

  let state = loadState();
  state = ensureDailyCounts(state);

  if (state.dailyCounts.content >= MAX_CONTENT_PER_DAY) {
    log(`Already posted ${MAX_CONTENT_PER_DAY} content items today`, true);
    return { posted: 0, reason: 'daily limit reached' };
  }

  // Check time spacing (2 hours between content posts)
  if (!canActNow(state.contentPosted, MIN_HOURS_BETWEEN * 60)) {
    log('Too soon since last content post (need 2h gap)', true);
    return { posted: 0, reason: 'spacing limit' };
  }

  // Get calendar posts
  const calendarPosts = parseCalendar();
  const alreadyPosted = new Set(state.contentPosted.map(p => p.calendarRef));
  const alreadyPostedTexts = new Set(state.contentPosted.map(p => p.content));

  // Find unposted calendar content
  let candidates = calendarPosts.filter(p =>
    !alreadyPosted.has(p.ref) && !alreadyPostedTexts.has(p.text)
  );

  // If no calendar content left, use content bank
  if (candidates.length === 0) {
    log('Calendar exhausted, using content bank', verbose);
    candidates = CONTENT_BANK
      .filter(t => !alreadyPostedTexts.has(t))
      .map(t => ({ text: t, ref: `bank-${Date.now()}`, week: 'evergreen', day: 'any' }));
  }

  if (candidates.length === 0) {
    log('No content available to post', true);
    return { posted: 0, reason: 'no content available' };
  }

  // Pick one post (sequential from calendar, random from bank)
  const pick = candidates[0];

  log(`Content: "${pick.text.slice(0, 80)}..." (${xCharCount(pick.text)} chars) [${pick.ref}]`, true);

  let posted = 0;
  if (!dryRun) {
    try {
      const result = await postTweet(pick.text);
      state.contentPosted.push({
        id: result.id,
        content: pick.text,
        at: new Date().toISOString(),
        calendarRef: pick.ref,
      });
      state.dailyCounts.content++;
      posted = 1;
      log(`✅ Posted content ${result.id}`, true);
    } catch (e) {
      if (e.message.includes('429')) {
        log('⚠️ Rate limited by X API', true);
      } else {
        log(`❌ Failed to post: ${e.message}`, true);
      }
    }
  } else {
    log(`[DRY RUN] Would post: "${pick.text}" [${pick.ref}]`, true);
    state.contentPosted.push({
      id: `dry-${Date.now()}`,
      content: pick.text,
      at: new Date().toISOString(),
      calendarRef: pick.ref,
    });
    state.dailyCounts.content++;
    posted = 1;
  }

  state.lastRun = new Date().toISOString();
  saveState(state);
  return { posted };
}

if (process.argv[1]?.endsWith('post.mjs')) {
  runContentPoster().then(r => {
    console.log(JSON.stringify(r, null, 2));
  }).catch(e => {
    console.error(`Fatal: ${e.message}`);
    process.exit(1);
  });
}
