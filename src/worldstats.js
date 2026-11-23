/**
 * worldstats.js – per-world photo statistics for the public heatmap page
 *
 * Two ways data gets in here:
 *
 *   1. Live — recordBatch() is called from scheduler.js's postBatch() right
 *      after a successful post, reusing the exact worldGroups/downloaded
 *      data postBatch already computed for the Bluesky reply thread. Fully
 *      accurate: no parsing, no guessing.
 *
 *   2. Backfill — runBackfill() walks the bot's own Bluesky post history
 *      and re-derives the same data from the *text* of the world-info reply
 *      thread, since that's the only surviving record for anything posted
 *      before this feature existed. See parseWorldBlocks() for the format
 *      this expects (matches buildVrcxReplyText's default template output).
 *
 * Live and historical writes share a ledger of counted root post URIs.
 * Only the historical scan advances the backfill checkpoint.
 *
 * World tags (see vrchat.js) are fetched once per world, the first time
 * it's ever recorded (live or via backfill), and cached forever — never
 * re-checked after that. See ensureTags() below.
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');
const bsky   = require('./bluesky');
const vrchat = require('./vrchat');
const { writeJSON } = require('./jsonfile');

const STATS_FILE = process.env.WORLD_STATS_FILE || path.join(__dirname, '..', 'world-stats.json');

const DEFAULT_DATA = {
  worlds: {},            // worldId -> { worldId, worldName, worldUrl, totalPhotos, photographers: {name: count}, tags, tagsFetchedAt, firstSeen, lastSeen }
  lastBackfillAt: null,
  lastBackfillPostUri: null,
  countedPostUris: {},
  legacyWorldRanges: {},
};

// ─── Storage ────────────────────────────────────────────────────────────────

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    const worlds = saved.worlds ?? {};
    const { lastSyncedPostUri, ...data } = saved;
    // Older files kept totals without post IDs. Preserve those totals and use
    // their date ranges to avoid adding historical photos that may already count.
    const legacyWorldRanges = saved.legacyWorldRanges ?? Object.fromEntries(
      Object.entries(worlds).map(([id, world]) => [id, { firstSeen: world.firstSeen, lastSeen: world.lastSeen }]),
    );
    const countedPostUris = saved.countedPostUris ?? (lastSyncedPostUri ? { [lastSyncedPostUri]: true } : {});
    return { ...DEFAULT_DATA, ...data, worlds, legacyWorldRanges, countedPostUris };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return structuredClone(DEFAULT_DATA);
  }
}

function save(data) {
  writeJSON(STATS_FILE, data);
}

function overlapsLegacyStats(data, worldId, createdAt) {
  const range = data.legacyWorldRanges[worldId];
  if (!range) return false;
  const date = Date.parse(createdAt);
  const first = Date.parse(range.firstSeen);
  const last = Date.parse(range.lastSeen);
  // Legacy live tallies used the time they were recorded, after the root published.
  const tolerance = 60_000;
  return !Number.isFinite(date) || !Number.isFinite(first) || !Number.isFinite(last) ||
    (date >= first - tolerance && date <= last + tolerance);
}

// ─── Recording (shared by live + backfill) ───────────────────────────────────

/**
 * Add `count` photos to a world's tally, splitting attribution across
 * `photographerNames` (already-resolved display handles). When there's
 * exactly one photographer, they get the full count. With more than one
 * and no per-image detail available (the backfill's multi-photographer
 * case), the count is split as evenly as integers allow — an approximation,
 * called out clearly in the README; live recording never needs this branch
 * since it always knows exactly who shot which image.
 */
function addWorldHit(data, { worldId, worldName, worldUrl, count, photographerNames = [], photographerCounts, when }) {
  if (!worldId || !count) return;

  let entry = data.worlds[worldId];
  if (!entry) {
    entry = data.worlds[worldId] = {
      worldId, worldName, worldUrl,
      totalPhotos: 0,
      photographers: {},
      tags: [],
      tagsFetchedAt: null, // null = not yet attempted; set on any successful fetch, tagged or not
      firstSeen: when || new Date().toISOString(),
      lastSeen:  when || new Date().toISOString(),
    };
  }
  entry.worldName = worldName || entry.worldName;
  entry.worldUrl  = worldUrl  || entry.worldUrl;
  entry.totalPhotos += count;
  if (when && (!entry.lastSeen || when > entry.lastSeen))  entry.lastSeen  = when;
  if (when && (!entry.firstSeen || when < entry.firstSeen)) entry.firstSeen = when;

  if (photographerCounts) {
    for (const [name, photos] of photographerCounts) {
      const previous = Object.hasOwn(entry.photographers, name) ? entry.photographers[name] : 0;
      entry.photographers = { ...entry.photographers, [name]: previous + photos };
    }
    return;
  }

  const names = [...new Set(photographerNames)];
  if (names.length === 1) {
    const [name] = names;
    entry.photographers = { ...entry.photographers, [name]: (Object.hasOwn(entry.photographers, name) ? entry.photographers[name] : 0) + count };
  } else if (names.length > 1) {
    const base  = Math.floor(count / names.length);
    const extra = count - base * names.length; // remainder goes to the first-listed
    names.forEach((name, i) => {
      const share = base + (i === 0 ? extra : 0);
      if (share > 0) {
        const previous = Object.hasOwn(entry.photographers, name) ? entry.photographers[name] : 0;
        entry.photographers = { ...entry.photographers, [name]: previous + share };
      }
    });
  }
}

