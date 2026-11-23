const crypto = require('node:crypto');

const configured = (process.env.SESSION_SECRET || '').trim();
const RENDER_SECRET = configured && configured !== 'replace-with-a-different-long-random-string'
  ? configured : null;
const SESSION_SECRET = RENDER_SECRET || crypto.randomBytes(32).toString('hex');

module.exports = { RENDER_SECRET, SESSION_SECRET };
