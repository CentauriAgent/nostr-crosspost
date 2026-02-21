/**
 * X/Twitter API Client
 *
 * Posts tweets using X API v2 with OAuth 1.0a User Context.
 * Supports text tweets, threads, and media uploads.
 */

import { readCredentials } from './token.mjs';
import { oauthHeader } from './oauth.mjs';

const TWEET_URL = 'https://api.twitter.com/2/tweets';
const MEDIA_UPLOAD_URL = 'https://upload.twitter.com/1.1/media/upload.json';

/**
 * Post a single tweet.
 * @param {string} text - Tweet text
 * @param {object} options - { replyTo?: string, mediaIds?: string[] }
 * @returns {{ id: string, text: string }}
 */
export async function postTweet(text, options = {}) {
  const creds = await readCredentials();

  const body = { text };
  if (options.replyTo) {
    body.reply = { in_reply_to_tweet_id: options.replyTo };
  }
  if (options.mediaIds?.length) {
    body.media = { media_ids: options.mediaIds };
  }

  const auth = oauthHeader('POST', TWEET_URL, {}, creds);

  const res = await fetch(TWEET_URL, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    throw new Error('X API 401 — check your credentials in ~/.x-poster/credentials.json');
  }

  if (res.status === 403) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`X API 403 Forbidden: ${JSON.stringify(data)}`);
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after') || 'unknown';
    throw new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`X API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.data;
}

/**
 * Post a thread (array of tweets).
 * @param {string[]} tweets - Array of tweet texts
 * @param {string[]} mediaIds - Media IDs for the first tweet
 * @returns {{ tweets: Array<{ id: string, text: string }>, url: string }}
 */
export async function postThread(tweets, mediaIds = []) {
  const results = [];

  for (let i = 0; i < tweets.length; i++) {
    const options = {};

    // Reply to previous tweet in thread
    if (i > 0 && results.length > 0) {
      options.replyTo = results[results.length - 1].id;
    }

    // Attach media to first tweet only
    if (i === 0 && mediaIds.length > 0) {
      options.mediaIds = mediaIds;
    }

    const result = await postTweet(tweets[i], options);
    results.push(result);

    // Small delay between thread tweets to avoid rate limits
    if (i < tweets.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  const firstId = results[0]?.id;
  const url = firstId ? `https://x.com/i/status/${firstId}` : '';

  return { tweets: results, url };
}

/**
 * Upload media (image) to X for use in tweets.
 * Uses v1.1 chunked upload for images.
 * @param {string} imageUrl - URL of image to upload
 * @returns {string} media_id_string
 */
export async function uploadMedia(imageUrl) {
  const creds = await readCredentials();

  // Download image
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`Failed to download image from ${imageUrl}: ${imgRes.status}`);
  }
  const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
  const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

  // Simple upload (for images under 5MB)
  const params = {
    media_category: 'tweet_image',
  };

  const boundary = '----FormBoundary' + Date.now().toString(16);

  // Build multipart form data manually
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="media_category"\r\n\r\ntweet_image`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="media_data"\r\n\r\n${imageBuffer.toString('base64')}`);
  parts.push(`--${boundary}--`);

  const formBody = parts.join('\r\n');

  const auth = oauthHeader('POST', MEDIA_UPLOAD_URL, { media_category: 'tweet_image' }, creds);

  const res = await fetch(MEDIA_UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: formBody,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Media upload failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.media_id_string;
}
