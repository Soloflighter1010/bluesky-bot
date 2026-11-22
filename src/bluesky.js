/**
 * bluesky.js – AT Protocol / Bluesky API wrapper
 */

const { BskyAgent, RichText } = require('@atproto/api');
const sharp  = require('sharp');
const logger = require('./logger');

const CHAT_PROXY_DID = 'did:web:api.bsky.chat';

const agent = new BskyAgent({ service: 'https://bsky.social' });
let sessionActive = false;

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function login() {
  await agent.login({
    identifier: process.env.BLUESKY_HANDLE,
    password:   process.env.BLUESKY_APP_PASSWORD,
  });
  sessionActive = true;
  logger.info(`Bluesky: logged in as ${process.env.BLUESKY_HANDLE}`);
}

async function ensureSession() {
  if (!sessionActive) await login();
}

/**
 * Wrap an AT Protocol call so that a single auth-expiry error causes one
 * automatic re-login and retry.  Any other error is re-thrown immediately.
 */
async function withSession(fn) {
  try {
    return await fn();
  } catch (err) {
    const msg = err.message || '';
    const isAuthError =
      err.status === 401 ||
      msg.includes('AuthenticationRequired') ||
      msg.includes('ExpiredToken') ||
      msg.includes('Invalid token') ||
      msg.includes('session expired');

    if (isAuthError) {
      logger.warn(`Bluesky: session expired (${msg}) — re-logging in…`);
      sessionActive = false;
      await login();
      return await fn(); // one retry
    }
    throw err;
  }
}

function chatAgent() {
  return agent.withProxy('bsky_chat', CHAT_PROXY_DID);
}

// ─── Image blob upload ────────────────────────────────────────────────────────

// Bluesky's hard limit per image blob
const MAX_BLOB_BYTES = 1_000_000; // 1 MB — leave headroom below the 2 MB API cap

/**
 * Compress a buffer until it fits within MAX_BLOB_BYTES.
 *
 * Strategy:
 *   1. If it's already small enough, return as-is.
 *   2. Otherwise convert to JPEG and reduce quality in steps (80 → 65 → 50 → 35 → 20)
 *      until it fits or we've exhausted all quality levels.
 *   3. If still too large after quality reduction (e.g. an 8K image at q20),
 *      also resize down — halving the longer dimension each pass — until it fits.
 *
 * This handles 8K VRChat screenshots and any other oversized source images.
 */
async function prepareImageBlob(buffer, mimeType) {
  if (buffer.length <= MAX_BLOB_BYTES) return { buf: buffer, mimeType };

  // Phase 1: quality reduction only (keeps full resolution)
  const qualities = [80, 65, 50, 35, 20];
  for (const quality of qualities) {
    const compressed = await sharp(buffer)
      .jpeg({ quality, progressive: true })
      .toBuffer();
    if (compressed.length <= MAX_BLOB_BYTES) {
      logger.info(`prepareImageBlob: compressed to ${Math.round(compressed.length / 1024)} KB at q${quality}`);
      return { buf: compressed, mimeType: 'image/jpeg' };
    }
  }

  // Phase 2: resize down if quality alone wasn't enough (e.g. true 8K images)
  const meta       = await sharp(buffer).metadata();
  let   longEdge   = Math.max(meta.width ?? 3840, meta.height ?? 2160);
  let   resized    = buffer;

  while (longEdge > 480) {
    longEdge = Math.round(longEdge / 2);
    resized  = await sharp(buffer)
      .resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, progressive: true })
      .toBuffer();

    if (resized.length <= MAX_BLOB_BYTES) {
      logger.info(`prepareImageBlob: resized to longest-edge ${longEdge}px — ${Math.round(resized.length / 1024)} KB`);
      return { buf: resized, mimeType: 'image/jpeg' };
    }
  }

  // Last resort — return whatever we have at the minimum size
  logger.warn(`prepareImageBlob: could not compress below limit, uploading ${Math.round(resized.length / 1024)} KB`);
  return { buf: resized, mimeType: 'image/jpeg' };
}

