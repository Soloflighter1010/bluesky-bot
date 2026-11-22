/**
 * scheduler.js – posting scheduler
 *
 * Runs hourly. Manual "post now" uses a 30 s stagger so all images
 * appear quickly. Scheduled posts stagger 5 minutes apart.
 */

const cron        = require('node-cron');
const chevereto   = require('./chevereto');
const bsky        = require('./bluesky');
const stateIO     = require('./state');
const logger      = require('./logger');
const bufferApi   = require('./buffer');
const imagerender = require('./imagerender');
const worldstats  = require('./worldstats');
const membershipdrafts = require('./membershipdrafts');
const kutt        = require('./kutt');
const { chunkText } = require('./textchunk');

const POSTS_PER_HOUR    = parseInt(process.env.POSTS_PER_HOUR || '4', 10);
const STAGGER_SCHED_MS  = 5 * 60 * 1000;  // 5 min between scheduled posts
const STAGGER_MANUAL_MS = 30 * 1000;       // 30 s between manual posts

// ── Fix #12: single source of truth for the Chevereto link reply header
const LINK_REPLY_HEADER = '🔗 View on Knowbody Online';

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

// ── Fix #15: strip empty/blank lines from post text so anonymous uploads
//             don't produce double blank-line artefacts
function compactText(text) {
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .join('\n')
    .trim();
}

/**
 * Resolve a Chevereto username to the right @handle for a given platform.
 * Falls back to the Chevereto username if no mapping exists for that platform.
 *
 * @param {string} chevUser   — Chevereto username
 * @param {object} mappings   — state.userMappings
 * @param {string} platform   — 'bluesky' | 'twitter' | 'instagram'
 */
function resolveHandle(chevUser, mappings, platform) {
  const entry  = mappings[chevUser];
  if (!entry) {
    // For Bluesky: bare Chevereto usernames are not valid Bluesky handles.
    // Prefixing with @ causes detectFacets to attempt DID resolution, which
    // returns "" for any unresolvable handle and makes the entire post fail
    // with "Invalid DID (got '')". Use the username as plain credited text
    // instead. Twitter/Instagram captions go through Buffer as plain text
    // anyway, so @username there is harmless.
    return platform === 'bluesky' ? chevUser : `@${chevUser}`;
  }
  const handle = typeof entry === 'object' ? (entry[platform] || '') : (platform === 'bluesky' ? entry : '');
  return handle ? `@${handle}` : (platform === 'bluesky' ? chevUser : `@${chevUser}`);
}

function buildPostText(images, templates, customTags = [], userMappings = {}, platform = 'bluesky', urlMap = new Map()) {
  const usernames = [...new Set(
    images.map(img => img.user?.username).filter(Boolean)
  )].map(u => resolveHandle(u, userMappings, platform)).join(' ');

  const titles = images
    .map(img => cleanTitle(img.title))
    .filter(Boolean)
    .slice(0, 2)
    .join(' · ');

  const tpl  = templates?.regularPost || '📸 {username}\n{title}\n{tags}';
  const tags = customTags.length ? customTags.join(' ') : '#photography';

  const firstViewerUrl = images[0]?.url_viewer || '';
  let text = renderTemplate(tpl, {
    username: usernames,
    title:    titles,
    tags,
    url:      urlMap.get(firstViewerUrl) || firstViewerUrl,
  });

  text = compactText(text);
  if (text.length > 280) text = text.slice(0, 277) + '…';
  return text;
}

/**
 * Build caption text for every platform in one pass.
 * Returns { bluesky, twitter, instagram } — all may be the same if no
 * platform-specific handles are configured.
 */
