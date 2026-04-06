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

function buildPostText(image, templates) {
  const tpl  = templates?.regularPost || '📸 {username}\n{title}\n{tags}';
  const tags = (image.tags ?? []).slice(0, 3).map(t => `#${t.tag_url ?? t.tag}`);
  if (!tags.includes('#photography')) tags.unshift('#photography');

  let text = renderTemplate(tpl, {
    username: image.user?.username ? `@${image.user.username}` : '',
    title:    image.title || 'Untitled',
    tags:     tags.join(' '),
    url:      image.url_viewer || '',
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
  logger.info(`postBatch: ${picks.length} images selected to post`);

  if (picks.length === 0) {
    logger.warn('postBatch: 0 images selected — all may already be in postedIds or pool empty');
    return;
  }

  for (let i = 0; i < picks.length; i++) {
    const img = picks[i];
    if (i > 0) {
      logger.info(`postBatch: waiting ${staggerMs / 1000}s before next post…`);
      await sleep(staggerMs);
    }

    logger.info(`postBatch: posting image ${i + 1}/${picks.length} id=${img.id} title="${img.title}"`);

    try {
      // ── Download thumbnail for posting ─────────────────────────────────────
      const { buffer: thumbBuf, mimeType } = await chevereto.downloadImage(img);
      const blob = await bsky.uploadBlob(thumbBuf, mimeType);
      const text = buildPostText(img, state.templates);
      const postRef = await bsky.postPhotoWithText(img, blob, text);

      // ── VRCX: download original for metadata (thumbnails strip metadata) ───
      if (postRef) {
        logger.info(`postBatch: checking image ${img.id} for VRCX metadata`);
        try {
          // Try the full-size URL for metadata — it must be a PNG to have tEXt chunks
          const { buffer: origBuf } = await chevereto.downloadOriginal(img);
          const vrcx = await chevereto.extractVRCXMetadata(origBuf);

          if (vrcx) {
            logger.info(`postBatch: VRCX found! World="${vrcx.worldName}" Author="${vrcx.worldAuthor}"`);
            const vrcxTpl  = state.templates?.vrcxReply || '🌍 World: {worldName}\n✍️ Author: {worldAuthor}\n📍 {instanceId}';
            const vrcxText = renderTemplate(vrcxTpl, {
              worldName:   vrcx.worldName  || 'Unknown World',
              worldAuthor: vrcx.worldAuthor || 'Unknown',
              instanceId:  vrcx.instanceId  || '',
              players:     (vrcx.players ?? []).join(', '),
            });
            await bsky.replyToPost(postRef, vrcxText);
            logger.info(`postBatch: VRCX reply posted for ${img.id}`);
          } else {
            logger.info(`postBatch: no VRCX metadata in image ${img.id}`);
          }
        } catch (vrcxErr) {
          logger.warn(`postBatch: VRCX check failed for ${img.id}: ${vrcxErr.message}`);
        }
      }

      const imgId = img.id_encoded ?? img.id;
      state.postedIds.push(imgId);
      state.stats.totalPosted++;
      state.stats.lastPostedAt = new Date().toISOString();
      stateIO.save(state);

    } catch (err) {
      logger.error(`postBatch: failed to post image ${img.id}: ${err.message}`);
    }
  }

  logger.info(`postBatch: cycle complete — ${picks.length} posts attempted`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startScheduler };