async function uploadBlob(buffer, mimeType) {
  const { buf, mimeType: mt } = await prepareImageBlob(buffer, mimeType);
  return withSession(async () => {
    const { data } = await agent.uploadBlob(buf, { encoding: mt });
    return data.blob;
  });
}

// ─── Posting ──────────────────────────────────────────────────────────────────

/**
 * Post up to 4 images in a single Bluesky post.
 * entries: array of { image, blob, altText? }
 * If altText is provided it overrides the default (image.title).
 * Returns { uri, cid } of the created post.
 */
async function postPhotosWithText(entries, text) {
  const rt = new RichText({ text });
  return withSession(async () => {
    await rt.detectFacets(agent);

    const embedImages = entries.slice(0, 4).map(({ image, blob, altText }) => ({
      image: blob,
      alt:   (altText || image.title || 'Untitled').slice(0, 300),
    }));

    const embed = {
      $type:  'app.bsky.embed.images',
      images: embedImages,
    };

    const res = await agent.post({
      text:      rt.text,
      facets:    rt.facets,
      embed,
      createdAt: new Date().toISOString(),
    });

    logger.info(`Posted ${entries.length} images`);
    return res;
  });
}

/**
 * Single-image post — kept for spotlight/album highlight paths.
 */
async function postPhotoWithText(image, blob, text) {
  return postPhotosWithText([{ image, blob }], text);
}

/**
 * Legacy wrapper used by album highlight path.
 * When overrideText=true (album highlight case), extraText is the entire post text.
 * When overrideText=false, constructs basic fallback text from image metadata.
 */
async function postPhoto(image, blob, extraText = '', overrideText = false) {
  await ensureSession();

  let text;
  if (overrideText) {
    text = extraText;
  } else {
    // Fallback — scheduler uses buildPostText() for regular batches.
    const title    = image.title || 'Untitled';
    const username = image.user?.username ? `📸 @${image.user.username}` : '';
    text = [username, title, extraText, '#photography'].filter(Boolean).join('\n').trim();
  }
  if (text.length > 280) text = text.slice(0, 277) + '…';

  return postPhotoWithText(image, blob, text);
}

async function postText(text) {
  return withSession(async () => {
    const rt = new RichText({ text: text.slice(0, 300) });
    await rt.detectFacets(agent);
    const res = await agent.post({ text: rt.text, facets: rt.facets, createdAt: new Date().toISOString() });
    logger.info(`Posted announcement: ${text.slice(0, 60)}…`);
    return res;
  });
}

/**
 * Post a reply in a thread.
 * rootRef   — the very first post in the thread (stays constant for all replies)
 * parentRef — the immediate parent of this reply (changes as the thread grows)
 * Returns { uri, cid } of the new reply so the next reply can reference it.
 */
async function replyToPost(rootRef, parentRef, text) {
  if (!rootRef?.uri || !rootRef?.cid) {
    logger.warn('replyToPost: invalid rootRef, skipping');
    return null;
  }
  const parent = (parentRef?.uri && parentRef?.cid) ? parentRef : rootRef;
  return withSession(async () => {
    const rt = new RichText({ text: text.slice(0, 300) });
    await rt.detectFacets(agent);
    const res = await agent.post({
      text:      rt.text,
      facets:    rt.facets,
      reply:     { root: rootRef, parent },
      createdAt: new Date().toISOString(),
    });
    logger.info(`Reply posted to ${parent.uri}`);
    return res;
  });
}

// ─── DM polling ───────────────────────────────────────────────────────────────

async function pollDMs(seenIds = new Set()) {
  const newMessages = [];
  try {
    await withSession(async () => {
      const chat = chatAgent();
      const { data: convos } = await chat.api.chat.bsky.convo.listConvos();
      for (const convo of convos.convos ?? []) {
        const { data: msgs } = await chat.api.chat.bsky.convo.getMessages({ convoId: convo.id, limit: 10 });
        for (const msg of msgs.messages ?? []) {
          if (seenIds.has(msg.id)) continue;
          if (msg.$type !== 'chat.bsky.convo.defs#messageView') continue;
          newMessages.push({
            convoId:   convo.id,
            messageId: msg.id,
            senderDid: msg.sender?.did,
            text:      msg.text ?? '',
            sentAt:    msg.sentAt ?? null,
          });
        }
      }
    });
  } catch (err) {
    logger.warn(`DM poll error: ${err.message}`);
  }
  return newMessages;
}

