import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './fsx.mjs';
import { dirKey } from './paths.mjs';
import { maskSecrets } from './secrets.mjs';

// Session ids, their prefixes and agent ids only ever name files inside a transcript directory.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Claude Code cuts longer directory names at 200 characters and appends a hash of its own.
const KEY_MAX = 200;

const listNames = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const listDirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };
const statOf = (file) => { try { return fs.statSync(file); } catch { return null; } };

// Claude Code's directory name for a project under <claude-home>/projects: every character other than an
// ASCII letter or digit becomes '-'.
export function projectKey(dir) {
  return String(dir).replace(/[^A-Za-z0-9]/g, '-');
}

// The transcript directories of a project: one per spelling of its root (as resolved, and its real path), each
// only when it exists. A key longer than 200 characters matches every directory named with its first 200 and a
// '-' (Claude Code's hash suffix follows).
export function projectDirs(home, root) {
  const base = path.join(home, 'projects');
  const spellings = new Set([path.resolve(root)]);
  try { spellings.add(fs.realpathSync.native(root)); } catch { /* a missing root keeps its resolved spelling */ }
  const found = new Map();
  const add = (dir) => {
    if (!statOf(dir)?.isDirectory()) return;
    let real = dir;
    try { real = fs.realpathSync.native(dir); } catch { /* keep the joined path */ }
    found.set(process.platform === 'win32' ? real.toLowerCase() : real, dir);
  };
  for (const key of [...spellings].map(projectKey)) {
    if (key.length <= KEY_MAX) add(path.join(base, key));
    else for (const n of listNames(base)) if (n.startsWith(`${key.slice(0, KEY_MAX)}-`)) add(path.join(base, n));
  }
  return [...found.values()];
}

