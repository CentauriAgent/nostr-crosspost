import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Dynamic imports for the modules under test
const { decode } = await import(join(ROOT, 'lib/decoder.mjs'));
const { fetchEvent } = await import(join(ROOT, 'lib/fetcher.mjs'));
const { format } = await import(join(ROOT, 'lib/formatter.mjs'));

const kind1Fixture = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/kind1-event.json'), 'utf8'));
const kind30023Fixture = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/kind30023-event.json'), 'utf8'));

describe('decoder', () => {
  it('decodes a nevent identifier', async () => {
    // Encode a known event id using nak
    const eventId = 'a'.repeat(64);
    const nevent = execSync(`nak encode nevent ${eventId} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    const result = await decode(nevent);
    assert.equal(result.type, 'nevent');
    assert.equal(result.id, eventId);
    assert.ok(Array.isArray(result.relays));
  });

  it('decodes a nevent with relay hint', async () => {
    const eventId = 'b'.repeat(64);
    const nevent = execSync(`nak encode nevent --relay wss://relay.damus.io ${eventId} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    const result = await decode(nevent);
    assert.equal(result.type, 'nevent');
    assert.equal(result.id, eventId);
    assert.ok(result.relays.includes('wss://relay.damus.io'));
  });

  it('decodes an naddr identifier', async () => {
    const pubkey = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
    const naddr = execSync(`nak encode naddr -k 30023 -d test-article -p ${pubkey} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    const result = await decode(naddr);
    assert.equal(result.type, 'naddr');
    assert.equal(result.kind, 30023);
    assert.equal(result.identifier, 'test-article');
    assert.equal(result.pubkey, pubkey);
  });

  it('rejects invalid identifiers', async () => {
    await assert.rejects(() => decode('note1abc'), /must start with nevent1 or naddr1/);
    await assert.rejects(() => decode(''), /empty or not a string/);
    await assert.rejects(() => decode(null), /empty or not a string/);
  });
});

describe('formatter - kind 1', () => {
  it('produces valid payload structure', () => {
    const { payload, images } = format(kind1Fixture, 'nevent1test');
    assert.ok(payload.commentary);
    assert.equal(payload.visibility, 'PUBLIC');
    assert.equal(payload.lifecycleState, 'PUBLISHED');
    assert.ok(payload.distribution);
    assert.equal(typeof payload.isReshareDisabledByAuthor, 'boolean');
  });

  it('extracts image URLs', () => {
    const { images } = format(kind1Fixture, 'nevent1test');
    assert.ok(images.includes('https://example.com/photo.jpg'));
  });

  it('strips nostr mentions', () => {
    const { payload } = format(kind1Fixture, 'nevent1test');
    assert.ok(!payload.commentary.includes('nostr:npub1'));
  });

  it('preserves hashtags', () => {
    const { payload } = format(kind1Fixture, 'nevent1test');
    assert.ok(payload.commentary.includes('#bitcoin') || payload.commentary.includes('#nostr'));
  });

  it('appends Nostr footer with njump link', () => {
    const { payload } = format(kind1Fixture, 'nevent1test');
    assert.ok(payload.commentary.includes('🟣 Originally posted on Nostr'));
    assert.ok(payload.commentary.includes('https://njump.me/nevent1test'));
  });

  it('handles truncation for long content', () => {
    const longEvent = { ...kind1Fixture, content: 'x'.repeat(5000) };
    const { payload } = format(longEvent, 'nevent1test');
    assert.ok(payload.commentary.length <= 3000);
  });
});

describe('formatter - kind 30023', () => {
  it('produces article payload', () => {
    const { payload, images } = format(kind30023Fixture, 'naddr1test');
    assert.ok(payload.content?.article);
    assert.equal(payload.content.article.title, 'Why Nostr Matters in 2025');
    assert.equal(payload.content.article.source, 'https://njump.me/naddr1test');
    assert.ok(payload.content.article.description);
  });

  it('extracts image from tags', () => {
    const { images } = format(kind30023Fixture, 'naddr1test');
    assert.ok(images.includes('https://example.com/blog-header.jpg'));
  });

  it('strips markdown in commentary', () => {
    const { payload } = format(kind30023Fixture, 'naddr1test');
    // Should not contain markdown headers
    assert.ok(!payload.commentary.includes('# '));
    assert.ok(!payload.commentary.includes('## '));
  });

  it('includes hashtags from tags', () => {
    const { payload } = format(kind30023Fixture, 'naddr1test');
    assert.ok(payload.commentary.includes('#nostr'));
    assert.ok(payload.commentary.includes('#decentralization'));
  });
});

describe('fetcher - live relay', () => {
  it('fetches a kind 1 event from relay', async () => {
    // Get a recent event id from damus relay
    const line = execSync('nak req --limit 1 -k 1 wss://relay.damus.io 2>/dev/null', { encoding: 'utf-8', timeout: 15000 }).trim();
    const sampleEvent = JSON.parse(line);
    const nevent = execSync(`nak encode nevent --relay wss://relay.damus.io ${sampleEvent.id} 2>/dev/null`, { encoding: 'utf-8' }).trim();

    const decoded = await decode(nevent);
    const event = await fetchEvent(decoded);
    assert.equal(event.id, sampleEvent.id);
    assert.equal(event.kind, 1);
  });
});

describe('CLI dry-run', () => {
  it('runs end-to-end in dry-run mode', () => {
    // Get a real event
    const line = execSync('nak req --limit 1 -k 1 wss://relay.damus.io 2>/dev/null', { encoding: 'utf-8', timeout: 15000 }).trim();
    const sampleEvent = JSON.parse(line);
    const nevent = execSync(`nak encode nevent --relay wss://relay.damus.io ${sampleEvent.id} 2>/dev/null`, { encoding: 'utf-8' }).trim();

    const output = execSync(`node ${join(ROOT, 'bin/post.mjs')} --dry-run ${nevent} 2>&1`, {
      encoding: 'utf-8',
      timeout: 30000,
    });

    assert.ok(output.includes('DRY RUN'));
    assert.ok(output.includes('commentary'));
    assert.ok(output.includes('PUBLIC'));
  });
});
