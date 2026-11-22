/**
 * membershipdrafts.js – Patreon & Ko-fi post draft generator
 *
 * Neither Patreon nor Ko-fi's public API supports creating posts from a
 * third party (Patreon's API v2 only exposes GET for posts; Ko-fi's API is
 * inbound-only, for payment webhooks). There is no automated-posting path
 * to build here, so this doesn't attempt one.
 *
 * What it does instead: prepare ready-to-copy drafts for the dashboard's
 * Membership Posts section, on two different cadences —
 *
 *   - Spotlights and albums are already occasional, one-off events, so each
 *     one gets its own draft immediately, the same way it always has.
 *   - Regular batch posts happen far more often (up to POSTS_PER_HOUR times
 *     an hour) — posting one Patreon/Ko-fi draft per batch would just mean
 *     Patreon/Ko-fi mirroring every other platform's cadence. Instead,
 *     every successful batch quietly adds to a running weekly and monthly
 *     tally (image count + which worlds were shot in); checkRoundups(),
 *     called once per scheduler cycle, detects when a week or month has
 *     rolled over and turns that period's tally into a single roundup
 *     draft — a count for the period and a list of the maps used, with a
 *     disclaimer that the map list depends on VRCX metadata and so isn't
 *     necessarily exhaustive.
 *
 * Either way, the actual "click publish" step on each platform stays
 * manual — that's the part neither platform exposes an API for.
 */

const logger      = require('./logger');
const imagerender = require('./imagerender');

const DRAFTS_MAX = 50;

// ─── Template rendering ────────────────────────────────────────────────────────
// Small local copies of scheduler.js's renderTemplate/compactText. Kept
// separate rather than imported — these are trivial, unlikely-to-change
// string helpers, and duplicating them avoids adding a cross-file dependency
// into scheduler.js's already-tested template rendering path.

function renderTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '').trim();
}

/**
 * Unlike scheduler.js's compactText (which strips every blank line — right
 * for Bluesky's compact single-block captions), these templates use
 * deliberate blank lines between sections for paragraph spacing, since
 * Patreon/Ko-fi posts are long-form. A variable rendering empty (e.g. no
 * VRCX world data this batch) can leave a run of several consecutive blank
 * lines where the template had one on each side of it — this collapses any
 * such run down to exactly one blank line, rather than removing spacing
 * entirely.
 */
function collapseBlankLines(text) {
  return text.replace(/\n[ \t]*\n(?:[ \t]*\n)*/g, '\n\n').trim();
}

// Local fallback defaults — mirrors state.js's DEFAULT_STATE.templates.
// Same defensive-fallback pattern scheduler.js already uses inline
// (e.g. `state.templates?.albumHighlight || '📂 New Album: ...'`).
const DEFAULT_TEMPLATES = {
  patreonPost:    '📸 {sourceTitle}\n\n{worldInfo}\n\n{photographers}\n\n{tags}',
  kofiPost:       '📸 {sourceTitle}\n\n{worldInfo}\n\n{photographers}',
  patreonWeekly:  '📆 {sourceTitle}\n\n{weekCount}\n{monthToDate}\n\n{mapList}',
  kofiWeekly:     '📆 {sourceTitle}\n\n{weekCount}\n{monthToDate}\n\n{mapList}',
  patreonMonthly: '🗓️ {sourceTitle}\n\n{monthCount}\n\n{mapList}',
  kofiMonthly:    '🗓️ {sourceTitle}\n\n{monthCount}\n\n{mapList}',
};

const MAP_LIST_DISCLAIMER = "Not every photographer uses VRCX metadata, so this list isn't exhaustive — just what we were able to detect.";

// Prepended to BOTH platform texts on a test draft, right in the copyable
// text itself — not just a UI badge. A badge only helps if you're looking
// at the dashboard; this line survives even if someone copies the text and
// pastes it somewhere without glancing back at the source.
const TEST_DRAFT_BANNER = '🧪 TEST DRAFT — sample data, not a real count. Do not publish. 🧪';

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Prefer the same re-rendered high-quality JPEG Buffer crossposts get
 * (see imagerender.js) over whatever thumbnail variant is on hand.
 */
function qualityUrl(image) {
  const original = image?.url || image?.medium?.url || image?.mediumUrl;
  if (!original) return null;
  return imagerender.buildRenderUrl(original) || original;
}

function buildMapListBlock(worldList, periodLabel) {
  if (worldList.length === 0) return '';
  const header = `🗺️ Maps this ${periodLabel}:\n`;
  const list = worldList.map(w => `${w.worldName} — ${w.worldUrl}`).join('\n');
  return `${header}${list}\n\n_${MAP_LIST_DISCLAIMER}_`;
}

