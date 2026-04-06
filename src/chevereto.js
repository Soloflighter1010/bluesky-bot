/**
 * chevereto.js – Chevereto scraper
 *
 * Scrapes /explore/recent (no API key needed) for image listings.
 * Also handles album and user profile pages.
 * Extracts VRCX/VRChat metadata from image EXIF when present.
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const sharp   = require('sharp');
const logger  = require('./logger');

const BASE_URL = process.env.CHEVERETO_BASE_URL?.replace(/\/$/, '');
const BIAS     = parseFloat(process.env.RECENCY_BIAS || '3.0');

// ─── HTTP fetcher ─────────────────────────────────────────────────────────────

async function fetchHTML(url) {
  const { data } = await axios.get(url, {
    timeout: 15_000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; PhotoBot/1.0)',
      'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  return data;
}

// ─── Image card parser ────────────────────────────────────────────────────────

function parsePage(html, pageUrl) {
  const $ = cheerio.load(html);
  const images = [];

  // Try standard Chevereto card selectors in priority order
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

  // Fallback: scan all links that look like image viewer URLs
  if (cards.length === 0) {
    logger.warn(`parsePage: no card elements on ${pageUrl}, falling back to link scan`);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (/\/(image\/|img\/)?[a-zA-Z0-9]{4,}$/.test(href)) cards = cards.add(el);
    });
  }

  logger.info(`parsePage: found ${cards.length} cards on ${pageUrl}`);

  cards.each((_, card) => {
    const $card = $(card);

    // Viewer URL
    const viewerHref =
      $card.is('a') ? $card.attr('href') :
      $card.find('a[href]').first().attr('href') || '';
    if (!viewerHref) return;

    const viewerUrl = viewerHref.startsWith('http')
      ? viewerHref
      : `${BASE_URL}${viewerHref.startsWith('/') ? '' : '/'}${viewerHref}`;

    // ID from URL
    const idMatch = viewerUrl.match(/\/(?:image\/|img\/)?([a-zA-Z0-9]{4,})(?:[/?#]|$)/);
    const id = idMatch ? idMatch[1] : viewerUrl;

    // Thumbnail — check src and data-src (lazy loading)
    const $img    = $card.find('img').first();
    const thumbSrc = $img.attr('src') || $img.attr('data-src') || '';
    const thumbUrl = thumbSrc.startsWith('http')
      ? thumbSrc
      : thumbSrc ? `${BASE_URL}${thumbSrc.startsWith('/') ? '' : '/'}${thumbSrc}` : '';

    // Derive full-size URL by removing thumbnail suffixes
    const directUrl = thumbUrl
      .replace(/\/thumbs\//, '/')
      .replace(/\.(th|md)\.(jpg|jpeg|png|gif|webp)/i, '.$2');

    if (!thumbUrl && !directUrl) return;

    // Title
    const title =
      $img.attr('alt') ||
      $card.find('.list-item-name, .image-title, .item-title').first().text().trim() ||
      $card.attr('data-title') || 'Untitled';

    // Username
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

  // Deduplicate by id
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
    // Chevereto explore pagination: /explore/recent (p1), /explore/recent?page=2
    const url = page === 1
      ? `${BASE_URL}/explore/recent`
      : `${BASE_URL}/explore/recent?page=${page}`;

    try {
      logger.info(`Scraping: ${url}`);
      const html = await fetchHTML(url);
      const imgs = parsePage(html, url);
      logger.info(`Chevereto page ${page}: got ${imgs.length} images`);
      all.push(...imgs);

      // Stop only when a page comes back completely empty
      if (imgs.length === 0) break;

    } catch (err) {
      logger.warn(`fetchRecentImages: page ${page} failed – ${err.message}`);
      break;
    }
  }

  return all;
}

// ─── Weighted sampling ────────────────────────────────────────────────────────

function weightedSample(images, n, excludeIds = []) {
  const pool = images.filter(img => !excludeIds.includes(img.id_encoded ?? img.id));
  if (pool.length === 0) return [];

  const N      = pool.length;
  const weights     = pool.map((_, i) => Math.pow(N - i, BIAS));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const picked = [];
  const used   = new Set();

  while (picked.length < Math.min(n, pool.length)) {
    let r = Math.random() * totalWeight;
    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue;
      r -= weights[i];
      if (r <= 0) { picked.push(pool[i]); used.add(i); break; }
    }
  }
  return picked;
}

// ─── Album helpers ────────────────────────────────────────────────────────────

async function fetchAlbum(albumIdOrHash) {
  // Try several URL formats Chevereto uses across versions
  const attempts = [
    `${BASE_URL}/a/${albumIdOrHash}`,
    `${BASE_URL}/album/${albumIdOrHash}`,
    `${BASE_URL}/albums/${albumIdOrHash}`,
  ];

  for (const url of attempts) {
    try {
      const html = await fetchHTML(url);
      const $    = cheerio.load(html);

      // If we landed on a 404 / empty page, skip
      const notFound = $('title').text().toLowerCase().includes('not found') ||
                       $('title').text().toLowerCase().includes('error') ||
                       $('body').text().trim().length < 100;
      if (notFound) continue;

      const title =
        $('h1.album-name, h1.list-title, .album-name, h1').first().text().trim() ||
        $('title').text().split(/[–—|]/)[0].trim() ||
        albumIdOrHash;

      logger.info(`fetchAlbum: found "${title}" at ${url}`);
      return { id: albumIdOrHash, name: title, url };

    } catch (err) {
      logger.warn(`fetchAlbum: ${url} failed – ${err.message}`);
    }
  }

  logger.warn(`fetchAlbum: all URL formats failed for ${albumIdOrHash}`);
  return null;
}

async function fetchAlbumImages(albumIdOrHash) {
  const attempts = [
    `${BASE_URL}/a/${albumIdOrHash}`,
    `${BASE_URL}/album/${albumIdOrHash}`,
  ];

  for (const url of attempts) {
    try {
      const html = await fetchHTML(url);
      const imgs = parsePage(html, url);
      if (imgs.length > 0) return imgs.slice(0, 20);
    } catch (err) {
      logger.warn(`fetchAlbumImages: ${url} – ${err.message}`);
    }
  }
  return [];
}

// ─── User helpers ─────────────────────────────────────────────────────────────

async function fetchUser(username) {
  // Try the user's image listing page directly — more reliable than the profile root
  const urls = [
    `${BASE_URL}/${username}/images`,
    `${BASE_URL}/${username}`,
  ];

  for (const url of urls) {
    try {
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);

      const notFound = $('title').text().toLowerCase().includes('not found') ||
                       $('body').text().trim().length < 100;
      if (notFound) continue;

      const name =
        $('.user-name, .profile-name, h1.username, .user-display-name').first().text().trim() ||
        username;

      const totalText = $('.user-images-count, .stat-count, [data-image-count]').first().text().trim();
      const total = parseInt(totalText.replace(/\D/g, '')) || null;

      logger.info(`fetchUser: found "${name}" at ${url}`);
      return { username, name, images_total: total };

    } catch (err) {
      logger.warn(`fetchUser: ${url} – ${err.message}`);
    }
  }

  return null;
}

async function fetchUserImages(username) {
  // /username/images is the most reliable Chevereto user gallery URL
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
      logger.warn(`fetchUserImages: ${url} – ${err.message}`);
    }
  }

  logger.warn(`fetchUserImages: no images found for @${username}`);
  return [];
}

// ─── Image download ───────────────────────────────────────────────────────────

async function downloadImage(image) {
  const urls = [image.medium?.url, image.url].filter(Boolean);
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
      logger.warn(`downloadImage: ${url} failed – ${err.message}`);
    }
  }
  throw lastErr ?? new Error(`No downloadable URL for image ${image.id}`);
}

// ─── VRCX / VRChat metadata extraction ───────────────────────────────────────

/**
 * Try to extract VRChat world metadata from image EXIF/XMP.
 * VRCX embeds world info in the image description or XMP fields.
 *
 * Returns null if no VRChat metadata found.
 * Returns { worldName, worldAuthor, instanceId } if found.
 */
