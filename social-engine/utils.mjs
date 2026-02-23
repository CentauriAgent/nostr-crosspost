/**
 * Shared utilities for the social engine
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const STATE_FILE = resolve(__dirname, 'state.json');
export const HOME = process.env.HOME || '/home/moltbot';
export const OPPORTUNITIES_FILE = resolve(HOME, 'clawd/social-strategy/reply-opportunities.json');
export const CALENDAR_FILE = resolve(HOME, 'clawd/social-strategy/CONTENT-CALENDAR.md');

/**
 * Calculate the X character count for text, accounting for t.co URL wrapping.
 * X replaces any URL (containing .com, .org, .net, etc.) with a 23-char t.co link.
 */
export function xCharCount(text) {
  // Match URLs that X would wrap as t.co
  const urlRegex = /https?:\/\/[^\s]+/g;
  let count = text.length;
  const urls = text.match(urlRegex) || [];
  for (const url of urls) {
    // X replaces each URL with a 23-char t.co link
    count = count - url.length + 23;
  }
  return count;
}

/**
 * Ensure text fits within X's 280 character limit (accounting for t.co).
 */
export function fitsInTweet(text) {
  return xCharCount(text) <= 280;
}

export function loadState() {
  if (!existsSync(STATE_FILE)) {
    return {
      lastRun: null,
      repliesPosted: [],
      contentPosted: [],
      engagementReplies: [],
      dailyCounts: { date: null, replies: 0, content: 0, engagement: 0 },
    };
  }
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); }
  catch { return { lastRun: null, repliesPosted: [], contentPosted: [], engagementReplies: [], dailyCounts: { date: null, replies: 0, content: 0, engagement: 0 } }; }
}

export function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Reset daily counts if the date has changed.
 */
export function ensureDailyCounts(state) {
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyCounts.date !== today) {
    state.dailyCounts = { date: today, replies: 0, content: 0, engagement: 0 };
  }
  return state;
}

/**
 * Check if enough time has passed since the last action of a given type.
 * @param {Array} actions - Array of { at: ISO string } entries
 * @param {number} minMinutes - Minimum minutes between actions
 */
export function canActNow(actions, minMinutes) {
  if (!actions || actions.length === 0) return true;
  const last = actions.reduce((latest, a) => {
    const t = new Date(a.at).getTime();
    return t > latest ? t : latest;
  }, 0);
  return (Date.now() - last) >= minMinutes * 60 * 1000;
}

export function log(msg, verbose = false) {
  if (verbose || process.argv.includes('--verbose')) {
    console.error(`[${new Date().toISOString()}] ${msg}`);
  }
}
