import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureDir, readJson, writeJsonAtomic } from './fsx.mjs';
import { sessionFreeEnv } from './claude.mjs';
import { normalizePhaseId } from './gsd.mjs';
import { claudeHome, dirKey, logsDir, runDir as runDirOf } from './paths.mjs';
import { findPhaseDir, planFileNames } from './phase-files.mjs';
import { readProgress } from './phase-progress.mjs';
import { agentIndex, harnessNotificationText, laneSessionIds, laneTranscript, projectDirs, readMeta, sessionById, sessionTranscripts } from './transcripts.mjs';

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
    // fix rounds: fixer sessions (a resumed one keeps its id and is one round); a null id counts alone
    fixers: new Set(records.filter((r) => r.role === 'fixer').map((r, i) => r.sessionId ?? `\0${i}`)).size,
  };
}

const logFile = (root) => path.join(logsDir(root), 'supervisor.log');
const readLog = (root) => {
  try {
    return fs.readFileSync(logFile(root), 'utf8');
  } catch {
    return ''; // no log: no lane session
  }
};
const fileKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const mtimeOf = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

// The session ids the supervisor logged for a phase's jobs before claude rm took their job state (lib/supervisor.mjs
// noteJob: `phase N job <id> sessions <id>,<id>`, `lane prep-N job …`): jobId -> Set. Without them a woken lane's later
// transcript would be lost with the job's state.
const JOB_RE = /^\S+ (?:phase (\S+)|lane prep-(\S+)) job ([A-Za-z0-9_-]{1,64}) sessions ([A-Za-z0-9_,-]+)$/;
function loggedSessions(logText, phase) {
  const want = normalizePhaseId(phase);
  const out = new Map();
  for (const line of String(logText ?? '').split(/\r?\n/)) {
    const m = JOB_RE.exec(line);
    if (!m || normalizePhaseId(m[1] ?? m[2]) !== want) continue;
    if (!out.has(m[3])) out.set(m[3], new Set());
    for (const id of m[4].split(',')) if (SESSION_RE.test(id)) out.get(m[3]).add(id);
  }
  return out;
}