async function extractVRCXMetadata(buffer) {
  try {
    const meta = await sharp(buffer).metadata();

    // XMP comes back as a raw XML Buffer
    if (meta.xmp) {
      const xmpStr = meta.xmp.toString('utf8');
      const result = parseVRCXml(xmpStr);
      if (result) return result;
    }

    // EXIF comes back as a raw Buffer — decode to string and scan
    if (meta.exif) {
      const exifStr = meta.exif.toString('binary');
      const result = parseVRCXml(exifStr);
      if (result) return result;
    }

  } catch (err) {
    logger.debug?.(`extractVRCXMetadata: ${err.message}`);
  }
  return null;
}

function parseVRCXml(text) {
  if (!text) return null;
  if (!text.toLowerCase().includes('vrchat') && !text.toLowerCase().includes('vrcx')) return null;

  // VRCX format typically: "World: WorldName by AuthorName (instance wrld_xxx:12345~region(us))"
  // or stored in XMP dc:description / xmp:Description
  const worldMatch   = text.match(/[Ww]orld[:\s]+([^\n\r<"]+)/);
  const authorMatch  = text.match(/(?:by|[Aa]uthor)[:\s]+([^\n\r<"(]+)/);
  const instanceMatch = text.match(/(?:wrld_[a-zA-Z0-9_]+:[0-9]+[^\s<"]*)/);

  if (!worldMatch) return null;

  return {
    worldName:  worldMatch[1].trim().replace(/ by .*$/, ''),
    worldAuthor: authorMatch ? authorMatch[1].trim() : null,
    instanceId:  instanceMatch ? instanceMatch[0].trim() : null,
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
  extractVRCXMetadata,
};