import { execSync } from 'node:child_process';

const NAK = '/usr/local/bin/nak';

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://relay.ditto.pub',
];

/**
 * Fetch a Nostr event from relays based on a decoded identifier.
 * @param {{type: string, id?: string, kind?: number, pubkey?: string, identifier?: string, relays: string[]}} decoded
 * @returns {Promise<object>} Raw Nostr event JSON
 */
export async function fetchEvent(decoded) {
  const relays = decoded.relays?.length ? decoded.relays : DEFAULT_RELAYS;
  const relayArgs = relays.join(' ');

  let stdout;

  if (decoded.type === 'nevent') {
    const cmd = `${NAK} req --limit 1 -i ${decoded.id} ${relayArgs} 2>/dev/null`;
    try {
      stdout = execSync(cmd, { timeout: 30_000, encoding: 'utf-8' });
    } catch (err) {
      if (err.stdout?.trim()) {
        stdout = err.stdout;
      } else {
        throw new Error(`nak req failed: ${err.message}`);
      }
    }
  } else if (decoded.type === 'naddr') {
    const filter = JSON.stringify({
      kinds: [decoded.kind],
      authors: [decoded.pubkey],
      '#d': [decoded.identifier],
    });
    const cmd = `echo '${filter.replace(/'/g, "'\\''")}' | ${NAK} req --limit 5 ${relayArgs} 2>/dev/null`;
    try {
      stdout = execSync(cmd, { timeout: 30_000, encoding: 'utf-8' });
    } catch (err) {
      if (err.stdout?.trim()) {
        stdout = err.stdout;
      } else {
        throw new Error(`nak req failed for naddr: ${err.message}`);
      }
    }
  } else {
    throw new Error(`Unknown decoded type: ${decoded.type}`);
  }

  // nak req may return multiple lines (one event per line). Take the best one.
  const lines = (stdout || '').trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    throw new Error('Event not found on any relay');
  }

  // For naddr, there may be multiple versions; pick the latest (highest created_at)
  let best = null;
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (!best || (event.created_at || 0) > (best.created_at || 0)) {
        best = event;
      }
    } catch {
      // skip unparseable lines
    }
  }

  if (!best) throw new Error('Event not found on any relay');
  return best;
}