// The transcripts of a phase's lane sessions (path L). Sessions: the job ids supervisor.log names for the phase
// (laneJobIds), each resolved through turbo's transcript layer: every transcript of every id the job is known by
// (laneSessionIds: the job id, the session ids its job state names, the one laneTranscript finds; and the ids the
// supervisor logged before it removed the job), in the project's transcript directories and the one laneTranscript
// found it in (a logged id elsewhere: in any project directory). mains: oldest first (a woken lane's later transcript
// repeats the earlier one's history: the earlier owns it). agents: every subagent transcript of those sessions, the
// shallow ones first (a nested agent takes its parent's step), then by age.
// { mains: [{ file, sessionId, mtimeMs }], agents: [{ file, sessionId, meta }] }
export function laneTranscripts({ home, root, phase }) {
  const log = readLog(root);
  const logged = loggedSessions(log, phase);
  const base = projectDirs(home, root);
  const mains = new Map();
  const add = (t) => {
    if (!mains.has(fileKey(t.file))) mains.set(fileKey(t.file), { file: t.file, sessionId: t.sessionId, mtimeMs: t.mtimeMs ?? mtimeOf(t.file) });
  };
  for (const jobId of laneJobIds(log, phase)) {
    const lane = laneTranscript({ home, root, jobId });
    const dirs = lane ? [...base, path.dirname(lane.file)] : base;
    for (const id of laneSessionIds({ home, root, jobId })) for (const t of sessionTranscripts(dirs, id)) add(t);
    for (const id of logged.get(jobId) ?? []) {
      const hits = sessionTranscripts(dirs, id).filter((t) => t.sessionId === id);
      const hit = hits.length ? null : sessionById({ home, root, sessionId: id });
      for (const t of hit ? [hit] : hits) add(t);
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
// The shell tools a lane may run turbo-run phase-step with (lib/liveness.mjs counts both as commands).
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// A main-thread user entry that is a prompt (a wake, the owner's message, a slash command, whose <command-name> often
// follows a <command-message>): the time before it is a wait, not work. Tool results, harness notifications, meta and
// compaction entries are not prompts.
function isPrompt(e, text, hasResult) {
  if (e.isMeta || e.isCompactSummary || e.toolUseResult !== undefined || hasResult || harnessNotificationText(e) !== null) return false;
  const t = text.trimStart();
  return t.includes('<command-name>') || (t !== '' && !t.startsWith('<') && !t.startsWith('['));
}

// Path L: every API call and every gap between entries of the phase's lane transcripts, each attributed to a (step,
// role). Each call counts once (by message id) and each user entry once (by uuid), across all files: a woken lane's
// transcript replays its history, which still updates the labels but counts nothing. Claude Code writes a message as
// one line per content block, and a subagent's earlier lines carry the usage streamed so far: a call counts each usage
// field's largest value over its lines (the last line's), and takes the step after its last line in the file it was
// first seen in. A main transcript starts with the step the one before it ended in (a woken lane that does not replay
// its history is still in its step). Time: per transcript, the gap before each entry, at most GAP_CAP_MS, goes to that
// entry's row, except a gap that ends at a prompt; the total and the steps are the same over the merged entries of all
// transcripts.
function laneSource({ home, root, phase }) {
  const { mains, agents } = laneTranscripts({ home, root, phase });
  const byId = new Map();
  const calls = [];
  const seenUsers = new Set();
  const spawnStep = new Map();
  const rows = new Map();
  const merged = [];
  const carried = { turboStep: null, skill: null };
  const stepOf = (ev) => (ev.call ? ev.call.step : ev.step);
  let read = 0;
  const readOne = (file, main, agentStep, role) => {
    const state = { ...carried };
    const stepCalls = new Set();
    const label = () => (main ? state.turboStep ?? state.skill ?? '-' : agentStep);
    const events = [];
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
            if (main && b.name === 'Skill') state.skill = stepSkill(b.input?.skill) ?? state.skill;
            if (main && SHELL_TOOLS.has(b.name) && /phase-step/.test(String(b.input?.command ?? ''))) stepCalls.add(b.id);
            if ((b.name === 'Agent' || b.name === 'Task') && typeof b.id === 'string') spawnStep.set(b.id, label());
          }
          const msg = e.message;
          if (!isObj(msg?.usage) || msg.model === '<synthetic>') return;
          const usage = Object.fromEntries(USAGE_FIELDS.map((k) => [k, count(msg.usage[k])]));
          const prev = msg.id ? byId.get(msg.id) : undefined;
          if (prev) {
            for (const k of USAGE_FIELDS) prev.usage[k] = Math.max(prev.usage[k], usage[k]);
            if (prev.file === file) prev.step = label();
            return;
          }
          const call = { file, role, step: label(), ms, usage };
          calls.push(call);
          if (msg.id) byId.set(msg.id, call);
          if (Number.isFinite(ms)) events.push({ ms, call, prompt: false });
          return;
        }
        const step = label();
        const fresh = !(e.uuid && seenUsers.has(e.uuid));
        if (e.uuid) seenUsers.add(e.uuid);
        const results = content.filter((b) => b?.type === 'tool_result');
        if (main) {
          for (const b of results) {
            if (!stepCalls.has(b.tool_use_id)) continue;
            state.turboStep = turboStepOf(typeof b.content === 'string' ? b.content : blocksText(b.content)) ?? state.turboStep;
          }
        }
        const text = blocksText(e.message?.content);
        if (main && !results.length) {
          const command = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text);
          if (command) state.skill = stepSkill(command[1]) ?? state.skill;
        }
        if (fresh && Number.isFinite(ms)) events.push({ ms, step, prompt: main && isPrompt(e, text, results.length > 0) });
      });
    } catch {
      return; // unreadable: skipped
    }
    read++;
    if (main) Object.assign(carried, state);
    events.sort((a, b) => a.ms - b.ms);
    for (let i = 1; i < events.length; i++) {
      if (events[i].prompt) continue;
      const row = rowOf(rows, stepOf(events[i]), role);
      row.wallMs += Math.min(events[i].ms - events[i - 1].ms, GAP_CAP_MS);
      row.firstMs = Math.min(row.firstMs, events[i].ms);
    }
    merged.push(...events);
  };
  for (const m of mains) readOne(m.file, true, null, 'orchestrator');
  for (const a of agents) readOne(a.file, false, spawnStep.get(a.meta.toolUseId) ?? '?', String(a.meta.agentType || 'unknown'));
  const callers = new Map();
  for (const c of calls) {
    const row = rowOf(rows, c.step, c.role);
    addUsage(row, c.usage);
    if (Number.isFinite(c.ms)) row.firstMs = Math.min(row.firstMs, c.ms);
    const key = rowKey(c.step, c.role);
    if (!callers.has(key)) callers.set(key, new Set());
    callers.get(key).add(c.file);
  }
  for (const [key, files] of callers) rows.get(key).sessions = files.size;
  merged.sort((a, b) => a.ms - b.ms);
  const stepWall = new Map();
  const stepFirst = new Map();
  let wallMs = 0;
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].prompt) continue;
    const gap = Math.min(merged[i].ms - merged[i - 1].ms, GAP_CAP_MS);
    const step = stepOf(merged[i]);
    wallMs += gap;
    stepWall.set(step, (stepWall.get(step) ?? 0) + gap);
    if (!stepFirst.has(step)) stepFirst.set(step, merged[i].ms);
  }
  return { rows, stepWall, stepFirst, wallMs, sessions: new Set(calls.map((c) => c.file)).size, read };
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

