/**
 * scheduler.js – posting scheduler with crosspost support
 *
 * Runs hourly. Manual "post now" uses a 30 s stagger so all images
 * appear quickly. Scheduled posts stagger 5 minutes apart.
 *
 * After successful Bluesky posting, triggers crosspost to Buffer.
 */

const cron      = require('node-cron');
const chevereto = require('./chevereto');
const bsky      = require('./bluesky');
const crosspost = require('./crosspost');
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

function buildPostText(images, templates, customTags = [], userMappings = {}) {
  // Resolve each Chevereto username to a Bluesky handle if a mapping exists,
  // otherwise fall back to the raw Chevereto username.
  const usernames = [...new Set(
    images.map(img => img.user?.username).filter(Boolean)
  )].map(u => {
    const mapped = userMappings[u];
    return mapped ? `@${mapped}` : `@${u}`;
  }).join(' ');

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

    // Note: album highlights not crossposted (simplification; can add if desired)

  } catch (err) {
    logger.error(`Album highlight failed: ${err.message}`);
  }
}

async function postMemberSpotlight(highlight, state, staggerMs) {
  logger.info(`Member spotlight: @${highlight.username}`);

  // Re-fetch spotlight images at post time using the proper sort URLs.
  logger.info(`Spotlight: fetching representative images for @${highlight.username}`);
  const images = await chevereto.fetchUserSpotlightImages(highlight.username);
  logger.info(`Spotlight: got ${images.length} images for @${highlight.username}`);

  if (images.length === 0) {
    // Fall back to whatever was queued if the live fetch failed
    const fallback = highlight.images ?? [];
    if (fallback.length === 0) {
      logger.warn(`Spotlight: no images for @${highlight.username}, posting text-only intro`);
      await bsky.postText(
        renderTemplate(
          state.templates?.memberSpotlight || '🌟 Spotlight: {name}\n#photography',
          { name: highlight.name, username: highlight.username }
        )
      );
      recordSpotlightHistory(state, highlight);
      return;
    }
    images.push(...fallback.slice(0, 3));
  }

  // ── Download & upload all spotlight images ──────────────────────────────────
  const entries = [];
  for (const img of images) {
    try {
      const { buffer, mimeType } = await chevereto.downloadImage(img);
      const blob = await bsky.uploadBlob(buffer, mimeType);
      // Use the spotlight role as alt text so screen readers know what each image represents
      const altText = img.spotlightRole ? `${img.spotlightRole} photo` : '';
      entries.push({ image: img, blob, altText });
    } catch (err) {
      logger.warn(`Spotlight: download failed for ${img.id}: ${err.message}`);
    }
  }

  if (entries.length === 0) {
    logger.warn(`Spotlight: all downloads failed for @${highlight.username}`);
    recordSpotlightHistory(state, highlight);
    return;
  }

  // ── Build intro text ───────────────────────────────────────────────────────
  const tpl  = state.templates?.memberSpotlight || '🌟 Spotlight: {name}\n#photography';
  const text = renderTemplate(tpl, { name: highlight.name, username: highlight.username });

  // ── Post intro + images in one post ────────────────────────────────────────
  try {
    await bsky.postPhotosWithText(entries, text);
    logger.info(`Spotlight: posted intro + ${entries.length} images for @${highlight.username}`);
    state.stats.totalPosted++;
    state.stats.lastPostedAt = new Date().toISOString();
    for (const { image } of entries) {
      state.postedIds.push(image.id_encoded ?? image.id);
    }
    stateIO.save(state);

    // Note: spotlight not crossposted (simplification)

  } catch (err) {
    logger.error(`Spotlight: post failed for @${highlight.username}: ${err.message}`);
  }

  recordSpotlightHistory(state, highlight);
}

function recordSpotlightHistory(state, highlight) {
  state.spotlightHistory = state.spotlightHistory ?? [];
  state.spotlightHistory = state.spotlightHistory.filter(h => h.username !== highlight.username);
  state.spotlightHistory.unshift({
    username:   highlight.username,
    name:       highlight.name,
    featuredAt: new Date().toISOString(),
  });
  if (state.spotlightHistory.length > 50) state.spotlightHistory.length = 50;
}

// ─── Reply thread helpers ─────────────────────────────────────────────────────

const REPLY_LIMIT = 280;

/**
 * Split a long text into chunks that each fit within REPLY_LIMIT.
 * Splits on newlines where possible so lines aren't broken mid-sentence.
 */
