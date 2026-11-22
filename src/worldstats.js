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
 * Both paths converge on the same on-disk shape and the same
 * lastSyncedPostUri cursor, so re-running a backfill after live posts have
 * already happened won't double-count anything — it just fills in
 * whatever's older than the cursor.
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

const STATS_FILE = process.env.WORLD_STATS_FILE || path.join(__dirname, '..', 'world-stats.json');

const DEFAULT_DATA = {
  worlds: {},            // worldId -> { worldId, worldName, worldUrl, totalPhotos, photographers: {name: count}, tags, tagsFetchedAt, firstSeen, lastSeen }
  lastBackfillAt: null,
  lastSyncedPostUri: null,
};

// ─── Storage ────────────────────────────────────────────────────────────────

function load() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      return { ...DEFAULT_DATA, ...saved, worlds: saved.worlds ?? {} };
    }
  } catch (err) {
    logger.warn(`worldstats.load: could not read ${STATS_FILE} — starting fresh (${err.message})`);
  }
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function save(data) {
  const dir = path.dirname(STATS_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error(`worldstats.save: could not write ${STATS_FILE} — ${err.message}`);
  }
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
function addWorldHit(data, { worldId, worldName, worldUrl, count, photographerNames = [], when }) {
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

  const names = [...new Set(photographerNames)];
  if (names.length === 1) {
    entry.photographers[names[0]] = (entry.photographers[names[0]] || 0) + count;
  } else if (names.length > 1) {
    const base  = Math.floor(count / names.length);
    const extra = count - base * names.length; // remainder goes to the first-listed
    names.forEach((name, i) => {
      const share = base + (i === 0 ? extra : 0);
      if (share > 0) entry.photographers[name] = (entry.photographers[name] || 0) + share;
    });
  }
}

/**
 * Fetch and cache a world's author tags — only if we haven't already tried.
 * A world with genuinely zero author tags is a valid final answer (VRChat
 * requires no minimum tags on upload); tagsFetchedAt gets set either way so
 * we don't keep re-asking VRChat about a world that just doesn't have any.
 * Only a failed *fetch* (network error, exhausted retries) leaves it unset,
 * so a later run can retry.
 *
 * Mutates `data` in place but doesn't save — callers save once per batch
 * of work rather than once per world.
 */
async function ensureTags(data, worldId) {
  const entry = data.worlds[worldId];
  if (!entry || entry.tagsFetchedAt) return;

  const result = await vrchat.fetchWorldTags(worldId);
  if (result.ok) {
    entry.tags = result.tags;
    entry.tagsFetchedAt = new Date().toISOString();
  }
}

/**
 * Live hook — call right after a successful batch post. Reuses the exact
 * worldGroups Map and downloaded array postBatch already built, so every
 * photographer/world attribution is exact, not parsed.
 *
 * @param {Map}      worldGroups     — worldKey -> { vrcx, nums }, from postBatch
 * @param {Array}    downloaded      — [{ image, blob, buffer }], from postBatch
 * @param {function} resolveDisplay  — (chevUsername) => display handle string
 * @param {string}   postUri         — the just-created root post's AT URI
 */
async function recordBatch(worldGroups, downloaded, resolveDisplay, postUri) {
  if (!worldGroups || worldGroups.size === 0) return;

  const data = load();
  const now  = new Date().toISOString();
  const newWorldIds = [];

  for (const { vrcx, nums } of worldGroups.values()) {
    if (!vrcx?.worldId) continue;
    const isNew = !data.worlds[vrcx.worldId];
    const photographerNames = [...new Set(
      nums.map(n => downloaded[n - 1]?.image?.user?.username).filter(Boolean)
    )].map(resolveDisplay);

    addWorldHit(data, {
      worldId:   vrcx.worldId,
      worldName: vrcx.worldName,
      worldUrl:  vrcx.worldUrl,
      count:     nums.length,
      photographerNames,
      when: now,
    });
    if (isNew) newWorldIds.push(vrcx.worldId);
  }

  if (postUri) data.lastSyncedPostUri = postUri;

  // Tag fetches only happen for brand-new worlds — most posts revisit
  // already-known ones, so this rarely adds any real delay to the cycle.
  for (const worldId of newWorldIds) {
    await ensureTags(data, worldId);
  }

  save(data);
  logger.info(`worldstats: recorded ${worldGroups.size} world(s) from live post${newWorldIds.length ? ` (${newWorldIds.length} new)` : ''}`);
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

/**
 * Walk the bot's own Bluesky history and rebuild world-stats.json from the
 * text of each post's world-info reply thread. Safe to re-run — stops once
 * it reaches lastSyncedPostUri, so it only ever fills in what's new/older
 * than what's already recorded (via a previous backfill or live posts).
 *
 * onProgress(current, total) is optional, for a dashboard progress readout.
 */
async function runBackfill({ onProgress } = {}) {
  const data  = load();
  const myDid = await bsky.getMyDid();

  logger.info('worldstats.runBackfill: fetching root post list…');
  const roots = await bsky.getMyRootPosts({ stopAtUri: data.lastSyncedPostUri });
  logger.info(`worldstats.runBackfill: ${roots.length} post(s) to check`);

  let worldsFound = 0;
  let postsWithWorlds = 0;
  const newWorldIds = new Set();

  for (let idx = 0; idx < roots.length; idx++) {
    const root = roots[idx];
    if (onProgress) onProgress(idx + 1, roots.length);

    try {
      const threadText = await bsky.getThreadText(root.uri, myDid);
      if (!threadText) continue;

      const blocks = parseWorldBlocks(threadText);
      if (blocks.length === 0) continue;

      // Single-photographer fallback: only needed if NONE of this post's
      // world blocks carried an explicit photographers line.
      const anyExplicitPhotographers = blocks.some(b => b.photographers.length > 0);
      const rootPhotographer = anyExplicitPhotographers ? null : extractRootPhotographer(root.text);

      for (const block of blocks) {
        const names = block.photographers.length > 0
          ? block.photographers
          : (rootPhotographer ? [rootPhotographer] : []);

        if (!data.worlds[block.worldId]) newWorldIds.add(block.worldId);
        addWorldHit(data, {
          worldId:   block.worldId,
          worldName: block.worldName,
          worldUrl:  block.worldUrl,
          count:     block.count,
          photographerNames: names,
          when: root.createdAt,
        });
        worldsFound++;
      }
      postsWithWorlds++;
    } catch (err) {
      logger.warn(`worldstats.runBackfill: failed on post ${root.uri} — ${err.message}`);
    }
  }

  // Tags for every newly-discovered world, once each, with a small courtesy
  // delay between calls — this is a background admin action, not
  // time-sensitive, and VRChat's own docs say their rate limits "must not
  // be treated as consistent or predictable."
  if (newWorldIds.size > 0) {
    logger.info(`worldstats.runBackfill: fetching tags for ${newWorldIds.size} new world(s)…`);
    for (const worldId of newWorldIds) {
      await ensureTags(data, worldId);
      await sleep(300);
    }
  }

  data.lastBackfillAt = new Date().toISOString();
  if (roots.length > 0) data.lastSyncedPostUri = roots[0].uri; // newest-first — roots[0] is the most recent
  save(data);

  logger.info(`worldstats.runBackfill: done — ${worldsFound} world hit(s) across ${postsWithWorlds}/${roots.length} post(s), ${newWorldIds.size} new world(s) tagged`);
  return { postsChecked: roots.length, postsWithWorlds, worldHits: worldsFound, newWorlds: newWorldIds.size };
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