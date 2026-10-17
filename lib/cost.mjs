import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { normalizePhaseId } from './gsd.mjs';
import { claudeHome, logsDir, runDir as runDirOf } from './paths.mjs';
import { findPhaseDir, planFileNames } from './phase-files.mjs';
import { readProgress } from './phase-progress.mjs';
import { agentIndex, harnessNotificationText, laneSessionIds, laneTranscript, projectDirs, readMeta, sessionTranscripts } from './transcripts.mjs';

// Stage 6 M (spec §7): how long a phase took and how many tokens it used, by step and role, for both phase paths.
// Path B (the build path): run/cost-p<N>.json, one record per headless session (recordSessionUsage). Path L (lanes):
// the phase's lane transcripts and their subagents. Both are merged into one cost object.

// ≈IEU, input-equivalent units: Anthropic's price ratios. Every cache write weighs 1.25 (the 1h cache's ×2 is not
// used: the build path's usage has no 1h split, and both paths must be on one scale).
export const IEU_WEIGHTS = Object.freeze({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
// A gap between two transcript entries counts at most this long (an idle session is not working).
export const GAP_CAP_MS = 5 * 60 * 1000;

const USAGE_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
const PHASE_RE = /^[A-Za-z0-9._-]+$/;
const LABEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

// IEU of one usage, or of summed fields: never a sum of rounded parts.
export function ieuOf(usage) {
  const u = isObj(usage) ? usage : {};
  const [input, write, read, output] = USAGE_FIELDS.map((k) => count(u[k]));
  return Math.round(input * IEU_WEIGHTS.input + write * IEU_WEIGHTS.cacheWrite + read * IEU_WEIGHTS.cacheRead + output * IEU_WEIGHTS.output);
}

// Calls fn with every non-empty line of a file, in order, reading `chunk` bytes at a time: the bytes are split on
// '\n' and each whole line is decoded on its own (a multi-byte character cut by a chunk boundary stays whole), a
// trailing '\r' is dropped, and a last line without its newline counts. A long transcript is never one string.
export function eachLine(file, fn, { chunk = 1024 * 1024 } = {}) {
  const emit = (bytes) => {
    let line = bytes.toString('utf8');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line) fn(line);
  };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(chunk);
    let carry = [];
    for (;;) {
      const got = fs.readSync(fd, buf, 0, chunk, null);
      if (!got) break;
      const view = buf.subarray(0, got);
      let start = 0;
      for (let nl = view.indexOf(0x0a); nl !== -1; nl = view.indexOf(0x0a, start)) {
        emit(carry.length ? Buffer.concat([...carry, view.subarray(start, nl)]) : view.subarray(start, nl));
        carry = [];
        start = nl + 1;
      }
      if (start < got) carry.push(Buffer.from(view.subarray(start)));
    }
    if (carry.length) emit(Buffer.concat(carry));
  } finally {
    fs.closeSync(fd);
  }
}

// The step `turbo-run phase-step` printed last in a text ('phase 3: next plan (done: …)', 'phase 3: prep next
// discuss'), or null: none printed, or `next none` (the phase has no step left: the step so far stays).
export function turboStepOf(text) {
  const hits = [...String(text ?? '').matchAll(/\bphase \S+: (?:prep )?next ([a-z-]+)/g)];
  const step = hits.at(-1)?.[1] ?? null;
  return step === 'none' ? null : step;
}

// The background job ids supervisor.log names for a phase, in first-seen order: its own launches and adoptions
// (`launch|adopt phase N session <id>`) and those of its prep lane (`lane prep-N`). Phase ids compare normalized
// ('03' is 3; 30 and 3.1 are not). Wake, annotate and failure lines never count.
const LAUNCH_RE = /^\S+ (?:launch|adopt) (?:phase (\S+)|lane prep-(\S+)) session ([A-Za-z0-9_-]{1,64})\b/;
export function laneJobIds(logText, phase) {
  const want = normalizePhaseId(phase);
  const ids = [];
  for (const line of String(logText ?? '').split(/\r?\n/)) {
    const m = LAUNCH_RE.exec(line);
    if (m && normalizePhaseId(m[1] ?? m[2]) === want && !ids.includes(m[3])) ids.push(m[3]);
  }
  return ids;
}

