/**
 * imagerender.js – on-demand image renderer for Buffer crossposts
 *
 * Twitter and Instagram currently get their images from Chevereto's own
 * `.md.` thumbnail variant, which is deliberately downscaled (~1280px,
 * lower JPEG quality) for fast page loads on the photo site itself.
 * That's noticeably softer than what Bluesky gets — the bot's own upload,
 * compressed only as much as Bluesky's 1MB blob cap actually requires.
 *
 * This module exposes a signed-URL endpoint that re-derives a much
 * higher quality JPEG on demand from the *original* Chevereto file —
 * resized to a size that comfortably clears Twitter/Instagram's limits
 * while looking dramatically sharper than the stock medium thumbnail —
 * for Buffer to fetch instead of the original .md. URL.
 *
 * Signing keeps this from becoming an open image proxy: the signature is
 * derived from the shared SESSION_SECRET (see secrets.js — no new env var
 * needed for this part) and every request is checked against
 * CHEVERETO_BASE_URL, so it can only ever re-render images already
 * publicly hosted on your own Chevereto instance.
 *
 * Requires PUBLIC_BASE_URL (e.g. https://photobot.yourdomain.com) to be
 * set — this is the externally-reachable origin Buffer's servers need to
 * fetch from. If it's not set, callers should fall back to the original
 * Chevereto URL rather than crashing; see buildRenderUrl's return value.
 */

const crypto = require('crypto');
const axios  = require('axios');
const sharp  = require('sharp');
const logger = require('./logger');
const { SESSION_SECRET } = require('./secrets');

const CHEVERETO_BASE = (process.env.CHEVERETO_BASE_URL || '').replace(/\/$/, '');
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');

const LONG_EDGE    = 2048; // px — comfortably sharper than Chevereto's ~1280px .md. variant
const JPEG_QUALITY = 88;
const SIG_TTL_MS   = 24 * 60 * 60 * 1000; // 24h — plenty of slack for Buffer's fetch queue

let warnedNoPublicUrl = false;

function derivedKey() {
  return crypto.createHmac('sha256', SESSION_SECRET).update('photobot-render-v1').digest();
}

function sign(src, exp) {
  return crypto.createHmac('sha256', derivedKey()).update(`${src}|${exp}`).digest('hex');
}

/**
 * Build a signed render URL for a given original Chevereto image URL.
 * Returns null if PUBLIC_BASE_URL isn't configured or src isn't on our
 * own Chevereto instance — callers should fall back to the plain
 * Chevereto URL in that case rather than breaking the post.
 */
function buildRenderUrl(src) {
  if (!src) return null;

  if (!PUBLIC_BASE_URL) {
    if (!warnedNoPublicUrl) {
      logger.warn('imagerender: PUBLIC_BASE_URL not set — Twitter/Instagram will keep using Chevereto\'s standard .md. thumbnail instead of the higher-quality render. Set PUBLIC_BASE_URL in .env (e.g. https://photobot.yourdomain.com) to enable it.');
      warnedNoPublicUrl = true;
    }
    return null;
  }
  if (!CHEVERETO_BASE || !src.startsWith(CHEVERETO_BASE + '/')) return null;

  const exp = Date.now() + SIG_TTL_MS;
  const sig = sign(src, exp);
  const qs  = new URLSearchParams({ src, exp: String(exp), sig });
  return `${PUBLIC_BASE_URL}/api/render?${qs.toString()}`;
}

function verify(src, exp, sig) {
  if (!src || !exp || !sig) return false;
  if (Date.now() > Number(exp)) return false;
  if (!CHEVERETO_BASE || !src.startsWith(CHEVERETO_BASE + '/')) return false;

  const expected = sign(src, exp);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Express request handler for GET /api/render?src=...&exp=...&sig=...
 * Deliberately unauthenticated (Buffer's servers need to fetch it) —
 * the signature is what gates access, not a session/secret header.
 */
async function renderHandler(req, res) {
  const { src, exp, sig } = req.query;

  if (!verify(src, exp, sig)) {
    logger.warn(`imagerender: rejected request for ${src || '(missing src)'}`);
    return res.status(403).json({ error: 'Invalid or expired render request' });
  }

  try {
    const { data } = await axios.get(src, {
      responseType: 'arraybuffer',
      timeout: 20_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PhotoBot/1.0)' },
    });

    const jpeg = await sharp(Buffer.from(data))
      .resize(LONG_EDGE, LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, progressive: true })
      .toBuffer();

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.send(jpeg);
  } catch (err) {
    logger.warn(`imagerender: failed to render ${src} — ${err.message}`);
    res.status(502).json({ error: 'Could not render image' });
  }
}

module.exports = { buildRenderUrl, renderHandler };