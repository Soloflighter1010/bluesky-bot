/**
 * dashboard.js – Express web dashboard & REST control API
 *
 * Auth supports two parallel modes — either is sufficient to pass requireAuth:
 *
 *   1. OIDC session cookie  — set when a user completes an OIDC login flow via
 *                             /auth/login → IdP → /auth/callback.  Activated by
 *                             setting OIDC_ISSUER_URL (plus CLIENT_ID, CLIENT_SECRET,
 *                             REDIRECT_URI).  The browser cookie is sent automatically;
 *                             no JS changes are needed for authenticated API calls.
 *
 *   2. x-dashboard-secret header — the existing shared-secret mechanism.  Kept for
 *                             backward compatibility so programmatic callers (the DM
 *                             command handler, Make/Zapier test, etc.) keep working.
 *
 * New env vars:
 *   OIDC_ISSUER_URL       Discovery URL of your IdP, e.g. https://accounts.google.com
 *   OIDC_CLIENT_ID        Client ID registered with the IdP
 *   OIDC_CLIENT_SECRET    Client secret registered with the IdP
 *   OIDC_REDIRECT_URI     Must match what you registered, e.g. https://bot.example.com/auth/callback
 *   OIDC_ALLOWED_EMAILS   Optional comma-sep list; supports exact emails and @domain.tld wildcards
 *   SESSION_SECRET        Random string for signing session cookies (auto-generated if omitted,
 *                         but sessions won't survive restarts — set it in .env)
 */

const express     = require('express');
const session     = require('express-session');
const path        = require('path');
const crypto      = require('crypto');
const axios       = require('axios');
const chevereto   = require('./chevereto');
const stateIO     = require('./state');
const logger      = require('./logger');
const buffer      = require('./buffer');
const imagerender = require('./imagerender');
const worldstats  = require('./worldstats');
const membershipdrafts = require('./membershipdrafts');
const { SESSION_SECRET } = require('./secrets');

const PORT   = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
const SECRET = (process.env.DASHBOARD_SECRET || 'change_me').trim();

// Internal API coordinates for the bot worker container.
// In Docker these are set via docker-compose environment; in local dev both
// processes run on localhost with BOT_INTERNAL_PORT distinguishing them.
const BOT_INTERNAL_HOST = (process.env.BOT_INTERNAL_HOST || 'localhost').trim();
const BOT_INTERNAL_PORT = parseInt(process.env.BOT_INTERNAL_PORT || '3001', 10);
const BOT_INTERNAL_URL  = `http://${BOT_INTERNAL_HOST}:${BOT_INTERNAL_PORT}`;

