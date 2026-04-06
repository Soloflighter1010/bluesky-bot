/**
 * state.js – lightweight JSON-backed state store
 * Keeps bot config persistent across restarts without needing a database.
 */

const fs   = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'bot-state.json');

const DEFAULT_STATE = {
  running: true,
  postedIds: [],          // track recently posted image IDs to avoid repeats
  highlights: [],         // queued album/member highlight posts
  stats: {
    totalPosted: 0,
    lastPostedAt: null,
    lastCheckAt: null,
  },
  memberSpotlight: null,  // { userId, postedAt }
  pinnedAlbum: null,      // { albumId, title, postedAt }
};

function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      return { ...DEFAULT_STATE, ...JSON.parse(raw) };
    }
  } catch (e) { /* ignore parse errors, start fresh */ }
  return { ...DEFAULT_STATE };
}

function save(state) {
  // Trim postedIds to last 500 so the file doesn't grow indefinitely
  if (state.postedIds.length > 500) {
    state.postedIds = state.postedIds.slice(-500);
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

module.exports = { load, save, DEFAULT_STATE };
