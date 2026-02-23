#!/usr/bin/env node
/**
 * Social Engine Orchestrator
 *
 * Single entry point that runs all social engine components in sequence.
 *
 * Usage:
 *   node social-engine/run.mjs [--dry-run] [--verbose]
 */

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runReplies } from './reply.mjs';
import { runContentPoster } from './post.mjs';
import { runEngagement } from './engage.mjs';
import { loadState, saveState, log } from './utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

async function runExternal(label, script, args = []) {
  log(`── ${label} ──`, true);
  try {
    const fullArgs = [...args];
    if (DRY_RUN) fullArgs.push('--dry-run');
    if (VERBOSE) fullArgs.push('--verbose');

    const output = execFileSync('node', [script, ...fullArgs], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (output.trim()) {
      try { return JSON.parse(output.trim()); }
      catch { log(output.trim(), VERBOSE); return { raw: output.trim() }; }
    }
    return {};
  } catch (e) {
    log(`⚠️ ${label} failed: ${e.message}`, true);
    return { error: e.message };
  }
}

async function main() {
  const startTime = Date.now();
  log('🚀 Social Engine starting...', true);
  if (DRY_RUN) log('🏜️  DRY RUN MODE — no posts will be made', true);

  const summary = {};

  // 1. Scan for new opportunities
  summary.scan = await runExternal('Reply Scanner', 'social-scanner/scan.mjs');

  // 2. Auto-reply to opportunities
  log('── Auto-Replier ──', true);
  summary.replies = await runReplies({ dryRun: DRY_RUN, verbose: VERBOSE });

  // 3. Post content from calendar
  log('── Content Poster ──', true);
  summary.content = await runContentPoster({ dryRun: DRY_RUN, verbose: VERBOSE });

  // 4. Engagement monitor
  log('── Engagement Monitor ──', true);
  summary.engagement = await runEngagement({ dryRun: DRY_RUN, verbose: VERBOSE });

  // 5. Metrics tracker
  summary.metrics = await runExternal('Metrics Tracker', 'social-metrics/track.mjs');

  // 6. Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const state = loadState();

  const report = {
    timestamp: new Date().toISOString(),
    dryRun: DRY_RUN,
    elapsed: `${elapsed}s`,
    results: {
      scannerOpportunities: summary.scan?.newOpportunities ?? summary.scan?.error ?? 'n/a',
      repliesPosted: summary.replies?.posted ?? 0,
      contentPosted: summary.content?.posted ?? 0,
      engagementReplies: summary.engagement?.posted ?? 0,
    },
    dailyTotals: state.dailyCounts,
  };

  log('', true);
  log('═══════════════════════════════════════', true);
  log('📊 Social Engine Run Complete', true);
  log(`⏱️  ${elapsed}s | ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`, true);
  log(`📨 Replies: ${report.results.repliesPosted} | 📝 Content: ${report.results.contentPosted} | 🤝 Engagement: ${report.results.engagementReplies}`, true);
  log('═══════════════════════════════════════', true);

  console.log(JSON.stringify(report, null, 2));
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
