/**
 * X/Twitter OAuth 1.0a Token Manager
 *
 * Storage: ~/.x-poster/credentials.json
 * Uses OAuth 1.0a User Context (API Key + Access Token)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const X_DIR = join(homedir(), '.x-poster');
const CREDENTIALS_PATH = join(X_DIR, 'credentials.json');

async function ensureDir() {
  await mkdir(X_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Read stored credentials.
 * Expected format:
 * {
 *   "apiKey": "...",
 *   "apiSecret": "...",
 *   "accessToken": "...",
 *   "accessTokenSecret": "..."
 * }
 */
export async function readCredentials() {
  try {
    return JSON.parse(await readFile(CREDENTIALS_PATH, 'utf8'));
  } catch {
    throw new Error(
      `Missing credentials. Create ${CREDENTIALS_PATH} with:\n` +
      `{\n  "apiKey": "...",\n  "apiSecret": "...",\n  "accessToken": "...",\n  "accessTokenSecret": "..."\n}`
    );
  }
}

/**
 * Store credentials.
 */
export async function writeCredentials(creds) {
  await ensureDir();
  await writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}
