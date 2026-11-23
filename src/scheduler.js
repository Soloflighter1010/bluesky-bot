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

const configuredBatchSize = Number(process.env.POSTS_PER_HOUR || bsky.MAX_POST_IMAGES);
const POSTS_PER_HOUR = Number.isInteger(configuredBatchSize) && configuredBatchSize > 0
  ? Math.min(configuredBatchSize, bsky.MAX_POST_IMAGES)
  : bsky.MAX_POST_IMAGES;
const STAGGER_SCHED_MS  = 5 * 60 * 1000;  // 5 min between scheduled posts
const STAGGER_MANUAL_MS = 30 * 1000;       // 30 s between manual posts

// ── Fix #12: single source of truth for the Chevereto link reply header
const LINK_REPLY_HEADER = '🔗 View on Knowbody Online';

// ─── Template renderer ────────────────────────────────────────────────────────

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '').trim();
}

// Chevereto sometimes uses the upload filename as the image title.
const RAW_SCREENSHOT = /^VRChat[ _-]+\d{4}[ _-]\d{2}[ _-]\d{2}[ _-]+\d{2}[ :_-]\d{2}[ :_-]\d{2}(?:\.\d+)?[ _-]+\d+x\d+(?:\.[a-z0-9]+)?$/i;
const IMAGE_FILENAME = /\.(?:avif|bmp|gif|heic|jpeg|jpg|png|tiff?|webp)(?:$|\s+[|–—-]\s+)/i;
const CAMERA_FILENAME = /^(?:capture|dscf?|img|pxl|screenshot)[ _-]?\d[\w-]*$/i;

function cleanTitle(image) {
  const title = image.title?.trim();
  if (!title || title === 'Untitled' || RAW_SCREENSHOT.test(title) || IMAGE_FILENAME.test(title) || CAMERA_FILENAME.test(title)) return '';
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
  const key = Object.hasOwn(mappings, chevUser) ? chevUser :
    Object.keys(mappings).find(name => name.toLowerCase() === chevUser.toLowerCase());
  const entry = key ? mappings[key] : undefined;
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
  const credit = new Map();
  for (const { user } of images) {
    if (user?.username) credit.set(user.username.toLowerCase(), user.username);
  }
  const usernames = [...credit.values()].map(u => resolveHandle(u, userMappings, platform)).join(' ');

  const titles = images
    .map(cleanTitle)
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
  let activeCycle = null;
  function trigger(manual = true) {
    if (activeCycle) return { started: false, reason: 'A posting cycle is already running' };
    if (manual && !stateIO.load().running) return { started: false, reason: 'The bot is paused' };

    activeCycle = runCycle(manual)
      .catch(err => logger.error(`Cycle error: ${err.message}\n${err.stack}`))
      .finally(() => { activeCycle = null; });
    return { started: true, completion: activeCycle };
  }

  if (configuredBatchSize !== POSTS_PER_HOUR) {
    logger.warn(`POSTS_PER_HOUR must be an integer from 1 to ${bsky.MAX_POST_IMAGES}. Using ${POSTS_PER_HOUR}.`);
  }
  cron.schedule('0 * * * *', () => trigger(false).completion);
  logger.info(`Scheduler active – up to ${POSTS_PER_HOUR} photos per batch`);
  return trigger;
}

async function runCycle(manual) {
  const state = await stateIO.update(current => {
    // Roundups and expired exclusions are maintained even while posting is paused.
    membershipdrafts.checkRoundups(current);
    const pruned = stateIO.pruneExpiredExclusions(current);
    if (pruned.length) logger.info(`Expired exclusions removed: ${pruned.join(', ')}`);
    if (current.running) current.stats.lastCheckAt = new Date().toISOString();
    return current;
  });
  if (!state.running) return;

  const staggerMs = manual ? STAGGER_MANUAL_MS : STAGGER_SCHED_MS;
  logger.info(`runCycle: starting (${manual ? 'manual' : 'scheduled'}, stagger ${staggerMs / 1000}s)`);
  const recentCache = state.randomMode ? null : await chevereto.fetchRecentImages(5);
  const latest = stateIO.load();
  if (!latest.running) return;

  const highlight = latest.highlights[0];
  if (highlight) {
    try {
      if (await postHighlight(highlight, latest)) await sleep(staggerMs);
    } catch (err) {
      logger.error(`Highlight failed: ${err.message}`);
    }
  }

  const batchState = stateIO.load();
  if (batchState.running) await postBatch(batchState, recentCache);
}

function canPublish(images, highlight) {
  const current = stateIO.load();
  if (!current.running) return false;
  if (highlight && (!current.highlights.some(item => item.id === highlight.id) ||
      stateIO.isExcluded(current, highlight.username))) return false;
  return images.every(image => !stateIO.isExcluded(current, image.user?.username));
}

async function finishHighlight(highlight, record = () => {}) {
  await stateIO.update(state => {
    const index = state.highlights.findIndex(item => item.id === highlight.id);
    if (index >= 0) state.highlights.splice(index, 1);
    record(state);
  });
}