const costFile = (runDir, phase) => path.join(runDir, `cost-p${phase}.json`);

// The first field of a session record that is not valid, as '<field> <why>', or null.
function badField({ step, role, sessionId, usage, wallMs }) {
  if (typeof step !== 'string' || !LABEL_RE.test(step)) return 'step must match [A-Za-z0-9._:-]{1,64}';
  if (typeof role !== 'string' || !LABEL_RE.test(role)) return 'role must match [A-Za-z0-9._:-]{1,64}';
  if (sessionId !== null && (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId))) return 'sessionId must be null or match [A-Za-z0-9_-]{1,64}';
  if (!isObj(usage)) return 'usage must be an object';
  for (const k of USAGE_FIELDS) if (usage[k] !== undefined && !(Number.isFinite(usage[k]) && usage[k] >= 0)) return `usage.${k} must be a finite number >= 0`;
  if (!(Number.isFinite(wallMs) && wallMs >= 0)) return 'wallMs must be a finite number >= 0';
  return null;
}

// Appends one headless session's usage to run/cost-p<N>.json and returns the record written. Synchronous and without a
// lock: one writer per phase (the build process). A file that does not parse counts as empty. A bad value throws a
// TypeError naming the field before anything is written.
export function recordSessionUsage(runDir, phase, { step, role, sessionId = null, usage, wallMs }, { now = new Date() } = {}) {
  if (!PHASE_RE.test(String(phase ?? ''))) throw new TypeError(`cost record: phase must match [A-Za-z0-9._-]+ (got ${JSON.stringify(phase)})`);
  const why = badField({ step, role, sessionId, usage, wallMs });
  if (why) throw new TypeError(`cost record: ${why}`);
  const id = normalizePhaseId(phase);
  const record = { step, role, sessionId, usage: Object.fromEntries(USAGE_FIELDS.map((k) => [k, usage[k] ?? 0])), wallMs, at: now.toISOString() };
  const file = costFile(runDir, id);
  const raw = readJson(file, null);
  const sessions = isObj(raw) && Array.isArray(raw.sessions) ? raw.sessions : [];
  writeJsonAtomic(file, { v: 1, phase: id, sessions: [...sessions, record] });
  return record;
}

// A per-(step, role) accumulator: summed usage fields, time, its sessions and its first moment.
const newRow = (step, role) => ({ step, role, in: 0, cc: 0, cr: 0, out: 0, wallMs: 0, sessions: 0, firstMs: Infinity });
const addUsage = (acc, u) => {
  acc.in += count(u.input_tokens);
  acc.cc += count(u.cache_creation_input_tokens);
  acc.cr += count(u.cache_read_input_tokens);
  acc.out += count(u.output_tokens);
};
const rowKey = (step, role) => `${step}\0${role}`;
const rowOf = (rows, step, role) => {
  const key = rowKey(step, role);
  if (!rows.has(key)) rows.set(key, newRow(step, role));
  return rows.get(key);
};

// The total length of a set of [start, end] intervals, overlaps counted once.
function unionMs(intervals) {
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of [...intervals].sort((x, y) => x[0] - y[0])) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

// Path B: the valid records of run/cost-p<N>.json. rows: per (step, role) the summed fields and session time, sessions
// = distinct session ids (a null one counts alone); wall clock (total and per step) = the union of [at - wallMs, at].
function buildSource(runDir, phase) {
  const raw = readJson(costFile(runDir, phase), null);
  const records = (isObj(raw) && Array.isArray(raw.sessions) ? raw.sessions : [])
    .filter((r) => isObj(r) && badField({ ...r, sessionId: r.sessionId ?? null }) === null && Number.isFinite(Date.parse(r.at)));
  const rows = new Map();
  const ids = new Map();
  const spans = new Map();
  const all = new Set();
  let anonymous = 0;
  for (const r of records) {
    const end = Date.parse(r.at);
    const start = end - r.wallMs;
    const row = rowOf(rows, r.step, r.role);
    addUsage(row, r.usage);
    row.wallMs += r.wallMs;
    row.firstMs = Math.min(row.firstMs, start);
    const key = rowKey(r.step, r.role);
    if (!ids.has(key)) ids.set(key, new Set());
    const sid = r.sessionId ?? `\0${anonymous++}`;
    ids.get(key).add(sid);
    all.add(sid);
    if (!spans.has(r.step)) spans.set(r.step, []);
    spans.get(r.step).push([start, end]);
  }
  for (const [key, set] of ids) rows.get(key).sessions = set.size;
  const stepWall = new Map([...spans].map(([step, list]) => [step, unionMs(list)]));
  return {
    rows,
    stepWall,
    stepFirst: new Map([...spans].map(([step, list]) => [step, list.reduce((m, x) => Math.min(m, x[0]), Infinity)])),
    wallMs: unionMs([...spans.values()].flat()),
    sessions: all.size,
    records: records.length,
    fixers: records.filter((r) => r.role === 'fixer').length,
  };
}

const fileKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const mtimeOf = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

// The transcripts of a phase's lane sessions (path L). Sessions: the job ids supervisor.log names for the phase
// (laneJobIds), each resolved through turbo's transcript layer: every transcript of every id the job is known by
// (laneSessionIds: the job id, the session ids its job state names, the one laneTranscript finds), in the project's
// transcript directories and the one laneTranscript found it in. mains: oldest first (a woken lane's later transcript
// repeats the earlier one's history: the earlier owns it). agents: every subagent transcript of those sessions, the
// shallow ones first (a nested agent takes its parent's step), then by age.
// { mains: [{ file, sessionId, mtimeMs }], agents: [{ file, sessionId, meta }] }
export function laneTranscripts({ home, root, phase }) {
  let log = '';
  try {
    log = fs.readFileSync(path.join(logsDir(root), 'supervisor.log'), 'utf8');
  } catch { /* no log: no lane session */ }
  const base = projectDirs(home, root);
  const mains = new Map();
  for (const jobId of laneJobIds(log, phase)) {
    const lane = laneTranscript({ home, root, jobId });
    const dirs = lane ? [...base, path.dirname(lane.file)] : base;
    for (const id of laneSessionIds({ home, root, jobId })) {
      for (const t of sessionTranscripts(dirs, id)) {
        if (!mains.has(fileKey(t.file))) mains.set(fileKey(t.file), { file: t.file, sessionId: t.sessionId, mtimeMs: t.mtimeMs });
      }
    }
  }
  const list = [...mains.values()].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const ids = new Set(list.map((m) => m.sessionId));
  const dirs = [...new Map(list.map((m) => [fileKey(path.dirname(m.file)), path.dirname(m.file)])).values()];
  const agents = new Map();
  for (const found of agentIndex(dirs).values()) {
    for (const c of found) {
      if (ids.has(c.sessionId) && !agents.has(fileKey(c.file))) agents.set(fileKey(c.file), { file: c.file, sessionId: c.sessionId, meta: readMeta(c.file), mtimeMs: mtimeOf(c.file) });
    }
  }
  const depth = (a) => (Number.isFinite(Number(a.meta.spawnDepth)) && a.meta.spawnDepth !== null ? Number(a.meta.spawnDepth) : 1);
  return {
    mains: list,
    agents: [...agents.values()].sort((a, b) => depth(a) - depth(b) || a.mtimeMs - b.mtimeMs).map(({ file, sessionId, meta }) => ({ file, sessionId, meta })),
  };
}

