/**
 * crosspost.js – Buffer API integration for X & Instagram
 *
 * Schedules posts on Buffer after successful Bluesky posting.
 * Handles per-platform formatting, image resizing, and error recovery.
 */

const axios   = require('axios');
const sharp   = require('sharp');
const logger  = require('./logger');

const BUFFER_API = 'https://api.bufferapp.com/1';
const BUFFER_TOKEN = (process.env.BUFFER_API_KEY || '').trim();

// Image dimensions for each platform (Buffer will center-crop)
const IMAGE_SPECS = {
  x: {
    width:          1200,
    height:         675,
    minChars:       1,
    maxChars:       280,
    name:           'X (formerly Twitter)',
  },
  instagram: {
    width:          1080,
    height:         1350,
    minChars:       1,
    maxChars:       2200,
    name:           'Instagram',
  },
};

// ─── Buffer API wrapper ────────────────────────────────────────────────────────

async function bufferFetch(method, endpoint, data = null) {
  if (!BUFFER_TOKEN) {
    logger.warn('crosspost: BUFFER_API_KEY not set, skipping Buffer');
    return null;
  }

  try {
    const config = {
      method,
      url: `${BUFFER_API}${endpoint}`,
      headers: {
        'Authorization': `Bearer ${BUFFER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    };
    if (data) config.data = data;

    const res = await axios(config);
    return res.data;
  } catch (err) {
    logger.error(`Buffer API error (${method} ${endpoint}): ${err.message}`);
    if (err.response?.data) logger.error(`  Details: ${JSON.stringify(err.response.data)}`);
    return null;
  }
}

// ─── Get user's Buffer profiles ────────────────────────────────────────────────

async function getProfiles() {
  const data = await bufferFetch('GET', '/profiles.json');
  if (!data?.profiles) return [];

  // Filter to X and Instagram only
  return data.profiles.filter(p => ['twitter', 'instagram'].includes(p.service));
}

async function getProfileByService(service) {
  const profiles = await getProfiles();
  return profiles.find(p => p.service === service) ?? null;
}

// ─── Image preparation ────────────────────────────────────────────────────────

/**
 * Resize image to platform spec and return base64.
 * Sharp will center-crop if aspect ratio doesn't match.
 */
async function prepareImageForPlatform(buffer, platform) {
  const spec = IMAGE_SPECS[platform];
  if (!spec) {
    logger.warn(`prepareImageForPlatform: unknown platform ${platform}`);
    return null;
  }

  try {
    const resized = await sharp(buffer)
      .resize(spec.width, spec.height, {
        fit: 'cover',      // center-crop to exact dimensions
        position: 'center',
      })
      .toBuffer();

    return resized.toString('base64');
  } catch (err) {
    logger.error(`prepareImageForPlatform(${platform}): ${err.message}`);
    return null;
  }
}

// ─── Text formatting ──────────────────────────────────────────────────────────

/**
 * Trim text to platform's character limit, preserving URLs at end.
 * If URLs don't fit, return main text + "..." and append as separate message.
 */
function fitTextToPlatform(mainText, urls, platform) {
  const spec = IMAGE_SPECS[platform];
  const urlStr = urls.join('\n');

  // Try: main text + newlines + URLs
  const full = mainText + '\n\n' + urlStr;
  if (full.length <= spec.maxChars) {
    return { text: full, overflow: null };
  }

  // Try: main text only
  if (mainText.length <= spec.maxChars) {
    return { text: mainText, overflow: urlStr };
  }

  // Truncate main text, append ellipsis, leave room for URLs
  const room = spec.maxChars - urlStr.length - 4; // 4 = "\n\n…\n"
  if (room > 20) {
    const truncated = mainText.slice(0, room) + '…';
    return { text: truncated + '\n\n' + urlStr, overflow: null };
  }

  // Last resort: just main text with ellipsis
  return { text: mainText.slice(0, spec.maxChars - 1) + '…', overflow: null };
}

/**
 * Build post text for each platform, including VRCX metadata and Chevereto links.
 *
 * For X: compact with hashtags
 * For Instagram: full text, hashtags can be in first comment (optional, we put in main)
 *
 * Returns: { x: { text, overflow }, instagram: { text, overflow } }
 */
function formatPostsForPlatforms(images, templates, customTags = [], userMappings = {}, vrcxByImageId = {}) {
  // Build URLs
  const urls = [];

  // Chevereto viewer links
  const imageLinks = images
    .map((img, i) => `${i + 1}. ${img.url_viewer}`)
    .slice(0, 4);
  urls.push('🔗 Chevereto:');
  urls.push(...imageLinks);

  // Group VRCX worlds if any exist
  const worldsMap = new Map();
  for (const img of images) {
    const vrcx = vrcxByImageId[img.id];
    if (!vrcx) continue;
    const key = vrcx.worldId || vrcx.worldName;
    if (!worldsMap.has(key)) {
      worldsMap.set(key, { vrcx, indices: [] });
    }
    worldsMap.get(key).indices.push(images.indexOf(img) + 1);
  }

  if (worldsMap.size > 0) {
    urls.push('\n🌍 Worlds:');
    for (const { vrcx, indices } of worldsMap.values()) {
      const label = indices.length === 1
        ? `[Img ${indices[0]}]`
        : `[Img ${indices.slice(0, -1).join(',')} & ${indices[indices.length - 1]}]`;
      urls.push(`${label} ${vrcx.worldName}`);
      if (vrcx.worldUrl) urls.push(vrcx.worldUrl);
    }
  }

  // Main text (usernames + titles)
  const usernames = [...new Set(
    images.map(img => img.user?.username).filter(Boolean)
  )].map(u => {
    const mapped = userMappings[u];
    return mapped ? `@${mapped}` : `@${u}`;
  }).join(' ');

  const titles = images
    .map(img => {
      if (!img.title) return null;
      const VRC_RE = /^VRChat_\d{4}-\d{2}-\d{2}_[\d-]+\.\d+_\d+x\d+\.png$/i;
      return VRC_RE.test(img.title.trim()) ? null : img.title;
    })
    .filter(Boolean)
    .slice(0, 2)
    .join(' · ');

  const tags = customTags.length ? customTags.join(' ') : '#photography';
  const mainText = [usernames, titles, tags].filter(Boolean).join('\n');

  return {
    x: fitTextToPlatform(mainText, urls.slice(0, 3), 'x'), // X: keep it short
    instagram: fitTextToPlatform(mainText, urls, 'instagram'), // IG: full details
  };
}

// ─── Post to Buffer ────────────────────────────────────────────────────────────

/**
 * Post to a single Buffer profile.
 *
 * text       — post caption
 * mediaBase64 — array of base64-encoded images (Buffer accepts up to 4)
 * profileId  — Buffer profile ID
 *
 * Returns success boolean.
 */
async function postToBuffer(text, mediaBase64 = [], profileId) {
  const payload = {
    text,
    media: mediaBase64.length > 0
      ? { link: mediaBase64[0] } // Buffer API: provide base64 directly
      : undefined,
    profile_ids: [profileId],
    now: false, // Schedule for next available time
  };

  const result = await bufferFetch('POST', '/updates/create.json', payload);
  return !!result?.updates?.length;
}

// ─── Main crosspost entry point ────────────────────────────────────────────────

/**
 * Called after Bluesky post succeeds.
 * Formats post for X & Instagram, downloads images, resizes, and sends to Buffer.
 *
 * entries: [{ image, blob }] – from bsky.postPhotosWithText
 * text: final post text that was sent to Bluesky
 * state: app state (for templates, mappings, custom tags)
 * vrcxByImageId: { imageId → { worldName, worldUrl, ... } }
 */
async function triggerCrosspost(entries, text, state, vrcxByImageId = {}) {
  if (!BUFFER_TOKEN) {
    logger.info('crosspost: disabled (no BUFFER_API_KEY)');
    return;
  }

  logger.info(`crosspost: processing ${entries.length} images for X & Instagram`);

  try {
    // ── Fetch user's profiles ──────────────────────────────────────────────
    const profiles = await getProfiles();
    if (profiles.length === 0) {
      logger.warn('crosspost: no X or Instagram profiles connected to Buffer account');
      return;
    }

    const xProfile = profiles.find(p => p.service === 'twitter');
    const igProfile = profiles.find(p => p.service === 'instagram');

    if (!xProfile && !igProfile) {
      logger.warn('crosspost: no X or Instagram profiles available');
      return;
    }

    // ── Prepare images for each platform ───────────────────────────────────
    const images = entries.map(e => e.image);
    const platformTexts = formatPostsForPlatforms(
      images,
      state.templates,
      state.customTags ?? [],
      state.userMappings ?? {},
      vrcxByImageId
    );

    logger.info(`crosspost: formatted for X and Instagram`);

    // ── Resize images ────────────────────────────────────────────────────
    const imageBuffers = entries
      .map(e => e.blob?.imageBuffer || e.imageBuffer)
      .filter(Boolean)
      .slice(0, 4); // Buffer max 4 images per post

    if (imageBuffers.length === 0) {
      logger.warn('crosspost: no image buffers available, posting text only');
    }

    const xImages = [];
    const igImages = [];

    for (const buf of imageBuffers) {
      const xBase64 = await prepareImageForPlatform(buf, 'x');
      const igBase64 = await prepareImageForPlatform(buf, 'instagram');
      if (xBase64) xImages.push(xBase64);
      if (igBase64) igImages.push(igBase64);
    }

    // ── Post to X ────────────────────────────────────────────────────────
    if (xProfile) {
      const xText = platformTexts.x.text;
      const xOk = await postToBuffer(xText, xImages, xProfile.id);
      if (xOk) {
        logger.info(`crosspost: X post queued — "${xText.slice(0, 60)}…"`);
        state.stats.xPosted = (state.stats.xPosted ?? 0) + 1;
      } else {
        logger.warn('crosspost: X post failed');
      }

      // If text was truncated, try posting the overflow as a reply
      if (platformTexts.x.overflow) {
        const overflowOk = await postToBuffer(platformTexts.x.overflow, [], xProfile.id);
        if (overflowOk) {
          logger.info('crosspost: X overflow posted as follow-up');
        }
      }
    }

    // ── Post to Instagram ────────────────────────────────────────────────
    if (igProfile) {
      const igText = platformTexts.instagram.text;
      const igOk = await postToBuffer(igText, igImages, igProfile.id);
      if (igOk) {
        logger.info(`crosspost: Instagram post queued — "${igText.slice(0, 60)}…"`);
        state.stats.instagramPosted = (state.stats.instagramPosted ?? 0) + 1;
      } else {
        logger.warn('crosspost: Instagram post failed');
      }

      if (platformTexts.instagram.overflow) {
        const overflowOk = await postToBuffer(platformTexts.instagram.overflow, [], igProfile.id);
        if (overflowOk) {
          logger.info('crosspost: Instagram overflow posted as follow-up');
        }
      }
    }

  } catch (err) {
    logger.error(`crosspost: fatal error: ${err.message}\n${err.stack}`);
    // Don't re-throw — crosspost failure shouldn't break Bluesky posting
  }
}

module.exports = { triggerCrosspost, getProfiles, getProfileByService };