async function postHighlight(highlight, state) {
  const uploader = highlight.username || highlight.coverImage?.user?.username;
  if (stateIO.isExcluded(state, uploader)) {
    logger.info(`Dropping queued highlight for excluded photographer @${uploader}`);
    await finishHighlight(highlight);
    return false;
  }
  if (highlight.type === 'album') return postAlbumHighlight(highlight, state);
  if (highlight.type === 'spotlight') return postMemberSpotlight(highlight, state);
  await finishHighlight(highlight);
  return false;
}

async function postAlbumHighlight(highlight, state) {
  const text = renderTemplate(state.templates.albumHighlight || stateIO.DEFAULT_STATE.templates.albumHighlight,
    { title: highlight.title });
  const image = highlight.coverImage;
  const isPublishable = () => canPublish(image ? [image] : [], highlight);

  let postRef;
  if (image) {
    const { buffer, mimeType } = await chevereto.downloadImage(image);
    const blob = await bsky.uploadBlob(buffer, mimeType);
    postRef = await bsky.postPhoto(image, blob, text, true, isPublishable);
  } else {
    postRef = await bsky.postText(text, isPublishable);
  }
  if (!postRef) return false;

  await finishHighlight(highlight, current => {
    current.stats.totalPosted++;
    current.stats.lastPostedAt = new Date().toISOString();
    membershipdrafts.recordAlbum(current, { highlight });
  });
  await bufferApi.crosspost(stateIO.load().buffer, {
    platformTexts: { bluesky: text, twitter: text, instagram: text },
  });
  return true;
}

