/**
 * state.js – lightweight JSON-backed state store
 */

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, '..', 'bot-state.json');

const DEFAULT_STATE = {
  running: true,
  randomMode: false,   // false = recency-biased (default); true = full random via /?random
  postedIds: [],
  highlights: [],
  spotlightHistory: [],
  // Rolling list of ready-to-copy Patreon/Ko-fi drafts, newest first, capped
  // at 50 by membershipdrafts.js. Neither platform's API supports automated
  // posting, so this is a manual copy-paste aid, not a crosspost queue.
  membershipDrafts: [],
  // Running weekly/monthly image + world tallies for the roundup drafts
  // above. Left null here (rather than a static object) since week/month
  // start dates need to be computed from the real current date on first
  // use, not baked in once at module-load time — see
  // membershipdrafts.js's ensureRoundupTracking().
  roundupTracking: null,
  customTags: ['#photography', '#VRChat'],
  // Chevereto usernames (lowercased) who've asked not to have their photos
  // auto-posted. Checked at selection time (batches/random mode) and at
  // request time (spotlight/album highlight) — never retroactive, this only
  // stops *future* selection; nothing already posted gets touched.
  // Shape: { "username": { excludedAt: ISOString, expiresAt: ISOString|null, note: "" } }
  // expiresAt null = permanent; an ISO timestamp auto-reverts once passed
  // (see isExcluded/getExcludedUsernameSet — expiry is checked live, not
  // dependent on pruneExpiredExclusions having run).
  excludedUsers: {},
  // Maps Chevereto username → per-platform handles.
  // Shape: { "alice": { bluesky: "alice.bsky.social", twitter: "alice_tw", instagram: "alice_ig" } }
  // Unset platform keys mean fall back to the Chevereto username for that platform.
  userMappings: {},

  // Direct Buffer crossposting
  buffer: {
    enabled:    false,
    token:      '',          // personal API token from publish.buffer.com/settings/api
    tokenSetAt: null,        // ISO timestamp — used to warn when token is near 30-day expiry
    // channels is an array of { id, service } so we know each channel's platform
    // and can set platform-specific fields (e.g. mediaType for Instagram)
    channels:   [],
    mode:       'addToQueue', // 'addToQueue' | 'customScheduled'
  },
  stats: {
    totalPosted: 0,
    lastPostedAt: null,
    lastCheckAt: null,
  },
  templates: {
    regularPost:     '📸 {username}\n{title}\n{tags}',
    albumHighlight:  '📂 New Album: {title}\nFresh collection from our team!\n#photography #photooftheday',
    memberSpotlight: '🌟 Photographer Spotlight: {name}\nCheck out their recent work below!\n#photography #teamspotlight',
    vrcxReply:       '{worldName}\n🔗 {worldUrl}{photographers}',
    patreonPost:     '📸 {sourceTitle}\n\n{worldInfo}\n\n{photographers}\n\n{tags}',
    kofiPost:        '📸 {sourceTitle}\n\n{worldInfo}\n\n{photographers}',
    patreonWeekly:   '📆 {sourceTitle}\n\n{weekCount}\n{monthToDate}\n\n{mapList}',
    kofiWeekly:      '📆 {sourceTitle}\n\n{weekCount}\n{monthToDate}\n\n{mapList}',
    patreonMonthly:  '🗓️ {sourceTitle}\n\n{monthCount}\n\n{mapList}',
    kofiMonthly:     '🗓️ {sourceTitle}\n\n{monthCount}\n\n{mapList}',
  },
};

