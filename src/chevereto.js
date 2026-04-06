/**
 * chevereto.js – Chevereto scraper
 *
 * Scrapes /explore/recent for image listings (no API key needed).
 * Also handles album pages and user image lookups.
 * Extracts VRCX/VRChat metadata from PNG tEXt chunks.
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const sharp   = require('sharp');
const logger  = require('./logger');

const BASE_URL = process.env.CHEVERETO_BASE_URL?.replace(/\/$/, '');
const BIAS     = parseFloat(process.env.RECENCY_BIAS || '3.0');

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PhotoBot/1.0)',
  'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function fetchHTML(url) {
  const { data } = await axios.get(url, { timeout: 15_000, headers: HTTP_HEADERS });
  return data;
}

async function fetchBuffer(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30_000,
    headers: { 'User-Agent': HTTP_HEADERS['User-Agent'] },
  });
  return {
    buffer:   Buffer.from(res.data),
    mimeType: (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim(),
  };
}

// ─── ID extraction ────────────────────────────────────────────────────────────

/**
 * Extract a Chevereto image hash from a viewer URL.
 *
 * Chevereto viewer URLs are typically:
 *   https://site.com/AbCd123           (short hash, last segment)
 *   https://site.com/image/AbCd123     (with /image/ prefix)
 *
 * We take the LAST path segment and accept it as an ID only if it
 * looks like a Chevereto hash (4–20 alphanumeric chars, not a common
 * English word that would appear in navigation URLs).
 */
const COMMON_SEGMENTS = new Set([
  'image', 'images', 'img', 'photo', 'photos', 'album', 'albums',
  'user', 'users', 'explore', 'recent', 'search', 'upload', 'login',
  'register', 'about', 'contact', 'home', 'index', 'profile', 'settings',
  'edit', 'delete', 'list', 'grid', 'page', 'view',
]);

function extractImageId(viewerUrl) {
  try {
    const pathname = new URL(viewerUrl).pathname;
    const segments = pathname.split('/').filter(Boolean);
    // Walk from the end to find the first segment that looks like a hash
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (seg.length >= 4 && seg.length <= 20 &&
          /^[a-zA-Z0-9]+$/.test(seg) &&
          !COMMON_SEGMENTS.has(seg.toLowerCase())) {
        return seg;
      }
    }
  } catch {}
  return viewerUrl; // fallback to full URL so at least it's unique
}

// ─── Image card parser ────────────────────────────────────────────────────────

function parsePage(html, pageUrl) {
  const $ = cheerio.load(html);
  const images = [];

  const cardSelectors = [
    'li[data-type="image"]',
    '.list-item[data-type="image"]',
    '.image-container',
    '.item-image',
    'li.list-item',
    'div.list-item',
  ];

  let cards = $();
  for (const sel of cardSelectors) {
    const found = $(sel);
    if (found.length > 0) { cards = found; break; }
  }

  if (cards.length === 0) {
    logger.warn(`parsePage: no card elements found on ${pageUrl} — falling back to link scan`);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      // Only include links that look like image viewer pages (short alphanumeric segment)
      const lastSeg = href.split('/').filter(Boolean).pop() || '';
      if (lastSeg.length >= 4 && /^[a-zA-Z0-9]+$/.test(lastSeg) &&
          !COMMON_SEGMENTS.has(lastSeg.toLowerCase())) {
        cards = cards.add(el);
      }
    });
  }

  logger.info(`parsePage: found ${cards.length} cards on ${pageUrl}`);

  cards.each((_, card) => {
    const $card = $(card);

    // ── Viewer URL ────────────────────────────────────────────────────────────
    const rawHref =
      $card.is('a') ? $card.attr('href') :
      $card.find('a[href]').first().attr('href') || '';
    if (!rawHref) return;

    const viewerUrl = rawHref.startsWith('http')
      ? rawHref
      : `${BASE_URL}${rawHref.startsWith('/') ? '' : '/'}${rawHref}`;

    const id = extractImageId(viewerUrl);

    // ── Thumbnail ─────────────────────────────────────────────────────────────
    const $img     = $card.find('img').first();
    const thumbSrc = $img.attr('src') || $img.attr('data-src') || '';
    const thumbUrl = thumbSrc.startsWith('http')
      ? thumbSrc
      : thumbSrc ? `${BASE_URL}${thumbSrc.startsWith('/') ? '' : '/'}${thumbSrc}` : '';

    // Derive full-size URL — strip thumbnail size suffixes
    // Common patterns: /thumbs/HASH.th.jpg  →  /HASH.jpg
    //                  /HASH.md.jpg          →  /HASH.jpg
    const directUrl = thumbUrl
      .replace(/\/thumbs\//, '/')
      .replace(/\.(th|md|sm|lg)\.(jpg|jpeg|png|gif|webp)/i, '.$2');

    if (!thumbUrl && !directUrl) return;

    // ── Title ─────────────────────────────────────────────────────────────────
    const title =
      $img.attr('alt') ||
      $card.find('.list-item-name, .image-title, .item-title').first().text().trim() ||
      $card.attr('data-title') || 'Untitled';

    // ── Username ──────────────────────────────────────────────────────────────
    const username =
      $card.find('[data-username]').first().attr('data-username') ||
      $card.find('.list-item-user a, .username, .user-link').first().text().trim().replace(/^@/, '') ||
      $card.attr('data-username') || '';

    images.push({
      id,
      id_encoded: id,
      url:        directUrl || thumbUrl,
      url_viewer: viewerUrl,
      medium:     { url: thumbUrl || directUrl },
      title:      title.slice(0, 200),
      user:       username ? { username } : null,
      tags:       [],
    });
  });

  // Deduplicate by ID
  const seen = new Set();
  return images.filter(img => {
    if (seen.has(img.id)) return false;
    seen.add(img.id);
    return true;
  });
}