function formatDateShort(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function formatDateShortYear(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function addDraft(state, { sourceType, sourceTitle, worldInfo, photographers, imageUrls, vars, patreonTplKey = 'patreonPost', kofiTplKey = 'kofiPost', isTest = false }) {
  const templates = state.templates || {};
  const patreonTpl = templates[patreonTplKey] || DEFAULT_TEMPLATES[patreonTplKey];
  const kofiTpl     = templates[kofiTplKey]     || DEFAULT_TEMPLATES[kofiTplKey];

  let patreonText = collapseBlankLines(renderTemplate(patreonTpl, vars));
  let kofiText     = collapseBlankLines(renderTemplate(kofiTpl, vars));

  if (isTest) {
    patreonText = `${TEST_DRAFT_BANNER}\n\n${patreonText}`;
    kofiText     = `${TEST_DRAFT_BANNER}\n\n${kofiText}`;
  }

  const draft = {
    id:          `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt:   new Date().toISOString(),
    sourceType,   // 'weekly' | 'monthly' | 'spotlight' | 'album' | 'test-weekly' | 'test-monthly' | 'test-spotlight' | 'test-album'
    sourceTitle,
    worldInfo,    // [{ worldName, worldUrl }] — for display only, already folded into vars for the text
    photographers, // [string] — for display only, already folded into vars for the text
    imageUrls,    // full-quality image URLs to download & attach manually — empty for roundups (see checkRoundups) and always empty for test drafts
    isTest,
    patreonText,
    kofiText,
  };

  state.membershipDrafts = state.membershipDrafts || [];
  state.membershipDrafts.unshift(draft);
  if (state.membershipDrafts.length > DRAFTS_MAX) {
    state.membershipDrafts.length = DRAFTS_MAX; // newest-first — truncating the tail drops the oldest
  }

  logger.info(`membershipdrafts: recorded ${sourceType} draft — "${sourceTitle}"`);
  return draft;
}

// ─── Weekly / monthly roundup tracking ─────────────────────────────────────────
// Real-time accumulation (incremented every successful batch) rather than
// derived after the fact — reconstructing "which worlds were shot this
// week" from history later would need either a timestamped per-post log
// nothing currently keeps, or re-querying Bluesky, which is unnecessary
// when the data is already right there at post time.

function startOfISOWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 (Sun) – 6 (Sat)
  const diff = (day === 0 ? -6 : 1) - day; // Monday = start of week
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

function startOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function ensureRoundupTracking(state) {
  if (!state.roundupTracking) {
    const now = new Date();
    state.roundupTracking = {
      weekStart:  startOfISOWeek(now).toISOString(),
      weekImageCount: 0,
      weekWorlds: {},   // worldId -> { worldName, worldUrl }
      monthStart: startOfMonth(now).toISOString(),
      monthImageCount: 0,
      monthWorlds: {},
    };
  }
  return state.roundupTracking;
}

/**
 * Called after every successful batch post — accumulates into the running
 * weekly/monthly tallies. Does not create a draft; checkRoundups() does
 * that once a period actually ends.
 *
 * @param {object} state
 * @param {object} opts
 * @param {Array}  opts.downloaded  — [{ image, blob, buffer }], from postBatch
 * @param {Map}    opts.worldGroups — worldKey -> { vrcx, nums }, from postBatch (may be empty)
 */
function trackBatch(state, { downloaded, worldGroups }) {
  // Flush any already-completed period before adding to what might
  // otherwise be a stale bucket — makes this correct regardless of
  // whether the caller already checked for a rollover this cycle, rather
  // than relying on scheduler.js always calling checkRoundups() first.
  checkRoundups(state);

  const tr = ensureRoundupTracking(state);
  const count = downloaded.length;
  tr.weekImageCount += count;
  tr.monthImageCount += count;

  for (const { vrcx } of worldGroups?.values() ?? []) {
    if (!vrcx?.worldId || !vrcx?.worldName || !vrcx?.worldUrl) continue;
    tr.weekWorlds[vrcx.worldId]  = { worldName: vrcx.worldName, worldUrl: vrcx.worldUrl };
    tr.monthWorlds[vrcx.worldId] = { worldName: vrcx.worldName, worldUrl: vrcx.worldUrl };
  }

  logger.info(`membershipdrafts: roundup tracking +${count} image(s) — week=${tr.weekImageCount}, month=${tr.monthImageCount}`);
}

function generateWeeklyRoundup(state, { weekStart, weekImageCount, weekWorlds, monthToDateCount }) {
  const start = new Date(weekStart);
  const end   = new Date(start.getTime() + 6 * 86_400_000);
  const worldList = Object.values(weekWorlds);
  const weekLabel = `${formatDateShort(start)} – ${formatDateShortYear(end)}`;

  const vars = {
    sourceTitle: `Weekly Roundup — ${weekLabel}`,
    weekCount: `📸 ${weekImageCount} new photo${weekImageCount === 1 ? '' : 's'} this week`,
    // Only worth a separate line if it actually adds information beyond
    // the week count — e.g. skip it on a month's first week, where the two
    // numbers would just be identical.
    monthToDate: monthToDateCount > weekImageCount ? `📈 ${monthToDateCount} so far this month` : '',
    mapList: buildMapListBlock(worldList, 'week'),
  };

  addDraft(state, {
    sourceType: 'weekly',
    sourceTitle: vars.sourceTitle,
    worldInfo: worldList,
    photographers: [],
    imageUrls: [], // a week's worth of shots is too many to sensibly attach — text summary only
    vars,
    patreonTplKey: 'patreonWeekly',
    kofiTplKey: 'kofiWeekly',
  });
}

function generateMonthlyRoundup(state, { monthStart, monthImageCount, monthWorlds }) {
  const start = new Date(monthStart);
  const monthLabel = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const worldList = Object.values(monthWorlds);

  const vars = {
    sourceTitle: `Monthly Roundup — ${monthLabel}`,
    monthCount: `📸 ${monthImageCount} new photo${monthImageCount === 1 ? '' : 's'} this month`,
    mapList: buildMapListBlock(worldList, 'month'),
  };

  addDraft(state, {
    sourceType: 'monthly',
    sourceTitle: vars.sourceTitle,
    worldInfo: worldList,
    photographers: [],
    imageUrls: [],
    vars,
    patreonTplKey: 'patreonMonthly',
    kofiTplKey: 'kofiMonthly',
  });
}

// ─── Test drafts ───────────────────────────────────────────────────────────
// Neither platform can actually be posted to (see the module docblock), so
// "test post" here means: render one of the four draft shapes right now,
// from clearly-fake sample data, so the current templates can be previewed
// and the copy buttons checked without waiting for a real spotlight/album
// or an actual week/month to end.

const TEST_SAMPLE_WORLDS = [
  { worldName: 'Sample World A', worldUrl: 'https://vrchat.com/home/world/wrld_00000000-0000-0000-0000-000000000001' },
  { worldName: 'Sample World B', worldUrl: 'https://vrchat.com/home/world/wrld_00000000-0000-0000-0000-000000000002' },
];

/**
 * @param {object} state
 * @param {'spotlight'|'album'|'weekly'|'monthly'} type
 * @returns the generated draft
 */
function generateTestDraft(state, type) {
  let sourceTitle, vars, patreonTplKey, kofiTplKey;
  let worldInfo = [];
  let photographers = [];

  switch (type) {
    case 'spotlight':
      sourceTitle = 'Spotlight: Sample Photographer';
      photographers = ['Sample Photographer'];
      vars = {
        sourceTitle,
        worldInfo: '',
        photographers: '📷 Featuring: Sample Photographer',
        tags: (state.customTags ?? []).join(' '),
      };
      patreonTplKey = 'patreonPost';
      kofiTplKey = 'kofiPost';
      break;

    case 'album':
      sourceTitle = 'Sample Album Title';
      vars = {
        sourceTitle,
        worldInfo: '',
        photographers: '',
        tags: (state.customTags ?? []).join(' '),
      };
      patreonTplKey = 'patreonPost';
      kofiTplKey = 'kofiPost';
      break;

    case 'weekly':
      sourceTitle = 'Weekly Roundup — Sample Week';
      worldInfo = TEST_SAMPLE_WORLDS;
      vars = {
        sourceTitle,
        weekCount: '📸 12 new photos this week',
        monthToDate: '📈 34 so far this month',
        mapList: buildMapListBlock(TEST_SAMPLE_WORLDS, 'week'),
      };
      patreonTplKey = 'patreonWeekly';
      kofiTplKey = 'kofiWeekly';
      break;

    case 'monthly':
      sourceTitle = 'Monthly Roundup — Sample Month';
      worldInfo = TEST_SAMPLE_WORLDS;
      vars = {
        sourceTitle,
        monthCount: '📸 34 new photos this month',
        mapList: buildMapListBlock(TEST_SAMPLE_WORLDS, 'month'),
      };
      patreonTplKey = 'patreonMonthly';
      kofiTplKey = 'kofiMonthly';
      break;

    default:
      throw new Error(`generateTestDraft: unknown type "${type}" — expected spotlight, album, weekly, or monthly`);
  }

  const sourceType = `test-${type}`;

  // Test drafts are disposable previews, not history — only the most
  // recent one of each type is worth keeping, so generating a new one
  // replaces the last rather than piling up and eventually crowding real
  // drafts out of the 50-slot cap.
  state.membershipDrafts = (state.membershipDrafts || []).filter(d => d.sourceType !== sourceType);

  return addDraft(state, {
    sourceType,
    sourceTitle: `[TEST] ${sourceTitle}`,
    worldInfo,
    photographers,
    imageUrls: [],
    vars,
    patreonTplKey,
    kofiTplKey,
    isTest: true,
  });
}

/**
 * Checks whether the current week and/or month has moved on since the
 * tracker's last known period, and if so, turns whatever was accumulated
 * into a roundup draft (skipped if the period had zero images — no point
 * drafting an empty roundup) before resetting the counters for the new
 * period. Cheap to call every cycle; only does anything on the cycle right
 * after an actual boundary crossing.
 *
 * Called from the very top of runCycle, before the paused/running check —
 * a roundup for a period that already happened shouldn't get stuck behind
 * the bot being paused.
 */
function checkRoundups(state) {
  const tr = ensureRoundupTracking(state);
  const now = new Date();

  const currentWeekStart  = startOfISOWeek(now).toISOString();
  const currentMonthStart = startOfMonth(now).toISOString();
  const weekRolledOver  = currentWeekStart  !== tr.weekStart;
  const monthRolledOver = currentMonthStart !== tr.monthStart;

  if (!weekRolledOver && !monthRolledOver) return;

  // Snapshot old values before either gets reset — matters when a week and
  // a month roll over in the same check (a month's first day landing on a
  // Monday), since the weekly roundup's "so far this month" figure needs
  // last month's still-unreset total, not the freshly-zeroed one.
  if (weekRolledOver) {
    if (tr.weekImageCount > 0) {
      generateWeeklyRoundup(state, {
        weekStart: tr.weekStart,
        weekImageCount: tr.weekImageCount,
        weekWorlds: tr.weekWorlds,
        monthToDateCount: tr.monthImageCount,
      });
    } else {
      logger.info('membershipdrafts: week rolled over with 0 images — skipping roundup draft');
    }
  }

  if (monthRolledOver) {
    if (tr.monthImageCount > 0) {
      generateMonthlyRoundup(state, {
        monthStart: tr.monthStart,
        monthImageCount: tr.monthImageCount,
        monthWorlds: tr.monthWorlds,
      });
    } else {
      logger.info('membershipdrafts: month rolled over with 0 images — skipping roundup draft');
    }
  }

  if (weekRolledOver) {
    tr.weekStart = currentWeekStart;
    tr.weekImageCount = 0;
    tr.weekWorlds = {};
  }
  if (monthRolledOver) {
    tr.monthStart = currentMonthStart;
    tr.monthImageCount = 0;
    tr.monthWorlds = {};
  }

}

/** Read-only snapshot for the dashboard — how much has accumulated so far this period. */
function getRoundupStatus(state) {
  const tr = ensureRoundupTracking(state);
  return {
    weekStart:       tr.weekStart,
    weekImageCount:  tr.weekImageCount,
    weekWorldCount:  Object.keys(tr.weekWorlds).length,
    monthStart:      tr.monthStart,
    monthImageCount: tr.monthImageCount,
    monthWorldCount: Object.keys(tr.monthWorlds).length,
  };
}

// ─── Record hooks (called from scheduler.js right after a successful post) ───

/**
 * @param {object} state
 * @param {object} opts
 * @param {object} opts.highlight — the spotlight highlight object (name/username)
 * @param {Array}  opts.entries   — [{ image, blob, altText }], the downloaded spotlight images
 */
function recordSpotlight(state, { highlight, entries }) {
  const photographers = [highlight.name || highlight.username].filter(Boolean);
  const imageUrls = entries.map(e => qualityUrl(e.image)).filter(Boolean);

  const vars = {
    sourceTitle: `Spotlight: ${highlight.name || highlight.username}`,
    worldInfo: '',
    photographers: photographers.length ? `📷 Featuring: ${photographers.join(', ')}` : '',
    tags: (state.customTags ?? []).join(' '),
  };

  addDraft(state, { sourceType: 'spotlight', sourceTitle: vars.sourceTitle, worldInfo: [], photographers, imageUrls, vars });
}

/**
 * @param {object} state
 * @param {object} opts
 * @param {object} opts.highlight — the album highlight object (title, coverImage)
 */
function recordAlbum(state, { highlight }) {
  const imageUrls = [];
  if (highlight.coverImage) {
    const url = qualityUrl(highlight.coverImage);
    if (url) imageUrls.push(url);
  }

  const vars = {
    sourceTitle: highlight.title || 'New Album',
    worldInfo: '',
    photographers: '',
    tags: (state.customTags ?? []).join(' '),
  };

  addDraft(state, { sourceType: 'album', sourceTitle: vars.sourceTitle, worldInfo: [], photographers: [], imageUrls, vars });
}

module.exports = {
  trackBatch, checkRoundups, getRoundupStatus,
  recordSpotlight, recordAlbum, generateTestDraft,
  DEFAULT_TEMPLATES,
};
