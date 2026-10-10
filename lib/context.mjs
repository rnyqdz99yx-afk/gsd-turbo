import fs from 'node:fs';
import path from 'node:path';
import { claudeHome, runDir } from './paths.mjs';
import { readJson } from './fsx.mjs';
import { contextTokens, findTranscript } from './transcripts.mjs';

// Transcripts reach hundreds of MB: only their tail is read, growing until a usage is found.
const FIRST_TAIL = 256 * 1024;
const MAX_TAIL = 16 * 1024 * 1024;

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
  return contextTokens(u);
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

// { used, window, pct, sessionId, transcript, source } or { unknown: why }. phase: a normalized id; the lane
// supervisor.json records for it is the third way to find the transcript. The order (session, job, lane, newest)
// is findTranscript's in lib/transcripts.mjs, and source names the way that found it.
export function measureContext({ root, phase = null, window, env = process.env }) {
  const w = Number(window);
  if (!Number.isFinite(w) || w <= 0) return { unknown: 'context_window in .planning/turbo/config.json is not a positive number' };
  const home = claudeHome(env);
  const rec = phase ? readJson(path.join(runDir(root), 'supervisor.json'), null)?.lane : null;
  const lane = rec && String(rec.phase) === String(phase) && typeof rec.sessionId === 'string' ? rec.sessionId : '';
  const t = findTranscript({ home, root, env, lane });
  if (!t) return { unknown: `no transcript of ${root} under ${path.join(home, 'projects')}` };
  let r;
  try {
    r = lastUsage(t.file);
  } catch (e) {
    return { unknown: `cannot read ${t.file}: ${e.code || e.message}` };
  }
  if (r.used === null) return { unknown: `no assistant message with token usage in the last ${Math.round(r.read / 1024)} KB of ${t.file}` };
  return { used: r.used, window: w, pct: Math.floor((r.used * 100) / w), sessionId: r.sessionId, transcript: t.file, source: t.via };
}
