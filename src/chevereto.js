/**
 * chevereto.js – Chevereto scraper
 *
 * The Chevereto API's image listing endpoint (/api/1/images) is not reliably
 * available. Instead we scrape /explore/recent which is always public and
 * already sorted newest-first.
 *
 * Pagination: /explore/recent?page=2, ?page=3, etc.
 *
 * What we extract per image:
 *   id          – hash from the viewer URL, used to avoid re-posting
 *   url_viewer  – link to the image page on your site
 *   url         – direct image URL (derived from thumbnail)
 *   medium.url  – thumbnail URL (used for download; small enough for Bluesky)
 *   title       – image title / alt text
 *   user        – { username } if visible on the page
 *   tags        – [] (not available from explore page)
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const logger  = require('./logger');

const BASE_URL = process.env.CHEVERETO_BASE_URL?.replace(/\/$/, '');
const BIAS     = parseFloat(process.env.RECENCY_BIAS || '3.0');

// ─── HTML fetcher ─────────────────────────────────────────────────────────────

async function fetchHTML(url) {
  const { data } = await axios.get(url, {
    timeout: 15_000,
    headers: {
      // Mimic a real browser so the site doesn't block the request
      'User-Agent': 'Mozilla/5.0 (compatible; PhotoBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  return data;
}

// ─── Image parsing ────────────────────────────────────────────────────────────

/**
 * Parse one page of /explore/recent and return a normalised image array.
 *
 * Chevereto renders image cards as <li> or <div> elements with:
 *   - A link to the viewer:  href="/image/HASH" or href="/HASH"
 *   - A thumbnail <img>:     src="…/thumbs/HASH.th.jpg"  (or .md.jpg)
 *   - Optional title / user info
 *
 * We try several selector patterns to handle different Chevereto versions
 * and themes.
 */
function parsePage(html, pageUrl) {
  const $ = cheerio.load(html);
  const images = [];

  // ── Find image cards ─────────────────────────────────────────────────────
  // Chevereto uses various class names depending on version/theme.
  // We cast a wide net and deduplicate by viewer URL afterward.
  const cardSelectors = [
    'li[data-type="image"]',       // v3/v4 standard list
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

  // Fallback: any <a> that looks like it links to an image viewer
  if (cards.length === 0) {
    logger.warn('parsePage: no standard card elements found, falling back to link scan');
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (/\/(image\/|img\/)?[a-zA-Z0-9]{5,}$/.test(href)) {
        cards = cards.add(el);
      }
    });
  }

  logger.info(`parsePage: found ${cards.length} cards on ${pageUrl}`);

  cards.each((_, card) => {
    const $card = $(card);

    // ── Viewer URL ─────────────────────────────────────────────────────────
    const viewerHref =
      $card.is('a') ? $card.attr('href') :
      $card.find('a[href]').first().attr('href') || '';

    if (!viewerHref) return; // skip cards with no link

    const viewerUrl = viewerHref.startsWith('http')
      ? viewerHref
      : `${BASE_URL}${viewerHref.startsWith('/') ? '' : '/'}${viewerHref}`;

    // ── Extract ID from URL hash ────────────────────────────────────────────
    // Chevereto viewer URLs: /image/AbC123  or  /AbC123
    const idMatch = viewerUrl.match(/\/(?:image\/|img\/)?([a-zA-Z0-9]{4,})(?:[/?#]|$)/);
    const id = idMatch ? idMatch[1] : viewerUrl;

    // ── Thumbnail URL ──────────────────────────────────────────────────────
    const thumbSrc =
      $card.find('img').first().attr('src') ||
      $card.find('img').first().attr('data-src') || // lazy-loaded
      '';

    const thumbUrl = thumbSrc.startsWith('http')
      ? thumbSrc
      : thumbSrc ? `${BASE_URL}${thumbSrc.startsWith('/') ? '' : '/'}${thumbSrc}` : '';

    // ── Derive full-size URL from thumbnail ────────────────────────────────
    // Common Chevereto patterns:
    //   /images/thumbs/HASH.th.jpg  →  /images/HASH.jpg
    //   /images/HASH.md.jpg         →  /images/HASH.jpg
    const directUrl = thumbUrl
      .replace(/\/thumbs\//, '/')
      .replace(/\.(th|md)\.(jpg|jpeg|png|gif|webp)/i, '.$2');

    // ── Title ──────────────────────────────────────────────────────────────
    const title =
      $card.find('img').first().attr('alt') ||
      $card.find('.list-item-name, .image-title, .item-title').first().text().trim() ||
      $card.attr('data-title') ||
      'Untitled';

    // ── Username ───────────────────────────────────────────────────────────
    const username =
      $card.find('[data-username]').first().attr('data-username') ||
      $card.find('.list-item-user a, .username, .user-link').first().text().trim().replace(/^@/, '') ||
      $card.attr('data-username') ||
      '';

    if (!thumbUrl && !directUrl) return; // skip if we couldn't find any image URL

    images.push({
      id,
      id_encoded: id,
      url:         directUrl || thumbUrl,
      url_viewer:  viewerUrl,
      medium: { url: thumbUrl || directUrl },
      title:   title.slice(0, 200),
      user:    username ? { username } : null,
      tags:    [],
    });
  });

  // Deduplicate by id in case multiple selectors matched the same card
  const seen = new Set();
  return images.filter(img => {
    if (seen.has(img.id)) return false;
    seen.add(img.id);
    return true;
  });
}

// ─── Public: fetch recent images ─────────────────────────────────────────────

async function fetchRecentImages(maxPages = 5) {
  const all = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `${BASE_URL}/explore/recent${page > 1 ? `?page=${page}` : ''}`;
    try {
      logger.info(`Scraping: ${url}`);
      const html = await fetchHTML(url);
      const imgs = parsePage(html, url);
      logger.info(`Chevereto page ${page}: got ${imgs.length} images`);
      all.push(...imgs);

      // If we got fewer than 12 images it's likely the last page
      if (imgs.length < 12) break;

    } catch (err) {
      logger.warn(`fetchRecentImages: page ${page} failed – ${err.message}`);
      break;
    }
  }

  return all;
}

// ─── Recency-weighted sampling ────────────────────────────────────────────────

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
  try {
    const url = `${BASE_URL}/a/${albumIdOrHash}`;
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);
    const title =
      $('h1.album-name, h1.list-title, h1').first().text().trim() ||
      $('title').text().split('–')[0].trim() ||
      albumIdOrHash;
    return { id: albumIdOrHash, name: title, url };
  } catch (err) {
    logger.warn(`fetchAlbum failed: ${err.message}`);
    return null;
  }
}

