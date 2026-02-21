/**
 * LinkedIn API Client
 *
 * Publishes posts and fetches user info via LinkedIn REST API.
 * Supports text posts, article posts, and image uploads.
 */

import { getAccessToken, getPersonUrn } from './token.mjs';
import { readFile } from 'node:fs/promises';

const LINKEDIN_VERSION = '202501';
const RESTLI_VERSION = '2.0.0';

async function apiHeaders() {
  const token = await getAccessToken();
  return {
    Authorization: `Bearer ${token}`,
    'LinkedIn-Version': LINKEDIN_VERSION,
    'X-Restli-Protocol-Version': RESTLI_VERSION,
    'Content-Type': 'application/json',
  };
}

/**
 * Get authenticated user info from LinkedIn.
 * @returns {{ sub: string, name: string, email?: string }}
 */
export async function getUserInfo() {
  const token = await getAccessToken();
  const res = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getUserInfo failed (${res.status}): ${text}`);
  }

  return res.json();
}

/**
 * Upload an image to LinkedIn for use in posts.
 * @param {string} imageUrl - URL of image to download and upload
 * @returns {string} Image URN (urn:li:image:...)
 */
export async function uploadImage(imageUrl) {
  const headers = await apiHeaders();
  const personUrn = await getPersonUrn();

  // Step 1: Initialize upload
  const initRes = await fetch(
    'https://api.linkedin.com/rest/images?action=initializeUpload',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: personUrn,
        },
      }),
    }
  );

  if (!initRes.ok) {
    const text = await initRes.text();
    throw new Error(`Image upload init failed (${initRes.status}): ${text}`);
  }

  const initData = await initRes.json();
  const { uploadUrl, image: imageUrn } = initData.value;

  // Step 2: Download the source image
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`Failed to download image from ${imageUrl}: ${imgRes.status}`);
  }
  const imageBuffer = Buffer.from(await imgRes.arrayBuffer());

  // Step 3: Upload binary to LinkedIn
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: headers.Authorization,
      'Content-Type': 'application/octet-stream',
    },
    body: imageBuffer,
  });

  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(`Image upload failed (${uploadRes.status}): ${text}`);
  }

  return imageUrn;
}

/**
 * Publish a post to LinkedIn.
 * @param {object} payload - LinkedIn post payload (must include author, commentary, etc.)
 * @returns {{ postId: string, url: string }}
 */
export async function publish(payload) {
  const token = await getAccessToken();
  const personUrn = await getPersonUrn();

  // Convert from /rest/posts format to /v2/ugcPosts format if needed
  let ugcPayload;
  if (payload.specificContent) {
    // Already in ugcPosts format
    ugcPayload = payload;
  } else {
    // Convert from posts API format
    ugcPayload = {
      author: personUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: payload.commentary || payload.text || '' },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    };
  }

  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(ugcPayload),
  });

  if (res.status === 401) {
    throw new Error('LinkedIn API 401 — token may be invalid. Run: linkedin-post --auth');
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after') || 'unknown';
    throw new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LinkedIn API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  const postUrn = data.id || '';
  const url = postUrn ? `https://www.linkedin.com/feed/update/${postUrn}` : '';

  return { postId: postUrn, url };
}
