/**
 * OAuth 1.0a signature generation for X/Twitter API
 * 
 * Pure Node.js implementation using built-in crypto.
 */

import { createHmac, randomBytes } from 'node:crypto';

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function generateNonce() {
  return randomBytes(16).toString('hex');
}

function generateTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

/**
 * Generate OAuth 1.0a Authorization header
 */
export function oauthHeader(method, url, params, credentials) {
  const { apiKey, apiSecret, accessToken, accessTokenSecret } = credentials;

  const oauthParams = {
    oauth_consumer_key: apiKey,
    oauth_nonce: generateNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: generateTimestamp(),
    oauth_token: accessToken,
    oauth_version: '1.0',
  };

  // Combine OAuth params + request params for signature base
  const allParams = { ...oauthParams, ...params };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys
    .map(k => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join('&');

  const signatureBase = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join('&');

  const signingKey = `${percentEncode(apiSecret)}&${percentEncode(accessTokenSecret)}`;
  const signature = createHmac('sha1', signingKey)
    .update(signatureBase)
    .digest('base64');

  oauthParams.oauth_signature = signature;

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(', ');

  return `OAuth ${headerParts}`;
}
