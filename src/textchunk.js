/**
 * textchunk.js – line-aware text chunking, shared by scheduler.js (Bluesky
 * reply threads) and buffer.js (Twitter/X thread splitting via Buffer's
 * TwitterPostMetadataInput.thread field).
 *
 * Splits text into chunks no longer than `limit`, preferring to break on
 * line boundaries. A single line longer than `limit` gets hard-split with
 * an ellipsis continuation marker rather than overflowing the limit.
 */

function chunkText(text, limit = 280) {
  if (text.length <= limit) return [text];

  const chunks = [];
  const lines  = text.split('\n');
  let current  = '';

  for (const line of lines) {
    const candidate = current ? current + '\n' + line : line;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      if (line.length > limit) {
        let remaining = line;
        while (remaining.length > limit) {
          chunks.push(remaining.slice(0, limit - 1) + '…');
          remaining = '…' + remaining.slice(limit - 1);
        }
        current = remaining;
      } else {
        current = line;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = { chunkText };