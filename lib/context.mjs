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

// A session or job id taken from the environment or a state file names a file, never a path.
const ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const winKey = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// projects/<any folder>/<id>.jsonl, or null.
function transcriptById(home, id) {
  if (typeof id !== 'string' || !ID.test(id)) return null;
  const base = path.join(home, 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  return dirs.map((d) => path.join(base, d.name, `${id}.jsonl`)).find((f) => fs.existsSync(f)) || null;
}

// The transcript a background job writes now. A job woken again writes into a transcript with a new id:
// its state.json names it (linkScanPath, resumeSessionId), while the old <jobId>-….jsonl stays behind.
function jobTranscript(home, jobDir) {
  const state = readJson(path.join(jobDir, 'state.json'), null);
  if (!state || typeof state !== 'object') return null;
  const projects = winKey(path.resolve(home, 'projects')) + path.sep;
  const link = typeof state.linkScanPath === 'string' ? path.resolve(state.linkScanPath) : '';
  if (link && winKey(link).startsWith(projects) && fs.existsSync(link)) return link;
  return transcriptById(home, state.resumeSessionId) || transcriptById(home, state.sessionId);
}

// A transcript's cwd as a directory key: on win32 the Git Bash form /c/… becomes C:/…; case-insensitive there.
function cwdKey(cwd) {
  const native = process.platform === 'win32' ? cwd.replace(/^\/([A-Za-z])(?=\/|$)/, '$1:') : cwd;
  return dirKey(native).replace(/\/+$/, '');
}

function measureFile(file, source, foreign) {
  let r;
  try {
    r = lastUsage(file, foreign);
  } catch {
    return null; // unreadable or gone
  }
  if (r.used === null) return { why: `no assistant message with token usage in the last ${Math.round(r.read / 1024)} KB of ${file}`, cwd: r.cwd };
  return { used: r.used, sessionId: r.sessionId, transcript: file, source, cwd: r.cwd };
}

// The transcript to measure, in this order: (1) the calling session (CLAUDE_CODE_SESSION_ID, set in a session's
// Bash tool, is its transcript's id); (2) the calling background job's current transcript (CLAUDE_JOB_DIR);
// (3) the given lane's job: its state, then the transcript named after its id; (4) the newest transcript whose
// entries carry a cwd inside the project root. A transcript found by id is measured whatever its cwd.
export function findUsage({ root, home, env = {}, lane = '' }) {
  const byId = [
    ['session', () => transcriptById(home, env.CLAUDE_CODE_SESSION_ID)],
    ['job', () => (env.CLAUDE_JOB_DIR ? jobTranscript(home, path.resolve(env.CLAUDE_JOB_DIR)) : null)],
    ['lane', () => (lane && ID.test(lane) ? jobTranscript(home, path.join(home, 'jobs', lane)) || transcripts(home).find((t) => t.name.startsWith(lane))?.file || null : null)],
  ];
  for (const [source, find] of byId) {
    const file = find();
    const r = file && measureFile(file, source);
    if (r) return r;
  }
  const rootKey = cwdKey(root);
  const foreign = (cwd) => {
    const k = cwdKey(cwd);
    return k !== rootKey && !k.startsWith(`${rootKey}/`);
  };
  let checked = 0;
  for (const t of transcripts(home)) {
    if (++checked > MAX_FILES) break;
    const r = measureFile(t.file, 'newest', foreign);
    if (!r || !r.cwd || foreign(r.cwd)) continue;
    return r;
  }
  return { why: `no transcript of ${root} under ${path.join(home, 'projects')}` };
}

// { used, window, pct, sessionId, transcript, source } or { unknown: why }. phase: a normalized id; the lane
// supervisor.json records for it is the third way to find the transcript (see findUsage).
export function measureContext({ root, phase = null, window, env = process.env }) {
  const w = Number(window);
  if (!Number.isFinite(w) || w <= 0) return { unknown: 'context_window in .planning/turbo/config.json is not a positive number' };
  const rec = phase ? readJson(path.join(runDir(root), 'supervisor.json'), null)?.lane : null;
  const lane = rec && String(rec.phase) === String(phase) && typeof rec.sessionId === 'string' ? rec.sessionId : '';
  const r = findUsage({ root, home: claudeHome(env), env, lane });
  if (r.why) return { unknown: r.why };
  return { used: r.used, window: w, pct: Math.floor((r.used * 100) / w), sessionId: r.sessionId, transcript: r.transcript, source: r.source };
}
