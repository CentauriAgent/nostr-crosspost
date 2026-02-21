#!/usr/bin/env node

import { decode } from '../lib/decoder.mjs';
import { fetchEvent } from '../lib/fetcher.mjs';
import { format } from '../lib/formatter.mjs';
import { publish } from '../lib/linkedin.mjs';
import { getPersonUrn, setupAuth } from '../lib/token.mjs';

const USAGE = `Usage: linkedin-post <nostr-identifier> [options]

  nostr-identifier    nevent1... or naddr1... string

Options:
  --dry-run     Show what would be posted without publishing
  --verbose     Show intermediate steps
  --auth        Run OAuth setup flow (interactive)
  --help        Show this help message`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { dryRun: false, verbose: false, auth: false, help: false };
  let identifier = null;

  for (const arg of args) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--verbose') flags.verbose = true;
    else if (arg === '--auth') flags.auth = true;
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

async function main() {
  const { identifier, dryRun, verbose, auth, help } = parseArgs(process.argv);

  if (help) {
    console.log(USAGE);
    process.exit(0);
  }

  // --auth: interactive OAuth setup
  if (auth) {
    await setupAuth();
    return;
  }

  // Require identifier
  if (!identifier) {
    console.error('Error: Missing nostr identifier\n');
    console.error(USAGE);
    process.exit(1);
  }

  // Validate identifier prefix
  if (!identifier.startsWith('nevent1') && !identifier.startsWith('naddr1')) {
    console.error('Error: Identifier must start with nevent1 or naddr1');
    process.exit(1);
  }

  if (verbose) console.log(`Decoding ${identifier}...`);
  const decoded = await decode(identifier);

  if (verbose) console.log('Fetching event from relays...');
  const nostrEvent = await fetchEvent(decoded);

  // Validate kind
  if (nostrEvent.kind !== 1 && nostrEvent.kind !== 30023) {
    console.error(`Error: Unsupported event kind ${nostrEvent.kind}. Only kind 1 (note) and kind 30023 (long-form) are supported.`);
    process.exit(1);
  }

  if (verbose) console.log(`Event kind ${nostrEvent.kind} — formatting for LinkedIn...`);
  const { payload, images } = format(nostrEvent, identifier);

  // Set author URN (skip in dry-run if not authenticated)
  if (dryRun) {
    try {
      const personUrn = await getPersonUrn();
      payload.author = personUrn;
    } catch {
      payload.author = 'urn:li:person:{YOUR_URN}';
    }
  } else {
    const personUrn = await getPersonUrn();
    payload.author = personUrn;
  }

  if (dryRun) {
    console.log('\n--- DRY RUN (would post to LinkedIn) ---\n');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (verbose) console.log('Publishing to LinkedIn...');
  const result = await publish(payload);

  const postId = result?.id?.replace('urn:li:share:', '') ?? result?.id ?? 'unknown';
  console.log(`✅ Published to LinkedIn!`);
  console.log(`   https://www.linkedin.com/feed/update/${result.id ?? postId}`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