async function replyDM(convoId, text) {
  try {
    await withSession(async () => {
      const chat = chatAgent();
      await chat.api.chat.bsky.convo.sendMessage({
        convoId,
        message: { $type: 'chat.bsky.convo.defs#messageInput', text: text.slice(0, 1000) },
      });
    });
  } catch (err) {
    logger.warn(`DM reply error: ${err.message}`);
  }
}

async function resolveHandle(did) {
  try {
    return await withSession(async () => {
      const { data } = await agent.getProfile({ actor: did });
      return data.handle;
    });
  } catch { return null; }
}

/**
 * Get the bot's own DID (needed to tell the bot's own replies apart from
 * anyone else's replies in a thread).
 */
async function getMyDid() {
  return withSession(async () => {
    if (!agent.session?.did) await login();
    return agent.session.did;
  });
}

/**
 * Walk the bot's own feed, oldest-relevant-first is NOT how the API works —
 * Bluesky's getAuthorFeed is newest-first, paginated via cursor. This yields
 * root posts only (skips the bot's own reply posts, which show up in the
 * thread instead), stopping once `stopAtUri` is reached (already-processed
 * cursor from a previous backfill/live run) or the feed is exhausted.
 *
 * Returns an array of { uri, cid, text, createdAt, images } — oldest posts
 * are naturally excluded once stopAtUri is hit, so callers get "everything
 * newer than last time" on repeat runs.
 */
async function getMyRootPosts({ stopAtUri = null, maxPages = 50 } = {}) {
  const did = await getMyDid();
  const posts = [];
  let cursor;
  let pages = 0;
  let hitStop = false;

  while (pages < maxPages && !hitStop) {
    pages++;
    const page = await withSession(async () => {
      const { data } = await agent.getAuthorFeed({
        actor: did,
        cursor,
        filter: 'posts_no_replies', // root posts only — replies are pulled via getThreadText per-root
        limit: 100,
      });
      return data;
    });

    for (const item of page.feed ?? []) {
      const post = item.post;
      if (!post) continue;
      if (stopAtUri && post.uri === stopAtUri) { hitStop = true; break; }
      // Skip anything that's actually a reply (defensive — filter above should
      // already exclude these, but the API's filter behavior can vary by version)
      if (post.record?.reply) continue;

      posts.push({
        uri:       post.uri,
        cid:       post.cid,
        text:      post.record?.text ?? '',
        createdAt: post.record?.createdAt ?? post.indexedAt ?? null,
      });
    }

    cursor = page.cursor;
    if (!cursor || !page.feed?.length) break;
  }

  return posts;
}

/**
 * Fetch a post's full thread and reconstruct the bot's own continuing reply
 * chain as one concatenated string, in order — undoing chunkText's 280-char
 * splitting so the world-info reply can be parsed as if it were never split
 * across multiple posts in the first place.
 *
 * Only follows replies authored by the bot itself; if someone else replied
 * partway down the thread, that branch is ignored rather than followed.
 */
async function getThreadText(rootUri, myDid) {
  const chunks = [];

  await withSession(async () => {
    const { data } = await agent.getPostThread({ uri: rootUri, depth: 20 });
    let node = data.thread;

    // Walk down through the bot's own reply chain
    while (node) {
      const replies = Array.isArray(node.replies) ? node.replies : [];
      const nextNode = replies.find(r => r?.post?.author?.did === myDid);
      if (!nextNode) break;
      const text = nextNode.post?.record?.text;
      if (text) chunks.push(text);
      node = nextNode;
    }
  });

  return chunks.join('\n');
}

module.exports = {
  login, postPhoto, postPhotoWithText, postPhotosWithText, postText,
  replyToPost, uploadBlob, pollDMs, replyDM, resolveHandle,
  getMyDid, getMyRootPosts, getThreadText,
};
