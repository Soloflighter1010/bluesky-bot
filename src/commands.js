/**
 * commands.js – DM command parser & executor
 *
 * Admins (listed in ADMIN_HANDLES) can control the bot by sending
 * direct messages on Bluesky. The bot polls DMs every 60 seconds.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  COMMAND REFERENCE                                          │
 * ├─────────────────────────────────────────────────────────────┤
 * │  !start              – Resume auto-posting                  │
 * │  !stop               – Pause auto-posting                   │
 * │  !status             – Show current bot state               │
 * │  !post now           – Trigger an immediate batch post      │
 * │  !highlight <albumId>– Announce an album highlight          │
 * │  !spotlight <user>   – Showcase a team member               │
 * │  !stats              – Show posting statistics              │
 * │  !help               – List all commands                    │
 * └─────────────────────────────────────────────────────────────┘
 */

const bsky      = require('./bluesky');
const chevereto = require('./chevereto');
const stateIO   = require('./state');
const logger    = require('./logger');

const ADMIN_HANDLES = (process.env.ADMIN_HANDLES || '')
  .split(',')
  .map(h => h.trim().toLowerCase())
  .filter(Boolean);

// ── Fix #7: cap seenMessageIds to prevent unbounded memory growth
const seenMessageIds = new Set();
const SEEN_IDS_MAX   = 10_000;
const SEEN_IDS_TRIM  = 5_000;

function markSeen(id) {
  seenMessageIds.add(id);
  if (seenMessageIds.size > SEEN_IDS_MAX) {
    // Prune oldest half
    const toDelete = [...seenMessageIds].slice(0, SEEN_IDS_TRIM);
    for (const oldId of toDelete) seenMessageIds.delete(oldId);
    logger.info(`commands: seenMessageIds trimmed to ${seenMessageIds.size}`);
  }
}

// ── Fix #21: cache DID → handle resolutions to avoid repeated API calls
const handleCache    = new Map(); // did → handle string (or null)
const HANDLE_CACHE_MAX  = 1_000;
const HANDLE_CACHE_TRIM = 500;

async function cachedResolveHandle(did) {
  if (handleCache.has(did)) return handleCache.get(did);
  const handle = await bsky.resolveHandle(did);
  // Evict oldest entries before inserting if at capacity
  if (handleCache.size >= HANDLE_CACHE_MAX) {
    const toDelete = [...handleCache.keys()].slice(0, HANDLE_CACHE_TRIM);
    for (const k of toDelete) handleCache.delete(k);
    logger.info(`commands: handleCache trimmed to ${handleCache.size}`);
  }
  handleCache.set(did, handle);
  return handle;
}

// ── Fix #8: ignore DMs that arrived before the bot started
const BOT_START_MS = Date.now();

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function startDMPoller(postNowCallback) {
  logger.info('DM poller started');
  let polling = false;
  setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      await pollOnce(postNowCallback);
    } catch (err) {
      logger.warn(`DM poll error: ${err.message}`);
    } finally {
      polling = false;
    }
  }, 60_000);
}

async function pollOnce(postNowCallback) {
  const messages = await bsky.pollDMs(seenMessageIds);

  for (const msg of messages) {
    markSeen(msg.messageId);

    // Fix #8: skip DMs that pre-date this bot session to avoid re-processing
    // commands that already ran before a restart.
    if (msg.sentAt && new Date(msg.sentAt).getTime() < BOT_START_MS) {
      logger.debug(`commands: skipping pre-startup DM ${msg.messageId}`);
      continue;
    }

    // Resolve sender and check admin status
    const handle = await cachedResolveHandle(msg.senderDid);
    if (!handle || !ADMIN_HANDLES.includes(handle.toLowerCase())) {
      logger.debug(`Ignoring DM from non-admin: ${handle ?? msg.senderDid}`);
      continue;
    }

    logger.info(`Command from ${handle}: ${msg.text}`);
    const reply = await handleCommand(msg.text.trim(), postNowCallback);
    if (reply) await bsky.replyDM(msg.convoId, reply);
  }
}

// ─── Command router ───────────────────────────────────────────────────────────