async function fetchAlbumImages(albumIdOrHash) {
  try {
    const url = `${BASE_URL}/a/${albumIdOrHash}`;
    const html = await fetchHTML(url);
    return parsePage(html, url).slice(0, 20);
  } catch (err) {
    logger.warn(`fetchAlbumImages failed: ${err.message}`);
    return [];
  }
}

// ─── User helpers ─────────────────────────────────────────────────────────────

async function fetchUser(username) {
  try {
    const url = `${BASE_URL}/${username}`;
    const html = await fetchHTML(url);
    const $ = cheerio.load(html);
    const name =
      $('.user-name, .profile-name, h1.username').first().text().trim() ||
      username;
    const totalText = $('.user-images-count, .stat-count').first().text().trim();
    const total = parseInt(totalText.replace(/\D/g, '')) || null;
    return { username, name, images_total: total };
  } catch (err) {
    logger.warn(`fetchUser failed: ${err.message}`);
    return null;
  }
}

async function fetchUserImages(username) {
  try {
    const url = `${BASE_URL}/${username}`;
    const html = await fetchHTML(url);
    return parsePage(html, url).slice(0, 12);
  } catch (err) {
    logger.warn(`fetchUserImages failed: ${err.message}`);
    return [];
  }
}

// ─── Image download ───────────────────────────────────────────────────────────

/**
 * Download the image.
 * Tries the full-size URL first; falls back to thumbnail if it 404s.
 */
async function downloadImage(image) {
  const urls = [
    image.medium?.url,
    image.url,
  ].filter(Boolean);

  let lastErr;
  for (const url of urls) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PhotoBot/1.0)' },
      });
      return {
        buffer:   Buffer.from(response.data),
        mimeType: (response.headers['content-type'] || 'image/jpeg').split(';')[0],
      };
    } catch (err) {
      lastErr = err;
      logger.warn(`downloadImage: ${url} failed (${err.message}), trying next URL`);
    }
  }
  throw lastErr ?? new Error(`No downloadable URL for image ${image.id}`);
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