async function postMemberSpotlight(highlight, state) {
  const images = await chevereto.fetchUserSpotlightImages(highlight.username);
  const candidates = images.length ? images : (highlight.images ?? []).slice(0, 3);
  const entries = [];
  for (const image of candidates) {
    try {
      const { buffer, mimeType } = await chevereto.downloadImage(image);
      const blob = await bsky.uploadBlob(buffer, mimeType);
      const altText = image.spotlightRole ? `${image.spotlightRole} photo` : '';
      entries.push({ image, blob, altText });
    } catch (err) {
      logger.warn(`Spotlight: download or upload failed for ${image.id}: ${err.message}`);
    }
  }
  if (candidates.length && !entries.length) throw new Error(`No usable photos for @${highlight.username}`);

  const tpl = state.templates.memberSpotlight || stateIO.DEFAULT_STATE.templates.memberSpotlight;
  const makeText = platform => renderTemplate(tpl, {
    name: highlight.name,
    username: resolveHandle(highlight.username, state.userMappings, platform),
  });
  const platformTexts = {
    bluesky: makeText('bluesky'),
    twitter: makeText('twitter'),
    instagram: makeText('instagram'),
  };
  const isPublishable = () => canPublish(entries.map(({ image }) => image), highlight);
  const postRef = entries.length
    ? await bsky.postPhotosWithText(entries, platformTexts.bluesky, isPublishable)
    : await bsky.postText(platformTexts.bluesky, isPublishable);
  if (!postRef) return false;

  await finishHighlight(highlight, current => {
    current.stats.totalPosted++;
    current.stats.lastPostedAt = new Date().toISOString();
    current.postedIds.push(...entries.map(({ image }) => image.id_encoded ?? image.id));
    if (entries.length) membershipdrafts.recordSpotlight(current, { highlight, entries });
    recordSpotlightHistory(current, highlight);
  });
  await bufferApi.crosspost(stateIO.load().buffer, {
    platformTexts,
    imageUrls: entries.map(({ image }) => renderUrlFor(image)).filter(Boolean),
  });
  return true;
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

async function postBatch(state, recentCache) {
  const excluded = stateIO.getExcludedUsernameSet(state);
  const recencyPool = state.randomMode ? [] : recentCache ?? await chevereto.fetchRecentImages(5);
  const picks = state.randomMode
    ? await chevereto.fetchRandomImages(POSTS_PER_HOUR, state.postedIds, excluded)
    : chevereto.weightedSample(recencyPool, POSTS_PER_HOUR, state.postedIds, excluded);

  if (!picks.length) {
    logger.warn('postBatch: no usable photos selected');
    return;
  }

  const uploaded = [];
  for (const image of picks) {
    if (!stateIO.load().running) return;
    try {
      const { buffer, mimeType } = await chevereto.downloadImage(image);
      const blob = await bsky.uploadBlob(buffer, mimeType);
      uploaded.push({ image, blob, buffer });
    } catch (err) {
      logger.warn(`postBatch: download or upload failed for ${image.id}: ${err.message}`);
    }
  }
  if (!uploaded.length) return;

  await Promise.all(uploaded.map(async entry => {
    try {
      entry.vrcx = await chevereto.extractVRCXMetadata(entry.buffer);
    } catch (err) {
      logger.warn(`postBatch: VRCX check failed for ${entry.image.id}: ${err.message}`);
    }
  }));
  const urlMap = await kutt.shortenMany(uploaded.flatMap(({ image, vrcx }) => [image.url_viewer, vrcx?.worldUrl]).filter(Boolean));

  const latest = stateIO.load();
  if (!latest.running) return;
  const downloaded = uploaded.filter(({ image }) => !stateIO.isExcluded(latest, image.user?.username));
  if (!downloaded.length) return;

  const images = downloaded.map(({ image }) => image);
  const entries = downloaded.map(({ image, blob, vrcx }) => ({
    image,
    blob,
    altText: vrcx ? [vrcx.worldName, vrcx.worldUrl].filter(Boolean).join(' | ') : cleanTitle(image) || 'Photo',
  }));
  const platformTexts = buildPlatformTexts(images, latest.templates, latest.customTags, latest.userMappings, urlMap);
  const postRef = await bsky.postPhotosWithText(entries, platformTexts.bluesky, () => canPublish(images));
  if (!postRef) return;

  const worldGroups = new Map();
  for (const [index, { vrcx }] of downloaded.entries()) {
    if (!vrcx) continue;
    const key = vrcx.worldId || vrcx.worldName;
    if (!worldGroups.has(key)) worldGroups.set(key, { vrcx, nums: [] });
    worldGroups.get(key).nums.push(index + 1);
  }
  await stateIO.update(current => {
    current.postedIds.push(...images.map(image => image.id_encoded ?? image.id));
    current.stats.totalPosted += images.length;
    current.stats.lastPostedAt = new Date().toISOString();
    membershipdrafts.trackBatch(current, { downloaded, worldGroups });
  });

  let lastRef = postRef;
  if (worldGroups.size) {
    const worldText = buildVrcxReplyText(worldGroups, downloaded, latest.templates, latest.userMappings, urlMap);
    await worldstats.recordBatch(
      worldGroups,
      downloaded,
      username => resolveHandle(username, latest.userMappings, 'bluesky').replace(/^@/, ''),
      postRef.uri,
    ).catch(err => logger.warn(`postBatch: could not record world stats — ${err.message}`));
    lastRef = await sendChunkedReplies(postRef, postRef, chunkText(worldText));
  }

  const linkText = buildImageLinks(images, urlMap);
  await sendChunkedReplies(postRef, lastRef, chunkText(linkText));
  logger.info(`postBatch: posted ${images.length} images with reply thread`);

  const crosspostState = stateIO.load();
  const { buffer: bufferConfig } = crosspostState;
  if (!bufferConfig.enabled || !bufferConfig.token || !bufferConfig.channels.length || !canPublish(images)) return;
  const instagramEnabled = bufferConfig.channels.some(({ service }) =>
    ['instagram', 'unknown'].includes(service.toLowerCase()));
  const instagramPicks = instagramEnabled
    ? await selectInstagramImages(downloaded, crosspostState, recencyPool, state.randomMode)
    : [];

  if (!canPublish(images)) return;
  const finalState = stateIO.load();
  const instagramMedia = instagramPicks
    .filter(image => !stateIO.isExcluded(finalState, image.user?.username))
    .map(image => ({ image, url: renderUrlFor(image) }))
    .filter(({ url }) => url);
  const instagramImages = instagramMedia.map(({ image }) => image);
  platformTexts.instagram = buildPostText(
    instagramImages, latest.templates, latest.customTags, latest.userMappings, 'instagram', urlMap,
  );

  const worldText = [...worldGroups.values()]
    .flatMap(({ vrcx }) => [`🌍 ${vrcx.worldName}`, urlMap.get(vrcx.worldUrl) || vrcx.worldUrl])
    .filter(Boolean).join('\n');
  const firstCommentText = [worldText, buildImageLinks(instagramImages, urlMap)].filter(Boolean).join('\n\n').slice(0, 2200);
  await bufferApi.crosspost(finalState.buffer, {
    platformTexts,
    worldText,
    firstCommentText,
    linkText,
    imageUrls: images.map(renderUrlFor).filter(Boolean),
    platformImageUrls: { instagram: instagramMedia.map(({ url }) => url) },
  });
}

function buildImageLinks(images, urlMap) {
  const links = [LINK_REPLY_HEADER];
  for (const [index, { url_viewer: viewerUrl }] of images.entries()) {
    if (viewerUrl) links.push(`Image ${index + 1}: ${urlMap.get(viewerUrl) || viewerUrl}`);
  }
  return links.join('\n');
}

async function selectInstagramImages(downloaded, state, recencyPool, randomMode) {
  const orientations = await Promise.all(downloaded.map(({ buffer }) => chevereto.getOrientation(buffer)));
  const target = determineTargetOrientation(orientations);
  const images = downloaded
    .filter((_, index) => orientations[index] === target || orientations[index] === 'square')
    .map(({ image }) => image);
  const need = 10 - images.length;
  const excluded = stateIO.getExcludedUsernameSet(state);
  const candidates = randomMode
    ? await chevereto.fetchRandomImages(need * 3, state.postedIds, excluded)
    : chevereto.weightedSample(recencyPool, need * 3, state.postedIds, excluded);
  return [...images, ...await pickOrientationMatched(candidates, target, need)];
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
