import fs from 'node:fs';
import path from 'node:path';
import { claudeHome, dirKey, runDir } from './paths.mjs';
import { readJson } from './fsx.mjs';

// Transcripts reach hundreds of MB: only their tail is read, growing until a usage is found.
const FIRST_TAIL = 256 * 1024;
const MAX_TAIL = 16 * 1024 * 1024;
// Transcripts checked for this project's cwd before giving up.
const MAX_FILES = 50;

// Main-session transcripts (projects/<key>/<sessionId>.jsonl; subagent ones live in subfolders), newest
// first. The session that asks is writing its own transcript right now, so it is among the newest.
function transcripts(home) {
  const base = path.join(home, 'projects');
  const files = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  for (const d of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(base, d.name)).filter((n) => n.endsWith('.jsonl'));
    } catch { /* unreadable folder */ }
    for (const n of names) {
      const file = path.join(base, d.name, n);
      try {
        files.push({ file, name: n, mtime: fs.statSync(file).mtimeMs });
      } catch { /* gone meanwhile */ }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

function readTail(file, size, n) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8', 0, got);
  } finally {
    fs.closeSync(fd);
  }
}

// Context in use after the last main-chain assistant message: its prompt side, cache included.
function usedTokens(e) {
  const u = e?.message?.usage;
  if (e?.type !== 'assistant' || e.isSidechain === true || !u || e.message.model === '<synthetic>') return null;
  const n = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);
  return n > 0 ? n : null;
}

// Reads a transcript from its end. Returns { used, cwd, sessionId, read }: used null when no main-chain
// assistant usage lies within MAX_TAIL, or once a cwd for which foreign(cwd) is true was seen (another
// project's transcript is not read any further); cwd is the newest main-chain cwd seen (null when none).
export function lastUsage(file, foreign = () => false) {
  const size = fs.statSync(file).size;
  let cwd = null;
  for (let n = Math.min(size, FIRST_TAIL); ; n = Math.min(size, n * 4)) {
    const lines = readTail(file, size, n).split('\n');
    if (n < size) lines.shift(); // starts inside a line
    cwd = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let e;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (!e || typeof e !== 'object' || e.isSidechain === true) continue;
      if (cwd === null && typeof e.cwd === 'string' && e.cwd) cwd = e.cwd;
      const used = usedTokens(e);
      if (used !== null) return { used, cwd: cwd ?? e.cwd ?? null, sessionId: e.sessionId || null, read: n };
    }
    if (n >= size || n >= MAX_TAIL || (cwd && foreign(cwd))) return { used: null, cwd, sessionId: null, read: n };
  }
}

// The transcript to measure and its usage: the lane's session (file name starting with its id) when one
// is given, else the newest transcript whose entries carry this project's root as cwd.
export function findUsage({ root, home, session = '' }) {
  const rootKey = dirKey(root);
  const foreign = (cwd) => dirKey(cwd) !== rootKey;
  let checked = 0;
  for (const t of transcripts(home)) {
    if (session && !t.name.startsWith(session)) continue;
    if (++checked > MAX_FILES) break;
    let r;
    try {
      r = lastUsage(t.file, foreign);
    } catch {
      continue; // unreadable or gone
    }
    if (!r.cwd || foreign(r.cwd)) continue;
    if (r.used === null) return { why: `no assistant message with token usage in the last ${Math.round(r.read / 1024)} KB of ${t.file}` };
    return { used: r.used, sessionId: r.sessionId, transcript: t.file };
  }
  return { why: session ? `no transcript of lane session ${session} for ${root}` : `no transcript of ${root} under ${path.join(home, 'projects')}` };
}

// { used, window, pct, sessionId, transcript } or { unknown: why }. phase: a normalized id; its lane's session
// is measured when supervisor.json records one for it.
export function measureContext({ root, phase = null, window, env = process.env }) {
  const w = Number(window);
  if (!Number.isFinite(w) || w <= 0) return { unknown: 'context_window in .planning/turbo/config.json is not a positive number' };
  const lane = phase ? readJson(path.join(runDir(root), 'supervisor.json'), null)?.lane : null;
  const session = lane && String(lane.phase) === String(phase) && typeof lane.sessionId === 'string' ? lane.sessionId : '';
  const r = findUsage({ root, home: claudeHome(env), session });
  if (r.why) return { unknown: r.why };
  return { used: r.used, window: w, pct: Math.floor((r.used * 100) / w), sessionId: r.sessionId, transcript: r.transcript };
}
