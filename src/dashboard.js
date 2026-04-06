/**
 * dashboard.js – Express web dashboard & REST control API
 *
 * Serves a web UI for monitoring and controlling the bot.
 * All mutating endpoints require an X-Dashboard-Secret header
 * matching the DASHBOARD_SECRET env var.
 *
 * Routes:
 *   GET  /           – Dashboard HTML
 *   GET  /api/status – Bot state (JSON)
 *   POST /api/start  – Resume posting
 *   POST /api/stop   – Pause posting
 *   POST /api/post-now         – Trigger immediate batch
 *   POST /api/highlight        – Queue an album { albumId }
 *   POST /api/spotlight        – Queue a member { username }
 */

const express   = require('express');
const path      = require('path');
const chevereto = require('./chevereto');
const stateIO   = require('./state');
const logger    = require('./logger');

const PORT   = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
const SECRET = process.env.DASHBOARD_SECRET || 'change_me';

function startDashboard(state, postNowCallback) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'dashboard')));

  // Auth middleware for mutating routes
  function requireAuth(req, res, next) {
    if (req.headers['x-dashboard-secret'] === SECRET) return next();
    res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Status ──────────────────────────────────────────────────────────────────
  app.get('/api/status', (req, res) => {
    res.json({
      running:       state.running,
      totalPosted:   state.stats.totalPosted,
      lastPostedAt:  state.stats.lastPostedAt,
      lastCheckAt:   state.stats.lastCheckAt,
      pendingQueue:  state.highlights.length,
      seenImages:    state.postedIds.length,
      uptime:        process.uptime(),
    });
  });

  // ── Auth check ──────────────────────────────────────────────────────────────
  // Dashboard calls this first to confirm the secret is correct.
  app.post('/api/verify', requireAuth, (req, res) => {
    res.json({ ok: true });
  });

  // ── Start / Stop ────────────────────────────────────────────────────────────
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

  // ── Post now ────────────────────────────────────────────────────────────────
  app.post('/api/post-now', requireAuth, (req, res) => {
    postNowCallback();
    logger.info('Dashboard: manual post triggered');
    res.json({ ok: true, message: 'Batch triggered' });
  });

  // ── Album highlight ─────────────────────────────────────────────────────────
  app.post('/api/highlight', requireAuth, async (req, res) => {
    const { albumId } = req.body;
    if (!albumId) return res.status(400).json({ error: 'albumId required' });

    try {
      const album  = await chevereto.fetchAlbum(albumId);
      if (!album) return res.status(404).json({ error: 'Album not found' });

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

  // ── Member spotlight ────────────────────────────────────────────────────────
  app.post('/api/spotlight', requireAuth, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });

    try {
      const user   = await chevereto.fetchUser(username);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const images = await chevereto.fetchUserImages(username);
      state.highlights.push({
        type:     'spotlight',
        username: user.username,
        name:     user.name ?? user.username,
        images:   images.slice(0, 3),
        queuedAt: new Date().toISOString(),
      });
      stateIO.save(state);
      res.json({ ok: true, user: user.username, queue: state.highlights.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Clear queue ─────────────────────────────────────────────────────────────
  app.post('/api/clear-queue', requireAuth, (req, res) => {
    state.highlights = [];
    stateIO.save(state);
    res.json({ ok: true });
  });

  app.listen(PORT, () => {
    logger.info(`Dashboard running at http://localhost:${PORT}`);
  });
}

module.exports = { startDashboard };