// ── OIDC allowed-email filter ──────────────────────────────────────────────────
// Entries can be:
//   exact email  → alice@example.com
//   domain glob  → @example.com  (matches any address at that domain)
const ALLOWED_EMAILS = (process.env.OIDC_ALLOWED_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function isEmailAllowed(email) {
  if (!ALLOWED_EMAILS.length) return true; // open to any authenticated user
  const lc = (email || '').toLowerCase();
  return ALLOWED_EMAILS.some(rule =>
    rule.startsWith('@')
      ? lc.endsWith(rule)       // domain wildcard
      : lc === rule             // exact match
  );
}

// ── Rate limiter (no extra dependency) ────────────────────────────────────────
function makeRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function rateLimiter(req, res, next) {
    const ip  = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;
    const times = (hits.get(ip) || []).filter(t => t > windowStart);
    times.push(now);
    hits.set(ip, times);
    if (times.length > max) {
      logger.warn(`Rate limit exceeded for ${ip} on ${req.path}`);
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}

const authRateLimit = makeRateLimiter({ windowMs: 15 * 60_000, max: 20  });
const generalLimit  = makeRateLimiter({ windowMs: 60_000,       max: 120 });

// ── OIDC client (initialised async; null if not configured) ───────────────────
let oidcClient     = null;
let oidcGenerators = null;

async function initOIDC() {
  const issuerUrl     = process.env.OIDC_ISSUER_URL?.trim();
  const clientId      = process.env.OIDC_CLIENT_ID?.trim();
  const clientSecret  = process.env.OIDC_CLIENT_SECRET?.trim();
  const redirectUri   = process.env.OIDC_REDIRECT_URI?.trim();

  if (!issuerUrl) return; // OIDC not configured — that's fine

  const missing = ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI']
    .filter(k => !process.env[k]?.trim());
  if (missing.length) {
    logger.error(`OIDC: OIDC_ISSUER_URL is set but missing: ${missing.join(', ')} — OIDC disabled`);
    return;
  }

  try {
    const { Issuer, generators } = require('openid-client');
    logger.info(`OIDC: discovering issuer at ${issuerUrl}…`);
    const issuer = await Issuer.discover(issuerUrl);
    oidcClient = new issuer.Client({
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uris: [redirectUri],
      response_types: ['code'],
    });
    oidcGenerators = generators;
    logger.info(`OIDC: ready — issuer ${issuer.issuer}`);
    if (ALLOWED_EMAILS.length) {
      logger.info(`OIDC: access restricted to: ${ALLOWED_EMAILS.join(', ')}`);
    } else {
      logger.info('OIDC: no email allowlist — any authenticated user can access the dashboard');
    }
  } catch (err) {
    logger.error(`OIDC: discovery failed — ${err.message}`);
    logger.error('OIDC: dashboard will fall back to secret-only auth');
  }
}

// ── Main dashboard startup ─────────────────────────────────────────────────────
async function startDashboard() {
  // Load state from the shared volume. The bot worker writes to this file
  // during every posting cycle; we refresh every 5 s so the dashboard stays
  // in sync without any process-to-process coordination beyond the file.
  let state = stateIO.load();
  setInterval(() => {
    try { state = stateIO.load(); } catch { /* keep last good state */ }
  }, 5_000);

  // Initialise OIDC before binding routes so oidcClient is ready
  await initOIDC();

  const app = express();
  app.use(express.json());
  app.use(generalLimit);

  // ── Session middleware ────────────────────────────────────────────────────────
  app.use(session({
    secret:            SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    name:              'photobot.sid',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // Set secure:true in production (behind HTTPS reverse proxy).
      // The TRUST_PROXY env var is a convenience switch for running behind nginx/Caddy.
      secure:   process.env.TRUST_PROXY === 'true',
      maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
    },
  }));

  // Trust the first proxy hop (needed for req.ip and secure cookies behind nginx/Caddy)
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

  app.use(express.static(path.join(__dirname, '..', 'dashboard'), { extensions: ['html'] }));

  // ── Auth middleware ───────────────────────────────────────────────────────────
  // Accepts either a valid session (OIDC) or the x-dashboard-secret header.
  function requireAuth(req, res, next) {
    // 1. Session auth (OIDC login)
    if (req.session?.authenticated === true) return next();

    // 2. Header auth (shared secret)
    const incoming = (req.headers['x-dashboard-secret'] || '').trim();
    const valid = incoming.length > 0 &&
      incoming.length === SECRET.length &&
      crypto.timingSafeEqual(Buffer.from(incoming), Buffer.from(SECRET));
    if (valid) return next();

    logger.warn(`Dashboard: auth failed from ${req.ip} on ${req.path}`);
    res.status(401).json({ error: 'Unauthorized' });
  }

  // ── OIDC routes ───────────────────────────────────────────────────────────────

  // GET /auth/login — redirect to IdP
  app.get('/auth/login', (req, res) => {
    if (!oidcClient) {
      return res.status(503).send('OIDC is not configured on this server.');
    }
    const code_verifier  = oidcGenerators.codeVerifier();
    const code_challenge = oidcGenerators.codeChallenge(code_verifier);
    const state          = oidcGenerators.state();
    const nonce          = oidcGenerators.nonce();

    // Stash PKCE + nonce in the session so the callback can verify them.
    req.session.oidcPending = { code_verifier, state, nonce };

    const url = oidcClient.authorizationUrl({
      scope:                 'openid email profile',
      code_challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    logger.info(`OIDC: login initiated from ${req.ip}`);
    res.redirect(url);
  });

  // GET /auth/callback — IdP posts back here with the auth code
  app.get('/auth/callback', async (req, res) => {
    if (!oidcClient) {
      return res.status(503).send('OIDC is not configured on this server.');
    }

    const pending = req.session.oidcPending;
    if (!pending) {
      logger.warn(`OIDC: callback reached without pending session from ${req.ip}`);
      return res.redirect('/auth/login?error=session_lost');
    }

    const { code_verifier, state, nonce } = pending;
    delete req.session.oidcPending; // consume — prevents replay

    try {
      const params   = oidcClient.callbackParams(req);
      const tokenSet = await oidcClient.callback(
        process.env.OIDC_REDIRECT_URI,
        params,
        { code_verifier, state, nonce }
      );

      const claims = tokenSet.claims();
      const email  = claims.email || '';
      const name   = claims.name  || claims.preferred_username || email;

      if (!isEmailAllowed(email)) {
        logger.warn(`OIDC: login denied for ${email} — not in allowlist`);
        return res.redirect('/auth/login?error=access_denied');
      }

      // Regenerate session ID to prevent session fixation
      req.session.regenerate(err => {
        if (err) {
          logger.error(`OIDC: session regeneration failed — ${err.message}`);
          return res.redirect('/auth/login?error=server_error');
        }
        req.session.authenticated = true;
        req.session.user          = { email, name };
        logger.info(`OIDC: login success for ${email}`);
        res.redirect('/');
      });

    } catch (err) {
      logger.error(`OIDC: callback error — ${err.message}`);
      res.redirect(`/auth/login?error=${encodeURIComponent(err.message)}`);
    }
  });

  // POST /auth/logout — destroy session and optionally end IdP session
  app.post('/auth/logout', (req, res) => {
    const user = req.session?.user;
    req.session.destroy(err => {
      if (err) logger.warn(`OIDC: session destroy error — ${err.message}`);
      res.clearCookie('photobot.sid');

      // If the IdP supports end_session_endpoint, redirect there; otherwise go home.
      const endSession = oidcClient?.issuer?.metadata?.end_session_endpoint;
      if (endSession) {
        const logoutUrl = new URL(endSession);
        logoutUrl.searchParams.set('post_logout_redirect_uri',
          process.env.OIDC_REDIRECT_URI?.replace('/auth/callback', '/') || '/');
        logger.info(`OIDC: logout for ${user?.email}, redirecting to IdP logout`);
        return res.json({ ok: true, redirect: logoutUrl.toString() });
      }

      logger.info(`OIDC: logout for ${user?.email}`);
      res.json({ ok: true, redirect: '/' });
    });
  });

  // ── Auth config (public) ──────────────────────────────────────────────────────
  // Called by the dashboard on load to decide which auth UI to show.
  app.get('/api/auth/config', (req, res) => {
    res.json({
      oidcEnabled:   !!oidcClient,
      sessionAuth:   req.session?.authenticated === true,
      user:          req.session?.user ?? null,
      // Let the UI know if the secret fallback is still meaningful
      secretEnabled: SECRET !== 'change_me',
    });
  });

  // ── Secret verify (rate-limited) ──────────────────────────────────────────────
  app.post('/api/verify', authRateLimit, requireAuth, (req, res) => res.json({ ok: true }));

  // ── Status (public — health check endpoint also used by Docker) ──────────────
  app.get('/api/status', (req, res) => {
    res.json({
      running:      state.running,
      totalPosted:  state.stats.totalPosted,
      lastPostedAt: state.stats.lastPostedAt,
      lastCheckAt:  state.stats.lastCheckAt,
      pendingQueue: state.highlights.length,
      seenImages:   state.postedIds.length,
      uptime:       process.uptime(),
    });
  });

  // ── Log tail (auth-gated — reads shared bot.log from the named volume) ──────
  // Returns the last N lines of the Winston log file so the dashboard can show
  // real posting activity rather than just client-side action events.
  app.get('/api/logs', requireAuth, (req, res) => {
    const tail = Math.min(parseInt(req.query.tail || '300', 10), 1000);
    const logFile = process.env.LOG_FILE || path.join(__dirname, '..', 'bot.log');
    try {
      if (!fs.existsSync(logFile)) return res.json({ lines: [] });
      const content = fs.readFileSync(logFile, 'utf8');
      const lines   = content.split('\n').filter(Boolean);
      res.json({ lines: lines.slice(-tail) });
    } catch (err) {
      logger.warn(`Dashboard: /api/logs failed — ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Image render (public, signed — see imagerender.js) ────────────────────────
  // Buffer's own servers fetch this URL directly for Twitter/Instagram crossposts,
  // so it can't sit behind requireAuth. Access is gated by the signed src/exp/sig
  // query params instead, checked inside renderHandler.
  app.get('/api/render', imagerender.renderHandler);

  // ── Queue ─────────────────────────────────────────────────────────────────────
  app.get('/api/queue', requireAuth, (req, res) => {
    res.json({ queue: state.highlights });
  });

  // ── Spotlight history ─────────────────────────────────────────────────────────
  app.get('/api/spotlight-history', requireAuth, (req, res) => {
    res.json({ history: state.spotlightHistory ?? [] });
  });

  // ── User mappings ─────────────────────────────────────────────────────────────
  // Maps Chevereto usernames → per-platform handles { bluesky, twitter, instagram }
  app.get('/api/user-mappings', requireAuth, (req, res) => {
    res.json({ mappings: state.userMappings ?? {} });
  });

  app.post('/api/user-mappings', requireAuth, (req, res) => {
    const { cheveretoUsername, bluesky = '', twitter = '', instagram = '' } = req.body;
    if (!cheveretoUsername?.trim())
      return res.status(400).json({ error: 'cheveretoUsername required' });
    if (!bluesky && !twitter && !instagram)
      return res.status(400).json({ error: 'At least one platform handle required' });

    const chev = cheveretoUsername.trim().replace(/^@/, '');

    // Validate bluesky handle format when provided
    const bskyH = bluesky.trim().replace(/^@/, '');
    if (bskyH && !bskyH.includes('.'))
      return res.status(400).json({ error: 'Bluesky handle must include domain, e.g. user.bsky.social' });

    state.userMappings       = state.userMappings ?? {};
    state.userMappings[chev] = {
      bluesky:   bskyH,
      twitter:   twitter.trim().replace(/^@/, ''),
      instagram: instagram.trim().replace(/^@/, ''),
    };
    stateIO.save(state);
    logger.info(`Dashboard: mapped @${chev} → bluesky:${bskyH} twitter:${state.userMappings[chev].twitter} instagram:${state.userMappings[chev].instagram}`);
    res.json({ ok: true, mappings: state.userMappings });
  });

  app.delete('/api/user-mappings/:username', requireAuth, (req, res) => {
    const chev = req.params.username;
    state.userMappings = state.userMappings ?? {};
    delete state.userMappings[chev];
    stateIO.save(state);
    logger.info(`Dashboard: removed mapping for @${chev}`);
    res.json({ ok: true, mappings: state.userMappings });
  });

  // ── Tags ──────────────────────────────────────────────────────────────────────
  app.get('/api/tags', requireAuth, (req, res) => {
    res.json({ tags: state.customTags ?? [] });
  });

  app.post('/api/tags', requireAuth, (req, res) => {
    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array' });
    state.customTags = tags.map(t => t.trim()).filter(Boolean)
      .map(t => t.startsWith('#') ? t : `#${t}`).slice(0, 20);
    stateIO.save(state);
    logger.info(`Dashboard: tags updated — ${state.customTags.join(' ')}`);
    res.json({ ok: true, tags: state.customTags });
  });

  // ── Templates ─────────────────────────────────────────────────────────────────
  app.get('/api/templates', requireAuth, (req, res) => {
    res.json({ templates: state.templates });
  });

  app.post('/api/templates', requireAuth, (req, res) => {
    const { templates } = req.body;
    if (!templates || typeof templates !== 'object')
      return res.status(400).json({ error: 'templates object required' });
    const allowed = ['regularPost', 'albumHighlight', 'memberSpotlight', 'vrcxReply', 'patreonPost', 'kofiPost', 'patreonWeekly', 'kofiWeekly', 'patreonMonthly', 'kofiMonthly'];
    for (const key of allowed) {
      if (typeof templates[key] === 'string') state.templates[key] = templates[key];
    }
    stateIO.save(state);
    logger.info('Dashboard: templates updated');
    res.json({ ok: true, templates: state.templates });
  });

  // ── Start / Stop ──────────────────────────────────────────────────────────────
  app.post('/api/start', requireAuth, (req, res) => {
    state.running = true; stateIO.save(state);
    logger.info('Dashboard: bot started');
    res.json({ ok: true, running: true });
  });

  app.post('/api/stop', requireAuth, (req, res) => {
    state.running = false; stateIO.save(state);
    logger.info('Dashboard: bot paused');
    res.json({ ok: true, running: false });
  });

  // ── Random mode ───────────────────────────────────────────────────────────────
  app.get('/api/random-mode', requireAuth, (req, res) => {
    res.json({ randomMode: state.randomMode ?? false });
  });

  app.post('/api/random-mode', requireAuth, (req, res) => {
    const { randomMode } = req.body;
    if (typeof randomMode !== 'boolean')
      return res.status(400).json({ error: 'randomMode must be a boolean' });
    state.randomMode = randomMode;
    stateIO.save(state);
    logger.info(`Dashboard: selection mode → ${randomMode ? 'full random' : 'recency biased'}`);
    res.json({ ok: true, randomMode: state.randomMode });
  });

  // ── Post now ──────────────────────────────────────────────────────────────────
  // Proxied to the bot worker — posting requires its live Bluesky session.
  app.post('/api/post-now', requireAuth, async (req, res) => {
    try {
      await axios.post(`${BOT_INTERNAL_URL}/internal/post-now`, {}, { timeout: 8_000 });
      logger.info('Dashboard: manual post triggered via bot worker');
      res.json({ ok: true, message: 'Batch triggered (30 s stagger)' });
    } catch (err) {
      logger.warn(`Dashboard: post-now proxy failed — ${err.message}`);
      res.status(502).json({ error: `Could not reach bot worker: ${err.message}` });
    }
  });

  // ── Album highlight ───────────────────────────────────────────────────────────
  app.post('/api/highlight', requireAuth, async (req, res) => {
    const { albumId } = req.body;
    if (!albumId) return res.status(400).json({ error: 'albumId required' });
    try {
      const album = await chevereto.fetchAlbum(albumId);
      if (!album) return res.status(404).json({ error: `Album not found for: ${albumId}` });
      const rawImages = await chevereto.fetchAlbumImages(albumId);
      const excludedUsernames = stateIO.getExcludedUsernameSet(state);
      const images = chevereto.filterExcludedUsers(rawImages, excludedUsernames);
      if (rawImages.length > 0 && images.length === 0) {
        return res.status(403).json({ error: 'This album is entirely from a photographer who has opted out of auto-posting' });
      }
      state.highlights.push({ type: 'album', albumId, title: album.name, coverImage: images[0] ?? null, queuedAt: new Date().toISOString() });
      stateIO.save(state);
      res.json({ ok: true, album: album.name, queue: state.highlights.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Member spotlight ──────────────────────────────────────────────────────────
  app.post('/api/spotlight', requireAuth, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    if (stateIO.isExcluded(state, username)) {
      return res.status(403).json({ error: `@${username} has opted out of auto-posting` });
    }
    try {
      const user = await chevereto.fetchUser(username);
      if (!user) return res.status(404).json({ error: `User not found: ${username}` });
      const images = await chevereto.fetchUserSpotlightImages(username);
      logger.info(`Spotlight queue: fetched ${images.length} representative images for @${username}`);
      state.highlights.push({ type: 'spotlight', username: user.username, name: user.name ?? user.username, images: images.slice(0, 3), queuedAt: new Date().toISOString() });
      stateIO.save(state);
      res.json({ ok: true, user: user.username, imageCount: images.length, queue: state.highlights.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Excluded photographers ────────────────────────────────────────────────────
  // Admin-managed opt-out list. Prevents *future* selection only (batches,
  // random mode, new spotlight/album requests) — nothing already posted is
  // touched or retracted.

  app.get('/api/excluded-users', requireAuth, (req, res) => {
    res.json({ excludedUsers: state.excludedUsers ?? {} });
  });

  app.post('/api/excluded-users', requireAuth, (req, res) => {
    const { username, note, durationDays, permanent } = req.body;
    if (!username?.trim()) return res.status(400).json({ error: 'username required' });
    const key = username.trim().toLowerCase().replace(/^@/, '');

    let expiresAt = null; // null = permanent
    if (!permanent) {
      const days = Number(durationDays);
      if (!Number.isFinite(days) || days <= 0) {
        return res.status(400).json({ error: 'durationDays must be a positive number, or set permanent: true' });
      }
      expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
    }

    state.excludedUsers = state.excludedUsers ?? {};
    state.excludedUsers[key] = {
      excludedAt: new Date().toISOString(),
      expiresAt,
      note: (note || '').trim().slice(0, 300),
    };

    // Drop any already-queued spotlight for this user — nothing to check for
    // albums here (an album highlight doesn't carry a username on the
    // highlight object itself), but postAlbumHighlight re-checks the cover
    // image's uploader defensively at post time regardless.
    const beforeCount = state.highlights.length;
    state.highlights = state.highlights.filter(h =>
      !(h.type === 'spotlight' && h.username?.toLowerCase() === key)
    );
    const removedFromQueue = beforeCount - state.highlights.length;

    stateIO.save(state);
    logger.info(`Dashboard: excluded @${key} (${expiresAt ? `until ${expiresAt}` : 'permanent'})${removedFromQueue ? ` — removed ${removedFromQueue} queued spotlight(s)` : ''}`);
    res.json({ ok: true, excludedUsers: state.excludedUsers, removedFromQueue });
  });

  app.delete('/api/excluded-users/:username', requireAuth, (req, res) => {
    const key = req.params.username.toLowerCase().replace(/^@/, '');
    state.excludedUsers = state.excludedUsers ?? {};
    delete state.excludedUsers[key];
    stateIO.save(state);
    logger.info(`Dashboard: removed @${key} from excluded list`);
    res.json({ ok: true, excludedUsers: state.excludedUsers });
  });

  // ── Buffer crossposting ───────────────────────────────────────────────────────

  // GET /api/buffer — return current config (token is masked)
  app.get('/api/buffer', requireAuth, (req, res) => {
    const b = state.buffer ?? {};
    let tokenDaysRemaining = null;
    if (b.tokenSetAt) {
      const msRemaining = (new Date(b.tokenSetAt).getTime() + 30 * 86_400_000) - Date.now();
      tokenDaysRemaining = Math.max(0, Math.floor(msRemaining / 86_400_000));
    }
    res.json({
      enabled:           b.enabled    ?? false,
      tokenSet:          !!b.token,
      tokenSetAt:        b.tokenSetAt ?? null,
      tokenDaysRemaining,
      channels:          b.channels   ?? [],
      mode:              b.mode       ?? 'addToQueue',
    });
  });

  // POST /api/buffer/token — validate and save a new API token
  app.post('/api/buffer/token', requireAuth, async (req, res) => {
    const { token } = req.body;
    if (!token?.trim()) return res.status(400).json({ error: 'token required' });
    try {
      const info = await buffer.validateToken(token.trim());
      state.buffer           = state.buffer ?? {};
      state.buffer.token     = token.trim();
      state.buffer.tokenSetAt = new Date().toISOString();
      // Clear cached channel selection so user re-picks with the new token
      state.buffer.channels  = [];
      stateIO.save(state);
      logger.info(`Dashboard: Buffer token saved for ${info.email}`);
      res.json({ ok: true, email: info.email });
    } catch (err) {
      logger.warn(`Dashboard: Buffer token validation failed — ${err.message}`);
      res.status(400).json({ error: `Invalid token: ${err.message}` });
    }
  });

  // GET /api/buffer/channels — fetch channels from Buffer using stored token
  app.get('/api/buffer/channels', requireAuth, async (req, res) => {
    const token = state.buffer?.token;
    if (!token) return res.status(400).json({ error: 'No Buffer token configured' });
    try {
      const channels = await buffer.getChannels(token);
      res.json({ channels });
    } catch (err) {
      logger.warn(`Dashboard: Buffer channel fetch failed — ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/buffer/config — save enabled flag, selected channel IDs, mode
  app.post('/api/buffer/config', requireAuth, (req, res) => {
    const { enabled, channels, mode } = req.body;
    state.buffer = state.buffer ?? {};
    if (typeof enabled === 'boolean') state.buffer.enabled = enabled;
    if (Array.isArray(channels)) {
      // Accept [{id, service}] objects; filter out anything malformed
      state.buffer.channels = channels
        .filter(c => c && typeof c.id === 'string' && typeof c.service === 'string')
        .map(c => ({ id: c.id, service: c.service }));
    }
    if (typeof mode === 'string' && ['addToQueue', 'customScheduled'].includes(mode)) {
      state.buffer.mode = mode;
    }
    stateIO.save(state);
    logger.info(`Dashboard: Buffer config updated — enabled=${state.buffer.enabled}, channels=${state.buffer.channels.map(c => `${c.service}:${c.id}`).join(',')}, mode=${state.buffer.mode}`);
    res.json({ ok: true, buffer: { enabled: state.buffer.enabled, channels: state.buffer.channels, mode: state.buffer.mode } });
  });

  // POST /api/buffer/test — send a test post to the first configured channel
  app.post('/api/buffer/test', requireAuth, async (req, res) => {
    const b = state.buffer ?? {};
    if (!b.token)              return res.status(400).json({ error: 'No Buffer token configured' });
    if (!b.channels?.length)   return res.status(400).json({ error: 'No channels selected' });
    const { id: channelId, service } = b.channels[0];
    try {
      const post = await buffer.createPost(b.token, {
        channelId,
        service,
        text:      '🧪 Test post from PhotoBot — you can delete this.',
        imageUrls: [],
        mode:      'addToQueue',
      });
      logger.info(`Dashboard: Buffer test post created — ${post?.id}`);
      res.json({ ok: true, postId: post?.id, dueAt: post?.dueAt });
    } catch (err) {
      logger.warn(`Dashboard: Buffer test post failed — ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Clear queue ───────────────────────────────────────────────────────────────
  app.post('/api/clear-queue', requireAuth, (req, res) => {
    state.highlights = [];
    stateIO.save(state);
    res.json({ ok: true });
  });

  // ── World stats (public heatmap page) ─────────────────────────────────────────

  // GET /api/world-stats — public, no auth. Feeds the public /worlds page.
  app.get('/api/world-stats', (req, res) => {
    try {
      res.json(worldstats.getPublicData());
    } catch (err) {
      logger.error(`Dashboard: world-stats read failed — ${err.message}`);
      res.status(500).json({ error: 'Could not load world stats' });
    }
  });

  // Backfill requires the bot's live Bluesky session — proxied to the worker.
  // The worker tracks progress in memory; the dashboard polls it via this proxy.
  app.post('/api/world-stats/backfill', requireAuth, async (req, res) => {
    logger.info('Dashboard: world-stats backfill triggered via bot worker');
    try {
      const { data } = await axios.post(
        `${BOT_INTERNAL_URL}/internal/world-stats/backfill`, {}, { timeout: 10_000 }
      );
      res.json(data);
    } catch (err) {
      const status = err.response?.status ?? 502;
      const body   = err.response?.data   ?? { error: err.message };
      res.status(status).json(body);
    }
  });

  app.get('/api/world-stats/backfill', requireAuth, async (req, res) => {
    try {
      const { data } = await axios.get(
        `${BOT_INTERNAL_URL}/internal/world-stats/backfill`, { timeout: 5_000 }
      );
      res.json(data);
    } catch {
      // Bot worker may not be up yet — return a safe idle status rather than an error
      res.json({ running: false, current: 0, total: 0, result: null, error: null });
    }
  });

  // ── Membership post drafts (Patreon / Ko-fi) ──────────────────────────────────
  // Neither platform's API supports creating posts, so this is a manual
  // copy-paste aid, not a crosspost queue — see membershipdrafts.js.

  app.get('/api/membership-drafts', requireAuth, (req, res) => {
    res.json({ drafts: state.membershipDrafts ?? [] });
  });

  // Read-only progress snapshot — how much has accumulated toward the next
  // weekly/monthly roundup draft. Doesn't trigger a check itself (that only
  // happens from the scheduler cycle); this just reports current totals.
  app.get('/api/membership-drafts/roundup-status', requireAuth, (req, res) => {
    res.json(membershipdrafts.getRoundupStatus(state));
  });

  // Generates a preview draft from sample data — neither platform can
  // actually be posted to (see membershipdrafts.js), so this is for
  // checking template output, not a real test post.
  const TEST_DRAFT_TYPES = ['spotlight', 'album', 'weekly', 'monthly'];
  app.post('/api/membership-drafts/test', requireAuth, (req, res) => {
    const { type } = req.body;
    if (!TEST_DRAFT_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${TEST_DRAFT_TYPES.join(', ')}` });
    }
    try {
      const draft = membershipdrafts.generateTestDraft(state, type);
      logger.info(`Dashboard: generated test ${type} draft`);
      res.json({ ok: true, draft });
    } catch (err) {
      logger.error(`Dashboard: test draft generation failed — ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/membership-drafts/:id', requireAuth, (req, res) => {
    state.membershipDrafts = (state.membershipDrafts ?? []).filter(d => d.id !== req.params.id);
    stateIO.save(state);
    res.json({ ok: true, drafts: state.membershipDrafts });
  });

  app.delete('/api/membership-drafts', requireAuth, (req, res) => {
    state.membershipDrafts = [];
    stateIO.save(state);
    res.json({ ok: true });
  });

  app.listen(PORT, () => logger.info(`Dashboard running at http://localhost:${PORT}`));
}

module.exports = { startDashboard };