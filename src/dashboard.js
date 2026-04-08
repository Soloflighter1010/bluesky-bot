/**
 * dashboard.js – Express web dashboard & REST control API
 */

const express   = require('express');
const path      = require('path');
const chevereto = require('./chevereto');
const stateIO   = require('./state');
const logger    = require('./logger');

const PORT   = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
const SECRET = (process.env.DASHBOARD_SECRET || 'change_me').trim();

function startDashboard(state, postNowCallback) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'dashboard')));

  function requireAuth(req, res, next) {
    const incoming = (req.headers['x-dashboard-secret'] || '').trim();
    if (incoming === SECRET) return next();
    logger.warn(`Dashboard auth failed (got length ${incoming.length}, expected ${SECRET.length})`);
    res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Auth verify ──────────────────────────────────────────────────────────────
  app.post('/api/verify', requireAuth, (req, res) => res.json({ ok: true }));

  // ── Status ────────────────────────────────────────────────────────────────────
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

  // ── Queue (full item list) ────────────────────────────────────────────────────
  app.get('/api/queue', requireAuth, (req, res) => {
    res.json({ queue: state.highlights });
  });

  // ── Spotlight history ─────────────────────────────────────────────────────────
  app.get('/api/spotlight-history', requireAuth, (req, res) => {
    res.json({ history: state.spotlightHistory ?? [] });
  });

  // ── User mappings ─────────────────────────────────────────────────────────────
  // Maps Chevereto username → Bluesky handle for proper @mentions in posts

  app.get('/api/user-mappings', requireAuth, (req, res) => {
    res.json({ mappings: state.userMappings ?? {} });
  });

  app.post('/api/user-mappings', requireAuth, (req, res) => {
    const { cheveretoUsername, bskyHandle } = req.body;
    if (!cheveretoUsername || !bskyHandle) {
      return res.status(400).json({ error: 'cheveretoUsername and bskyHandle required' });
    }

    const chev = cheveretoUsername.trim().replace(/^@/, '');
    // Normalise Bluesky handle: strip leading @, ensure it has a dot (basic check)
    const bsky = bskyHandle.trim().replace(/^@/, '');
    if (!bsky.includes('.')) {
      return res.status(400).json({ error: 'bskyHandle must be a full handle, e.g. user.bsky.social' });
    }

    state.userMappings = state.userMappings ?? {};
    state.userMappings[chev] = bsky;
    stateIO.save(state);
    logger.info(`Dashboard: mapped @${chev} → @${bsky}`);
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

    // Normalise: ensure each tag starts with #, strip empties
    state.customTags = tags
      .map(t => t.trim())
      .filter(Boolean)
      .map(t => t.startsWith('#') ? t : `#${t}`)
      .slice(0, 20); // reasonable cap

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
    if (!templates || typeof templates !== 'object') {
      return res.status(400).json({ error: 'templates object required' });
    }
    // Only allow known keys
    const allowed = ['regularPost', 'albumHighlight', 'memberSpotlight', 'vrcxReply'];
    for (const key of allowed) {
      if (typeof templates[key] === 'string') {
        state.templates[key] = templates[key];
      }
    }
    stateIO.save(state);
    logger.info('Dashboard: templates updated');
    res.json({ ok: true, templates: state.templates });
  });

  // ── Start / Stop ──────────────────────────────────────────────────────────────
  app.post('/api/start', requireAuth, (req, res) => {
    state.running = true;
    stateIO.save(state);
    logger.info('Dashboard: bot started');
    res.json({ ok: true, running: true });
  });

  app.post('/api/stop', requireAuth, (req, res) => {
    state.running = false;
    stateIO.save(state);
    logger.info('Dashboard: bot paused');
    res.json({ ok: true, running: false });
  });

  // ── Post now ──────────────────────────────────────────────────────────────────
  app.post('/api/post-now', requireAuth, (req, res) => {
    postNowCallback(true); // true = manual, use short stagger
    logger.info('Dashboard: manual post triggered');
    res.json({ ok: true, message: 'Batch triggered (30 s stagger)' });
  });

  // ── Album highlight ───────────────────────────────────────────────────────────
  app.post('/api/highlight', requireAuth, async (req, res) => {
    const { albumId } = req.body;
    if (!albumId) return res.status(400).json({ error: 'albumId required' });

    try {
      const album = await chevereto.fetchAlbum(albumId);
      if (!album) return res.status(404).json({ error: `Album not found for: ${albumId}` });

      const images = await chevereto.fetchAlbumImages(albumId);
      state.highlights.push({
        type:       'album',
        albumId,
        title:      album.name,
        coverImage: images[0] ?? null,
        queuedAt:   new Date().toISOString(),
      });
      stateIO.save(state);
      res.json({ ok: true, album: album.name, queue: state.highlights.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Member spotlight ──────────────────────────────────────────────────────────
  app.post('/api/spotlight', requireAuth, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });

    try {
      const user = await chevereto.fetchUser(username);
      if (!user) return res.status(404).json({ error: `User not found: ${username}` });

      const images = await chevereto.fetchUserSpotlightImages(username);
      logger.info(`Spotlight queue: fetched ${images.length} representative images for @${username}`);

      state.highlights.push({
        type:     'spotlight',
        username: user.username,
        name:     user.name ?? user.username,
        images:   images.slice(0, 3),
        queuedAt: new Date().toISOString(),
      });
      stateIO.save(state);
      res.json({ ok: true, user: user.username, imageCount: images.length, queue: state.highlights.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Clear queue ───────────────────────────────────────────────────────────────
  app.post('/api/clear-queue', requireAuth, (req, res) => {
    state.highlights = [];
    stateIO.save(state);
    res.json({ ok: true });
  });

  app.listen(PORT, () => logger.info(`Dashboard running at http://localhost:${PORT}`));
}

module.exports = { startDashboard };