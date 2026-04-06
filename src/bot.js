/**
 * bot.js – main entry point
 *
 * Wires everything together:
 *   1. Loads .env
 *   2. Logs into Bluesky
 *   3. Restores persisted state
 *   4. Starts the posting scheduler
 *   5. Starts the DM command poller
 *   6. Starts the web dashboard
 */

require('dotenv').config();

const bsky      = require('./bluesky');
const scheduler = require('./scheduler');
const commands  = require('./commands');
const dashboard = require('./dashboard');
const stateIO   = require('./state');
const logger    = require('./logger');

async function main() {
  logger.info('═══════════════════════════════════');
  logger.info('  PhotoBot for Bluesky starting…   ');
  logger.info('═══════════════════════════════════');

  // Validate required env vars
  const required = ['BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD', 'CHEVERETO_BASE_URL', 'CHEVERETO_API_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    logger.error(`Missing env vars: ${missing.join(', ')}`);
    logger.error('Copy .env.example to .env and fill in your credentials.');
    process.exit(1);
  }

  // Load persisted state
  const state = stateIO.load();
  logger.info(`State loaded – bot is ${state.running ? 'running' : 'paused'}, ${state.stats.totalPosted} total posts`);

  // Log in to Bluesky
  try {
    await bsky.login();
  } catch (err) {
    logger.error(`Bluesky login failed: ${err.message}`);
    process.exit(1);
  }

  // Start the scheduler and get the manual trigger
  const postNow = scheduler.startScheduler(state);

  // Start DM poller
  await commands.startDMPoller(state, postNow);

  // Start dashboard
  dashboard.startDashboard(state, postNow);

  // Post immediately on startup so you don't wait an hour for the first post
  logger.info('Running initial post cycle on startup…');
  setTimeout(() => postNow(), 5_000);

  // Graceful shutdown
  process.on('SIGINT',  () => { stateIO.save(state); logger.info('Bye!'); process.exit(0); });
  process.on('SIGTERM', () => { stateIO.save(state); logger.info('Bye!'); process.exit(0); });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