// The transcripts of one session, newest first: <dir>/<id>.jsonl whose name starts with sessionId, the full id or
// the prefix claude --bg printed (supervisor.json lane.sessionId). [{ file, sessionId, mtimeMs, size }].
export function sessionTranscripts(dirs, sessionId) {
  if (!SAFE_ID.test(String(sessionId))) return [];
  const found = [];
  for (const dir of dirs) {
    for (const n of listNames(dir)) {
      if (!n.endsWith('.jsonl') || !n.startsWith(sessionId)) continue;
      const file = path.join(dir, n);
      const st = statOf(file);
      if (st?.isFile()) found.push({ file, sessionId: n.slice(0, -'.jsonl'.length), mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Every project directory under <claude-home>/projects.
export function allProjectDirs(home) {
  const base = path.join(home, 'projects');
  return listDirs(base).map((n) => path.join(base, n));
}

// Every subagent transcript of the project: agentId -> [{ file, sessionId }], from
// <dir>/<session>/subagents/agent-<id>.jsonl in every session directory.
export function agentIndex(dirs) {
  const index = new Map();
  for (const dir of dirs) {
    for (const session of listDirs(dir)) {
      const sub = path.join(dir, session, 'subagents');
      for (const n of listNames(sub)) {
        const m = /^agent-([A-Za-z0-9_-]{1,64})\.jsonl$/.exec(n);
        if (!m) continue;
        if (!index.has(m[1])) index.set(m[1], []);
        index.get(m[1]).push({ file: path.join(sub, n), sessionId: session });
      }
    }
  }
  return index;
}

// The subagent's meta file (agentType, description, model, worktreeBranch, spawnDepth); {} when absent or broken.
export function readMeta(file) {
  const m = readJson(file.replace(/\.jsonl$/, '.meta.json'), null);
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

// The newest transcript of a subagent in any session directory of the project: a session fork moves a running
// subagent's transcript into the new session's directory. The output_file a notification names is never used.
// Returns { file, sessionId, mtimeMs, size, meta } or null.
export function findAgentTranscript(dirs, agentId, index = null) {
  if (!SAFE_ID.test(String(agentId))) return null;
  let best = null;
  for (const c of (index || agentIndex(dirs)).get(agentId) || []) {
    const st = statOf(c.file);
    if (st?.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { ...c, mtimeMs: st.mtimeMs, size: st.size };
  }
  return best && { ...best, meta: readMeta(best.file) };
}

// What one refresh parses of a transcript: its tail, at most this many bytes (spec §4).
export const TAIL_MAX = 256 * 1024;
const DETAIL_MAX = 80;
// Input fields that describe a tool call, most telling first: a file path, else the start of a command or pattern.
const DETAIL_KEYS = ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'skill', 'description', 'prompt'];
const PATH_KEYS = new Set(['file_path', 'notebook_path', 'path']);

const parseLine = (line) => {
  if (!line.trim()) return null;
  try {
    const e = JSON.parse(line);
    return e && typeof e === 'object' && !Array.isArray(e) ? e : null;
  } catch {
    return null;
  }
};

function readSlice(file, from, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const got = fs.readSync(fd, buf, 0, length, from);
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

// The entries of the last `max` bytes of a transcript, oldest first: a line the window starts inside is dropped, and
// lines that do not parse are skipped. Returns { entries, read } (read: bytes read).
export function tailEntries(file, { max = TAIL_MAX } = {}) {
  const size = fs.statSync(file).size;
  const n = Math.min(size, max);
  const buf = readSlice(file, size - n, n);
  const lines = buf.toString('utf8').split('\n');
  if (n < size) lines.shift();
  return { entries: lines.map(parseLine).filter(Boolean), read: buf.length };
}

// The first entry of a transcript, read from at most `max` bytes; null when its line is longer or does not parse.
export function headEntry(file, { max = TAIL_MAX } = {}) {
  const buf = readSlice(file, 0, Math.min(fs.statSync(file).size, max));
  const end = buf.indexOf(0x0a);
  if (end < 0 && buf.length === max) return null;
  return parseLine(buf.subarray(0, end < 0 ? buf.length : end).toString('utf8'));
}

// Context in use after an assistant message: the prompt side of its usage, cache included (spec §4); null without.
export function contextTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);
  return n > 0 ? n : null;
}

// A file path relative to the root when it lies inside it, with forward slashes; any other path as written.
function shownPath(p, root) {
  if (!root) return p.replace(/\\/g, '/');
  const rel = path.relative(root, path.resolve(root, p));
  if (!rel) return '.';
  const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return (outside ? p : rel).replace(/\\/g, '/');
}

// A tool call in short (spec §4): { tool, detail }. detail is the first describing input field, whitespace collapsed,
// secrets masked, at most 80 characters (a path keeps its end, anything else its start).
export function actionOf(toolUse, root = '') {
  const input = toolUse?.input && typeof toolUse.input === 'object' ? toolUse.input : {};
  const key = DETAIL_KEYS.find((k) => typeof input[k] === 'string' && input[k].trim());
  const isPath = PATH_KEYS.has(key);
  let detail = key ? input[key] : '';
  if (isPath) detail = shownPath(detail, root);
  detail = maskSecrets(detail.replace(/\s+/g, ' ').trim());
  if (detail.length > DETAIL_MAX) detail = isPath ? `…${detail.slice(-(DETAIL_MAX - 1))}` : `${detail.slice(0, DETAIL_MAX - 1)}…`;
  return { tool: String(toolUse?.name || '?').slice(0, 40), detail };
}

// The plan and task a GSD dispatch description names: "Execute plan 07 of phase 32" -> 32-07, "Continue plan 32-07
// from Task 2" -> 32-07 and task 2. null where it names none.
export function planOf(description) {
  const d = typeof description === 'string' ? description : '';
  const full = /\bplan\s+(\d+(?:\.\d+)*[A-Z]?-\d+[A-Za-z]?)\b/i.exec(d);
  const short = full ? null : /\bplan\s+(\d+[A-Za-z]?)\s+of\s+phase\s+(\d+(?:\.\d+)*[A-Z]?)\b/i.exec(d);
  const task = /\btask\s+(\d+)\b/i.exec(d);
  return { plan: full ? full[1] : short ? `${short[2]}-${short[1]}` : null, task: task ? task[1] : null };
}

// The newest-transcript fallback of findTranscript: how many transcripts it looks at, newest first, and how far back it
// reads one for a cwd (the window grows past a long last line).
const CWD_SCAN_MAX = 50;
const CWD_TAIL_MAX = 16 * 1024 * 1024;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Git Bash spells a Windows path /c/Users/…; on win32 that is C:/Users/…. Backslashes become slashes.
export function normalCwd(cwd, platform = process.platform) {
  const s = String(cwd ?? '').replace(/\\/g, '/');
  return platform === 'win32' ? s.replace(/^\/([A-Za-z])(\/|$)/, (m, d) => `${d.toUpperCase()}:/`) : s;
}

// True when a transcript's cwd is the root or a directory inside it: Bash in a session may have moved below the root.
export function cwdInside(cwd, root) {
  if (typeof cwd !== 'string' || !cwd) return false;
  const c = dirKey(normalCwd(cwd));
  const r = dirKey(root);
  return c === r || c.startsWith(r.endsWith('/') ? r : `${r}/`);
}

// A background job's state as Claude Code keeps it: <claude-home>/jobs/<job id>/state.json; null when absent.
export function jobState(home, jobId) {
  if (!SAFE_ID.test(String(jobId))) return null;
  const s = readJson(path.join(home, 'jobs', String(jobId), 'state.json'), null);
  return isObj(s) ? s : null;
}

// A session's transcript by its id (exact: <id>.jsonl) or, for a job id, by prefix: the project's own directories
// first, then every project directory. { file, sessionId, mtimeMs, size } or null.
function bySession(home, root, id, { prefix = false } = {}) {
  const pick = (dirs) => sessionTranscripts(dirs, id).find((t) => prefix || t.sessionId === id) || null;
  return pick(projectDirs(home, root)) || pick(allProjectDirs(home));
}

// The transcript a job's state names: its linkScanPath when that is an existing file under <claude-home>/projects/,
// else the transcript of its resumeSessionId, else of its sessionId. A job woken or resumed may write another
// transcript than the one its id prefixes; that older file stays on disk.
function jobTranscript(state, home, root) {
  const projects = `${path.resolve(home, 'projects')}${path.sep}`;
  const under = (p) => (process.platform === 'win32' ? p.toLowerCase().startsWith(projects.toLowerCase()) : p.startsWith(projects));
  const link = typeof state.linkScanPath === 'string' ? path.resolve(state.linkScanPath) : '';
  if (link.endsWith('.jsonl') && under(link) && statOf(link)?.isFile()) return { file: link, sessionId: path.basename(link, '.jsonl'), via: 'job-link' };
  for (const id of [state.resumeSessionId, state.sessionId]) {
    const hit = typeof id === 'string' && SAFE_ID.test(id) ? bySession(home, root, id) : null;
    if (hit) return { file: hit.file, sessionId: hit.sessionId, via: 'job-session' };
  }
  return null;
}

// A lane's transcript, read from outside the lane (supervisor, view). jobId is supervisor.json lane.sessionId: the
// background job id claude --bg printed. The job's state.json decides first; without one, the newest transcript whose
// name starts with the job id. No cwd check: an id decides. { file, sessionId, via } (via: job-link, job-session or
// job-prefix) or null.
export function laneTranscript({ home, root, jobId }) {
  if (!SAFE_ID.test(String(jobId))) return null;
  const state = jobState(home, jobId);
  const fromJob = state ? jobTranscript(state, home, root) : null;
  if (fromJob) return fromJob;
  const hit = bySession(home, root, String(jobId), { prefix: true });
  return hit ? { file: hit.file, sessionId: hit.sessionId, via: 'job-prefix' } : null;
}

// The newest main-chain cwd of a transcript, read from its end; null when none lies within CWD_TAIL_MAX.
function lastCwd(file) {
  const size = fs.statSync(file).size;
  for (let max = TAIL_MAX; ; max *= 4) {
    const { entries } = tailEntries(file, { max });
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.isSidechain !== true && typeof e.cwd === 'string' && e.cwd) return e.cwd;
    }
    if (max >= size || max >= CWD_TAIL_MAX) return null;
  }
}

// The transcript to read for the calling session or for a lane, the most exact source first:
// session: CLAUDE_CODE_SESSION_ID, which Claude Code sets in a session's Bash tool to its transcript's id;
// job: the state of the background job in CLAUDE_JOB_DIR (the calling job's current transcript);
// lane: laneTranscript of the given job id (supervisor.json lane.sessionId);
// newest: the newest transcript whose newest main-chain cwd is the root or inside it.
// A transcript found by an id is taken whatever its cwd. { file, sessionId, via } (via: the source's name) or null.
export function findTranscript({ home, root, env = process.env, lane = '' }) {
  const own = String(env.CLAUDE_CODE_SESSION_ID ?? '');
  const mine = SAFE_ID.test(own) ? bySession(home, root, own) : null;
  if (mine) return { file: mine.file, sessionId: mine.sessionId, via: 'session' };
  if (env.CLAUDE_JOB_DIR) {
    const state = readJson(path.join(path.resolve(String(env.CLAUDE_JOB_DIR)), 'state.json'), null);
    const fromJob = isObj(state) ? jobTranscript(state, home, root) : null;
    if (fromJob) return { file: fromJob.file, sessionId: fromJob.sessionId, via: 'job' };
  }
  const fromLane = lane ? laneTranscript({ home, root, jobId: lane }) : null;
  if (fromLane) return { file: fromLane.file, sessionId: fromLane.sessionId, via: 'lane' };
  const files = allProjectDirs(home).flatMap((dir) => listNames(dir).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n)));
  const newest = files.map((file) => ({ file, st: statOf(file) })).filter((f) => f.st?.isFile()).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, CWD_SCAN_MAX);
  for (const { file } of newest) {
    let cwd = null;
    try {
      cwd = lastCwd(file);
    } catch {
      continue; // gone meanwhile
    }
    if (cwdInside(cwd, root)) return { file, sessionId: path.basename(file, '.jsonl'), via: 'newest' };
  }
  return null;
}
