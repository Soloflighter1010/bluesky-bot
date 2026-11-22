/**
 * bot.js – posting bot entry point (photobot-worker container)
 *
 * Runs the scheduler, DM command poller, and a lightweight internal HTTP API
 * that the dashboard container calls for operations requiring bot context
 * (Bluesky session, in-memory scheduler state).
 *
 * The web dashboard lives in serve.js / photobot-dashboard.
 */

require('dotenv').config();

const http       = require('http');
const bsky       = require('./bluesky');
const scheduler  = require('./scheduler');
const commands   = require('./commands');
const worldstats = require('./worldstats');
const logger     = require('./logger');

const BOT_INTERNAL_PORT = parseInt(process.env.BOT_INTERNAL_PORT || '3001', 10);

// Backfill status lives here — it needs the bot's live Bluesky session and
// is proxied through the dashboard rather than run directly in that container.
let backfillStatus = { running: false, current: 0, total: 0, result: null, error: null };

async function main() {
  logger.info('═══════════════════════════════════');
  logger.info('  PhotoBot for Bluesky starting…   ');
  logger.info('═══════════════════════════════════');

  const required = ['BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD', 'CHEVERETO_BASE_URL'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    logger.error(`Missing env vars: ${missing.join(', ')}`);
    logger.error('Copy .env.example to .env and fill in your credentials.');
    process.exit(1);
  }

  try {
    await bsky.login();
  } catch (err) {
    logger.error(`Bluesky login failed: ${err.message}`);
    process.exit(1);
  }

  const postNow = scheduler.startScheduler();
  await commands.startDMPoller(postNow);

  // ── Internal API ─────────────────────────────────────────────────────────────
  // Bound to BOT_INTERNAL_PORT, which is NOT forwarded to the host in
  // docker-compose — only reachable from the dashboard container on the
  // shared Docker network. Keeps Bluesky auth and in-memory scheduler state
  // in one place while still giving the dashboard a way to trigger them.
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // Health — used by Docker healthcheck and the dashboard's startup probe
    if (req.method === 'GET' && req.url === '/internal/health') {
      return send(200, { ok: true, uptime: process.uptime() });
    }

    // Trigger an immediate posting cycle
    if (req.method === 'POST' && req.url === '/internal/post-now') {
      Promise.resolve(postNow(true)).catch(err =>
        logger.error(`internal post-now: unhandled error — ${err.message}\n${err.stack}`)
      );
      logger.info('Internal API: manual post triggered');
      return send(200, { ok: true, message: 'Batch triggered (30 s stagger)' });
    }

    // Start a world-stats backfill (requires the live Bluesky session)
    if (req.method === 'POST' && req.url === '/internal/world-stats/backfill') {
      if (backfillStatus.running) {
        return send(409, { error: 'A backfill is already running', ...backfillStatus });
      }
      backfillStatus = { running: true, current: 0, total: 0, result: null, error: null };
      logger.info('Internal API: world-stats backfill triggered');
      worldstats.runBackfill({
        onProgress: (current, total) => {
          backfillStatus.current = current;
          backfillStatus.total   = total;
        },
      })
        .then(result => {
          backfillStatus = { running: false, current: 0, total: 0, result, error: null };
        })
        .catch(err => {
          logger.error(`Internal API: world-stats backfill failed — ${err.message}\n${err.stack}`);
          backfillStatus = { running: false, current: 0, total: 0, result: null, error: err.message };
        });
      return send(200, { ok: true, message: 'Backfill started — poll GET /internal/world-stats/backfill for progress' });
    }

    // Poll backfill progress
    if (req.method === 'GET' && req.url === '/internal/world-stats/backfill') {
      return send(200, backfillStatus);
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(BOT_INTERNAL_PORT, () =>
    logger.info(`Bot internal API listening on port ${BOT_INTERNAL_PORT}`)
  );

  process.on('SIGINT',  () => { logger.info('Bye!'); process.exit(0); });
  process.on('SIGTERM', () => { logger.info('Bye!'); process.exit(0); });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});