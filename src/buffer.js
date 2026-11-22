/**
 * buffer.js – Buffer GraphQL API integration
 *
 * Uses Buffer's public GraphQL API (https://api.buffer.com).
 * A personal API token is required — generate one at:
 *   https://publish.buffer.com/settings/api
 *
 * IMPORTANT: Buffer tokens expire 30 days after creation.
 * The dashboard will warn when the stored token is approaching expiry.
 *
 * API docs: https://developers.buffer.com
 */

const axios     = require('axios');
const logger    = require('./logger');
const { chunkText } = require('./textchunk');

const BUFFER_API = 'https://api.buffer.com';

// ─── GraphQL core ─────────────────────────────────────────────────────────────

async function graphql(token, query) {
  let res;
  try {
    res = await axios.post(BUFFER_API, { query }, {
      timeout: 15_000,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });
  } catch (err) {
    // Axios throws on non-2xx — extract Buffer's actual error body if available
    const body = err.response?.data;
    const msg  = body?.errors?.[0]?.message
              ?? body?.message
              ?? JSON.stringify(body)
              ?? err.message;
    logger.warn(`Buffer HTTP ${err.response?.status ?? '?'}: ${msg}`);
    throw new Error(msg);
  }

  const body = res.data;

  if (body.errors?.length) {
    const msg = body.errors.map(e => e.message).join('; ');
    throw new Error(`Buffer GraphQL error: ${msg}`);
  }

  return body.data;
}

// ─── Account / org ────────────────────────────────────────────────────────────

async function getOrganizationId(token) {
  const data = await graphql(token, `
    query GetOrganizations {
      account {
        organizations {
          id
          name
        }
      }
    }
  `);
  const orgs = data?.account?.organizations ?? [];
  if (!orgs.length) throw new Error('No Buffer organizations found for this token');
  return orgs[0].id;
}

async function validateToken(token) {
  const data = await graphql(token, `
    query ValidateToken {
      account {
        id
        email
      }
    }
  `);
  return { valid: true, email: data?.account?.email ?? '' };
}

// ─── Channels ─────────────────────────────────────────────────────────────────

async function getChannels(token) {
  const orgId = await getOrganizationId(token);
  const data  = await graphql(token, `
    query GetChannels {
      channels(input: {
        organizationId: "${orgId}"
      }) {
        id
        name
        displayName
        service
        avatar
        isQueuePaused
      }
    }
  `);

  return (data?.channels ?? []).map(ch => ({
    id:            ch.id,
    service:       ch.service,
    displayName:   ch.displayName || ch.name,
    avatar:        ch.avatar || '',
    isQueuePaused: !!ch.isQueuePaused,
  }));
}

// ─── Post creation ────────────────────────────────────────────────────────────

// Per-platform caption character limits.
// Twitter enforces 280 server-side; Instagram allows up to 2200.
// All others get a generous 2000 as a safe default.
const PLATFORM_LIMITS = {
  twitter:   280,
  x:         280,
  instagram: 2200,
};
const DEFAULT_LIMIT = 2000;

function assetInputBlock(imageUrls) {
  return imageUrls.length
    ? `[${imageUrls.map(u => `{ image: { url: ${JSON.stringify(u)} } }`).join(', ')}]`
    : '[]';
}

/**
 * Create a single (non-threaded) post on a Buffer channel.
 *
 * Buffer GraphQL AssetInput schema (confirmed via introspection, round 13):
 *   AssetInput { image: ImageAssetInput, video: ..., document: ..., link: LinkAssetInput }
 *   ImageAssetInput { url: String }
 * Correct shape: assets: [{ image: { url: "..." } }]
 */
