/**
 * state.js – lightweight JSON-backed state store
 *
 * Now includes crosspost configuration (Buffer API key).
 * Buffer API keys are sensitive — store them in .env instead for production.
 * This state file tracks which posts were crossposted and sync status.
 */

const fs   = require('fs');
const path = require('path');

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, '..', 'bot-state.json');

const DEFAULT_STATE = {
  running: true,
  postedIds: [],
  highlights: [],
  spotlightHistory: [],
  customTags: ['#photography', '#VRChat'],  // shown on every regular post
  // Maps Chevereto username → Bluesky handle, e.g. { "alice": "alice.bsky.social" }
  userMappings: {},
  // Crosspost configuration
  crosspost: {
    enabled: true,
    // Platform-specific settings (overrides defaults)
    platforms: {
      x: {
        enabled: true,
        hashtags: ['#photography', '#VRChat'], // X specific tags (if different from main)
      },
      instagram: {
        enabled: true,
        hashtags: ['#photography', '#VRChat', '#VRChatCommunity'], // IG specific tags
      },
    },
  },
  stats: {
    totalPosted: 0,
    lastPostedAt: null,
    lastCheckAt: null,
    xPosted: 0,              // crosspost tracking
    instagramPosted: 0,
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
      // Deep-merge with defaults so new fields appear automatically
      return {
        ...DEFAULT_STATE,
        ...saved,
        customTags:   saved.customTags   ?? DEFAULT_STATE.customTags,
        userMappings: saved.userMappings ?? {},
        crosspost:    { ...DEFAULT_STATE.crosspost, ...(saved.crosspost || {}) },
        templates:  { ...DEFAULT_STATE.templates, ...(saved.templates || {}) },
        stats:      { ...DEFAULT_STATE.stats,     ...(saved.stats     || {}) },
      };
    }
  } catch (e) {
    console.error(`state.js: failed to load state file: ${e.message}`);
  }
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function save(state) {
  if (state.postedIds.length > 500) {
    state.postedIds = state.postedIds.slice(-500);
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

module.exports = { load, save, DEFAULT_STATE };