async function fetchMissingTags(worldIds, delay = 0) {
  for (const worldId of worldIds) {
    if (load().worlds[worldId]?.tagsFetchedAt) continue;
    const result = await vrchat.fetchWorldTags(worldId);
    if (result.ok) {
      const latest = load();
      const entry = latest.worlds[worldId];
      if (entry && !entry.tagsFetchedAt) {
        entry.tags = result.tags;
        entry.tagsFetchedAt = new Date().toISOString();
        save(latest);
      }
    }
    if (delay) await sleep(delay);
  }
}

async function recordBatch(worldGroups, downloaded, resolveDisplay, postUri) {
  if (!worldGroups?.size) return;
  const data = load();
  if (postUri && Object.hasOwn(data.countedPostUris, postUri)) return;
  const now = new Date().toISOString();
  const worldIds = new Set();

  for (const { vrcx, nums } of worldGroups.values()) {
    if (!vrcx?.worldId) continue;
    const photographerCounts = new Map();
    for (const imageNumber of nums) {
      const username = downloaded[imageNumber - 1]?.image?.user?.username;
      if (!username) continue;
      const display = resolveDisplay(username);
      photographerCounts.set(display, (photographerCounts.get(display) ?? 0) + 1);
    }
    addWorldHit(data, {
      worldId: vrcx.worldId,
      worldName: vrcx.worldName,
      worldUrl: vrcx.worldUrl,
      count: nums.length,
      photographerCounts,
      when: now,
    });
    worldIds.add(vrcx.worldId);
  }

  if (postUri) data.countedPostUris[postUri] = true;
  save(data);
  fetchMissingTags(worldIds).catch(err => logger.warn(`worldstats: could not save world tags — ${err.message}`));
  logger.info(`worldstats: recorded ${worldIds.size} world(s) from live post`);
}

// ─── Historical text parsing ──────────────────────────────────────────────────

const LINK_REPLY_HEADER = '🔗 View on Knowbody Online'; // must match scheduler.js's constant
const WORLD_HEADER_RE = /^Images?\s+([\d,\s&]+)\s+—\s+(.+)$/;
const WORLD_URL_RE    = /https:\/\/vrchat\.com\/home\/world\/(wrld_[A-Za-z0-9-]+)/;
const HANDLE_LINE_RE  = /^(@[\w.-]+\s*)+$/;
const ROOT_HANDLE_RE  = /@([\w.-]+)/g;

/**
 * Parse the reconstructed reply-chain text (world info + link list,
 * concatenated) into a list of { count, worldName, worldUrl, worldId,
 * photographers } blocks. Stops scanning once it reaches the link-list
 * header, since everything after that is Chevereto viewer links, not
 * world info, and shares no format with the world blocks.
 *
 * Exported on its own so it can be unit-tested against synthetic text
 * without touching the network.
 */
function parseWorldBlocks(fullText) {
  const lines  = fullText.split('\n');
  const blocks = [];
  let unmatched = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === LINK_REPLY_HEADER) break; // link-list section starts here — done with world blocks

    const header = line.match(WORLD_HEADER_RE);
    if (header) {
      const count = header[1].split(/[,&]/).map(s => s.trim()).filter(Boolean).length;
      const worldName = header[2].trim();

      let worldUrl = null, worldId = null;
      if (i + 1 < lines.length) {
        const urlMatch = lines[i + 1].match(WORLD_URL_RE);
        if (urlMatch) { worldUrl = urlMatch[0]; worldId = urlMatch[1]; }
      }

      let photographers = [];
      let consumed = 2;
      if (i + 2 < lines.length && HANDLE_LINE_RE.test(lines[i + 2].trim())) {
        photographers = lines[i + 2].trim().split(/\s+/).map(h => h.replace(/^@/, ''));
        consumed = 3;
      }

      if (worldUrl && worldId) {
        blocks.push({ count, worldName, worldUrl, worldId, photographers });
      } else {
        unmatched++;
      }
      i += consumed;
      continue;
    }
    i++;
  }

  if (unmatched > 0) {
    logger.warn(`worldstats.parseWorldBlocks: ${unmatched} world header line(s) found without a following URL — likely a custom vrcxReply template on those posts`);
  }
  return blocks;
}