// A skill or slash command that names a step: GSD's and turbo's own ('/gsd:execute-phase' is gsd-execute-phase).
function stepSkill(raw) {
  const name = /^[A-Za-z0-9._:-]+/.exec(String(raw ?? '').trim().replace(/^\//, '').replace(/^gsd:/, 'gsd-'))?.[0] ?? '';
  return /^(?:gsd|turbo)-/.test(name) ? name : null;
}
const blocksText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n') : '');

// A main-thread user entry that is a prompt (a wake, the owner's message, a slash command): the time before it is a
// wait, not work. Tool results, harness notifications, meta and compaction entries are not prompts.
function isPrompt(e, text, hasResult) {
  if (e.isMeta || e.isCompactSummary || e.toolUseResult !== undefined || hasResult || harnessNotificationText(e) !== null) return false;
  const t = text.trimStart();
  return t.startsWith('<command-name>') || (t !== '' && !t.startsWith('<') && !t.startsWith('['));
}

// Path L: every API call and every gap between entries of the phase's lane transcripts, each attributed to a (step,
// role). Each call counts once (by message id) and each user entry once (by uuid), across all files: a woken lane's
// transcript replays its history, which still updates the labels but counts nothing. Time: per transcript, the gap
// before each entry, at most GAP_CAP_MS, goes to that entry's row, except a gap that ends at a prompt; the total and
// the steps are the same over the merged entries of all transcripts.
function laneSource({ home, root, phase }) {
  const { mains, agents } = laneTranscripts({ home, root, phase });
  const seenCalls = new Set();
  const seenUsers = new Set();
  const spawnStep = new Map();
  const rows = new Map();
  const callers = new Map();
  const merged = [];
  let read = 0;
  let sessions = 0;
  const readOne = (file, main, agentStep, role) => {
    let turboStep = null;
    let skill = null;
    const stepCalls = new Set();
    const label = () => (main ? turboStep ?? skill ?? '-' : agentStep);
    const events = [];
    let called = false;
    try {
      eachLine(file, (line) => {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        if (!isObj(e) || (e.type !== 'user' && e.type !== 'assistant')) return;
        const ms = Date.parse(e.timestamp);
        const content = Array.isArray(e.message?.content) ? e.message.content : [];
        if (e.type === 'assistant') {
          for (const b of content) {
            if (b?.type !== 'tool_use') continue;
            if (main && b.name === 'Skill') skill = stepSkill(b.input?.skill) ?? skill;
            if (main && b.name === 'Bash' && /phase-step/.test(String(b.input?.command ?? ''))) stepCalls.add(b.id);
            if ((b.name === 'Agent' || b.name === 'Task') && typeof b.id === 'string') spawnStep.set(b.id, label());
          }
          const msg = e.message;
          if (!isObj(msg?.usage) || msg.model === '<synthetic>' || (msg.id && seenCalls.has(msg.id))) return;
          if (msg.id) seenCalls.add(msg.id);
          const step = label();
          const row = rowOf(rows, step, role);
          addUsage(row, msg.usage);
          if (Number.isFinite(ms)) row.firstMs = Math.min(row.firstMs, ms);
          const key = rowKey(step, role);
          if (!callers.has(key)) callers.set(key, new Set());
          callers.get(key).add(file);
          called = true;
          if (Number.isFinite(ms)) events.push({ ms, step, prompt: false });
          return;
        }
        const step = label();
        const fresh = !(e.uuid && seenUsers.has(e.uuid));
        if (e.uuid) seenUsers.add(e.uuid);
        const results = content.filter((b) => b?.type === 'tool_result');
        if (main) {
          for (const b of results) {
            if (!stepCalls.has(b.tool_use_id)) continue;
            turboStep = turboStepOf(typeof b.content === 'string' ? b.content : blocksText(b.content)) ?? turboStep;
          }
        }
        const text = blocksText(e.message?.content);
        if (main && !results.length) {
          const command = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text);
          if (command) skill = stepSkill(command[1]) ?? skill;
        }
        if (fresh && Number.isFinite(ms)) events.push({ ms, step, prompt: main && isPrompt(e, text, results.length > 0) });
      });
    } catch {
      return; // unreadable: skipped
    }
    read++;
    if (called) sessions++;
    events.sort((a, b) => a.ms - b.ms);
    for (let i = 1; i < events.length; i++) {
      if (events[i].prompt) continue;
      const row = rowOf(rows, events[i].step, role);
      row.wallMs += Math.min(events[i].ms - events[i - 1].ms, GAP_CAP_MS);
      row.firstMs = Math.min(row.firstMs, events[i].ms);
    }
    merged.push(...events);
  };
  for (const m of mains) readOne(m.file, true, null, 'orchestrator');
  for (const a of agents) readOne(a.file, false, spawnStep.get(a.meta.toolUseId) ?? '?', String(a.meta.agentType || 'unknown'));
  for (const [key, files] of callers) rows.get(key).sessions = files.size;
  merged.sort((a, b) => a.ms - b.ms);
  const stepWall = new Map();
  const stepFirst = new Map();
  let wallMs = 0;
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].prompt) continue;
    const gap = Math.min(merged[i].ms - merged[i - 1].ms, GAP_CAP_MS);
    const { step, ms } = merged[i];
    wallMs += gap;
    stepWall.set(step, (stepWall.get(step) ?? 0) + gap);
    if (!stepFirst.has(step)) stepFirst.set(step, ms);
  }
  return { rows, stepWall, stepFirst, wallMs, sessions, read };
}