async function createPost(token, { channelId, service = '', text, imageUrls = [], mode = 'addToQueue', dueAt, firstComment }) {
  const svc = service.toLowerCase();

  const assetsBlock = imageUrls.length ? `assets: ${assetInputBlock(imageUrls)}` : '';
  const dueAtArg = (mode === 'customScheduled' && dueAt)
    ? `dueAt: ${JSON.stringify(dueAt)},`
    : '';

  // Instagram requires the post type via InstagramPostMetadata nested under `metadata`.
  // Without this, Buffer rejects the post with a 400 for multi-image posts.
  // firstComment is included when provided — note: as of this writing, Buffer's
  // own roadmap lists Instagram firstComment as a known no-op (it's silently
  // dropped server-side, though the same field works for Facebook/LinkedIn).
  // Sending it costs nothing and will start working the moment Buffer fixes it.
  let metadataArg = '';
  if (svc === 'instagram') {
    const fields = ['type: post', 'shouldShareToFeed: true'];
    if (firstComment) fields.push(`firstComment: ${JSON.stringify(firstComment)}`);
    metadataArg = `metadata: { instagram: { ${fields.join(', ')} } }`;
  }

  const mutation = `
    mutation CreatePost {
      createPost(input: {
        text: ${JSON.stringify(text)},
        channelId: ${JSON.stringify(channelId)},
        schedulingType: automatic,
        mode: ${mode},
        ${dueAtArg}
        ${metadataArg}
        ${assetsBlock}
      }) {
        ... on PostActionSuccess {
          post {
            id
            dueAt
          }
        }
        ... on MutationError {
          message
        }
      }
    }
  `;

  const data   = await graphql(token, mutation);
  const result = data?.createPost;

  if (result?.message) throw new Error(result.message);
  return result?.post ?? null;
}

/**
 * Create a threaded post on Twitter/X.
 *
 * Confirmed against Buffer's public GraphQL reference (developers.buffer.com):
 * TwitterPostMetadataInput.thread: [ThreadedPostInput!] is a real, documented
 * field — an ordered list where item 0 is the root post (must match the
 * top-level `text`) and each following item replies to the previous one.
 * ThreadedPostInput = { text: String, assets: [AssetInput!]! }.
 *
 * tweetTexts must already be pre-split to fit the platform's character limit
 * (see chunkText in textchunk.js). Falls back to a single truncated tweet if
 * the thread mutation itself fails, so a schema surprise never blocks
 * crossposting entirely — same resilience posture as the rest of this file.
 */
async function createThreadedPost(token, { channelId, imageUrls = [], mode = 'addToQueue', dueAt }, tweetTexts) {
  const [rootText, ...replyTexts] = tweetTexts;
  const rootAssets = assetInputBlock(imageUrls);

  const threadItems = tweetTexts
    .map((t, i) => `{ text: ${JSON.stringify(t)}, assets: ${i === 0 ? rootAssets : '[]'} }`)
    .join(', ');

  const dueAtArg = (mode === 'customScheduled' && dueAt)
    ? `dueAt: ${JSON.stringify(dueAt)},`
    : '';

  const mutation = `
    mutation CreateThreadedPost {
      createPost(input: {
        text: ${JSON.stringify(rootText)},
        channelId: ${JSON.stringify(channelId)},
        schedulingType: automatic,
        mode: ${mode},
        ${dueAtArg}
        metadata: { twitter: { thread: [${threadItems}] } }
        assets: ${rootAssets}
      }) {
        ... on PostActionSuccess {
          post {
            id
            dueAt
          }
        }
        ... on MutationError {
          message
        }
      }
    }
  `;

  try {
    const data   = await graphql(token, mutation);
    const result = data?.createPost;
    if (result?.message) throw new Error(result.message);
    logger.info(`Buffer: posted Twitter thread — ${tweetTexts.length} tweet(s) (${replyTexts.length} repl${replyTexts.length === 1 ? 'y' : 'ies'})`);
    return result?.post ?? null;
  } catch (err) {
    logger.warn(`Buffer: threaded post failed (${err.message}) — falling back to a single truncated tweet`);
    return createPost(token, { channelId, service: 'twitter', text: rootText, imageUrls, mode, dueAt });
  }
}

// ─── Crosspost (called from scheduler) ────────────────────────────────────────

/**
 * Crosspost to all configured Buffer channels.
 * Non-blocking — errors per channel are logged but never thrown.
 *
 * @param {object}   bufferState
 * @param {object}   opts
 * @param {object}   opts.platformTexts     — { bluesky, twitter, instagram } caption variants
 * @param {string}  [opts.text]             — fallback caption if platformTexts not provided
 * @param {string}  [opts.worldText]        — VRCX world info; appended to the caption when it
 *                                            fits within the platform limit, otherwise Twitter
 *                                            threads it instead of dropping it
 * @param {string}  [opts.firstCommentText] — full text (world info + image links) posted as
 *                                            Instagram's first comment — IG allows far more
 *                                            room (2200 chars) than a caption append would
 * @param {object}   opts.platformImageUrls — { instagram: [...], twitter: [...] } overrides per service
 * @param {string[]} opts.imageUrls         — default image URLs for platforms without a specific override
 * @param {string}  [opts.mode]
 * @param {string}  [opts.dueAt]
 */
