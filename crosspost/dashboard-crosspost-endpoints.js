/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ADD THESE ENDPOINTS TO dashboard.js (after the templates endpoints)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * These endpoints manage crosspost configuration for X & Instagram via Buffer.
 *
 * Paste this entire section into dashboard.js between the templates and
 * Start/Stop sections.
 */

// ── Crosspost Configuration ───────────────────────────────────────────────────

app.get('/api/crosspost/config', requireAuth, (req, res) => {
  res.json({
    enabled: state.crosspost?.enabled ?? true,
    platforms: state.crosspost?.platforms ?? {},
    stats: {
      xPosted: state.stats?.xPosted ?? 0,
      instagramPosted: state.stats?.instagramPosted ?? 0,
    },
  });
});

app.post('/api/crosspost/toggle', requireAuth, (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be boolean' });
  }

  state.crosspost = state.crosspost ?? {};
  state.crosspost.enabled = enabled;
  stateIO.save(state);
  logger.info(`Dashboard: crosspost ${enabled ? 'enabled' : 'disabled'}`);
  res.json({ ok: true, enabled: state.crosspost.enabled });
});

app.post('/api/crosspost/platform-config', requireAuth, (req, res) => {
  const { platform, config } = req.body;
  if (!['x', 'instagram'].includes(platform)) {
    return res.status(400).json({ error: 'platform must be x or instagram' });
  }
  if (typeof config !== 'object') {
    return res.status(400).json({ error: 'config must be an object' });
  }

  state.crosspost = state.crosspost ?? {};
  state.crosspost.platforms = state.crosspost.platforms ?? {};
  state.crosspost.platforms[platform] = config;
  stateIO.save(state);
  logger.info(`Dashboard: ${platform} config updated`);
  res.json({ ok: true, platforms: state.crosspost.platforms });
});

app.get('/api/crosspost/test', requireAuth, async (req, res) => {
  try {
    const crosspost = require('./crosspost');
    const profiles = await crosspost.getProfiles();
    res.json({
      ok: true,
      connected: profiles.length > 0,
      profiles: profiles.map(p => ({
        id: p.id,
        service: p.service,
        name: p.name || 'Unnamed',
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