// ─── Fetch recent images ──────────────────────────────────────────────────────

async function fetchRecentImages(maxPages = 5) {
  const all = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1
      ? `${BASE_URL}/explore/recent`
      : `${BASE_URL}/explore/recent?page=${page}`;

    try {
      logger.info(`Scraping: ${url}`);
      const html = await fetchHTML(url);
      const imgs = parsePage(html, url);

      // Log the IDs so we can verify they're unique
      logger.info(`Page ${page} IDs: ${imgs.map(i => i.id).join(', ')}`);

      all.push(...imgs);
      if (imgs.length === 0) break;

    } catch (err) {
      logger.warn(`fetchRecentImages page ${page} failed: ${err.message}`);
      break;
    }
  }

  logger.info(`fetchRecentImages total: ${all.length} images across ${maxPages} pages`);
  return all;
}

// ─── Weighted sampling ────────────────────────────────────────────────────────

/**
 * Recency-biased random sampling without replacement.
 *
 * Fixed algorithm: recalculate totalWeight from *remaining* entries on each
 * draw so r always reaches 0. Removes the drawn entry from the pool so we
 * never double-pick or spin.
 */
function weightedSample(images, n, excludeIds = []) {
  const pool = images.filter(img => !excludeIds.includes(img.id_encoded ?? img.id));
  logger.info(`weightedSample: pool=${pool.length} after excluding ${excludeIds.length} seen IDs, want ${n}`);

  if (pool.length === 0) return [];

  const N = pool.length;
  // entries = { index into pool, weight }; index 0 = newest = highest weight
  const entries = pool.map((_, i) => ({ i, weight: Math.pow(N - i, BIAS) }));
  const picked  = [];

  while (picked.length < Math.min(n, pool.length) && entries.length > 0) {
    // Recompute total from remaining entries each draw
    const total = entries.reduce((s, e) => s + e.weight, 0);
    let r = Math.random() * total;

    let chosenIdx = entries.length - 1; // fallback: last entry (avoids fp edge case)
    for (let j = 0; j < entries.length; j++) {
      r -= entries[j].weight;
      if (r <= 0) { chosenIdx = j; break; }
    }

    picked.push(pool[entries[chosenIdx].i]);
    entries.splice(chosenIdx, 1); // remove so it can't be picked again
  }

  logger.info(`weightedSample: picked ${picked.length} images: ${picked.map(p => p.id).join(', ')}`);
  return picked;
}

// ─── Album helpers ────────────────────────────────────────────────────────────

async function fetchAlbum(albumIdOrHash) {
  const attempts = [
    `${BASE_URL}/a/${albumIdOrHash}`,
    `${BASE_URL}/album/${albumIdOrHash}`,
    `${BASE_URL}/albums/${albumIdOrHash}`,
  ];

  for (const url of attempts) {
    try {
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      const bodyText = $('body').text().trim();
      if (bodyText.length < 100) continue;
      if ($('title').text().toLowerCase().includes('not found')) continue;

      const title =
        $('h1.album-name, h1.list-title, .album-name, h1').first().text().trim() ||
        $('title').text().split(/[–—|]/)[0].trim() ||
        albumIdOrHash;

      logger.info(`fetchAlbum: "${title}" at ${url}`);
      return { id: albumIdOrHash, name: title, url };
    } catch (err) {
      logger.warn(`fetchAlbum ${url}: ${err.message}`);
    }
  }

  return null;
}