function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw   = fs.readFileSync(STATE_FILE, 'utf8');
      const saved = JSON.parse(raw);

      // Migrate old buffer.channelIds (array of strings) → buffer.channels (array of {id,service})
      const savedBuffer = saved.buffer || {};
      if (!savedBuffer.channels && savedBuffer.channelIds?.length) {
        savedBuffer.channels = savedBuffer.channelIds.map(id => ({ id, service: 'unknown' }));
      }

      // Migrate old userMappings flat strings → per-platform objects.
      // Old format: { "alice": "alice.bsky.social" }
      // New format: { "alice": { bluesky: "alice.bsky.social", twitter: "", instagram: "" } }
      const savedMappings = saved.userMappings ?? {};
      const migratedMappings = {};
      for (const [chev, val] of Object.entries(savedMappings)) {
        if (typeof val === 'string') {
          migratedMappings[chev] = { bluesky: val, twitter: '', instagram: '' };
        } else {
          migratedMappings[chev] = { bluesky: '', twitter: '', instagram: '', ...val };
        }
      }

      return {
        ...DEFAULT_STATE,
        ...saved,
        randomMode:       saved.randomMode       ?? false,
        customTags:       saved.customTags       ?? DEFAULT_STATE.customTags,
        membershipDrafts: saved.membershipDrafts ?? [],
        roundupTracking:  saved.roundupTracking  ?? null,
        excludedUsers:    saved.excludedUsers    ?? {},
        userMappings:     migratedMappings,
        buffer:    { ...DEFAULT_STATE.buffer,    ...savedBuffer },
        templates: { ...DEFAULT_STATE.templates, ...(saved.templates || {}) },
        stats:     { ...DEFAULT_STATE.stats,     ...(saved.stats     || {}) },
      };
    }
  } catch (e) { /* ignore, start fresh */ }
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function save(state) {
  // membershipDrafts — membershipdrafts.js already caps this
  // at 50 before calling save(), this is just a safety net in case some
  // future caller forgets. Newest-first (unshifted), so keep the front.
  if (state.membershipDrafts && state.membershipDrafts.length > 50) {
    state.membershipDrafts = state.membershipDrafts.slice(0, 50);
  }

  // Call mkdirSync unconditionally — { recursive: true } makes it a no-op when
  // the directory already exists, and avoids a TOCTOU race between existsSync
  // and writeFileSync (the dir can vanish between the two calls on Docker/WSL2).
  const dir = path.dirname(STATE_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    // Log but don't re-throw — a failed save is recoverable; state stays in
    // memory and the next save attempt may succeed. Re-throwing would crash the
    // process when save() is called from a fire-and-forget async context.
    logger.error(`state.save: could not write ${STATE_FILE} — ${err.message}`);
  }
}

module.exports = {
  load, save, DEFAULT_STATE,
  getExcludedUsernameSet, isExcluded, pruneExpiredExclusions,
};

/**
 * An exclusion entry is active if it has no expiresAt (permanent) or its
 * expiresAt is still in the future. Used at read time so correctness never
 * depends on pruneExpiredExclusions() having run recently — a temporary
 * exclusion stops applying the instant it expires, whether or not anything
 * has cleaned up the stale entry yet.
 */
function isEntryActive(entry) {
  if (!entry) return false;
  if (!entry.expiresAt) return true; // permanent
  return new Date(entry.expiresAt).getTime() > Date.now();
}

/**
 * Build a lowercased Set of currently-excluded Chevereto usernames from
 * state, for O(1) lookup during image selection (weightedSample/
 * fetchRandomImages run this check per-image, potentially many times a
 * cycle). Expired temporary exclusions are excluded from the set.
 */
function getExcludedUsernameSet(state) {
  return new Set(
    Object.entries(state.excludedUsers || {})
      .filter(([, entry]) => isEntryActive(entry))
      .map(([username]) => username.toLowerCase())
  );
}

/** Case-insensitive single-username check, for the request-time checks
 * (spotlight/album) where building a whole Set is unnecessary overhead. */
function isExcluded(state, username) {
  if (!username) return false;
  return isEntryActive((state.excludedUsers || {})[username.toLowerCase()]);
}

/**
 * Remove any exclusion entries whose time period has passed. Not required
 * for correctness (isExcluded/getExcludedUsernameSet already ignore expired
 * entries on their own) — this is purely so the stored list and the
 * dashboard don't accumulate stale "expired 3 months ago" rows forever.
 * Returns the list of usernames that were pruned, for logging.
 */
function pruneExpiredExclusions(state) {
  const now = Date.now();
  const expired = [];
  for (const [username, entry] of Object.entries(state.excludedUsers || {})) {
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() <= now) {
      expired.push(username);
    }
  }
  for (const username of expired) delete state.excludedUsers[username];
  return expired;
}