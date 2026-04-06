/**
 * bluesky.js – AT Protocol / Bluesky API wrapper
 */

const { BskyAgent, RichText } = require('@atproto/api');
const sharp  = require('sharp');
const logger = require('./logger');

const CHAT_PROXY_DID = 'did:web:api.bsky.chat';

const agent = new BskyAgent({ service: 'https://bsky.social' });
let sessionActive = false;
let selfDid = null;  // our own DID, needed for reply threading

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function login() {
  const res = await agent.login({
    identifier: process.env.BLUESKY_HANDLE,
    password:   process.env.BLUESKY_APP_PASSWORD,
  });
  sessionActive = true;
  selfDid = res.data.did;
  logger.info(`Bluesky: logged in as ${process.env.BLUESKY_HANDLE} (${selfDid})`);
}

async function ensureSession() {
  if (!sessionActive) await login();
}

function chatAgent() {
  return agent.withProxy('bsky_chat', CHAT_PROXY_DID);
}

// ─── Image blob upload ────────────────────────────────────────────────────────

const MAX_BLOB_BYTES = 976_560;

async function prepareImageBlob(buffer, mimeType) {
  if (buffer.length > MAX_BLOB_BYTES) {
    buffer   = await sharp(buffer).jpeg({ quality: 80, progressive: true }).toBuffer();
    mimeType = 'image/jpeg';
  }
  return { buf: buffer, mimeType };
}

async function uploadBlob(buffer, mimeType) {
  await ensureSession();
  const { buf, mimeType: mt } = await prepareImageBlob(buffer, mimeType);
  const { data } = await agent.uploadBlob(buf, { encoding: mt });
  return data.blob;
}

// ─── Posting ──────────────────────────────────────────────────────────────────

/**
 * Post up to 4 images in a single Bluesky post.
 * `entries` is an array of { image, blob } — max 4 (Bluesky limit).
 * Returns { uri, cid } of the created post.
 */
async function postPhotosWithText(entries, text) {
  await ensureSession();

  const rt = new RichText({ text });
  await rt.detectFacets(agent);

  const embedImages = entries.slice(0, 4).map(({ image, blob }) => ({
    image,
    alt: (image.title || 'Untitled').slice(0, 300),
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

  const titles = entries.map(e => `"${e.image.title}"`).join(', ');
  logger.info(`Posted ${entries.length} images: ${titles}`);
  return res; // { uri, cid }
}

/**
 * Single-image post — kept for spotlight/album highlight paths.
 */
async function postPhotoWithText(image, blob, text) {
  return postPhotosWithText([{ image, blob }], text);
}

/**
 * Legacy wrapper used by spotlight / album highlight paths.
 * extraText is appended if the caller wants to override the full text.
 * If overrideText=true, `extraText` is the entire post text.
 */
async function postPhoto(image, blob, extraText = '', overrideText = false) {
  await ensureSession();

  let text;
  if (overrideText) {
    text = extraText;
  } else {
    const title    = image.title || 'Untitled';
    const username = image.user?.username ? `📸 @${image.user.username}` : '';
    const tags     = buildHashtags(image);
    text = [username, title, extraText, tags].filter(Boolean).join('\n').trim();
  }
  if (text.length > 280) text = text.slice(0, 277) + '…';

  return postPhotoWithText(image, blob, text);
}

async function postText(text) {
  await ensureSession();
  const rt = new RichText({ text: text.slice(0, 300) });
  await rt.detectFacets(agent);
  const res = await agent.post({ text: rt.text, facets: rt.facets, createdAt: new Date().toISOString() });
  logger.info(`Posted announcement: ${text.slice(0, 60)}…`);
  return res;
}

/**
 * Post a reply to an existing post (used for VRCX metadata thread).
 * parentRef is the { uri, cid } returned by postPhotoWithText / postText.
 */
async function replyToPost(parentRef, text) {
  await ensureSession();
  if (!parentRef?.uri || !parentRef?.cid) {
    logger.warn('replyToPost: invalid parentRef, skipping');
    return;
  }

  const rt = new RichText({ text: text.slice(0, 300) });
  await rt.detectFacets(agent);

  await agent.post({
    text:      rt.text,
    facets:    rt.facets,
    reply:     { root: parentRef, parent: parentRef },
    createdAt: new Date().toISOString(),
  });
  logger.info(`Reply posted to ${parentRef.uri}`);
}

function buildHashtags(image) {
  const tags = (image.tags ?? []).slice(0, 3).map(t => `#${t.tag_url ?? t.tag}`);
  if (!tags.includes('#photography')) tags.unshift('#photography');
  return tags.join(' ');
}

// ─── DM polling ───────────────────────────────────────────────────────────────

async function pollDMs(seenIds = new Set()) {
  await ensureSession();
  const chat = chatAgent();
  const newMessages = [];

  try {
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
        });
      }
    }
  } catch (err) {
    logger.warn(`DM poll error: ${err.message}`);
  }

  return newMessages;
}

async function replyDM(convoId, text) {
  await ensureSession();
  const chat = chatAgent();
  try {
    await chat.api.chat.bsky.convo.sendMessage({
      convoId,
      message: { $type: 'chat.bsky.convo.defs#messageInput', text: text.slice(0, 1000) },
    });
  } catch (err) {
    logger.warn(`DM reply error: ${err.message}`);
  }
}

async function resolveHandle(did) {
  try {
    const { data } = await agent.getProfile({ actor: did });
    return data.handle;
  } catch { return null; }
}

module.exports = {
  login, postPhoto, postPhotoWithText, postPhotosWithText, postText,
  replyToPost, uploadBlob, pollDMs, replyDM, resolveHandle,
};