async function handleCommand(text, postNowCallback) {
  const [cmd, ...args] = text.split(/\s+/);
  const arg = args.join(' ').trim();

  switch (cmd.toLowerCase()) {

    case '!start':
      await stateIO.update(state => { state.running = true; });
      return '✅ Bot resumed. Photos will post on schedule.';

    case '!stop':
      await stateIO.update(state => { state.running = false; });
      return '⏸️ Bot paused. Use !start to resume.';

    case '!status': {
      const state = stateIO.load();
      const next = state.running ? 'running ✅' : 'paused ⏸️';
      const last = state.stats.lastPostedAt
        ? new Date(state.stats.lastPostedAt).toLocaleString()
        : 'never';
      return [
        `🤖 Bot is ${next}`,
        `📸 Total posted: ${state.stats.totalPosted}`,
        `🕐 Last post: ${last}`,
        `🗂️ Queue: ${state.highlights.length} highlight(s) pending`,
      ].join('\n');
    }

    case '!stats': {
      const state = stateIO.load();
      const last = state.stats.lastPostedAt
        ? new Date(state.stats.lastPostedAt).toLocaleString()
        : 'never';
      return [
        `📊 Bot Statistics`,
        `Total posts: ${state.stats.totalPosted}`,
        `Last posted: ${last}`,
        `Unique IDs seen: ${state.postedIds.length}`,
      ].join('\n');
    }

    case '!post':
      if (arg.toLowerCase() === 'now') {
        const { started, reason } = postNowCallback();
        return started ? '🚀 Posting a batch right now!' : `❌ ${reason}`;
      }
      return '❓ Did you mean !post now?';

    case '!highlight':
      return await cmdHighlight(arg);

    case '!spotlight':
      return await cmdSpotlight(arg);

    case '!help':
      return HELP_TEXT;

    default:
      return `❓ Unknown command: ${cmd}\n\n${HELP_TEXT}`;
  }
}

// ─── !highlight <albumId | albumHash> ────────────────────────────────────────

async function cmdHighlight(albumIdOrHash) {
  if (!albumIdOrHash) return '❌ Usage: !highlight <album_id_or_hash>';

  try {
    const album = await chevereto.fetchAlbum(albumIdOrHash);
    if (!album) return `❌ Album not found: ${albumIdOrHash}`;

    const rawImages = await chevereto.fetchAlbumImages(albumIdOrHash);
    const queued = await stateIO.update(state => {
      const images = chevereto.filterExcludedUsers(rawImages, stateIO.getExcludedUsernameSet(state));
      if (rawImages.length && !images.length) return false;
      stateIO.enqueueHighlight(state, {
        type: 'album',
        albumId: albumIdOrHash,
        title: album.name,
        coverImage: images[0] ?? null,
      });
      return true;
    });
    if (!queued) {
      logger.warn(`!highlight: album "${album.name}" is entirely from excluded uploader(s) — refusing to queue`);
      return `❌ This album is entirely from a photographer who's opted out of auto-posting — not queuing it.`;
    }

    return [
      `📂 Album queued for highlight!`,
      `Title: ${album.name}`,
      `Photos: ${album.images_total ?? '?'}`,
      `It'll be announced at the next posting cycle.`,
    ].join('\n');
  } catch (err) {
    logger.error(`!highlight error: ${err.message}`);
    return `❌ Error fetching album: ${err.message}`;
  }
}

// ─── !spotlight <username> ────────────────────────────────────────────────────

async function cmdSpotlight(username) {
  if (!username) return '❌ Usage: !spotlight <chevereto_username>';

  if (stateIO.isExcluded(stateIO.load(), username)) {
    return `❌ @${username} has opted out of auto-posting — not spotlighting them.`;
  }

  try {
    const user   = await chevereto.fetchUser(username);
    if (!user) return `❌ User not found: ${username}`;

    const images = await chevereto.fetchUserSpotlightImages(username);

    const queued = await stateIO.update(state => {
      if (stateIO.isExcluded(state, user.username)) return false;
      stateIO.enqueueHighlight(state, {
        type: 'spotlight',
        username: user.username,
        name: user.name ?? user.username,
        images,
      });
      return true;
    });
    if (!queued) return `❌ @${username} has opted out of auto-posting — not spotlighting them.`;

    return [
      `🌟 Spotlight queued for @${user.username}!`,
      `Images found: ${images.length} (most recent, most viewed, most liked)`,
      `It'll post at the next posting cycle.`,
    ].join('\n');
  } catch (err) {
    logger.error(`!spotlight error: ${err.message}`);
    return `❌ Error fetching user: ${err.message}`;
  }
}

// ─── Help text ────────────────────────────────────────────────────────────────

const HELP_TEXT = `
🤖 PhotoBot Commands
━━━━━━━━━━━━━━━━━━━━
!start           Resume auto-posting
!stop            Pause auto-posting
!status          Show bot status
!stats           Posting statistics
!post now        Post a batch immediately
!highlight <id>  Queue an album highlight
!spotlight <user> Showcase a team member
!help            This message
`.trim();

module.exports = { startDMPoller, handleCommand };
