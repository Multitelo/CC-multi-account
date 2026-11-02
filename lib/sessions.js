'use strict';
// Pins: map a Claude Code session to its project folder, then to a pinned
// account. Claude Code sends X-Claude-Code-Session-Id on every request and
// writes its transcript to ~/.claude/projects/<slug>/<session-id>.jsonl, whose
// lines carry the session's "cwd".
const fs = require('fs');
const path = require('path');
const P = require('./paths');

const cache = new Map(); // sessionId -> { cwd, at }
const MISS_TTL = 20000;

// Windows and macOS folders are case-insensitive; Linux ones are not.
function norm(p) {
  const n = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'linux' ? n : n.toLowerCase();
}

function sessionCwd(sessionId) {
  if (!sessionId || !/^[0-9a-f-]{8,64}$/i.test(sessionId)) return null;
  const hit = cache.get(sessionId);
  if (hit && (hit.cwd || Date.now() - hit.at < MISS_TTL)) return hit.cwd;
  let cwd = null;
  const root = path.join(P.CLAUDE_DIR, 'projects');
  try {
    for (const dir of fs.readdirSync(root)) {
      const f = path.join(root, dir, `${sessionId}.jsonl`);
      let fd;
      try { fd = fs.openSync(f, 'r'); } catch { continue; }
      try {
        const buf = Buffer.alloc(65536);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n));
        if (m) cwd = JSON.parse(`"${m[1]}"`);
      } finally { fs.closeSync(fd); }
      if (cwd) break;
    }
  } catch {}
  cache.set(sessionId, { cwd, at: Date.now() });
  return cwd;
}

// Longest pinned folder that contains cwd wins.
function pinFor(cwd, pins) {
  if (!cwd || !pins) return null;
  const c = norm(cwd);
  let best = null, bestLen = -1;
  for (const [folder, name] of Object.entries(pins)) {
    const f = norm(folder);
    if ((c === f || c.startsWith(f + path.sep)) && f.length > bestLen) { best = name; bestLen = f.length; }
  }
  return best;
}

module.exports = { sessionCwd, pinFor, norm };