async function fetchAlbumImages(albumIdOrHash) {
  const attempts = [
    `${BASE_URL}/a/${albumIdOrHash}`,
    `${BASE_URL}/album/${albumIdOrHash}`,
  ];
  for (const url of attempts) {
    try {
      const imgs = parsePage(await fetchHTML(url), url);
      if (imgs.length > 0) return imgs.slice(0, 20);
    } catch (err) {
      logger.warn(`fetchAlbumImages ${url}: ${err.message}`);
    }
  }
  return [];
}

// ─── User helpers ─────────────────────────────────────────────────────────────

async function fetchUser(username) {
  const urls = [
    `${BASE_URL}/${username}/images`,
    `${BASE_URL}/${username}`,
  ];
  for (const url of urls) {
    try {
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      if ($('title').text().toLowerCase().includes('not found')) continue;
      if ($('body').text().trim().length < 100) continue;

      const name =
        $('.user-name, .profile-name, h1.username, .user-display-name').first().text().trim() ||
        username;

      return { username, name, images_total: null };
    } catch (err) {
      logger.warn(`fetchUser ${url}: ${err.message}`);
    }
  }
  return null;
}

/**
 * Fetch images for a specific user.
 *
 * Primary strategy: filter /explore/recent by username — reliable because
 * we already know that page works.
 * Fallback: scrape the user's profile page directly.
 */
async function fetchUserImages(username) {
  const lc = username.toLowerCase();

  // ── Strategy 1: filter explore/recent ─────────────────────────────────────
  try {
    const allImages = await fetchRecentImages(5);
    const userImages = allImages.filter(img =>
      img.user?.username?.toLowerCase() === lc
    );
    if (userImages.length > 0) {
      logger.info(`fetchUserImages: found ${userImages.length} images for @${username} via explore/recent`);
      return userImages.slice(0, 12);
    }
    logger.info(`fetchUserImages: @${username} not found in explore/recent (${allImages.length} total images checked)`);
  } catch (err) {
    logger.warn(`fetchUserImages explore strategy: ${err.message}`);
  }

  // ── Strategy 2: scrape profile page ───────────────────────────────────────
  const urls = [
    `${BASE_URL}/${username}/images`,
    `${BASE_URL}/${username}`,
  ];
  for (const url of urls) {
    try {
      const html = await fetchHTML(url);
      const imgs = parsePage(html, url);
      if (imgs.length > 0) {
        logger.info(`fetchUserImages: found ${imgs.length} images for @${username} at ${url}`);
        return imgs.slice(0, 12);
      }
    } catch (err) {
      logger.warn(`fetchUserImages ${url}: ${err.message}`);
    }
  }

  logger.warn(`fetchUserImages: no images found for @${username}`);
  return [];
}

// ─── Image download ───────────────────────────────────────────────────────────

async function downloadImage(image) {
  // Try full-size first, thumbnail as fallback
  const urls = [image.url, image.medium?.url].filter(Boolean);
  let lastErr;

  for (const url of urls) {
    try {
      logger.info(`downloadImage: fetching ${url}`);
      return await fetchBuffer(url);
    } catch (err) {
      lastErr = err;
      logger.warn(`downloadImage ${url} failed: ${err.message}`);
    }
  }
  throw lastErr ?? new Error(`No downloadable URL for image ${image.id}`);
}

/**
 * Download the original full-size file for metadata extraction.
 * Thumbnails strip EXIF/PNG metadata — must use the original.
 */
