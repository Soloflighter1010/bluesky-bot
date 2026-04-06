/**
 * chevereto.js – Chevereto v3/v4 API client
 *
 * Fetches images and albums from your Chevereto instance.
 * Implements recency-weighted random selection so newer uploads
 * are significantly more likely to be picked.
 */

const axios  = require('axios');
const logger = require('./logger');

const BASE_URL = process.env.CHEVERETO_BASE_URL?.replace(/\/$/, '');
const API_KEY  = process.env.CHEVERETO_API_KEY;
const BIAS     = parseFloat(process.env.RECENCY_BIAS || '3.0');

// ─── HTTP client ─────────────────────────────────────────────────────────────

const api = axios.create({
  baseURL: `${BASE_URL}/api/1`,
  timeout: 15_000,
  params: { key: API_KEY },
});

// Log the full error response body on 4xx so misconfigurations are obvious
api.interceptors.response.use(
  res => res,
  err => {
    if (err.response) {
      logger.warn(
        `Chevereto API ${err.response.status} on ${err.config?.url}: ` +
        JSON.stringify(err.response.data).slice(0, 300)
      );
    }
    return Promise.reject(err);
  }
);

// ─── Image fetching ──────────────────────────────────────────────────────────

/**
 * Fetch one page of images from Chevereto.
 *
 * The Chevereto v3/v4 public API only supports `page` as a pagination param.
 * `per_page` and `sort` are NOT part of the standard API — omitting them
 * avoids the 400 error. The API returns images newest-first by default.
 */
async function fetchImages(page = 1) {
  const { data } = await api.get('/images', { params: { page } });

  // The response shape can vary slightly between Chevereto versions:
  //   v3: data.images.images[]  (nested)
  //   v4: data.images[]         (flat array)
  const imgs =
    data?.images?.images ??
    (Array.isArray(data?.images) ? data.images : null) ??
    [];

  return imgs;
}

/**
 * Fetch recent images across multiple pages (newest first).
 * Caps at maxPages to avoid hammering your server on every cycle.
 */
async function fetchRecentImages(maxPages = 5) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const imgs = await fetchImages(page);
      logger.info(`Chevereto page ${page}: got ${imgs.length} images`);
      all.push(...imgs);
      // Chevereto default page size is typically 100; fewer means last page
      if (imgs.length < 100) break;
    } catch (err) {
      logger.warn(`fetchRecentImages: page ${page} failed – ${err.message}`);
      break;
    }
  }
  return all;
}

// ─── Recency-weighted sampling ────────────────────────────────────────────────

/**
 * Pick n images using power-law weighting so newer photos are chosen more often.
 * index 0 = newest image (highest weight).
 *
 * weight[i] = (N - i) ^ BIAS
 */
function weightedSample(images, n, excludeIds = []) {
  const pool = images.filter(img => !excludeIds.includes(img.id_encoded ?? img.id));
  if (pool.length === 0) return [];

  const N = pool.length;
  const weights = pool.map((_, i) => Math.pow(N - i, BIAS));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const picked = [];
  const used   = new Set();

  while (picked.length < Math.min(n, pool.length)) {
    let r = Math.random() * totalWeight;
    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue;
      r -= weights[i];
      if (r <= 0) {
        picked.push(pool[i]);
        used.add(i);
        break;
      }
    }
  }
  return picked;
}

// ─── Album helpers ────────────────────────────────────────────────────────────

async function fetchAlbum(albumIdOrHash) {
  const { data } = await api.get('/album', { params: { id: albumIdOrHash } });
  return data?.album ?? null;
}

async function fetchAlbumImages(albumIdOrHash, page = 1) {
  const { data } = await api.get('/album/images', {
    params: { id: albumIdOrHash, page },
  });
  return (
    data?.images?.images ??
    (Array.isArray(data?.images) ? data.images : null) ??
    []
  );
}

// ─── User helpers ─────────────────────────────────────────────────────────────

async function fetchUser(username) {
  const { data } = await api.get('/user', { params: { username } });
  return data?.user ?? null;
}

async function fetchUserImages(username, page = 1) {
  const { data } = await api.get('/user/images', { params: { username, page } });
  return (
    data?.images?.images ??
    (Array.isArray(data?.images) ? data.images : null) ??
    []
  );
}

// ─── Image download ───────────────────────────────────────────────────────────

/**
 * Download an image as a Buffer.
 * Prefers the `medium` size URL to stay under Bluesky's 1 MB blob limit.
 */
async function downloadImage(image) {
  const url = image.medium?.url ?? image.url;
  if (!url) throw new Error(`No URL found for image ${image.id}`);

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
  });
  return {
    buffer:   Buffer.from(response.data),
    mimeType: (response.headers['content-type'] || 'image/jpeg').split(';')[0],
  };
}

module.exports = {
  fetchRecentImages,
  weightedSample,
  fetchAlbum,
  fetchAlbumImages,
  fetchUser,
  fetchUserImages,
  downloadImage,
};