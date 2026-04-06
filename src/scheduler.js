/**
 * scheduler.js – posting scheduler
 *
 * Runs hourly. Manual "post now" uses a 30 s stagger so all images
 * appear quickly. Scheduled posts stagger 5 minutes apart.
 */

const cron      = require('node-cron');
const chevereto = require('./chevereto');
const bsky      = require('./bluesky');
const stateIO   = require('./state');
const logger    = require('./logger');

const POSTS_PER_HOUR    = parseInt(process.env.POSTS_PER_HOUR || '4', 10);
const STAGGER_SCHED_MS  = 5 * 60 * 1000;  // 5 min between scheduled posts
const STAGGER_MANUAL_MS = 30 * 1000;       // 30 s between manual posts

// ─── Template renderer ────────────────────────────────────────────────────────

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '').trim();
}

// VRChat raw screenshot filename pattern — strip these rather than show them as titles
const VRC_FILENAME_RE = /^VRChat_\d{4}-\d{2}-\d{2}_[\d-]+\.\d+_\d+x\d+\.png$/i;

function cleanTitle(title) {
  if (!title || VRC_FILENAME_RE.test(title.trim())) return '';
  return title;
}

function buildPostText(images, templates, customTags = []) {
  const usernames = [...new Set(
    images.map(img => img.user?.username).filter(Boolean)
  )].map(u => `@${u}`).join(' ');

  const titles = images
    .map(img => cleanTitle(img.title))
    .filter(Boolean)
    .slice(0, 2)
    .join(' · ');

  const tpl  = templates?.regularPost || '📸 {username}\n{title}\n{tags}';
  const tags = customTags.length ? customTags.join(' ') : '#photography';

  let text = renderTemplate(tpl, {
    username: usernames,
    title:    titles,
    tags,
    url:      images[0]?.url_viewer || '',
  });

  if (text.length > 280) text = text.slice(0, 277) + '…';
  return text;
}

// ─── Public API ───────────────────────────────────────────────────────────────

function startScheduler(state) {
  cron.schedule('0 * * * *', () => runCycle(state, false));
  logger.info(`Scheduler active – ${POSTS_PER_HOUR} posts/hour`);
  return (manual = true) => runCycle(state, manual);
}

// ─── Main cycle ───────────────────────────────────────────────────────────────

async function runCycle(state, manual = false) {
  if (!state.running) {
    logger.info('Scheduler: bot is paused, skipping cycle');
    return;
  }

  const staggerMs = manual ? STAGGER_MANUAL_MS : STAGGER_SCHED_MS;
  logger.info(`runCycle: starting (${manual ? 'manual' : 'scheduled'}, stagger ${staggerMs / 1000}s)`);

  state.stats.lastCheckAt = new Date().toISOString();
  stateIO.save(state);

  try {
    if (state.highlights.length > 0) {
      const highlight = state.highlights.shift();
      logger.info(`Processing highlight: type=${highlight.type}`);
      await postHighlight(highlight, state, staggerMs);
      stateIO.save(state);
    }

    await postBatch(state, staggerMs);
  } catch (err) {
    logger.error(`Cycle error: ${err.message}\n${err.stack}`);
  }
}

// ─── Highlight posts ──────────────────────────────────────────────────────────

async function postHighlight(highlight, state, staggerMs) {
  if (highlight.type === 'album')     return postAlbumHighlight(highlight, state);
  if (highlight.type === 'spotlight') return postMemberSpotlight(highlight, state, staggerMs);
}

async function postAlbumHighlight(highlight, state) {
  logger.info(`Album highlight: ${highlight.title}`);
  const tpl  = state.templates?.albumHighlight || '📂 New Album: {title}\n#photography';
  const text = renderTemplate(tpl, { title: highlight.title });

  try {
    if (highlight.coverImage) {
      const { buffer, mimeType } = await chevereto.downloadImage(highlight.coverImage);
      const blob = await bsky.uploadBlob(buffer, mimeType);
      await bsky.postPhoto(highlight.coverImage, blob, text, true);
    } else {
      await bsky.postText(text);
    }
    state.stats.totalPosted++;
    state.stats.lastPostedAt = new Date().toISOString();
  } catch (err) {
    logger.error(`Album highlight failed: ${err.message}`);
  }
}

async function postMemberSpotlight(highlight, state, staggerMs) {
  logger.info(`Member spotlight: @${highlight.username}`);
  const tpl   = state.templates?.memberSpotlight || '🌟 Spotlight: {name}\n#photography';
  const intro = renderTemplate(tpl, { name: highlight.name, username: highlight.username });

  await bsky.postText(intro);

  // Images should already be attached when queued; re-fetch if missing
  let images = highlight.images ?? [];
  if (images.length === 0) {
    logger.info(`Spotlight: no images pre-fetched for @${highlight.username}, fetching now`);
    images = await chevereto.fetchUserImages(highlight.username);
    logger.info(`Spotlight: fetched ${images.length} images for @${highlight.username}`);
  }

  if (images.length === 0) {
    logger.warn(`Spotlight: still no images found for @${highlight.username}, skipping photos`);
  }

  for (const img of images.slice(0, 3)) {
    await sleep(staggerMs);
    try {
      const { buffer, mimeType } = await chevereto.downloadImage(img);
      const blob = await bsky.uploadBlob(buffer, mimeType);
      await bsky.postPhoto(img, blob);
      state.stats.totalPosted++;
      state.stats.lastPostedAt = new Date().toISOString();
      state.postedIds.push(img.id_encoded ?? img.id);
      stateIO.save(state);
    } catch (err) {
      logger.warn(`Spotlight image failed: ${err.message}`);
    }
  }

  // Record in spotlight history
  state.spotlightHistory = state.spotlightHistory ?? [];
  state.spotlightHistory = state.spotlightHistory.filter(h => h.username !== highlight.username);
  state.spotlightHistory.unshift({
    username:   highlight.username,
    name:       highlight.name,
    featuredAt: new Date().toISOString(),
  });
  if (state.spotlightHistory.length > 50) state.spotlightHistory.length = 50;
}