async function downloadOriginal(image) {
  // Prefer directUrl (full size) over thumbnail
  const urls = [image.url, image.medium?.url].filter(Boolean);
  let lastErr;
  for (const url of urls) {
    try {
      return await fetchBuffer(url);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error(`Cannot download original for ${image.id}`);
}

// ─── VRCX / VRChat metadata extraction ───────────────────────────────────────

/**
 * Parse PNG tEXt chunks from a raw PNG buffer.
 * Returns a { keyword: value } map of all tEXt chunks found.
 *
 * PNG chunk structure (per spec):
 *   4 bytes: data length (big-endian)
 *   4 bytes: chunk type (ASCII)
 *   N bytes: chunk data
 *   4 bytes: CRC
 *
 * tEXt chunk data: null-terminated keyword + text value (latin-1)
 */
function parsePNGTextChunks(buf) {
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 8 || !buf.slice(0, 8).equals(PNG_SIG)) return {};

  const chunks = {};
  let offset = 8;

  while (offset + 12 <= buf.length) {
    const length   = buf.readUInt32BE(offset);
    const type     = buf.slice(offset + 4, offset + 8).toString('ascii');
    const data     = buf.slice(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IEND') break;

    if (type === 'tEXt' || type === 'iTXt') {
      const nullIdx = data.indexOf(0);
      if (nullIdx !== -1) {
        const keyword = data.slice(0, nullIdx).toString('ascii').trim();
        // iTXt has extra header bytes; tEXt value starts right after null
        const valueStart = type === 'iTXt' ? nullIdx + 3 : nullIdx + 1;
        const value = data.slice(valueStart).toString('utf8').replace(/\0/g, '').trim();
        chunks[keyword] = value;
      }
    }
  }
  return chunks;
}

/**
 * Extract VRChat world metadata from an image buffer.
 *
 * VRCX embeds a JSON blob in the PNG "Description" tEXt chunk:
 * {
 *   "application": "VRChat",
 *   "world": { "name": "...", "id": "wrld_...", "instanceId": "wrld_...:12345~..." },
 *   "author": { "displayName": "..." },
 *   "players": [{ "displayName": "..." }, ...]
 * }
 *
 * Returns null if no VRChat metadata found.
 * Returns { worldName, worldAuthor, worldId, worldUrl, players[] } if found.
 */
async function extractVRCXMetadata(buffer) {
  try {
    // ── Try PNG tEXt / iTXt chunks (VRCX primary storage) ───────────────────
    const textChunks = parsePNGTextChunks(buffer);
    logger.info(`VRCX: PNG text chunks: [${Object.keys(textChunks).join(', ') || 'none'}]`);

    for (const [key, value] of Object.entries(textChunks)) {
      if (!value) continue;
      const lower = value.toLowerCase();
      if (!lower.includes('vrchat') && !lower.includes('wrld_')) continue;

      // ── JSON format (VRCX standard) ─────────────────────────────────────────
      try {
        const json = JSON.parse(value);
        if (json.world?.name) {
          // world.id = "wrld_XXXX" (clean), world.instanceId = full instance string
          const worldId  = json.world.id ?? null;
          const worldUrl = worldId
            ? `https://vrchat.com/home/world/${worldId}`
            : null;

          logger.info(`VRCX: JSON metadata in chunk "${key}": ${json.world.name} (${worldId})`);
          return {
            worldName:   json.world.name,
            worldAuthor: json.author?.displayName ?? null,
            worldId,
            worldUrl,
            players: (json.players ?? []).map(p => p.displayName).filter(Boolean),
          };
        }
      } catch { /* not JSON, try plain-text below */ }

      // ── Plain-text format (older VRChat screenshots) ─────────────────────────
      const worldMatch   = value.match(/World[:\s]+([^\n\r]+)/i);
      const authorMatch  = value.match(/(?:by|Author)[:\s]+([^\n\r(]+)/i);
      // Extract the clean wrld_ ID (stop at colon or whitespace)
      const worldIdMatch = value.match(/wrld_([a-zA-Z0-9_-]+)/);

      if (worldMatch) {
        const worldId  = worldIdMatch ? `wrld_${worldIdMatch[1]}` : null;
        const worldUrl = worldId ? `https://vrchat.com/home/world/${worldId}` : null;
        logger.info(`VRCX: plain-text metadata in chunk "${key}"`);
        return {
          worldName:   worldMatch[1].trim().replace(/ by .*$/, ''),
          worldAuthor: authorMatch ? authorMatch[1].trim() : null,
          worldId,
          worldUrl,
          players: [],
        };
      }
    }

    // ── Fallback: scan raw EXIF for embedded JSON ────────────────────────────
    const meta = await sharp(buffer).metadata();
    if (meta.exif) {
      const exifStr    = meta.exif.toString('utf8');
      const jsonMatch  = exifStr.match(/\{[\s\S]*?"application"\s*:\s*"VRChat"[\s\S]*?\}/);
      if (jsonMatch) {
        try {
          const json = JSON.parse(jsonMatch[0]);
          if (json.world?.name) {
            const worldId  = json.world.id ?? null;
            const worldUrl = worldId ? `https://vrchat.com/home/world/${worldId}` : null;
            logger.info(`VRCX: metadata in EXIF: ${json.world.name}`);
            return {
              worldName:   json.world.name,
              worldAuthor: json.author?.displayName ?? null,
              worldId,
              worldUrl,
              players: (json.players ?? []).map(p => p.displayName).filter(Boolean),
            };
          }
        } catch {}
      }
    }

    logger.info('VRCX: no VRChat metadata found in this image');
    return null;

  } catch (err) {
    logger.warn(`VRCX extractMetadata error: ${err.message}`);
    return null;
  }
}

module.exports = {
  fetchRecentImages,
  weightedSample,
  fetchAlbum,
  fetchAlbumImages,
  fetchUser,
  fetchUserImages,
  downloadImage,
  downloadOriginal,
  extractVRCXMetadata,
};