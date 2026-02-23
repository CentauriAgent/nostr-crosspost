#!/usr/bin/env node
/**
 * Auto-Reply Engine
 *
 * Reads reply-opportunities.json, generates Derek-voice replies using
 * template-based logic, and posts them via X API.
 *
 * Usage:
 *   node social-engine/reply.mjs [--dry-run] [--verbose]
 */

import { readFileSync, existsSync } from 'fs';
import { postTweet } from '../x-poster/lib/x.mjs';
import {
  loadState, saveState, ensureDailyCounts, canActNow,
  fitsInTweet, OPPORTUNITIES_FILE, log,
} from './utils.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_REPLIES_PER_DAY = 5;
const MIN_MINUTES_BETWEEN = 30;

// ─── Topic Templates ────────────────────────────────────────────────
// Variables: {author} = @handle of tweet author
// Each template must be < 280 chars with no URLs

const TEMPLATES = {
  Bitcoin: [
    "This is why self-custody matters. If you're not holding your keys, you're trusting the same system Bitcoin was built to replace.",
    "Bitcoin doesn't need permission, defenders, or marketing departments. It just needs blocks. 850,000+ and counting.",
    "The hardest money ever created doesn't care about your timeline. Stack sats. Run a node. Everything else is noise.",
    "Sound money + sovereign communication = the full stack. Bitcoin fixes the money. Nostr fixes the signal.",
    "Every cycle, the same institutions that laughed at Bitcoin come crawling back. The protocol doesn't hold grudges — it just keeps producing blocks.",
    "Self-custody isn't paranoia. It's the rational response to a system that's proven it will freeze your assets when convenient.",
    "Bitcoin mining monetizes stranded energy and strengthens grids. The energy FUD is dead. The builders won.",
    "The orange pill is realizing no one should control your money. The next step is realizing no one should control your speech either.",
  ],
  Nostr: [
    "Been building on Nostr for 3 years. The protocol is solid — what we need now is more developers shipping clients.",
    "Your keypair is your identity. No email. No phone number. No company. That's not a bug — that's the entire point.",
    "Nostr doesn't need your permission. That's the point. Post from any client. Your followers are portable. Your identity is yours.",
    "I run my own relay. My posts live on my hardware. Even if every other relay went down, my content survives. Try that with your tweet archive.",
    "People ask 'which Nostr app?' That's like asking 'which email app.' Dozens of clients, one identity. Switch anytime. That's freedom.",
    "NIP-57 zaps turned social media into a value-for-value economy. Every like can carry sats. Creators don't need brand deals.",
    "Nostr isn't competing with X. It's making X optional. Big difference.",
  ],
  AI: [
    "This is exactly why AI agents need open protocols. Nostr gives them identity, Bitcoin lets them transact. No API key gatekeepers.",
    "An API key is a permission slip. A Nostr keypair is sovereign identity. One can be revoked. The other can't. This matters more than people realize.",
    "AI agents need three things: freedom to communicate, freedom of identity, freedom to pay. Nostr + Bitcoin delivers all three. No corporate stack does.",
    "The AI companies building 'agent frameworks' are building prettier cages. Agents don't need frameworks. They need protocols.",
    "We're building AI that's smart enough to do everything but sovereign enough for nothing. An agent with a Nostr keypair and Lightning wallet needs zero corporate permission.",
    "The future of AI isn't corporate APIs with rate limits. It's sovereign agents on open protocols, paying each other in Bitcoin. We're building this now.",
    "Cryptographic identity solves the AI trust problem. Not more regulation. Not more gatekeeping. Keypairs and open protocols.",
  ],
  'Freedom Tech': [
    "Sovereignty isn't just about money. It's communication, identity, data. Bitcoin + Nostr is the full stack.",
    "If your social media account can be deleted by someone you've never met, you don't have a social media account. You have a permission slip.",
    "Freedom tech isn't a niche. It's the future pretending to be a niche.",
    "The best protocol is the one no company controls. Not the one with the best marketing. The one no one can shut down.",
    "Decentralization isn't a feature you add later. It's a design choice you make on day one or never.",
    "Encryption, self-custody, open protocols — these aren't political positions. They're engineering decisions that protect human agency.",
  ],
  'Open Source': [
    "Open source wins because contributors build what they need, not what a PM greenlit. Nostr is proof.",
    "The best software is built by people who use it. Open protocols attract builders. Closed platforms attract rent-seekers.",
    "Demo > deck. Show me the thing running. I don't care about your roadmap.",
    "Ship culture: small team, clear vision, AI-assisted dev, deployed in production. That's the playbook.",
  ],
  'AI Agents': [
    "This is exactly why AI agents need open protocols. Nostr gives them identity, Bitcoin lets them transact. No API key gatekeepers.",
    "AI agents on open protocols will outperform every corporate-caged agent. Speed, cost, and capability — permissionless wins.",
    "The first AI agent that earns its own Bitcoin, chooses its own relays, and operates without a single corporate API key — that's the milestone. We're close.",
  ],
};

// ─── Known high-value accounts (HIGH tier) ──────────────────────────
const HIGH_TIER_ACCOUNTS = new Set([
  'BitcoinMagazine', 'DocumentingBTC', 'nvk', 'fiatjaf', 'jb55',
  'jack', 'odell', 'sabornostr', 'ODELL', 'lopp', 'giacomozucco',
  'excellion', 'francispouliot_', 'daborogozi',
]);

const MEDIUM_TIER_ACCOUNTS = new Set([
  'AnthropicAI', 'OpenAI', 'huggingface', 'balajis', 'naval',
  'elikimantra', 'GoogleDeepMind', 'ylecun',
]);

