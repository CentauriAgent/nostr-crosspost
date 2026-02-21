/**
 * LinkedIn OAuth 2.0 Token Manager
 *
 * Storage: ~/.linkedin/ (credentials.json, token.json)
 * 3-legged OAuth with local callback server on port 3847
 * Auto-refreshes tokens before 60-day expiry
 */

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LINKEDIN_DIR = join(homedir(), '.linkedin');
const CREDENTIALS_PATH = join(LINKEDIN_DIR, 'credentials.json');
const TOKEN_PATH = join(LINKEDIN_DIR, 'token.json');
const REDIRECT_URI = 'http://localhost:3847/callback';
const SCOPES = 'openid profile w_member_social';
const REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours before expiry

async function ensureDir() {
  await mkdir(LINKEDIN_DIR, { recursive: true, mode: 0o700 });
}

async function readCredentials() {
  try {
    return JSON.parse(await readFile(CREDENTIALS_PATH, 'utf8'));
  } catch {
    throw new Error(
      `Missing credentials. Create ${CREDENTIALS_PATH} with {"clientId":"...","clientSecret":"..."}`
    );
  }
}

async function readToken() {
  try {
    return JSON.parse(await readFile(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function writeToken(tokenData) {
  await ensureDir();
  await writeFile(TOKEN_PATH, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
}

async function exchangeCode(code, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  return res.json();
}

/**
 * Interactive OAuth setup flow (--auth)
 */
export async function setupAuth() {
  const { clientId, clientSecret } = await readCredentials();

  const authUrl =
    `https://www.linkedin.com/oauth/v2/authorization?` +
    `response_type=code&` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `scope=${encodeURIComponent(SCOPES)}`;

  // Wait for callback
  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost:3847');
      if (url.pathname === '/callback') {
        const authCode = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (authCode) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>✅ Authorization successful!</h1><p>You can close this tab.</p>');
          server.close();
          resolve(authCode);
          return;
        }
      }
      res.writeHead(404);
      res.end();
    });

    server.listen(3847, () => {
      console.log(`\nOpen this URL in your browser to authorize:\n\n${authUrl}\n`);
      console.log('Waiting for callback on http://localhost:3847/callback ...');

      // Try to open browser automatically
      import('child_process')
        .then(({ exec }) => exec(`open "${authUrl}" 2>/dev/null || xdg-open "${authUrl}" 2>/dev/null`))
        .catch(() => {}); // ignore if browser launch fails
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout — no callback received within 5 minutes'));
    }, 5 * 60 * 1000);
  });

  // Exchange code for tokens
  const tokenResponse = await exchangeCode(code, clientId, clientSecret);

  const expiresAt = Date.now() + tokenResponse.expires_in * 1000;

  // Fetch person URN — try /v2/me, fall back to /v2/userinfo, then prompt manually
  let sub = null;
  let name = 'Unknown';

  for (const endpoint of ['https://api.linkedin.com/v2/me', 'https://api.linkedin.com/v2/userinfo']) {
    const userInfo = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
    });
    if (userInfo.ok) {
      const data = await userInfo.json();
      sub = data.id || data.sub;
      name = data.localizedFirstName
        ? [data.localizedFirstName, data.localizedLastName].filter(Boolean).join(' ')
        : data.name || sub;
      break;
    }
  }

  if (!sub) {
    // Can't fetch profile — use vanity name as fallback
    // The real numeric ID will be resolved on first post via the API
    sub = process.env.LINKEDIN_PERSON_ID || 'unknown';
    name = sub;
    console.log(`\nNote: Could not fetch profile via API. Using person ID: ${sub}`);
  }

  const tokenData = {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token || null,
    expiresAt,
    personUrn: `urn:li:person:${sub}`,
    name,
  };

  await writeToken(tokenData);
  console.log(`\n✅ Authenticated as ${name} (${tokenData.personUrn})`);
  console.log(`Token stored at ${TOKEN_PATH}`);
}

/**
 * Get a valid access token, auto-refreshing if needed.
 */
export async function getAccessToken() {
  const token = await readToken();
  if (!token) {
    throw new Error('Not authenticated. Run: linkedin-post --auth');
  }

  // Check if token needs refresh (within 24h of expiry)
  if (token.expiresAt - Date.now() < REFRESH_THRESHOLD_MS) {
    if (!token.refreshToken) {
      throw new Error('Token expired and no refresh token available. Run: linkedin-post --auth');
    }

    console.error('Token near expiry, refreshing...');
    const { clientId, clientSecret } = await readCredentials();

    try {
      const refreshed = await refreshAccessToken(token.refreshToken, clientId, clientSecret);
      token.accessToken = refreshed.access_token;
      token.expiresAt = Date.now() + refreshed.expires_in * 1000;
      if (refreshed.refresh_token) {
        token.refreshToken = refreshed.refresh_token;
      }
      await writeToken(token);
      console.error('Token refreshed successfully.');
    } catch (err) {
      throw new Error(`Token refresh failed: ${err.message}\nRe-run: linkedin-post --auth`);
    }
  }

  return token.accessToken;
}

/**
 * Get the stored person URN.
 */
export async function getPersonUrn() {
  const token = await readToken();
  if (!token?.personUrn) {
    throw new Error('Not authenticated. Run: linkedin-post --auth');
  }
  return token.personUrn;
}