function buildPlatformTexts(images, templates, customTags, userMappings, urlMap = new Map()) {
  return {
    bluesky:   buildPostText(images, templates, customTags, userMappings, 'bluesky',   urlMap),
    twitter:   buildPostText(images, templates, customTags, userMappings, 'twitter',   urlMap),
    instagram: buildPostText(images, templates, customTags, userMappings, 'instagram', urlMap),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

function startScheduler() {
  cron.schedule('0 * * * *', () => runCycle(false));
  logger.info(`Scheduler active – ${POSTS_PER_HOUR} posts/hour`);
  return (manual = true) => runCycle(manual);
}

// ─── Main cycle ───────────────────────────────────────────────────────────────

async function runCycle(manual = false) {
  // Load state fresh from disk on every cycle so dashboard changes (paused,
  // new exclusions, template edits, etc.) are picked up without a restart.
  const state = stateIO.load();

  // Checked before the paused/running gate below — a week or month that
  // already ended shouldn't wait for posting to resume before its roundup
  // draft gets generated.
  membershipdrafts.checkRoundups(state);

  // Same reasoning — a temporary exclusion's expiry isn't gated on posting
  // being active. Not required for correctness (isExcluded/
  // getExcludedUsernameSet already treat expired entries as inactive on
  // their own), just keeps the stored list and dashboard from accumulating
  // stale "expired months ago" rows.
  const prunedExclusions = stateIO.pruneExpiredExclusions(state);
  if (prunedExclusions.length > 0) {
    logger.info(`runCycle: ${prunedExclusions.length} exclusion(s) expired and reverted — ${prunedExclusions.join(', ')}`);
    stateIO.save(state);
  }

  if (!state.running) {
    logger.info('Scheduler: bot is paused, skipping cycle');
    return;
  }

  const staggerMs = manual ? STAGGER_MANUAL_MS : STAGGER_SCHED_MS;
  logger.info(`runCycle: starting (${manual ? 'manual' : 'scheduled'}, stagger ${staggerMs / 1000}s)`);

  state.stats.lastCheckAt = new Date().toISOString();
  stateIO.save(state);

  try {
    // In random mode with no highlights queued, there's no need to scrape
    // /explore/recent — fetchRandomImages will call /?random directly instead.
    // (Highlights don't actually consume this cache either — postAlbumHighlight
    // and postMemberSpotlight fetch their own data — so this only ever depends
    // on which selection mode is active, not on whether a highlight is queued.)
    const needsRecentCache = !state.randomMode;
    logger.info(needsRecentCache
      ? 'runCycle: pre-fetching recent images for this cycle…'
      : 'runCycle: random mode active, skipping /explore/recent scrape');
    const recentCache = needsRecentCache
      ? await chevereto.fetchRecentImages(5)
      : [];

    if (state.highlights.length > 0) {
      // Fix #3: peek, don't shift — only remove on success
      const highlight = state.highlights[0];
      logger.info(`Processing highlight: type=${highlight.type}`);
      try {
        await postHighlight(highlight, state, staggerMs, recentCache);
        state.highlights.shift(); // only remove from queue after success
      } catch (err) {
        logger.error(`Highlight failed, keeping in queue for retry: ${err.message}`);
      }
      stateIO.save(state);

      // Always stagger between the highlight post and the regular batch
      logger.info(`runCycle: waiting ${staggerMs / 1000}s before batch post…`);
      await sleep(staggerMs);
    }

    await postBatch(state, staggerMs, recentCache);
  } catch (err) {
    logger.error(`Cycle error: ${err.message}\n${err.stack}`);
  }
}

// ─── Highlight posts ──────────────────────────────────────────────────────────

async function postHighlight(highlight, state, staggerMs, recentCache) {
  if (highlight.type === 'album')     return postAlbumHighlight(highlight, state);
  if (highlight.type === 'spotlight') return postMemberSpotlight(highlight, state, staggerMs, recentCache);
}

async function postAlbumHighlight(highlight, state) {
  logger.info(`Album highlight: ${highlight.title}`);

  // Defensive re-check: commands.js/dashboard.js already filter excluded
  // uploaders out when an album is queued, but this also covers "excluded
  // after queueing." Skip the whole highlight rather than post a stripped
  // version — a cover-less announcement could still surface an excluded
  // person's album/title in a way they didn't ask for.
  const coverUsername = highlight.coverImage?.user?.username;
  if (coverUsername && stateIO.isExcluded(state, coverUsername)) {
    logger.warn(`Album highlight: cover image uploader @${coverUsername} is on the excluded list — skipping "${highlight.title}"`);
    return;
  }

  const tpl  = state.templates?.albumHighlight || '📂 New Album: {title}\n#photography';
  const text = renderTemplate(tpl, { title: highlight.title });

  let postRef;
  if (highlight.coverImage) {
    const { buffer, mimeType } = await chevereto.downloadImage(highlight.coverImage);
    const blob = await bsky.uploadBlob(buffer, mimeType);
    postRef = await bsky.postPhoto(highlight.coverImage, blob, text, true);
  } else {
    postRef = await bsky.postText(text);
  }
  state.stats.totalPosted++;
  state.stats.lastPostedAt = new Date().toISOString();

  // Buffer crosspost — text only for album announcements (no stable cover image URL)
  await bufferApi.crosspost(state.buffer, {
    platformTexts: { bluesky: text, twitter: text, instagram: text },
  });

  membershipdrafts.recordAlbum(state, { highlight });
}

async function postMemberSpotlight(highlight, state, staggerMs, recentCache) {
  logger.info(`Member spotlight: @${highlight.username}`);

  // Defensive re-check: commands.js/dashboard.js already block queueing a
  // spotlight for an excluded user, but this also covers the case where
  // someone was excluded *after* their spotlight was already sitting in
  // the queue — better to silently skip here than post them anyway.
  if (stateIO.isExcluded(state, highlight.username)) {
    logger.warn(`Spotlight: @${highlight.username} is on the excluded list — skipping, not posting`);
    return;
  }

  // Re-fetch spotlight images at post time using the proper sort URLs.
  logger.info(`Spotlight: fetching representative images for @${highlight.username}`);
  const images = await chevereto.fetchUserSpotlightImages(highlight.username);
  logger.info(`Spotlight: got ${images.length} images for @${highlight.username}`);

  if (images.length === 0) {
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

  // ── Build intro text — per platform so @mentions are correct ──────────────
  const tpl       = state.templates?.memberSpotlight || '🌟 Spotlight: {name}\n#photography';
  const userMaps  = state.userMappings ?? {};
  const chev      = highlight.username;

  const makeSpotlightText = platform => renderTemplate(tpl, {
    name:     highlight.name,
    username: resolveHandle(chev, userMaps, platform),
  });

  const spotlightPlatformTexts = {
    bluesky:   makeSpotlightText('bluesky'),
    twitter:   makeSpotlightText('twitter'),
    instagram: makeSpotlightText('instagram'),
  };
  const text = spotlightPlatformTexts.bluesky;

  // ── Post intro + images in one post ────────────────────────────────────────
  const postRef = await bsky.postPhotosWithText(entries, text);
  logger.info(`Spotlight: posted intro + ${entries.length} images for @${highlight.username}`);
  state.stats.totalPosted++;
  state.stats.lastPostedAt = new Date().toISOString();
  for (const { image } of entries) {
    state.postedIds.push(image.id_encoded ?? image.id);
  }
  stateIO.save(state);

  // Buffer crosspost — re-rendered high-quality JPEGs, same as regular batches
  const spotlightImageUrls = entries.map(e => renderUrlFor(e.image)).filter(Boolean);
  await bufferApi.crosspost(state.buffer, {
    platformTexts: spotlightPlatformTexts,
    imageUrls:     spotlightImageUrls,
  });

  membershipdrafts.recordSpotlight(state, { highlight, entries });

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

/**
 * Prefer a re-rendered high-quality JPEG (see imagerender.js) over
 * Chevereto's own downscaled .md. thumbnail for anything headed to Buffer.
 * Falls back to the .md./original URL if PUBLIC_BASE_URL isn't configured,
 * so a missing env var never blocks a post — it just stays soft until set.
 */
function renderUrlFor(img) {
  const original = img.url || img.medium?.url || img.mediumUrl;
  if (!original) return null;
  // High-quality re-render (requires PUBLIC_BASE_URL). Falls back to the
  // Chevereto medium thumbnail (.md.) rather than the full-size original —
  // the originals are often 8–10 MB raw PNGs which exceed Buffer/Twitter's
  // 5 MB per-image limit, while the .md. thumbnail is well within it.
  return imagerender.buildRenderUrl(original)
    || img.mediumUrl
    || img.medium?.url
    || img.url;
}

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

// Fix #2: render the vrcxReply template for the world info reply
function buildVrcxReplyText(worldGroups, downloaded, templates, userMappings, urlMap = new Map()) {
  const tpl = templates?.vrcxReply ||
    '{worldName}\n🔗 {worldUrl}{photographers}';

  const lines = [];

  for (const { vrcx, nums } of worldGroups.values()) {
    const label = nums.length === 1
      ? `Image ${nums[0]}`
      : `Images ${nums.slice(0, -1).join(', ')} & ${nums[nums.length - 1]}`;

    // Resolve photographers for images in this world group to Bluesky handles
    const worldPhotographerHandles = [...new Set(
      nums.map(n => downloaded[n - 1]?.image?.user?.username).filter(Boolean)
    )].map(u => resolveHandle(u, userMappings, 'bluesky'));

    // Only append photographers line when there are multiple uploaders in the batch
    const allPhotographers = [...new Set(
      downloaded.map(d => d.image?.user?.username).filter(Boolean)
    )];
    const photographersText = allPhotographers.length > 1
      ? '\n' + worldPhotographerHandles.join(' ')
      : '';

    const rendered = renderTemplate(tpl, {
      worldName:     vrcx.worldName,
      worldId:       vrcx.worldId  || '',
      worldUrl:      urlMap.get(vrcx.worldUrl) || vrcx.worldUrl  || '',
      players:       (vrcx.players || []).join(', '),
      photographers: photographersText,
    });

    lines.push(`${label} — ${rendered}`);
  }

  return lines.join('\n');
}

async function postBatch(state, staggerMs, recentCache) {
  const INSTAGRAM_MAX = 10;
  let picks;
  let recencyPool = null; // only populated in recency mode — reused below for Instagram extras
  const excludedUsernames = stateIO.getExcludedUsernameSet(state);

  if (state.randomMode) {
    // ── Full-random mode: pick via /?random ──────────────────────────────────
    logger.info('postBatch: full-random mode — fetching images via /?random');
    picks = await chevereto.fetchRandomImages(POSTS_PER_HOUR, state.postedIds, excludedUsernames);
    logger.info(`postBatch: ${picks.length} images selected (random): ${picks.map(p => p.id).join(', ')}`);

    if (picks.length === 0) {
      logger.warn('postBatch: /?random returned no usable images');
      return;
    }

  } else {
    // ── Recency-biased mode: weighted sample from /explore/recent ────────────
    recencyPool = recentCache ?? await chevereto.fetchRecentImages(5);
    logger.info(`postBatch: ${recencyPool.length} images in recency pool`);

    if (!recencyPool.length) {
      logger.warn('postBatch: no images returned from Chevereto — check scraper logs above');
      return;
    }

    picks = chevereto.weightedSample(recencyPool, POSTS_PER_HOUR, state.postedIds, excludedUsernames);
    logger.info(`postBatch: ${picks.length} images selected for Bluesky: ${picks.map(p => p.id).join(', ')}`);

    if (picks.length === 0) {
      logger.warn('postBatch: 0 images selected — pool exhausted or all already posted');
      return;
    }
  }

  // ── Fix #5: download each image once, reuse buffer for both upload and VRCX
  logger.info(`postBatch: downloading ${picks.length} images…`);
  const downloaded = [];
  for (const img of picks) {
    try {
      const { buffer, mimeType } = await chevereto.downloadImage(img);
      const blob = await bsky.uploadBlob(buffer, mimeType);
      downloaded.push({ image: img, blob, buffer }); // keep buffer for VRCX below
      logger.info(`postBatch: downloaded & uploaded ${img.id}`);
    } catch (err) {
      logger.error(`postBatch: download/upload failed for ${img.id}: ${err.message}`);
    }
  }

  if (downloaded.length === 0) {
    logger.warn('postBatch: all downloads failed, nothing to post');
    return;
  }

  // ── Curate Instagram's carousel — same orientation only ────────────────────
  // Twitter and Bluesky keep whatever mix of portrait/landscape the batch has.
  // Orientation for the primary batch is free (buffers already downloaded
  // above); extra candidates beyond the primary batch do need real fetches
  // to check, bounded to how many are actually needed.
  const orientations = await Promise.all(downloaded.map(d => chevereto.getOrientation(d.buffer)));
  const targetOrientation = determineTargetOrientation(orientations);
  const instagramBase = downloaded
    .filter((d, i) => orientations[i] === targetOrientation || orientations[i] === 'square')
    .map(d => d.image);
  logger.info(`postBatch: Instagram target orientation = ${targetOrientation} (${instagramBase.length}/${downloaded.length} of primary batch match)`);

  const pickedIds = new Set(downloaded.map(d => d.image.id_encoded ?? d.image.id));
  const need = INSTAGRAM_MAX - instagramBase.length;
  let instagramExtra = [];
  if (need > 0) {
    const excludeIds = [...state.postedIds, ...pickedIds];
    const candidatePool = state.randomMode
      ? await chevereto.fetchRandomImages(need * 3, excludeIds, excludedUsernames)
      : chevereto.weightedSample(recencyPool ?? [], need * 3, excludeIds, excludedUsernames);
    instagramExtra = await pickOrientationMatched(candidatePool, targetOrientation, need);
  }
  const instagramPicks = [...instagramBase, ...instagramExtra];
  logger.info(`postBatch: ${instagramPicks.length} images for Instagram (${instagramBase.length} from primary batch + ${instagramExtra.length} orientation-matched extra)`);

  // ── Fix #19: extract VRCX metadata concurrently (reuse cached buffers)
  const vrcxResults = await Promise.all(
    downloaded.map(async ({ image, buffer }) => {
      try {
        const vrcx = await chevereto.extractVRCXMetadata(buffer);
        if (vrcx) logger.info(`postBatch: VRCX found in ${image.id}: ${vrcx.worldName}`);
        else       logger.info(`postBatch: no VRCX metadata in ${image.id}`);
        return { id: image.id, vrcx };
      } catch (err) {
        logger.warn(`postBatch: VRCX check error for ${image.id}: ${err.message}`);
        return { id: image.id, vrcx: null };
      }
    })
  );

  const vrcxByImageId = {};
  for (const { id, vrcx } of vrcxResults) {
    if (vrcx) vrcxByImageId[id] = vrcx;
  }

  // ── Shorten long URLs for reply threads and captions ───────────────────────
  // VRChat world URLs go into the VRCX reply thread and Buffer captions.
  // Chevereto viewer URLs go into the image links reply and the {url} template
  // variable. Both are stable per world/image, so the cache fills up over time
  // and API calls become increasingly rare.
  const urlMap = await kutt.shortenMany([
    ...Object.values(vrcxByImageId).map(v => v.worldUrl).filter(Boolean),
    ...downloaded.map(d => d.image.url_viewer).filter(Boolean),
  ]);

  // ── Build entries with per-image alt text ──────────────────────────────────
  const entries = downloaded.map(({ image, blob }) => {
    const vrcx = vrcxByImageId[image.id];
    const altText = vrcx
      ? (vrcx.worldUrl ? `${vrcx.worldName} | ${vrcx.worldUrl}` : vrcx.worldName)
      : '';
    return { image, blob, altText };
  });

  // ── Build caption text for every platform ─────────────────────────────────
  const platformTexts = buildPlatformTexts(
    downloaded.map(d => d.image),
    state.templates,
    state.customTags ?? [],
    state.userMappings ?? {},
    urlMap
  );
  // Bluesky gets the bluesky-specific caption
  const text = platformTexts.bluesky;

  // ── Post ───────────────────────────────────────────────────────────────────
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

  if (!postRef) return;

  // ── Reply 1: World Information (Fix #2: use template) ─────────────────────
  const anyVrcx    = Object.keys(vrcxByImageId).length > 0;
  const worldGroups = new Map(); // hoisted — also used by Buffer crosspost below
  let lastRef = postRef;

  if (anyVrcx) {
    // Build ordered map: worldKey → { vrcx, nums[] }
    for (let i = 0; i < downloaded.length; i++) {
      const { image } = downloaded[i];
      const vrcx      = vrcxByImageId[image.id];
      if (!vrcx) continue;
      const key = vrcx.worldId || vrcx.worldName;
      if (!worldGroups.has(key)) worldGroups.set(key, { vrcx, nums: [] });
      worldGroups.get(key).nums.push(i + 1);
    }

    // Fix #2: render via template instead of hardcoded strings
    const worldText   = buildVrcxReplyText(worldGroups, downloaded, state.templates, state.userMappings ?? {}, urlMap);
    const worldChunks = chunkText(worldText);
    lastRef = await sendChunkedReplies(postRef, postRef, worldChunks);
    logger.info(`postBatch: world info reply posted (${worldGroups.size} unique world(s))`);
  } else {
    logger.info('postBatch: no VRCX data in any image — skipping world info reply');
  }

  // World-stats heatmap: reuses worldGroups/downloaded exactly as-is — no
  // separate scrape or parsing needed since we already have the structured
  // data right here. No-ops safely if worldGroups is empty (no VRCX this batch).
  // Strips resolveHandle's leading "@" so live-recorded names use the same
  // bare-handle convention the historical backfill parser stores.
  await worldstats.recordBatch(
    worldGroups,
    downloaded,
    username => resolveHandle(username, state.userMappings ?? {}, 'bluesky').replace(/^@/, ''),
    postRef.uri,
  );

  // Weekly/monthly roundup tracking — no longer a draft per batch (that
  // just mirrored every other platform's cadence); this quietly tallies
  // into the running week/month totals, and checkRoundups() (top of
  // runCycle) turns a completed period into a single roundup draft.
  membershipdrafts.trackBatch(state, { downloaded, worldGroups });

  // ── Reply 2: Image Links ───────────────────────────────────────────────────
  // Fix #12: single source of truth for the Chevereto link reply header
  const linkLines = [LINK_REPLY_HEADER];
  for (let i = 0; i < downloaded.length; i++) {
    const { image } = downloaded[i];
    if (image.url_viewer) {
      const viewerUrl = urlMap.get(image.url_viewer) || image.url_viewer;
      linkLines.push(`Image ${i + 1}: ${viewerUrl}`);
    }
  }

  const linkChunks = chunkText(linkLines.join('\n'));
  await sendChunkedReplies(postRef, lastRef, linkChunks);

  // ── Buffer crosspost ───────────────────────────────────────────────────────
  // Twitter and Instagram get a re-rendered high-quality JPEG built from the
  // same original file Bluesky uses (see imagerender.js), instead of
  // Chevereto's own downscaled .md. thumbnail — falls back to the .md. URL
  // if PUBLIC_BASE_URL isn't configured, so this never blocks a post.
  const batchImageUrls     = downloaded.map(d => renderUrlFor(d.image)).filter(Boolean);
  const instagramImageUrls = instagramPicks.map(renderUrlFor).filter(Boolean);

  let bufferWorldText = '';
  if (anyVrcx) {
    const worldLines = [];
    for (const { vrcx } of worldGroups.values()) {
      worldLines.push(`🌍 ${vrcx.worldName}`);
      if (vrcx.worldUrl) worldLines.push(urlMap.get(vrcx.worldUrl) || vrcx.worldUrl);
    }
    bufferWorldText = worldLines.join('\n');
  }

  // Instagram doesn't hyperlink captions or comments, but this still gives
  // people the same world info + per-image links Bluesky gets as a reply
  // thread — just as a first comment instead, since IG has no reply concept.
  // Note: Buffer currently has a known bug where Instagram firstComment is
  // silently dropped server-side (works fine for Facebook/LinkedIn) — this
  // is sent regardless so it starts working the moment Buffer fixes it.
  const igFirstComment = [bufferWorldText, linkLines.join('\n')]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 2200);

  await bufferApi.crosspost(state.buffer, {
    platformTexts,
    worldText:         bufferWorldText || undefined,
    firstCommentText:  igFirstComment  || undefined,
    // Image viewer links — Bluesky gets these as a reply thread; Twitter gets
    // them as additional tweets; Instagram gets them via firstCommentText above.
    linkText:          linkLines.length > 1 ? linkLines.join('\n') : undefined,
    imageUrls:         batchImageUrls,
    platformImageUrls: { instagram: instagramImageUrls },
  });

  logger.info(`postBatch: cycle complete — ${downloaded.length} images posted with reply thread`);
}

// ─── Instagram orientation matching ───────────────────────────────────────────
// Twitter and Bluesky are fine with mixed portrait/landscape in one post.
// Instagram's carousel looks inconsistent when slides don't share an
// orientation, so its image list is curated to be all-portrait or
// all-landscape — never a mix — rather than transformed after the fact.

/**
 * Pick the orientation Instagram's carousel should target, from the
 * primary batch's own orientations. Ties favor landscape (VRChat's
 * default screenshot shape); square images don't count toward either
 * side but are treated as compatible with whichever orientation wins.
 */
function determineTargetOrientation(orientations) {
  const counts = { landscape: 0, portrait: 0 };
  for (const o of orientations) {
    if (o === 'landscape') counts.landscape++;
    else if (o === 'portrait') counts.portrait++;
  }
  if (counts.landscape === 0 && counts.portrait === 0) return 'landscape';
  return counts.portrait > counts.landscape ? 'portrait' : 'landscape';
}

/**
 * Download and check orientation for a pool of candidate images, keeping
 * only ones matching targetOrientation (or square), up to `need` of them.
 * These weren't already downloaded for Bluesky/Twitter, so this does cost
 * real fetches — bounded to what's needed to fill Instagram's carousel,
 * not the whole candidate pool.
 */
async function pickOrientationMatched(candidates, targetOrientation, need) {
  const picked = [];
  for (const img of candidates) {
    if (picked.length >= need) break;
    try {
      const { buffer } = await chevereto.downloadImage(img);
      const orientation = await chevereto.getOrientation(buffer);
      if (orientation === targetOrientation || orientation === 'square') {
        picked.push(img);
      }
    } catch (err) {
      logger.warn(`postBatch: Instagram orientation check failed for ${img.id}: ${err.message}`);
    }
  }
  return picked;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startScheduler };