// A duration: <h>h<mm>m from one hour, else <m>m<ss>s (floored).
function dur(ms) {
  const s = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(s % 60).padStart(2, '0')}s`;
}

// A token count: n below 1000, <x.x>K below a million, else <x.xx>M (rounded half up).
function tok(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1000) return String(Math.round(v));
  const k = Math.round(v / 100) / 10;
  if (k < 1000) return `${k.toFixed(1)}K`;
  return `${(Math.round(v / 1e4) / 100).toFixed(2)}M`;
}

const pathOf = (cost) => (cost.sources?.build ? 'build' : 'lane');

// The phase's line for supervisor.log (spec §7, §5.6 item 4): path, wall clock, ≈IEU, sessions, slices, fix rounds
// and the time and ≈IEU of each step (the line stays after Claude Code removes the transcripts).
export function costLine(cost, { path: p = pathOf(cost) } = {}) {
  const head = `phase ${cost.phase} cost: path ${p} · wall ${dur(cost.total.wallMs)} · ≈IEU ${tok(cost.total.ieu)} · sessions ${cost.total.sessions} · slices ${cost.slices} · fix rounds ${cost.fixRounds}`;
  return cost.steps.length ? `${head} · steps: ${cost.steps.map((s) => `${s.step} ${dur(s.wallMs)} ${tok(s.ieu)}`).join(', ')}` : head;
}

// Columns two spaces apart: the first two left-aligned, the rest right-aligned.
function columns(lines) {
  const width = lines[0].map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  return lines.map((l) => l.map((c, i) => (i < 2 ? c.padEnd(width[i]) : c.padStart(width[i]))).join('  ').trimEnd());
}

function table(cost) {
  const cells = (r) => [String(r.sessions), dur(r.wallMs), tok(r.out), tok(r.inCreate), tok(r.cacheRead), tok(r.ieu)];
  return [
    `phase ${cost.phase} · path ${pathOf(cost)} · wall ${dur(cost.total.wallMs)} · ≈IEU ${tok(cost.total.ieu)}`,
    ...columns([
      ['step', 'role', 'sessions', 'time', 'out', 'in+create', 'cache read', '≈IEU'],
      ...cost.rows.map((r) => [r.step, r.role, ...cells(r)]),
      ['total', '', ...cells(cost.total)],
    ]),
    `steps: ${cost.steps.map((s) => `${s.step} ${dur(s.wallMs)} ${tok(s.ieu)}`).join(', ')}`,
    'time: each row adds up its sessions\' own time (parallel sessions add up); total and steps are wall clock. A gap counts at most 5 min; a wait for a prompt does not count.',
    '≈IEU = input + 1.25 × cache write + 0.1 × cache read + 5 × output',
  ];
}

function compareTable(a, b) {
  const key = (r) => rowKey(r.step, r.role);
  const inB = new Map(b.rows.map((r) => [key(r), r]));
  const inA = new Set(a.rows.map(key));
  const cells = (r) => (r ? [String(r.sessions), dur(r.wallMs), tok(r.ieu)] : ['-', '-', '-']);
  const ratio = (x, y) => (y > 0 ? `${Math.round((x / y) * 100)}%` : '-');
  return [
    `phase ${a.phase} (path ${pathOf(a)}) beside phase ${b.phase} (path ${pathOf(b)})`,
    ...columns([
      ['step', 'role', ...['sessions', 'time', '≈IEU'].map((c) => `${a.phase} ${c}`), ...['sessions', 'time', '≈IEU'].map((c) => `${b.phase} ${c}`)],
      ...a.rows.map((r) => [r.step, r.role, ...cells(r), ...cells(inB.get(key(r)))]),
      ...b.rows.filter((r) => !inA.has(key(r))).map((r) => [r.step, r.role, ...cells(null), ...cells(r)]),
      ['total', '', ...cells(a.total), ...cells(b.total)],
    ]),
    `phase ${a.phase} / phase ${b.phase}: wall ${ratio(a.total.wallMs, b.total.wallMs)} · ≈IEU ${ratio(a.total.ieu, b.total.ieu)}`,
  ];
}

// Why a phase has no cost data, in one line.
function noDataLine(root, cost) {
  const jobs = laneJobIds(readLog(root), cost.phase).length;
  const lane = !jobs ? 'no lane session in supervisor.log'
    : cost.sources.lane ? `no API call in the transcripts of its lane sessions (${jobs})`
      : `no transcript of its lane sessions (${jobs}; Claude Code keeps them about 30 days)`;
  const file = `cost-p${cost.phase}.json`;
  const build = fs.existsSync(path.join(runDirOf(root), file)) ? `no valid record in run/${file}` : `no run/${file}`;
  return `phase ${cost.phase}: no cost data: ${lane}, ${build}`;
}

// Measures the phase and appends its cost line to supervisor.log (the supervisor's detached `turbo-run cost N
// --log`); returns the line.
export function logPhaseCost({ root, phase, env = process.env, now = new Date() }) {
  const line = costLine(phaseCost({ root, phase, env }));
  ensureDir(logsDir(root));
  fs.appendFileSync(logFile(root), `${now.toISOString()} ${line}\n`);
  return line;
}