// ─── Regular batch ────────────────────────────────────────────────────────────

async function postBatch(state, staggerMs) {
  logger.info('postBatch: fetching recent images from Chevereto…');
  const allImages = await chevereto.fetchRecentImages(5);
  logger.info(`postBatch: fetched ${allImages.length} images total`);

  if (!allImages.length) {
    logger.warn('postBatch: no images returned from Chevereto — check scraper logs above');
    return;
  }

  const picks = chevereto.weightedSample(allImages, POSTS_PER_HOUR, state.postedIds);
  logger.info(`postBatch: ${picks.length} images selected: ${picks.map(p => p.id).join(', ')}`);

  if (picks.length === 0) {
    logger.warn('postBatch: 0 images selected — pool exhausted or all already posted');
    return;
  }

  // ── Download all picked images concurrently ────────────────────────────────
  logger.info(`postBatch: downloading ${picks.length} images…`);
  const downloaded = [];
  for (const img of picks) {
    try {
      const { buffer, mimeType } = await chevereto.downloadImage(img);
      const blob = await bsky.uploadBlob(buffer, mimeType);
      downloaded.push({ image: img, blob, buffer });
      logger.info(`postBatch: downloaded & uploaded ${img.id}`);
    } catch (err) {
      logger.error(`postBatch: download/upload failed for ${img.id}: ${err.message}`);
    }
  }

  if (downloaded.length === 0) {
    logger.warn('postBatch: all downloads failed, nothing to post');
    return;
  }

  // ── Post all images in a single Bluesky post ───────────────────────────────
  const text     = buildPostText(downloaded.map(d => d.image), state.templates, state.customTags ?? []);
  const entries  = downloaded.map(d => ({ image: d.image, blob: d.blob }));
  let   postRef  = null;

  try {
    postRef = await bsky.postPhotosWithText(entries, text);
    logger.info(`postBatch: posted ${downloaded.length} images in one post`);
  } catch (err) {
    logger.error(`postBatch: failed to post: ${err.message}`);
    return;
  }

  // Mark all as posted regardless of VRCX outcome
  for (const { image } of downloaded) {
    state.postedIds.push(image.id_encoded ?? image.id);
    state.stats.totalPosted++;
  }
  state.stats.lastPostedAt = new Date().toISOString();
  stateIO.save(state);

  // ── VRCX: check each image for VRChat metadata, reply once per world found ─
  if (postRef) {
    const vrcxResults = [];

    for (const { image, buffer } of downloaded) {
      logger.info(`postBatch: checking image ${image.id} for VRCX metadata`);
      try {
        // Must use full-size original — thumbnails have EXIF/tEXt stripped
        const { buffer: origBuf } = await chevereto.downloadOriginal(image);
        const vrcx = await chevereto.extractVRCXMetadata(origBuf);
        if (vrcx) {
          vrcxResults.push(vrcx);
          logger.info(`postBatch: VRCX found in ${image.id}: ${vrcx.worldName}`);
        } else {
          logger.info(`postBatch: no VRCX metadata in ${image.id}`);
        }
      } catch (vrcxErr) {
        logger.warn(`postBatch: VRCX check error for ${image.id}: ${vrcxErr.message}`);
      }
    }

    // Collect unique photographers from this batch for the VRCX reply
    const photographers = [...new Set(
      downloaded.map(d => d.image.user?.username).filter(Boolean)
    )];

    // Deduplicate by worldId and post one reply per unique world
    const seenWorlds = new Set();
    for (const vrcx of vrcxResults) {
      const key = vrcx.worldId || vrcx.worldName;
      if (seenWorlds.has(key)) continue;
      seenWorlds.add(key);

      const vrcxTpl = state.templates?.vrcxReply ||
        '🌍 World: {worldName}\n🔗 {worldUrl}{photographers}';

      // Only surface photographer list when the batch has multiple uploaders
      const photographerLine = photographers.length > 1
        ? '\n📸 ' + photographers.map(u => `@${u}`).join(' ')
        : '';

      const vrcxText = renderTemplate(vrcxTpl, {
        worldName:    vrcx.worldName || 'Unknown World',
        worldId:      vrcx.worldId   || '',
        worldUrl:     vrcx.worldUrl  || '',
        players:      (vrcx.players ?? []).join(', '),
        photographers: photographerLine,
      });

      try {
        await bsky.replyToPost(postRef, vrcxText);
        logger.info(`postBatch: VRCX reply posted for world "${vrcx.worldName}"`);
      } catch (replyErr) {
        logger.warn(`postBatch: VRCX reply failed: ${replyErr.message}`);
      }
    }
  }

  logger.info(`postBatch: cycle complete — ${downloaded.length} images posted`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startScheduler };