/**
 * kutt.js — Kutt.it URL shortener integration
 *
 * Maintains a persistent JSON cache of long URL → short URL mappings so the
 * API is only ever called for URLs we haven't seen before. VRChat world URLs
 * and Chevereto viewer URLs are stable once created, so the cache accumulates
 * naturally over time and API calls become increasingly rare.
 *
 * Uses Kutt's `reuse: true` flag as a server-side safety net — if the local
 * cache is ever lost or corrupted, Kutt will return the same short URL it
 * already generated rather than creating a duplicate.
 *
 * Never throws. If KUTT_API_URL or KUTT_API_KEY aren't set, or if the API
 * call fails for any reason, the original URL is returned unchanged — URL
 * shortening is optional infrastructure that should never block a post.
 *
 * Env vars (add to .env):
 *   KUTT_API_URL    Base URL of your Kutt instance, e.g. https://knowbody.link
 *   KUTT_API_KEY    API key from your Kutt dashboard (Settings → API)
 *
 * docker-compose.yml sets:
 *   KUTT_CACHE_FILE=/app/data/kutt-cache.json  (persisted in the named volume)
 */

const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const logger = require('./logger');

const KUTT_API_URL = (process.env.KUTT_API_URL || '').replace(/\/$/, '').trim();
const KUTT_API_KEY = (process.env.KUTT_API_KEY || '').trim();
const CACHE_FILE   = process.env.KUTT_CACHE_FILE
  || path.join(__dirname, '..', 'kutt-cache.json');

// In-memory cache: long URL → short URL string
const cache = new Map();
let cacheLoaded = false;
let warnedUnconfigured = false;

// ─── Cache I/O ────────────────────────────────────────────────────────────────

function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      for (const [k, v] of Object.entries(saved)) cache.set(k, v);
      logger.info(`kutt: loaded ${cache.size} cached URL(s) from ${CACHE_FILE}`);
    }
  } catch (err) {
    logger.warn(`kutt: could not read cache — ${err.message}`);
  }
}

function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache), null, 2));
  } catch (err) {
    logger.error(`kutt: could not write cache — ${err.message}`);
  }
}

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Shorten a single URL.
 *
 * Returns the short URL on success, or the original URL if shortening is not
 * configured or the API call fails. Saves the result to the persistent cache
 * so subsequent calls for the same URL never hit the API.
 */
async function shorten(longUrl) {
  if (!longUrl) return longUrl;

  if (!KUTT_API_URL || !KUTT_API_KEY) {
    if (!warnedUnconfigured) {
      logger.info('kutt: KUTT_API_URL or KUTT_API_KEY not set — URL shortening disabled. Add both to .env to enable it.');
      warnedUnconfigured = true;
    }
    return longUrl;
  }

  loadCache();
  if (cache.has(longUrl)) return cache.get(longUrl);

  try {
    const { data } = await axios.post(
      `${KUTT_API_URL}/api/v2/links`,
      { target: longUrl, reuse: true },
      {
        timeout: 8_000,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key':    KUTT_API_KEY,
        },
      }
    );

    // Kutt v2 returns short_url; some self-hosted forks use link instead
    const shortUrl = data.short_url || data.link;
    if (!shortUrl) {
      throw new Error(`unexpected response shape: ${JSON.stringify(data).slice(0, 120)}`);
    }

    cache.set(longUrl, shortUrl);
    saveCache();
    logger.info(`kutt: shortened ${longUrl} → ${shortUrl}`);
    return shortUrl;

  } catch (err) {
    const detail = err.response?.data?.error ?? err.message;
    logger.warn(`kutt: failed to shorten ${longUrl} — ${detail}`);
    return longUrl; // graceful fallback — post continues with the original URL
  }
}

/**
 * Shorten multiple URLs concurrently.
 *
 * Returns a Map<longUrl, shortUrl>. Any URL that fails to shorten maps to
 * itself, so callers can always do `urlMap.get(url) ?? url` safely.
 * Deduplicates inputs so the same URL never triggers more than one API call.
 */
async function shortenMany(urls) {
  loadCache();

  const unique  = [...new Set(urls.filter(Boolean))];
  const results = await Promise.all(unique.map(async u => [u, await shorten(u)]));
  return new Map(results);
}

/**
 * Current number of cached URL mappings — for dashboard display or logging.
 */
function cacheSize() {
  loadCache();
  return cache.size;
}

module.exports = { shorten, shortenMany, cacheSize };