export const COST_USAGE = 'usage: turbo-run cost <phase> [--compare <phase>] [--json] | cost <phase> --log';

// turbo-run cost: prints the phase's cost by step and role (or as JSON), beside another phase with --compare; --log
// appends the cost line to supervisor.log instead. It changes nothing else. Returns the exit code (2: usage).
export function runCostCommand(args, { root, out, err, env = process.env }) {
  const usage = () => {
    err(COST_USAGE);
    return 2;
  };
  const isId = (v) => typeof v === 'string' && PHASE_RE.test(v) && !v.startsWith('-');
  const ids = [];
  const flags = new Set();
  let compare = null;
  let project = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json' || a === '--log') flags.add(a);
    else if (a === '--compare') {
      if (!isId(args[i + 1]) || compare !== null) return usage();
      compare = args[++i];
    } else if (a === '--project') {
      if (args[i + 1] === undefined) return usage();
      project = args[++i]; // bin resolved the root from it
    } else if (isId(a)) ids.push(a);
    else return usage();
  }
  if (ids.length !== 1 || (flags.has('--log') && (flags.has('--json') || compare !== null))) return usage();
  // bin's projectArg reads a --project after --log as --log's value (another command's flag) and falls back to the
  // working directory: that project is never measured, nor its log written, in the named one's place
  if (project !== null && dirKey(project) !== dirKey(root)) {
    err(`turbo-run cost: --project ${project} was not taken (it must come before --log); nothing measured`);
    return 2;
  }
  const [phase] = ids;
  if (flags.has('--log')) {
    try {
      out(logPhaseCost({ root, phase, env }));
      return 0;
    } catch (e) {
      // the supervisor's detached child: a failure is logged, never lost
      const line = `phase ${normalizePhaseId(phase)} cost: not measured: ${String(e?.message ?? e).split(/\r?\n/)[0]}`;
      try {
        ensureDir(logsDir(root));
        fs.appendFileSync(logFile(root), `${new Date().toISOString()} ${line}\n`);
      } catch { /* logging is best-effort */ }
      err(line);
      return 1;
    }
  }
  const cost = phaseCost({ root, phase, env });
  const other = compare === null ? null : phaseCost({ root, phase: compare, env });
  if (flags.has('--json')) {
    out(JSON.stringify({ ...cost, path: pathOf(cost), ...(other ? { compare: { ...other, path: pathOf(other) } } : {}) }, null, 2));
    return 0;
  }
  const empty = [cost, other].filter((c) => c && !c.rows.length);
  if (empty.length) {
    for (const c of empty) out(noDataLine(root, c));
    return 0;
  }
  for (const line of other ? compareTable(cost, other) : table(cost)) out(line);
  return 0;
}

// The supervisor's measurement at phase close (Stage 6 M, spec §7): `turbo-run cost <N> --log` as a detached child, so
// a long phase's transcripts are never read inside a tick. Its cwd is turbo's own directory (no handle held on the
// project); a child that cannot start is logged as `phase <N> cost: not measured: <why>`, never thrown. Returns it.
export function spawnCostLog({ script, root, phase, log, node = process.execPath, env = sessionFreeEnv() }) {
  // --project first: bin's projectArg takes the argument after --log as that flag's value (lib/cli-phase.mjs)
  const child = spawn(node, [script, 'cost', String(phase), '--project', root, '--log'], { cwd: path.dirname(script), env, detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', (err) => log(`phase ${phase} cost: not measured: ${String(err?.message ?? err).split(/\r?\n/)[0]}`));
  child.unref();
  return child;
}
