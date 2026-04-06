/**
 * bluesky.js – AT Protocol / Bluesky API wrapper
 *
 * Handles session management, blob uploads, rich-text posts,
 * and DM polling for command processing.
 *
 * DM NOTE: Bluesky's chat API (chat.bsky.convo.*) is served by a separate
 * proxy service at api.bsky.chat, not bsky.social. Every chat call must go
 * through agent.withProxy('bsky_chat', 'did:web:api.bsky.chat') — using the
 * base agent directly returns "Method Not Implemented".
 */

const { BskyAgent, RichText } = require('@atproto/api');
const sharp  = require('sharp');
const logger = require('./logger');

const CHAT_PROXY_DID = 'did:web:api.bsky.chat';

const agent = new BskyAgent({ service: 'https://bsky.social' });
let   sessionActive = false;

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
 * Returns an agent configured to proxy chat requests through api.bsky.chat.
 * Must be called after login() — the proxy needs an active session.
 */
function chatAgent() {
  return agent.withProxy('bsky_chat', CHAT_PROXY_DID);
}

// ─── Image blob upload ────────────────────────────────────────────────────────

const MAX_BLOB_BYTES = 976_560; // Bluesky image limit ~1 MB

async function prepareImageBlob(buffer, mimeType) {
  let buf = buffer;
  if (buf.length > MAX_BLOB_BYTES) {
    buf = await sharp(buf)
      .jpeg({ quality: 80, progressive: true })
      .toBuffer();
    mimeType = 'image/jpeg';
  }
  return { buf, mimeType };
}

async function uploadBlob(buffer, mimeType) {
  await ensureSession();
  const { buf, mimeType: mt } = await prepareImageBlob(buffer, mimeType);
  const { data } = await agent.uploadBlob(buf, { encoding: mt });
  return data.blob;
}

// ─── Posting ──────────────────────────────────────────────────────────────────

async function postPhoto(image, blob, extraText = '') {
  await ensureSession();

  const title = image.title || 'Untitled';
  const user  = image.user?.username ? `📸 @${image.user.username}` : '';
  const tags  = buildHashtags(image);

  let postText = [user, title, extraText, tags].filter(Boolean).join('\n').trim();
  if (postText.length > 280) postText = postText.slice(0, 277) + '…';

  const rt = new RichText({ text: postText });
  await rt.detectFacets(agent);

  const embed = {
    $type: 'app.bsky.embed.images',
    images: [{ image: blob, alt: title.slice(0, 300) }],
  };

  await agent.post({
    text:      rt.text,
    facets:    rt.facets,
    embed,
    createdAt: new Date().toISOString(),
  });

  logger.info(`Posted: "${title}" by ${image.user?.username ?? 'unknown'}`);
}

async function postText(text) {
  await ensureSession();
  const rt = new RichText({ text: text.slice(0, 300) });
  await rt.detectFacets(agent);
  await agent.post({ text: rt.text, facets: rt.facets, createdAt: new Date().toISOString() });
  logger.info(`Posted announcement: ${text.slice(0, 60)}…`);
}

function buildHashtags(image) {
  const tags = (image.tags ?? []).slice(0, 3).map(t => `#${t.tag_url ?? t.tag}`);
  if (!tags.includes('#photography')) tags.unshift('#photography');
  return tags.join(' ');
}

// ─── DM (Chat) polling ────────────────────────────────────────────────────────

/**
 * Returns new DM messages since the last check.
 *
 * All chat.bsky.convo.* calls are routed through the bsky_chat proxy.
 * Without this, Bluesky returns "Method Not Implemented".
 */
async function pollDMs(seenIds = new Set()) {
  await ensureSession();
  const chat = chatAgent();
  const newMessages = [];

  try {
    const { data: convos } = await chat.api.chat.bsky.convo.listConvos();

    for (const convo of convos.convos ?? []) {
      const { data: msgs } = await chat.api.chat.bsky.convo.getMessages({
        convoId: convo.id,
        limit:   10,
      });

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

/**
 * Send a reply DM. Also routed through the chat proxy.
 */
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
  } catch {
    return null;
  }
}

module.exports = { login, postPhoto, postText, uploadBlob, pollDMs, replyDM, resolveHandle };