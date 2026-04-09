/**
 * webhook.js – outbound webhook for crossposting via Make / Zapier / Buffer
 *
 * After every successful Bluesky post the bot fires a POST request to a
 * configurable URL with a structured JSON payload containing everything a
 * downstream automation needs to crosspost the same content.
 *
 * Payload shape:
 * {
 *   event:        "post" | "spotlight" | "album",
 *   postedAt:     ISO timestamp,
 *   blueskyUrl:   "https://bsky.app/profile/.../post/...",  // direct post link
 *   text:         string,                                   // main post text
 *   images: [
 *     {
 *       viewerUrl:  string,    // Chevereto image page
 *       directUrl:  string,    // full-size image file URL
 *       altText:    string,    // what went into Bluesky alt text
 *       vrcx: {               // null if no VRCX metadata
 *         worldName: string,
 *         worldUrl:  string,
 *         worldId:   string,
 *       } | null
 *     }
 *   ],
 *   worlds: [                 // deduplicated list of unique worlds in this post
 *     { worldName, worldUrl, worldId, imageNumbers: number[] }
 *   ],
 *   photographers: string[],  // Bluesky handles if mapped, otherwise Chevereto usernames
 *   replyText:     string,    // full world-info reply text (ready to append to caption)
 *   linkText:      string,    // full image-links reply text
 * }
 */

const axios  = require('axios');
const logger = require('./logger');

/**
 * Fire the webhook if one is configured.
 * Non-blocking — errors are logged but never throw to the caller.
 */
async function sendWebhook(state, payload) {
  const url     = state.webhookUrl?.trim();
  const enabled = state.webhookEnabled !== false; // default true if url is set

  if (!url || !enabled) return;

  try {
    logger.info(`Webhook: firing to ${url} (event=${payload.event})`);
    await axios.post(url, payload, {
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });
    logger.info('Webhook: delivered successfully');
  } catch (err) {
    logger.warn(`Webhook: delivery failed — ${err.message}`);
  }
}

/**
 * Build the webhook payload after a regular batch post.
 *
 * @param {object}   postRef       — { uri, cid } returned by Bluesky
 * @param {string}   text          — main post text
 * @param {Array}    downloaded    — [{ image, blob }] from postBatch
 * @param {object}   vrcxByImageId — { imageId: vrcxData }
 * @param {object}   userMappings  — { chevUser: bskyHandle }
 */
function buildBatchPayload(postRef, text, downloaded, vrcxByImageId, userMappings = {}) {
  const blueskyUrl = postRefToUrl(postRef);

  const images = downloaded.map(({ image }) => {
    const vrcx = vrcxByImageId[image.id] ?? null;
    return {
      viewerUrl:    image.url_viewer  || '',
      directUrl:    image.url         || '',
      thumbnailUrl: image.medium?.url || image.url || '',  // web-sized, safe for Instagram/X
      altText:    vrcx
        ? (vrcx.worldUrl ? `${vrcx.worldName} | ${vrcx.worldUrl}` : vrcx.worldName)
        : '',
      vrcx: vrcx ? {
        worldName: vrcx.worldName,
        worldUrl:  vrcx.worldUrl  || '',
        worldId:   vrcx.worldId   || '',
      } : null,
    };
  });

  // Deduplicated world list with which image numbers belong to each
  const worldMap = new Map();
  for (let i = 0; i < downloaded.length; i++) {
    const { image } = downloaded[i];
    const vrcx      = vrcxByImageId[image.id];
    if (!vrcx) continue;
    const key = vrcx.worldId || vrcx.worldName;
    if (!worldMap.has(key)) worldMap.set(key, { worldName: vrcx.worldName, worldUrl: vrcx.worldUrl || '', worldId: vrcx.worldId || '', imageNumbers: [] });
    worldMap.get(key).imageNumbers.push(i + 1);
  }
  const worlds = [...worldMap.values()];

  // World info text (mirrors what went into the reply thread)
  const worldLines = worlds.length ? ['🌍 World Information'] : [];
  for (const w of worlds) {
    const nums  = w.imageNumbers;
    const label = nums.length === 1
      ? `Image ${nums[0]}`
      : `Images ${nums.slice(0, -1).join(', ')} & ${nums[nums.length - 1]}`;
    worldLines.push(`${label} — ${w.worldName}`);
    if (w.worldUrl) worldLines.push(`Visit: ${w.worldUrl}`);
  }

  // Image links text
  const linkLines = ['🔗 View on Chevereto'];
  for (let i = 0; i < downloaded.length; i++) {
    const { image } = downloaded[i];
    if (image.url_viewer) linkLines.push(`Image ${i + 1}: ${image.url_viewer}`);
  }

  // Resolve Bluesky handles for photographers
  const photographers = [...new Set(
    downloaded.map(d => d.image.user?.username).filter(Boolean)
  )].map(u => userMappings[u] ? `@${userMappings[u]}` : `@${u}`);

  return {
    event:         'post',
    postedAt:      new Date().toISOString(),
    blueskyUrl,
    text,
    images,
    worlds,
    photographers,
    replyText:     worldLines.join('\n'),
    linkText:      linkLines.join('\n'),
  };
}

/**
 * Build the webhook payload after a member spotlight post.
 */
function buildSpotlightPayload(postRef, text, entries, highlight, userMappings = {}) {
  const blueskyUrl = postRefToUrl(postRef);

  const images = entries.map(({ image, altText }) => ({
    viewerUrl:    image.url_viewer  || '',
    directUrl:    image.url         || '',
    thumbnailUrl: image.medium?.url || image.url || '',
    altText:      altText || '',
    vrcx:         null,
    role:         image.spotlightRole || '',
  }));

  const linkLines = ['🔗 View on Chevereto'];
  for (let i = 0; i < entries.length; i++) {
    const { image } = entries[i];
    if (image.url_viewer) linkLines.push(`Image ${i + 1}: ${image.url_viewer}`);
  }

  const username = highlight.username;
  const handle   = userMappings[username]
    ? `@${userMappings[username]}`
    : `@${username}`;

  return {
    event:         'spotlight',
    postedAt:      new Date().toISOString(),
    blueskyUrl,
    text,
    images,
    worlds:        [],
    photographers: [handle],
    replyText:     '',
    linkText:      linkLines.join('\n'),
  };
}

/**
 * Build the webhook payload after an album highlight post.
 */
function buildAlbumPayload(postRef, text, highlight) {
  return {
    event:         'album',
    postedAt:      new Date().toISOString(),
    blueskyUrl:    postRefToUrl(postRef),
    text,
    images:        [],
    worlds:        [],
    photographers: [],
    replyText:     '',
    linkText:      '',
    albumTitle:    highlight.title,
  };
}

/**
 * Convert a Bluesky { uri, cid } ref to a https://bsky.app URL.
 * AT URI format: at://did:plc:xxx/app.bsky.feed.post/rkey
 */
function postRefToUrl(postRef) {
  if (!postRef?.uri) return '';
  try {
    const parts = postRef.uri.replace('at://', '').split('/');
    const did   = parts[0];
    const rkey  = parts[2];
    return `https://bsky.app/profile/${did}/post/${rkey}`;
  } catch {
    return '';
  }
}

module.exports = { sendWebhook, buildBatchPayload, buildSpotlightPayload, buildAlbumPayload };