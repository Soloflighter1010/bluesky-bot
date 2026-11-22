/**
 * secrets.js – resolves process-wide secrets exactly once.
 *
 * SESSION_SECRET is used for two things: signing express-session cookies
 * (dashboard.js) and signing the on-demand image render URLs handed to
 * Buffer (imagerender.js). Both need to agree on the same value. If it's
 * generated with a random fallback independently in two different module
 * scopes, they'd disagree and every render-URL signature check would fail.
 * Centralizing the resolution here (and requiring it from both places)
 * guarantees a single value for the life of the process, regardless of
 * which module happens to be required first.
 */

const crypto = require('crypto');
const logger = require('./logger');

let SESSION_SECRET = (process.env.SESSION_SECRET || '').trim();
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  logger.warn('SESSION_SECRET not set — sessions will be invalidated on every restart, and image-render URLs signed before a restart will stop validating. Set it in .env.');
}

module.exports = { SESSION_SECRET };