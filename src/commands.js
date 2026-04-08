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

const seenMessageIds = new Set();

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function startDMPoller(state, postNowCallback) {
  logger.info('DM poller started');
  setInterval(() => pollOnce(state, postNowCallback), 60_000);
}

async function pollOnce(state, postNowCallback) {
  const messages = await bsky.pollDMs(seenMessageIds);

  for (const msg of messages) {
    seenMessageIds.add(msg.messageId);

    // Resolve sender and check admin status
    const handle = await bsky.resolveHandle(msg.senderDid);
    if (!handle || !ADMIN_HANDLES.includes(handle.toLowerCase())) {
      logger.debug(`Ignoring DM from non-admin: ${handle ?? msg.senderDid}`);
      continue;
    }

    logger.info(`Command from ${handle}: ${msg.text}`);
    const reply = await handleCommand(msg.text.trim(), state, postNowCallback);
    if (reply) await bsky.replyDM(msg.convoId, reply);
    stateIO.save(state);
  }
}

// ─── Command router ───────────────────────────────────────────────────────────

async function handleCommand(text, state, postNowCallback) {
  const [cmd, ...args] = text.split(/\s+/);
  const arg = args.join(' ').trim();

  switch (cmd.toLowerCase()) {

    case '!start':
      state.running = true;
      return '✅ Bot resumed. Photos will post on schedule.';

    case '!stop':
      state.running = false;
      return '⏸️ Bot paused. Use !start to resume.';

    case '!status': {
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
        postNowCallback(); // fire-and-forget
        return '🚀 Posting a batch right now!';
      }
      return '❓ Did you mean !post now?';

    case '!highlight':
      return await cmdHighlight(arg, state);

    case '!spotlight':
      return await cmdSpotlight(arg, state);

    case '!help':
      return HELP_TEXT;

    default:
      return `❓ Unknown command: ${cmd}\n\n${HELP_TEXT}`;
  }
}

// ─── !highlight <albumId | albumHash> ────────────────────────────────────────

async function cmdHighlight(albumIdOrHash, state) {
  if (!albumIdOrHash) return '❌ Usage: !highlight <album_id_or_hash>';

  try {
    const album = await chevereto.fetchAlbum(albumIdOrHash);
    if (!album) return `❌ Album not found: ${albumIdOrHash}`;

    const images = await chevereto.fetchAlbumImages(albumIdOrHash);
    const cover  = images[0];

    // Queue the highlight – scheduler will post it at the next cycle
    state.highlights.push({
      type:       'album',
      albumId:    albumIdOrHash,
      title:      album.name,
      coverImage: cover ?? null,
      queuedAt:   new Date().toISOString(),
    });

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

async function cmdSpotlight(username, state) {
  if (!username) return '❌ Usage: !spotlight <chevereto_username>';

  try {
    const user   = await chevereto.fetchUser(username);
    if (!user) return `❌ User not found: ${username}`;

    const images = await chevereto.fetchUserSpotlightImages(username);

    state.highlights.push({
      type:     'spotlight',
      username: user.username,
      name:     user.name ?? user.username,
      images:   images,
      queuedAt: new Date().toISOString(),
    });

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