/**
 * Fallback photographer for single-photographer batches, where the
 * per-world "who shot this" line is omitted (the uploader's already
 * credited in the main post). Takes the FIRST @handle in the root post
 * text, matching how buildPostText renders {username} for a one-uploader
 * batch.
 */
function extractRootPhotographer(rootText) {
  const match = ROOT_HANDLE_RE.exec(rootText);
  ROOT_HANDLE_RE.lastIndex = 0; // reset — this regex is reused across calls
  return match ? match[1] : null;
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

async function runBackfill({ onProgress } = {}) {
  const initial = load();
  const myDid = await bsky.getMyDid();
  const roots = await bsky.getMyRootPosts({ stopAtUri: initial.lastBackfillPostUri });
  logger.info(`worldstats.runBackfill: ${roots.length} historical post(s) to check`);

  const posts = [];
  let failed = 0;
  for (const [index, root] of roots.entries()) {
    onProgress?.(index + 1, roots.length);
    if (Object.hasOwn(initial.countedPostUris, root.uri)) continue;
    try {
      const threadText = await bsky.getThreadText(root.uri, myDid);
      const blocks = parseWorldBlocks(threadText);
      const rootPhotographer = blocks.some(block => block.photographers.length)
        ? null : extractRootPhotographer(root.text);
      posts.push({ root, blocks, rootPhotographer });
    } catch (err) {
      failed++;
      logger.warn(`worldstats.runBackfill: failed on ${root.uri} — ${err.message}`);
    }
  }

  // A live batch can finish while the history is being fetched.
  const data = load();
  let worldHits = 0;
  let postsWithWorlds = 0;
  const worldIds = new Set();
  const newWorldIds = new Set();

  for (const { root, blocks, rootPhotographer } of posts.reverse()) {
    if (Object.hasOwn(data.countedPostUris, root.uri)) continue;
    let added = false;
    for (const block of blocks) {
      if (overlapsLegacyStats(data, block.worldId, root.createdAt)) continue;
      if (!data.worlds[block.worldId]) newWorldIds.add(block.worldId);
      addWorldHit(data, {
        ...block,
        photographerNames: block.photographers.length ? block.photographers : [rootPhotographer].filter(Boolean),
        when: root.createdAt,
      });
      worldIds.add(block.worldId);
      worldHits++;
      added = true;
    }
    if (added) postsWithWorlds++;
    if (blocks.length) data.countedPostUris[root.uri] = true;
  }

  data.lastBackfillAt = new Date().toISOString();
  // Keep the checkpoint behind failed thread reads so the next run can retry them.
  if (!failed && roots.length) data.lastBackfillPostUri = roots[0].uri;
  save(data);
  await fetchMissingTags(worldIds, 300);

  logger.info(`worldstats.runBackfill: ${worldHits} new world hit(s) in ${postsWithWorlds} post(s), ${failed} failed thread read(s)`);
  return { postsChecked: roots.length, postsWithWorlds, worldHits, newWorlds: newWorldIds.size, failed };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ─── Public read ────────────────────────────────────────────────────────────

/**
 * Shape the stored data for the public /worlds page — an array rather
 * than an id-keyed object, sorted by total photos descending.
 */
function getPublicData() {
  const data = load();
  const worlds = Object.values(data.worlds)
    .map(w => ({
      worldId:       w.worldId,
      worldName:     w.worldName,
      worldUrl:      w.worldUrl,
      totalPhotos:   w.totalPhotos,
      photographers: w.photographers,
      tags:          w.tags ?? [],
    }))
    .sort((a, b) => b.totalPhotos - a.totalPhotos);

  const photographerSet = new Set();
  const tagCounts = new Map();
  worlds.forEach(w => {
    Object.keys(w.photographers).forEach(p => photographerSet.add(p));
    w.tags.forEach(t => tagCounts.set(t, (tagCounts.get(t) || 0) + 1));
  });
  const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);

  return {
    worlds,
    photographers: [...photographerSet].sort(),
    tags,
    lastBackfillAt: data.lastBackfillAt,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  recordBatch, runBackfill, getPublicData,
  parseWorldBlocks, extractRootPhotographer, // exported for testing
};
