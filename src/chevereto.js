/**
 * chevereto.js – Chevereto v3/v4 API client
 *
 * Fetches images and albums from your Chevereto instance.
 * Implements recency-weighted random selection so newer uploads
 * are significantly more likely to be picked.
 */

const axios  = require('axios');
const logger = require('./logger');

const BASE_URL   = process.env.CHEVERETO_BASE_URL?.replace(/\/$/, '');
const API_KEY    = process.env.CHEVERETO_API_KEY;
const BIAS       = parseFloat(process.env.RECENCY_BIAS || '3.0');

// ─── HTTP client ─────────────────────────────────────────────────────────────

const api = axios.create({
  baseURL: `${BASE_URL}/api/1`,
  timeout: 15_000,
  params: { key: API_KEY },
});

// ─── Image fetching ──────────────────────────────────────────────────────────

/**
 * Fetch a page of images sorted newest-first.
 * Chevereto API: GET /api/1/images?page=N&per_page=100
 */
async function fetchImages(page = 1, perPage = 100) {
  const { data } = await api.get('/images', {
    params: { page, per_page: perPage, sort: 'date_desc' },
  });
  return data?.images?.images ?? [];
}

/**
 * Fetch all images up to `maxPages` pages (newest first).
 * With ~1 000 uploads/month per person × 7 people, we cap at 5 pages
 * (500 images) which already covers the most recent several weeks.
 */
async function fetchRecentImages(maxPages = 5) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const imgs = await fetchImages(page);
      all.push(...imgs);
      if (imgs.length < 100) break; // last page
    } catch (err) {
      logger.warn(`fetchRecentImages: page ${page} failed – ${err.message}`);
      break;
    }
  }
  return all;
}

/**
 * Assign a recency weight to each image.
 * Images are already sorted newest-first (index 0 = newest).
 * Weight = (N - index)^BIAS   where N = total count
 * This creates a power-law curve: recent photos have much higher probability.
 */
function weightedSample(images, n, excludeIds = []) {
  const pool = images.filter(img => !excludeIds.includes(img.id_encoded ?? img.id));
  if (pool.length === 0) return [];

  const N = pool.length;
  const weights = pool.map((_, i) => Math.pow(N - i, BIAS));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const picked = [];
  const used   = new Set();

  while (picked.length < Math.min(n, pool.length) && picked.length < pool.length) {
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
  const { data } = await api.get(`/album?id=${albumIdOrHash}`);
  return data?.album ?? null;
}

async function fetchAlbumImages(albumIdOrHash, page = 1) {
  const { data } = await api.get(`/album/images`, {
    params: { id: albumIdOrHash, page, per_page: 20 },
  });
  return data?.images?.images ?? [];
}

// ─── User helpers ─────────────────────────────────────────────────────────────

async function fetchUser(username) {
  const { data } = await api.get(`/user?username=${username}`);
  return data?.user ?? null;
}

async function fetchUserImages(username, page = 1) {
  const { data } = await api.get(`/user/images`, {
    params: { username, page, per_page: 12, sort: 'date_desc' },
  });
  return data?.images?.images ?? [];
}

// ─── Image download ───────────────────────────────────────────────────────────

/**
 * Download an image as a Buffer for uploading to Bluesky.
 * Uses the medium-sized URL when available to keep uploads under 1 MB.
 */
async function downloadImage(image) {
  const url = image.medium?.url ?? image.url;
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
  });
  return {
    buffer: Buffer.from(response.data),
    mimeType: response.headers['content-type'] || 'image/jpeg',
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
