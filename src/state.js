/**
 * state.js – lightweight JSON-backed state store
 */

const fs   = require('fs');
const path = require('path');

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, '..', 'bot-state.json');

const DEFAULT_STATE = {
  running: true,
  postedIds: [],
  highlights: [],
  spotlightHistory: [],
  customTags: ['#photography', '#VRChat'],
  // Maps Chevereto username → Bluesky handle, e.g. { "alice": "alice.bsky.social" }
  userMappings: {},
  // Crossposting webhook (Make / Zapier)
  webhookUrl:     '',    // POST target URL
  webhookEnabled: false, // must be explicitly enabled after setting URL
  stats: {
    totalPosted: 0,
    lastPostedAt: null,
    lastCheckAt: null,
  },
  templates: {
    regularPost:     '📸 {username}\n{title}\n{tags}',
    albumHighlight:  '📂 New Album: {title}\nFresh collection from our team!\n#photography #photooftheday',
    memberSpotlight: '🌟 Photographer Spotlight: {name}\nCheck out their recent work below!\n#photography #teamspotlight',
    vrcxReply:       '🌍 World: {worldName}\n🔗 {worldUrl}{photographers}',
  },
};

function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const saved = JSON.parse(raw);
      // Deep-merge templates so new defaults appear if state predates them
      return {
        ...DEFAULT_STATE,
        ...saved,
        customTags:      saved.customTags      ?? DEFAULT_STATE.customTags,
        userMappings:    saved.userMappings    ?? {},
        webhookUrl:      saved.webhookUrl      ?? '',
        webhookEnabled:  saved.webhookEnabled  ?? false,
        templates:  { ...DEFAULT_STATE.templates, ...(saved.templates || {}) },
        stats:      { ...DEFAULT_STATE.stats,     ...(saved.stats     || {}) },
      };
    }
  } catch (e) { /* ignore, start fresh */ }
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function save(state) {
  if (state.postedIds.length > 500) {
    state.postedIds = state.postedIds.slice(-500);
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

module.exports = { load, save, DEFAULT_STATE };