function chunkText(text) {
  if (text.length <= REPLY_LIMIT) return [text];

  const chunks = [];
  const lines  = text.split('\n');
  let current  = '';

  for (const line of lines) {
    const candidate = current ? current + '\n' + line : line;
    if (candidate.length <= REPLY_LIMIT) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      // If a single line is over the limit, hard-split it
      if (line.length > REPLY_LIMIT) {
        let remaining = line;
        while (remaining.length > REPLY_LIMIT) {
          chunks.push(remaining.slice(0, REPLY_LIMIT - 1) + '…');
          remaining = '…' + remaining.slice(REPLY_LIMIT - 1);
        }
        current = remaining;
      } else {
        current = line;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Post a series of text chunks as a chained reply thread.
 * Each chunk replies to the previous one. Returns the ref of the last reply posted.
 * rootRef stays fixed (the original post); parentRef advances with each new reply.
 */
async function sendChunkedReplies(rootRef, startingParentRef, textChunks) {
  let parent = startingParentRef;
  for (const chunk of textChunks) {
    try {
      const newRef = await bsky.replyToPost(rootRef, parent, chunk);
      if (newRef) parent = newRef;
    } catch (err) {
      logger.warn(`sendChunkedReplies: failed to post chunk: ${err.message}`);
    }
  }
  return parent;
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

  // ── Download all picked images ─────────────────────────────────────────────
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

  // ── Extract VRCX metadata before posting ──────────────────────────────────
  const vrcxByImageId = {};
  for (const { image } of downloaded) {
    try {
      const { buffer: origBuf } = await chevereto.downloadOriginal(image);
      const vrcx = await chevereto.extractVRCXMetadata(origBuf);
      if (vrcx) {
        vrcxByImageId[image.id] = vrcx;
        logger.info(`postBatch: VRCX found in ${image.id}: ${vrcx.worldName}`);
      } else {
        logger.info(`postBatch: no VRCX metadata in ${image.id}`);
      }
    } catch (err) {
      logger.warn(`postBatch: VRCX check error for ${image.id}: ${err.message}`);
    }
  }

  // ── Build entries with per-image alt text ──────────────────────────────────
  // Images WITH VRCX: "World Name | World URL"
  // Images WITHOUT: empty string (raw filename is worse than nothing for a11y)
  const entries = downloaded.map(({ image, blob }) => {
    const vrcx = vrcxByImageId[image.id];
    const altText = vrcx
      ? (vrcx.worldUrl ? `${vrcx.worldName} | ${vrcx.worldUrl}` : vrcx.worldName)
      : '';
    return { image, blob, altText };
  });

  // ── Build main post text (no URLs or world info — those go in replies) ─────
  const text = buildPostText(
    downloaded.map(d => d.image),
    state.templates,
    state.customTags ?? [],
    state.userMappings ?? {}
  );

  // ── Post to Bluesky ────────────────────────────────────────────────────────
  let postRef = null;
  try {
    postRef = await bsky.postPhotosWithText(entries, text);
    logger.info(`postBatch: posted ${downloaded.length} images in one post`);
  } catch (err) {
    logger.error(`postBatch: failed to post: ${err.message}`);
    return;
  }

  // Mark all as posted
  for (const { image } of downloaded) {
    state.postedIds.push(image.id_encoded ?? image.id);
    state.stats.totalPosted++;
  }
  state.stats.lastPostedAt = new Date().toISOString();
  stateIO.save(state);

  // ── Trigger crosspost (X & Instagram via Buffer) ──────────────────────────
  // Pass image buffers so crosspost can resize them
  const entriesWithBuffers = downloaded.map(({ image, blob, buffer }) => ({
    image,
    blob: { ...blob, imageBuffer: buffer },
  }));
  await crosspost.triggerCrosspost(entriesWithBuffers, text, state, vrcxByImageId);

  if (!postRef) return;

  // ── Reply 1: World Information ─────────────────────────────────────────────
  // Only post if at least one image has VRCX data.
  // Group images that share the same world to avoid repeating the URL.
  const anyVrcx = Object.keys(vrcxByImageId).length > 0;
  let lastRef = postRef;

  if (anyVrcx) {
    // Build an ordered map: worldKey → { vrcx, imageNumbers[] }
    const worldGroups = new Map();
    for (let i = 0; i < downloaded.length; i++) {
      const { image } = downloaded[i];
      const vrcx      = vrcxByImageId[image.id];
      if (!vrcx) continue;
      const key = vrcx.worldId || vrcx.worldName;
      if (!worldGroups.has(key)) worldGroups.set(key, { vrcx, nums: [] });
      worldGroups.get(key).nums.push(i + 1);
    }

    const worldLines = ['🌍 World Information'];
    for (const { vrcx, nums } of worldGroups.values()) {
      const label = nums.length === 1
        ? `Image ${nums[0]}`
        : `Images ${nums.slice(0, -1).join(', ')} & ${nums[nums.length - 1]}`;
      worldLines.push(`${label} — ${vrcx.worldName}`);
      if (vrcx.worldUrl) worldLines.push(`Visit: ${vrcx.worldUrl}`);
    }

    const worldChunks = chunkText(worldLines.join('\n'));
    lastRef = await sendChunkedReplies(postRef, postRef, worldChunks);
    logger.info(`postBatch: world info reply posted (${worldGroups.size} unique world(s))`);
  } else {
    logger.info('postBatch: no VRCX data in any image — skipping world info reply');
  }

  // ── Reply 2: Image Links ───────────────────────────────────────────────────
  // Viewer URL for every image in the batch, chained after the world info reply.
  const linkLines = ['🔗 View on Knowbody Online'];
  for (let i = 0; i < downloaded.length; i++) {
    const { image } = downloaded[i];
    if (image.url_viewer) linkLines.push(`Image ${i + 1}: ${image.url_viewer}`);
  }

  const linkText   = linkLines.join('\n');
  const linkChunks = chunkText(linkText);
  await sendChunkedReplies(postRef, lastRef, linkChunks);

  logger.info(`postBatch: cycle complete — ${downloaded.length} images posted with reply thread + crosspost`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startScheduler };
