/**
 * scheduler.js – posting scheduler
 *
 * Runs on a cron job (every hour by default).
 * Each cycle it:
 *   1. Processes any queued highlights first
 *   2. Fetches recent images from Chevereto
 *   3. Picks N photos using recency-weighted random sampling
 *   4. Downloads each, uploads to Bluesky, and posts
 *
 * Staggered posting: to avoid spamming followers with 4 posts
 * at once, images are posted with a 5-minute gap between each.
 */

const cron      = require('node-cron');
const chevereto = require('./chevereto');
const bsky      = require('./bluesky');
const stateIO   = require('./state');
const logger    = require('./logger');

const POSTS_PER_HOUR = parseInt(process.env.POSTS_PER_HOUR || '4', 10);
const STAGGER_MS     = 5 * 60 * 1000; // 5 minutes between posts

// ─── Public API ───────────────────────────────────────────────────────────────

function startScheduler(state) {
  // Post at :00 of every hour
  cron.schedule('0 * * * *', () => runCycle(state));
  logger.info(`Scheduler active – ${POSTS_PER_HOUR} posts/hour, staggered every 5 min`);
  return () => runCycle(state); // return trigger for manual !post now
}

// ─── Main cycle ───────────────────────────────────────────────────────────────

async function runCycle(state) {
  if (!state.running) {
    logger.info('Scheduler: bot paused, skipping cycle');
    return;
  }

  state.stats.lastCheckAt = new Date().toISOString();
  stateIO.save(state);

  try {
    // 1. Drain highlight queue first (albums & spotlights)
    if (state.highlights.length > 0) {
      const highlight = state.highlights.shift();
      await postHighlight(highlight, state);
      stateIO.save(state);
    }

    // 2. Regular photo batch
    await postBatch(state);

  } catch (err) {
    logger.error(`Cycle error: ${err.message}`);
  }
}

// ─── Highlight posts ──────────────────────────────────────────────────────────

async function postHighlight(highlight, state) {
  if (highlight.type === 'album') {
    await postAlbumHighlight(highlight, state);
  } else if (highlight.type === 'spotlight') {
    await postMemberSpotlight(highlight, state);
  }
}

async function postAlbumHighlight(highlight, state) {
  logger.info(`Posting album highlight: ${highlight.title}`);

  const announcementText = [
    `📂 New Album Drop: ${highlight.title}`,
    `Check out this fresh collection from our team!`,
    `#photography #photooftheday`,
  ].join('\n');

  if (highlight.coverImage) {
    const { buffer, mimeType } = await chevereto.downloadImage(highlight.coverImage);
    const blob = await bsky.uploadBlob(buffer, mimeType);
    await bsky.postPhoto(highlight.coverImage, blob, `📂 Album: ${highlight.title}`);
  } else {
    await bsky.postText(announcementText);
  }

  state.stats.totalPosted++;
  state.stats.lastPostedAt = new Date().toISOString();
}

async function postMemberSpotlight(highlight, state) {
  logger.info(`Posting member spotlight: ${highlight.name}`);

  const intro = [
    `🌟 Meet the photographer: ${highlight.name}`,
    `Here's a look at some of their recent work:`,
    `#photography #photographer #teamspotlight`,
  ].join('\n');

  await bsky.postText(intro);

  // Post up to 3 of their photos, staggered
  for (const img of highlight.images.slice(0, 3)) {
    await sleep(STAGGER_MS);
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
}

// ─── Regular batch ────────────────────────────────────────────────────────────

async function postBatch(state) {
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
    if (i > 0) await sleep(STAGGER_MS);

    try {
      const { buffer, mimeType } = await chevereto.downloadImage(img);
      const blob = await bsky.uploadBlob(buffer, mimeType);
      await bsky.postPhoto(img, blob);

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
