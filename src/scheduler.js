/**
 * scheduler.js – posting scheduler
 *
 * Runs hourly. Each cycle:
 *   1. Drains one highlight from the queue (album or spotlight)
 *   2. Posts a recency-weighted batch of regular photos
 *
 * Manual "post now" uses a short stagger (30 s) so you see all
 * photos post quickly. Scheduled posts use 5-minute stagger.
 */

const cron      = require('node-cron');
const chevereto = require('./chevereto');
const bsky      = require('./bluesky');
const stateIO   = require('./state');
const logger    = require('./logger');

const POSTS_PER_HOUR   = parseInt(process.env.POSTS_PER_HOUR || '4', 10);
const STAGGER_SCHED_MS = 5 * 60 * 1000;   // 5 min between scheduled posts
const STAGGER_MANUAL_MS = 30 * 1000;       // 30 s between manual "post now" posts

// ─── Template renderer ────────────────────────────────────────────────────────

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '').trim();
}

function buildPostText(image, extraText, templates) {
  const tpl  = templates?.regularPost || '📸 {username}\n{title}\n{tags}';
  const tags = (image.tags ?? []).slice(0, 3).map(t => `#${t.tag_url ?? t.tag}`);
  if (!tags.includes('#photography')) tags.unshift('#photography');

  let text = renderTemplate(tpl, {
    username: image.user?.username ? `@${image.user.username}` : '',
    title:    image.title || 'Untitled',
    tags:     tags.join(' '),
    url:      image.url_viewer || '',
  });

  if (extraText) text += `\n${extraText}`;
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
    logger.info('Scheduler: bot paused, skipping cycle');
    return;
  }

  state.stats.lastCheckAt = new Date().toISOString();
  stateIO.save(state);

  const staggerMs = manual ? STAGGER_MANUAL_MS : STAGGER_SCHED_MS;

  try {
    if (state.highlights.length > 0) {
      const highlight = state.highlights.shift();
      await postHighlight(highlight, state, staggerMs);
      stateIO.save(state);
    }

    await postBatch(state, staggerMs);

  } catch (err) {
    logger.error(`Cycle error: ${err.message}`);
  }
}

// ─── Highlight posts ──────────────────────────────────────────────────────────

async function postHighlight(highlight, state, staggerMs) {
  if (highlight.type === 'album')     return postAlbumHighlight(highlight, state);
  if (highlight.type === 'spotlight') return postMemberSpotlight(highlight, state, staggerMs);
}

async function postAlbumHighlight(highlight, state) {
  logger.info(`Posting album highlight: ${highlight.title}`);
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
    logger.error(`Album highlight post failed: ${err.message}`);
  }
}

async function postMemberSpotlight(highlight, state, staggerMs) {
  logger.info(`Posting member spotlight: ${highlight.name}`);

  const tpl  = state.templates?.memberSpotlight || '🌟 Spotlight: {name}\n#photography';
  const intro = renderTemplate(tpl, { name: highlight.name, username: highlight.username });

  await bsky.postText(intro);

  const images = highlight.images ?? [];
  if (images.length === 0) {
    logger.warn(`Spotlight for @${highlight.username} has no images — fetching now`);
    const fetched = await chevereto.fetchUserImages(highlight.username);
    images.push(...fetched.slice(0, 3));
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
    } catch (err) {
      logger.warn(`Spotlight image post failed: ${err.message}`);
    }
  }

  // Record in spotlight history
  const historyEntry = {
    username:    highlight.username,
    name:        highlight.name,
    featuredAt:  new Date().toISOString(),
  };
  state.spotlightHistory = state.spotlightHistory ?? [];
  // Remove previous entry for same user so we always have the latest date
  state.spotlightHistory = state.spotlightHistory.filter(h => h.username !== highlight.username);
  state.spotlightHistory.unshift(historyEntry);
  // Keep last 50
  if (state.spotlightHistory.length > 50) state.spotlightHistory = state.spotlightHistory.slice(0, 50);
}

// ─── Regular batch ────────────────────────────────────────────────────────────

async function postBatch(state, staggerMs) {
  logger.info('Fetching recent images from Chevereto…');
  const allImages = await chevereto.fetchRecentImages(5);
  logger.info(`Fetched ${allImages.length} images`);

  if (!allImages.length) {
    logger.warn('No images returned from Chevereto');
    return;
  }

  const picks = chevereto.weightedSample(allImages, POSTS_PER_HOUR, state.postedIds);
  logger.info(`Selected ${picks.length} images to post`);

  for (let i = 0; i < picks.length; i++) {
    const img = picks[i];
    if (i > 0) await sleep(staggerMs);

    try {
      const { buffer, mimeType } = await chevereto.downloadImage(img);
      const blob = await bsky.uploadBlob(buffer, mimeType);

      // Build post text using template
      const postText = buildPostText(img, '', state.templates);
      const postUri  = await bsky.postPhotoWithText(img, blob, postText);

      // Check for VRCX metadata and post a reply if found
      if (postUri) {
        const vrcx = await chevereto.extractVRCXMetadata(buffer);
        if (vrcx) {
          const vrcxTpl  = state.templates?.vrcxReply || '🌍 World: {worldName}\n✍️ Author: {worldAuthor}';
          const vrcxText = renderTemplate(vrcxTpl, {
            worldName:   vrcx.worldName  || 'Unknown World',
            worldAuthor: vrcx.worldAuthor || 'Unknown',
            instanceId:  vrcx.instanceId  || '',
          });
          await bsky.replyToPost(postUri, vrcxText);
          logger.info(`VRCX reply posted for ${img.id}: ${vrcx.worldName}`);
        }
      }

      const imgId = img.id_encoded ?? img.id;
      state.postedIds.push(imgId);
      state.stats.totalPosted++;
      state.stats.lastPostedAt = new Date().toISOString();
      stateIO.save(state);

    } catch (err) {
      logger.error(`Failed to post image ${img.id}: ${err.message}`);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startScheduler };