// The phase's PLAN files (the slices of either path); 0 without a phase directory.
function sliceCount(root, phase) {
  try {
    const dir = findPhaseDir(root, phase);
    return dir ? planFileNames(dir).length : 0;
  } catch {
    return 0;
  }
}

const shown = (acc) => ({ out: acc.out, inCreate: acc.in + acc.cc, cacheRead: acc.cr, ieu: ieuOf({ input_tokens: acc.in, cache_creation_input_tokens: acc.cc, cache_read_input_tokens: acc.cr, output_tokens: acc.out }) });

// Merges the sources into the cost object: rows ordered by their first moment, then step, then role; steps in the
// order they first appear; total over everything. Wall clock of the total and of each step: lane + build.
function merge(phase, sources) {
  const rows = new Map();
  const steps = new Map();
  const total = newRow('', '');
  let wallMs = 0;
  let sessions = 0;
  for (const src of sources) {
    for (const [key, r] of src.rows) {
      if (!rows.has(key)) rows.set(key, newRow(r.step, r.role));
      const m = rows.get(key);
      for (const f of ['in', 'cc', 'cr', 'out', 'wallMs', 'sessions']) m[f] += r[f];
      m.firstMs = Math.min(m.firstMs, r.firstMs);
      if (!steps.has(r.step)) steps.set(r.step, { ...newRow(r.step, ''), wallMs: 0 });
      const s = steps.get(r.step);
      for (const f of ['in', 'cc', 'cr', 'out']) s[f] += r[f];
      s.firstMs = Math.min(s.firstMs, r.firstMs);
      for (const f of ['in', 'cc', 'cr', 'out']) total[f] += r[f];
    }
    for (const [step, ms] of src.stepWall) {
      if (!steps.has(step)) steps.set(step, newRow(step, ''));
      steps.get(step).wallMs += ms;
      steps.get(step).firstMs = Math.min(steps.get(step).firstMs, src.stepFirst.get(step) ?? Infinity);
    }
    wallMs += src.wallMs;
    sessions += src.sessions;
  }
  const order = (a, b) => a.firstMs - b.firstMs || a.step.localeCompare(b.step) || a.role.localeCompare(b.role);
  return {
    phase,
    rows: [...rows.values()].sort(order).map((r) => ({ step: r.step, role: r.role, sessions: r.sessions, wallMs: r.wallMs, ...shown(r) })),
    total: { sessions, wallMs, ...shown(total) },
    steps: [...steps.values()].sort(order).map((s) => ({ step: s.step, wallMs: s.wallMs, ieu: shown(s).ieu })),
  };
}

// The cost of phase N: { phase, rows: [{ step, role, sessions, wallMs, out, inCreate, cacheRead, ieu }], total,
// steps: [{ step, wallMs, ieu }], sources: { lane, build } (transcripts read, valid records), slices, fixRounds }.
// slices: the phase's PLAN files; fixRounds: the build path's fixer sessions, else the lane's --attempt fix count.
// Missing files read as no data; it never writes.
export function phaseCost({ root, phase, env = process.env }) {
  if (!PHASE_RE.test(String(phase ?? ''))) throw new TypeError(`phase cost: phase must match [A-Za-z0-9._-]+ (got ${JSON.stringify(phase)})`);
  const id = normalizePhaseId(phase);
  const lane = laneSource({ home: claudeHome(env), root, phase: id });
  const build = buildSource(runDirOf(root), id);
  const cost = merge(id, [lane, build]);
  let fixRounds = build.fixers;
  if (!build.records) {
    try {
      fixRounds = readProgress(root, id).attempts.fix ?? 0;
    } catch {
      fixRounds = 0;
    }
  }
  return { ...cost, sources: { lane: lane.read, build: build.records }, slices: sliceCount(root, id), fixRounds };
}
