/**
 * serve.js – dashboard entry point (photobot-dashboard container)
 *
 * Serves the web dashboard and REST control API. Reads and writes state
 * through the shared named volume; delegates Bluesky-dependent operations
 * (posting, world-stats backfill) to the bot worker via its internal API.
 *
 * Run alongside bot.js in the same Docker Compose stack:
 *   docker compose up -d
 */

require('dotenv').config();

const dashboard = require('./dashboard');
const logger    = require('./logger');

async function main() {
  logger.info('═══════════════════════════════════');
  logger.info('  PhotoBot Dashboard starting…     ');
  logger.info('═══════════════════════════════════');

  await dashboard.startDashboard();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});