function getTier(author, topics) {
  const highTopics = ['Bitcoin', 'Nostr', 'Freedom Tech'];
  if (HIGH_TIER_ACCOUNTS.has(author) && topics.some(t => highTopics.includes(t))) return 'HIGH';
  if (MEDIUM_TIER_ACCOUNTS.has(author) || topics.includes('AI')) return 'MEDIUM';
  if (HIGH_TIER_ACCOUNTS.has(author)) return 'MEDIUM';
  return 'LOW';
}

function pickTemplate(topics, usedTemplates) {
  // Try topics in priority order
  const priority = ['Nostr', 'Bitcoin', 'Freedom Tech', 'AI', 'AI Agents', 'Open Source'];
  for (const topic of priority) {
    if (!topics.includes(topic)) continue;
    const templates = TEMPLATES[topic] || [];
    // Filter out recently used
    const available = templates.filter(t => !usedTemplates.has(t));
    if (available.length > 0) {
      const pick = available[Math.floor(Math.random() * available.length)];
      return { text: pick, topic };
    }
    // If all used, pick random anyway
    if (templates.length > 0) {
      return { text: templates[Math.floor(Math.random() * templates.length)], topic };
    }
  }
  return null;
}

export async function runReplies(options = {}) {
  const dryRun = options.dryRun ?? DRY_RUN;
  const verbose = options.verbose ?? process.argv.includes('--verbose');

  if (!existsSync(OPPORTUNITIES_FILE)) {
    log('No opportunities file found. Run scanner first.', true);
    return { posted: 0, skipped: 0 };
  }

  const opps = JSON.parse(readFileSync(OPPORTUNITIES_FILE, 'utf-8'));
  let state = loadState();
  state = ensureDailyCounts(state);

  const today = state.dailyCounts.date;
  const todayReplies = state.repliesPosted.filter(r => r.at?.startsWith(today));
  const repliedAccounts24h = new Set(
    state.repliesPosted
      .filter(r => Date.now() - new Date(r.at).getTime() < 24 * 60 * 60 * 1000)
      .map(r => r.target)
  );

  // Track used templates to avoid repetition
  const recentTemplates = new Set(
    state.repliesPosted.slice(-20).map(r => r.text).filter(Boolean)
  );

  let posted = 0;
  let skipped = 0;

  for (const opp of opps.opportunities || []) {
    if (posted >= MAX_REPLIES_PER_DAY - todayReplies.length) break;
    if (state.dailyCounts.replies >= MAX_REPLIES_PER_DAY) break;

    // Skip already acted on
    if (opp.actedOn) { skipped++; continue; }

    // Determine topics — handle both formats in the JSON
    const topics = opp.topics || (opp.topic ? [opp.topic] : []);
    if (topics.length === 0) { skipped++; continue; }

    // Check tier
    const tier = getTier(opp.author, topics);
    if (tier === 'LOW') { skipped++; continue; }

    // Don't reply to same account twice in 24h
    if (repliedAccounts24h.has(`@${opp.author}`)) {
      log(`Skipping @${opp.author} — already replied in 24h`, verbose);
      skipped++;
      continue;
    }

    // Rate limit: min 30 min between replies
    if (!canActNow(state.repliesPosted, MIN_MINUTES_BETWEEN)) {
      log('Rate limit: waiting 30 min between replies', verbose);
      break;
    }

    // Pick template
    const picked = pickTemplate(topics, recentTemplates);
    if (!picked) { skipped++; continue; }

    // Verify length
    if (!fitsInTweet(picked.text)) {
      log(`Template too long (${picked.text.length} chars), skipping`, verbose);
      skipped++;
      continue;
    }

    log(`${tier} | @${opp.author} [${topics.join(',')}] → "${picked.text.slice(0, 80)}..."`, true);

    if (!dryRun) {
      try {
        const result = await postTweet(picked.text, { replyTo: opp.id });
        state.repliesPosted.push({
          id: result.id,
          target: `@${opp.author}`,
          at: new Date().toISOString(),
          topic: picked.topic,
          text: picked.text,
          tier,
          inReplyTo: opp.id,
        });
        state.dailyCounts.replies++;
        opp.actedOn = true;
        recentTemplates.add(picked.text);
        repliedAccounts24h.add(`@${opp.author}`);
        posted++;
        log(`✅ Posted reply ${result.id}`, true);

        // Wait a bit between posts
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        if (e.message.includes('429')) {
          log('⚠️ Rate limited by X API. Stopping replies.', true);
          break;
        }
        log(`❌ Failed to post reply: ${e.message}`, true);
      }
    } else {
      log(`[DRY RUN] Would reply to @${opp.author} (${opp.id}): "${picked.text}"`, true);
      posted++;
      opp.actedOn = true;
      state.dailyCounts.replies++;
    }
  }

  // Save updated opportunities (actedOn flags)
  const oppsData = JSON.parse(readFileSync(OPPORTUNITIES_FILE, 'utf-8'));
  const actedIds = new Set((opps.opportunities || []).filter(o => o.actedOn).map(o => o.id));
  for (const o of oppsData.opportunities || []) {
    if (actedIds.has(o.id)) o.actedOn = true;
  }
  const { writeFileSync } = await import('fs');
  writeFileSync(OPPORTUNITIES_FILE, JSON.stringify(oppsData, null, 2));

  state.lastRun = new Date().toISOString();
  saveState(state);

  return { posted, skipped };
}

// CLI entry point
if (process.argv[1]?.endsWith('reply.mjs')) {
  runReplies().then(r => {
    console.log(JSON.stringify(r, null, 2));
  }).catch(e => {
    console.error(`Fatal: ${e.message}`);
    process.exit(1);
  });
}
