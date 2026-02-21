import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const NAK = '/usr/local/bin/nak';

/**
 * Decode a Nostr nevent1.../naddr1... identifier using nak CLI.
 * @param {string} identifier - nevent1... or naddr1... string
 * @returns {Promise<{type: string, id?: string, kind?: number, pubkey?: string, identifier?: string, relays: string[]}>}
 */
export async function decode(identifier) {
  if (!identifier || typeof identifier !== 'string') {
    throw new Error('Invalid Nostr identifier: empty or not a string');
  }

  const trimmed = identifier.trim();
  let type;
  if (trimmed.startsWith('nevent1')) type = 'nevent';
  else if (trimmed.startsWith('naddr1')) type = 'naddr';
  else throw new Error(`Invalid Nostr identifier: must start with nevent1 or naddr1, got "${trimmed.slice(0, 20)}..."`);

  let stdout;
  try {
    ({ stdout } = await execFileAsync(NAK, ['decode', trimmed], { timeout: 10_000 }));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('nak CLI not found. Install: go install github.com/fiatjaf/nak@latest');
    }
    throw new Error(`nak decode failed: ${err.stderr || err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`Failed to parse nak decode output: ${stdout.trim()}`);
  }

  const relays = Array.isArray(parsed.relays) ? parsed.relays.filter(Boolean) : [];

  if (type === 'nevent') {
    if (!parsed.id) throw new Error('nak decode returned nevent without id');
    return { type, id: parsed.id, relays };
  }

  // naddr
  return {
    type,
    kind: parsed.kind,
    pubkey: parsed.pubkey,
    identifier: parsed.identifier ?? parsed.d ?? '',
    relays,
  };
}
