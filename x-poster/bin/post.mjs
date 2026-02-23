#!/usr/bin/env node

/**
 * X/Twitter Cross-Poster
 *
 * Cross-posts Nostr notes to X/Twitter.
 * Reuses decoder and fetcher from the LinkedIn poster.
 *
 * Usage:
 *   node tools/x-poster/bin/post.mjs nevent1...
 *   node tools/x-poster/bin/post.mjs nevent1... --dry-run
 *   node tools/x-poster/bin/post.mjs nevent1... --no-link
 *   node tools/x-poster/bin/post.mjs --setup
 */

// Reuse Nostr decoder and fetcher from LinkedIn poster
import { decode } from '../../linkedin-poster/lib/decoder.mjs';
import { fetchEvent } from '../../linkedin-poster/lib/fetcher.mjs';
import { format } from '../lib/formatter.mjs';
import { postThread, uploadMedia } from '../lib/x.mjs';
import { readCredentials, writeCredentials } from '../lib/token.mjs';
import { createInterface } from 'node:readline';

const USAGE = `Usage: x-post <nostr-identifier> [options]

  nostr-identifier    nevent1... or naddr1... string

Options:
  --dry-run     Show what would be posted without publishing
  --no-link     Omit the Nostr footer/link
  --verbose     Show intermediate steps
  --setup       Interactive credential setup
  --help        Show this help message`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { dryRun: false, noLink: false, verbose: false, setup: false, help: false };
  let identifier = null;

  for (const arg of args) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--no-link') flags.noLink = true;
    else if (arg === '--verbose') flags.verbose = true;
    else if (arg === '--setup') flags.setup = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (!arg.startsWith('--')) identifier = arg;
    else {
      console.error(`Unknown option: ${arg}\n`);
      console.error(USAGE);
      process.exit(1);
    }
  }

  return { identifier, ...flags };
}

async function setupCredentials() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log('\n🐦 X/Twitter API Credential Setup\n');
  console.log('Go to https://developer.x.com → Your App → Keys and Tokens\n');

  const apiKey = await ask('API Key (Consumer Key): ');
  const apiSecret = await ask('API Secret (Consumer Secret): ');
  const accessToken = await ask('Access Token: ');
  const accessTokenSecret = await ask('Access Token Secret: ');

  rl.close();

  await writeCredentials({
    apiKey: apiKey.trim(),
    apiSecret: apiSecret.trim(),
    accessToken: accessToken.trim(),
    accessTokenSecret: accessTokenSecret.trim(),
  });

  console.log('\n✅ Credentials saved to ~/.x-poster/credentials.json');
}

async function main() {
  const { identifier, dryRun, noLink, verbose, setup, help } = parseArgs(process.argv);

  if (help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (setup) {
    await setupCredentials();
    return;
  }

  if (!identifier) {
    console.error('Error: Missing nostr identifier\n');
    console.error(USAGE);
    process.exit(1);
  }

  if (!identifier.startsWith('nevent1') && !identifier.startsWith('naddr1')) {
    console.error('Error: Identifier must start with nevent1 or naddr1');
    process.exit(1);
  }

  if (verbose) console.log(`Decoding ${identifier}...`);
  const decoded = await decode(identifier);

  if (verbose) console.log('Fetching event from relays...');
  const nostrEvent = await fetchEvent(decoded);

  if (nostrEvent.kind !== 1 && nostrEvent.kind !== 30023) {
    console.error(`Error: Unsupported event kind ${nostrEvent.kind}. Only kind 1 (note) and kind 30023 (long-form) are supported.`);
    process.exit(1);
  }

  if (verbose) console.log(`Event kind ${nostrEvent.kind} — formatting for X...`);
  const { tweets, images } = format(nostrEvent, identifier, {});

  if (dryRun) {
    console.log('\n--- DRY RUN (would post to X) ---\n');
    tweets.forEach((t, i) => {
      if (tweets.length > 1) console.log(`--- Tweet ${i + 1}/${tweets.length} ---`);
      console.log(t);
      console.log(`(${t.length} chars)\n`);
    });
    if (images.length > 0) {
      console.log(`Images: ${images.join(', ')}`);
    }
    return;
  }

  // Verify credentials exist before posting
  await readCredentials();

  // Upload images if any
  let mediaIds = [];
  if (images.length > 0) {
    if (verbose) console.log(`Uploading ${images.length} image(s)...`);
    for (const imgUrl of images.slice(0, 4)) { // X allows max 4 images
      try {
        const mediaId = await uploadMedia(imgUrl);
        mediaIds.push(mediaId);
        if (verbose) console.log(`  Uploaded: ${mediaId}`);
      } catch (err) {
        console.error(`  Warning: Failed to upload image ${imgUrl}: ${err.message}`);
      }
    }
  }

  // Post
  if (verbose) console.log(`Posting ${tweets.length} tweet(s)...`);
  const result = await postThread(tweets, mediaIds);

  console.log(`Published: ${result.url}`);
  if (verbose) {
    result.tweets.forEach((t, i) => {
      console.log(`  Tweet ${i + 1}: ${t.id}`);
    });
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