async function crosspost(bufferState, {
  platformTexts, text, worldText, firstCommentText, linkText,
  imageUrls = [], platformImageUrls = {}, mode, dueAt,
} = {}) {
  if (!bufferState?.enabled)           return;
  if (!bufferState?.token)             return;
  if (!bufferState?.channels?.length)  return;

  const token    = bufferState.token;
  let   channels = bufferState.channels;
  const postMode = mode ?? bufferState.mode ?? 'addToQueue';

  // Resolve any channels whose service is still 'unknown' from a migration
  if (channels.some(c => c.service === 'unknown')) {
    try {
      const live    = await getChannels(token);
      const liveMap = new Map(live.map(c => [c.id, c.service]));
      channels = channels.map(c =>
        c.service === 'unknown' && liveMap.has(c.id)
          ? { ...c, service: liveMap.get(c.id) }
          : c
      );
      logger.info(`Buffer: resolved unknown service(s): ${channels.map(c => `${c.id}→${c.service}`).join(', ')}`);
    } catch (err) {
      logger.warn(`Buffer: could not resolve unknown channel services — ${err.message}`);
    }
  }

  logger.info(`Buffer: crossposting to ${channels.length} channel(s), mode=${postMode}`);

  const results = await Promise.allSettled(
    channels.map(({ id, service }) => {
      const svc   = (service || '').toLowerCase();
      const limit = PLATFORM_LIMITS[svc] ?? DEFAULT_LIMIT;

      // Pick the platform-specific caption, fall back to generic text
      const baseText = platformTexts?.[svc] ?? platformTexts?.bluesky ?? text ?? '';

      // Pick platform-specific image list, fall back to default imageUrls
      const urls = platformImageUrls[svc] ?? imageUrls;

      const fullText = worldText ? `${baseText}\n\n${worldText}` : baseText;

      // Twitter/X: build the full thread content — caption, world info, and
      // image viewer links — then chunk and thread so nothing gets dropped.
      // If it all fits in one tweet, post it as a single tweet instead.
      if (svc === 'twitter' || svc === 'x') {
        const twitterFull = [fullText, linkText].filter(Boolean).join('\n\n');
        const tweetTexts  = chunkText(twitterFull, limit);
        if (tweetTexts.length > 1) {
          return createThreadedPost(token, { channelId: id, imageUrls: urls, mode: postMode, dueAt }, tweetTexts)
            .then(post => {
              logger.info(`Buffer: posted Twitter thread — ${tweetTexts.length} tweet(s) to channel ${id}, root id ${post?.id}`);
              return post;
            });
        }
        const singleCaption = tweetTexts[0].slice(0, limit);
        return createPost(token, { channelId: id, service, text: singleCaption, imageUrls: urls, mode: postMode, dueAt })
          .then(post => {
            logger.info(`Buffer: posted to twitter channel ${id} — post id ${post?.id}, due ${post?.dueAt ?? 'auto'}`);
            return post;
          });
      }

      // Everyone else (and short Twitter captions): single post, append
      // world info only if it fits, hard-truncate as a final backstop.
      let caption = fullText.length <= limit ? fullText : baseText;
      if (caption.length > limit) caption = caption.slice(0, limit - 1) + '…';

      const firstComment = svc === 'instagram' && firstCommentText
        ? firstCommentText.slice(0, 2200)
        : undefined;

      return createPost(token, { channelId: id, service, text: caption, imageUrls: urls, mode: postMode, dueAt, firstComment })
        .then(post => {
          logger.info(`Buffer: posted to ${service} channel ${id} — post id ${post?.id}, due ${post?.dueAt ?? 'auto'}`);
          return post;
        });
    })
  );

  for (const r of results) {
    if (r.status === 'rejected') {
      logger.warn(`Buffer: channel post failed — ${r.reason?.message}`);
    }
  }

  return results;
}

module.exports = { validateToken, getChannels, createPost, createThreadedPost, crosspost };