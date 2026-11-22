/**
 * vrchat.js – minimal, read-only VRChat API client
 *
 * Used only to fetch a world's author-set tags for the /worlds heatmap page.
 * Hits VRChat's community-reverse-engineered API (not officially documented
 * or supported by VRChat — see https://vrchat.community) at the
 * unauthenticated "Get World by ID" endpoint. That endpoint works without
 * login; some numeric fields (visit counts, favorites, etc.) come back as 0
 * when unauthenticated, but none of those are used here.
 *
 * VRChat requires API clients to identify themselves with a proper
 * User-Agent — format "appName/version contactInfo" — and warns that
 * identifying improperly can result in moderation action against the
 * request. Set VRCHAT_API_CONTACT in .env (an email or a URL is fine) to
 * comply. Falls back to a placeholder with a one-time warning if unset,
 * rather than failing outright — but this should be set for real use.
 */

const axios  = require('axios');
const logger = require('./logger');

const VRCHAT_API = 'https://api.vrchat.cloud/api/1';
const CONTACT    = (process.env.VRCHAT_API_CONTACT || '').trim();

let warnedNoContact = false;
function userAgent() {
  if (!CONTACT && !warnedNoContact) {
    logger.warn('vrchat: VRCHAT_API_CONTACT not set — using a placeholder User-Agent. VRChat requires clients to identify themselves properly (format: appName/version contactInfo); set VRCHAT_API_CONTACT in .env — an email or URL is fine.');
    warnedNoContact = true;
  }
  return `PhotoBot/1.0 ${CONTACT || '(contact not configured)'}`;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/**
 * Extract the author's own descriptive tags from VRChat's raw tag array,
 * which also mixes in system/admin/feature/event tags that say nothing
 * about what kind of world it is. Strips the author_tag_ namespace and
 * formats for display: "author_tag_cozy_hangout" -> "Cozy Hangout".
 * Deliberately excludes content_* (content warnings) — those are set via
 * a separate checkbox in the upload flow, not the free-text tag field this
 * feature is about.
 */
function extractAuthorTags(rawTags) {
  return (rawTags || [])
    .filter(t => typeof t === 'string' && t.startsWith('author_tag_'))
    .map(t => t
      .slice('author_tag_'.length)
      .split('_')
      .filter(Boolean)
      .map(w => w[0].toUpperCase() + w.slice(1))
      .join(' ')
    )
    .filter(Boolean);
}

/**
 * Fetch up to the first 2 author-set tags for a world.
 *
 * Returns { ok: true, tags: [...] } on success (tags may be an empty array
 * if the world genuinely has none — that's a valid, final answer, not a
 * failure). Returns { ok: false, tags: [] } if the fetch never succeeded
 * after retries — callers should treat this as "unknown for now" and leave
 * the door open to try again later, rather than caching a false negative.
 */
async function fetchWorldTags(worldId, attempt = 1) {
  try {
    const { data } = await axios.get(`${VRCHAT_API}/worlds/${worldId}`, {
      timeout: 10_000,
      headers: { 'User-Agent': userAgent() },
    });
    const tags = extractAuthorTags(data.tags).slice(0, 2);
    return { ok: true, tags };
  } catch (err) {
    const status = err.response?.status;
    if (status === 429 && attempt <= 3) {
      const wait = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      logger.warn(`vrchat: rate limited fetching tags for ${worldId} — retrying in ${wait}ms (attempt ${attempt}/3)`);
      await sleep(wait);
      return fetchWorldTags(worldId, attempt + 1);
    }
    logger.warn(`vrchat: could not fetch tags for ${worldId} — ${status ? `HTTP ${status}` : err.message}`);
    return { ok: false, tags: [] };
  }
}

module.exports = { fetchWorldTags, extractAuthorTags };