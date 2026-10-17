import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { laneSettings, resolveBin, sessionFreeEnv } from './claude.mjs';
import { laneTmpBase, prepareLaneTmp, removeLaneTmp } from './lane-tmp.mjs';
import { ensureDir, readJson, readJsonState, writeJsonAtomic } from './fsx.mjs';
import { claudeHome, turboHome } from './paths.mjs';
import { pidAlive } from './merge-lock.mjs';
import { withFileLock } from './questions.mjs';
import { maskSecrets } from './secrets.mjs';
import { sessionById, sessionTreeMtimeMs, projectKey } from './transcripts.mjs';

// Stage 6 B1 (spec §6.2): the build path's short role sessions run headless, as `claude -p` with stream-json output and
// the prompt on stdin. This module builds their command line, environment and settings, runs them, watches them and
// caps how many run on the machine at once.

export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// The calling Claude Code session's markers, its messaging socket and token, and its effort: a child that inherits them
// takes itself for a nested session, or reports into the owner's session. CLAUDE_CODE_SESSION_ID and CLAUDE_JOB_DIR go
// through sessionFreeEnv. Compared upper-cased: Windows env names are case-insensitive.
export const DROP_ENV = Object.freeze(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT']);

// appendViaFile and usageSource are set by the live probe (scripts/headless-probe.mjs).
// Probe findings (scripts/headless-probe.mjs, 2026-10-17, Claude Code 2.1.302, Windows 11 / win32), all nine PASS:
// P1 stream-json: events system/hook_started, system/hook_response (SessionStart hooks, before init even without
//    --include-hook-events), system/init, assistant, rate_limit_event, user, result/success. init carries session_id,
//    model (claude-opus-5-5), tools (no AskUserQuestion), permissionMode bypassPermissions, its own messaging socket;
//    result carries result, is_error, subtype, session_id, usage (the four keys, numbers). result.usage is the whole run
//    (input and cache counts equal the sum over message ids); the stream's per-message output_tokens are a snapshot
//    from the message start (21 against 158), so the stream sum undercounts output: usageSource 'result'.
// P2 --effort: accepted with -p; an unknown value only warns on stderr and runs at the default (EFFORTS checks it here).
// P3 --agent: applied (init.tools = the agent's tools line exactly, no Edit); init has no agent field.
// P4 --settings: the lane guard denies a write outside the checkout, allows one inside; TURBO_LANE=1 reaches the shell.
// P5 --resume after -p: the same session id (resumeKeepsId true), the context kept (a Cyrillic token repeated), the
//    same transcript grows.
// P6 transcript: <config dir>/projects/<projectKey(cwd)>/<session id>.jsonl, as transcriptPath computes it.
// P7 GSD hooks in -p: SessionStart, PreToolUse, PostToolUse and Stop hooks run and succeed; Write, Read, Edit and a
//    git commit go through.
// P8 tree kill: taskkill /T /F from the claude pid ends the shell and its node grandchild; claude exits in 290 ms.
// P9 --append-system-prompt-file: known and applied (absent from claude --help): appendViaFile true.
export const HEADLESS = Object.freeze({ model: 'opus', timeoutMin: 120, stallMin: 15, pollMs: 5000, killGraceMs: 5000, closeGraceMs: 2000, appendViaFile: true, usageSource: 'result' });

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^[A-Za-z0-9._-]{1,64}$/;

// The argv after the claude binary. Never a prompt argument: the prompt goes on stdin. --disallowedTools
// AskUserQuestion always, as for lanes: a session that needs the owner prints an OWNER QUESTION block instead.
export function buildHeadlessArgs({ model = HEADLESS.model, effort, settingsFile, agent, appendSystemPromptFile, resume } = {}) {
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new Error(`headless: effort must be one of ${EFFORTS.join(', ')}, got ${JSON.stringify(effort)}`);
  if (agent !== undefined && !NAME.test(String(agent))) throw new Error(`headless: bad agent name ${JSON.stringify(agent)}`);
  if (resume !== undefined && !NAME.test(String(resume))) throw new Error(`headless: bad session id ${JSON.stringify(resume)}`);
  const append = appendSystemPromptFile === undefined
    ? []
    : HEADLESS.appendViaFile
      ? ['--append-system-prompt-file', String(appendSystemPromptFile)]
      : ['--append-system-prompt', fs.readFileSync(appendSystemPromptFile, 'utf8')];
  return [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', String(model),
    ...(effort !== undefined ? ['--effort', effort] : []),
    '--permission-mode', 'bypassPermissions',
    ...(settingsFile !== undefined ? ['--settings', String(settingsFile)] : []),
    '--disallowedTools', 'AskUserQuestion',
    ...(agent !== undefined ? ['--agent', String(agent)] : []),
    ...append,
    ...(resume !== undefined ? ['--resume', String(resume)] : []),
  ];
}

const DROP = new Set(DROP_ENV);
export function headlessEnv(env = process.env) {
  return Object.fromEntries(Object.entries(sessionFreeEnv(env)).filter(([k]) => !DROP.has(k.toUpperCase())));
}

// The session's settings file: the lane settings (TURBO_LANE, TMP/TEMP/TMPDIR, the control root, the write guard with
// cwd as the checkout). The temp directory is <turbo home>/tmp/<project key>/p<key>; the file lies next to it, not in it:
// the guard allows writes to the temp directory, and a session must never rewrite its own guard. resumeSession reuses
// the same file. Lanes keep their temp directories next to these (lanes-state.mjs laneKey: <phase>, prep-<phase>,
// annotate), and preparing one empties it: a key that a lane could have is refused (B4 keys: <phase>-<slice>).
const LANE_KEY = /^(?:annotate|prep-.*|\d[\dA-Za-z.]*)$/;
function checkKey(key) {
  if (!KEY.test(String(key ?? ''))) throw new Error(`headless: bad session key ${JSON.stringify(key)}`);
  if (LANE_KEY.test(key)) throw new Error(`headless: session key ${key} is a lane's (a phase, prep-<phase> or annotate)`);
}
export function sessionSettings({ root, key, cwd, controlRoot, guard = true, platform = process.platform }) {
  checkKey(key);
  const tmpDir = prepareLaneTmp(root, key);
  const settingsFile = path.join(laneTmpBase(root), `p${key}.settings.json`);
  writeJsonAtomic(settingsFile, JSON.parse(laneSettings({ tmpDir, controlRoot, cwd, guard, platform })));
  return { settingsFile, tmpDir };
}

// Removes what sessionSettings made for a key once its session is over for good (after any resume): the settings file
// and the temp directory (lane-tmp.mjs removeLaneTmp: throws when the directory is in use or resolves elsewhere).
export function removeSessionSettings({ root, key }) {
  checkKey(key);
  fs.rmSync(path.join(laneTmpBase(root), `p${key}.settings.json`), { force: true });
  removeLaneTmp(root, key);
}

export const USAGE_KEYS = Object.freeze(['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']);

// One stdout line of stream-json: a JSON object, or null (blank, cut short, not an object).
export function parseStreamLine(line) {
  const s = String(line ?? '').replace(/\r$/, '');
  if (!s.trim()) return null;
  try {
    const v = JSON.parse(s);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function newStreamState() {
  return { sessionId: null, model: null, tools: null, byMessage: new Map(), result: null, isError: null, subtype: null, resultUsage: null, events: 0 };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = (v) => typeof v === 'string' && NAME.test(v);

// Folds one stream-json event into the state (mutated and returned). init names the session (SessionStart hook events
// come before it); an assistant event's usage is kept per message id, the last one winning (stream-json repeats a
// message once per content block); the result event gives the final text, the error flag and the run's usage. Any
// event's valid session_id fills a session id still unknown.
export function foldEvent(state, event) {
  if (!isObj(event)) return state;
  state.events++;
  if (event.type === 'system' && event.subtype === 'init') {
    if (validId(event.session_id)) state.sessionId = event.session_id;
    if (typeof event.model === 'string') state.model = event.model;
    if (Array.isArray(event.tools)) state.tools = event.tools;
  } else if (event.type === 'assistant' && isObj(event.message) && event.message.id && isObj(event.message.usage)) {
    state.byMessage.set(String(event.message.id), event.message.usage);
  } else if (event.type === 'result') {
    state.result = String(event.result ?? '');
    state.isError = event.is_error === true;
    state.subtype = typeof event.subtype === 'string' ? event.subtype : null;
    state.resultUsage = isObj(event.usage) ? event.usage : null;
  }
  if (state.sessionId === null && validId(event.session_id)) state.sessionId = event.session_id;
  return state;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
// The session's token usage: the result event's (the whole run, probe P1) when there is one, else the last usage of
// each distinct message id summed (its output_tokens undercount: the stream's are start-of-message snapshots).
export function usageOf(state) {
  const sources = state.resultUsage && HEADLESS.usageSource === 'result' ? [state.resultUsage] : [...state.byMessage.values()];
  return Object.fromEntries(USAGE_KEYS.map((k) => [k, sources.reduce((sum, u) => sum + num(u?.[k]), 0)]));
}

// Where Claude Code keeps the session's transcript: the file found by its id, else
// <home>/projects/<projectKey(cwd)>/<id>.jsonl (probe P6).
export function transcriptPath({ home, cwd, sessionId, platform = process.platform }) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const found = sessionById({ home, root: cwd, sessionId });
  if (found) return found.file;
  return P.join(home, 'projects', projectKey(P.resolve(cwd)), `${sessionId}.jsonl`);
}

// spec §6.5: a session that needs the owner ends its final message with this block (lib/questions.mjs CONTEXT_MAX and
// LANE_OPTIONS_MAX are the same limits):
//   ## OWNER QUESTION
//   Question: <one line>
//   Context: <text, may span lines until Options:>
//   Options:
//   1. <label> — <description> (recommended)
// No options: a free-text question.
export const OWNER_CONTEXT_MAX = 600;
export const OWNER_OPTIONS_MAX = 4;
const OQ_HEADING = /^#{2,3}[ \t]*OWNER QUESTION[ \t]*:?[ \t]*$/i;
const ANY_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const RECOMMENDED = /\s*\((?:recommended|рекомендуется)\)\s*$/i;
const OPTION_LINE = /^\s*(?:\d+[.)]|[-*•])\s+(.*)$/;
const LABEL_CUT = /\s+[-–—]\s+/;
// a field line as a model may dress it: `Question:`, `- Question:`, `**Question:**`, `**Question**:`
const field = (name) => new RegExp(`^\\s*(?:[-*•]\\s+)?(?:\\*\\*|__)?${name}(?:\\*\\*|__)?\\s*:\\s*(?:\\*\\*|__)?(.*)$`, 'i');
const QUESTION_LINE = field('Question');
const CONTEXT_LINE = field('Context');
const OPTIONS_LINE = field('Options');

// The last OWNER QUESTION block of text: { question, context, options: [{ label, description, recommended }] }, or null
// without the heading or a non-empty Question line. A later heading ends the block; options (numbered, or bulleted)
// keep their written order (the first OWNER_OPTIONS_MAX), a line that is no option continues the previous one's
// description, and only the first option marked (recommended) or (рекомендуется) is recommended.
export function parseOwnerQuestion(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  const start = lines.findLastIndex((l) => OQ_HEADING.test(l));
  if (start < 0) return null;
  let question = null;
  let mode = null;
  const context = [];
  const options = [];
  for (const line of lines.slice(start + 1)) {
    if (ANY_HEADING.test(line)) break;
    let m;
    if (question === null && (m = QUESTION_LINE.exec(line))) {
      question = m[1].trim();
      mode = null;
    } else if (mode !== 'options' && !context.length && (m = CONTEXT_LINE.exec(line))) {
      context.push(m[1]);
      mode = 'context';
    } else if ((m = OPTIONS_LINE.exec(line))) {
      mode = 'options';
      const first = OPTION_LINE.exec(m[1]);
      if (first) options.push([first[1]]);
    } else if (mode === 'context') {
      context.push(line);
    } else if (mode === 'options' && line.trim()) {
      const opt = OPTION_LINE.exec(line);
      if (opt) options.push([opt[1]]);
      else if (options.length) options.at(-1).push(line);
    }
  }
  if (!question) return null;
  let marked = false;
  const parsed = [];
  for (const parts of options) {
    let rec = false;
    const full = parts.map((p) => p.replace(RECOMMENDED, () => { rec = true; return ''; }).trim()).filter(Boolean).join(' ');
    const cut = LABEL_CUT.exec(full);
    const label = (cut ? full.slice(0, cut.index) : full).trim();
    if (!label) continue;
    parsed.push({ label, description: cut ? full.slice(cut.index + cut[0].length).trim() : '', recommended: rec && !marked });
    if (rec) marked = true;
  }
  return { question, context: context.join('\n').trim().slice(0, OWNER_CONTEXT_MAX), options: parsed.slice(0, OWNER_OPTIONS_MAX) };
}

const STDERR_TAIL = 2000;

// Runs one headless session to its end: claude -p with the module's argv in cwd, the prompt on stdin, the environment
// scrubbed of the calling session (headlessEnv of opts.env). onStart({ sessionId, pid, transcript }) is called once,
// when the session id is first known (a throw in it is ignored). Rejects only when the session cannot run at all (bad
// options, claude missing); everything after the start is in the SessionResult:
// { sessionId, transcript, result, usage, exitCode, timedOut, stalled, wallMs, ownerQuestion, isError, role, stderrTail }.
// Finishes on close, or closeGraceMs after claude exited while something it started still holds its stdout.
export async function runSession(opts = {}, deps = {}) {
  const { cwd, role = null, prompt, model = HEADLESS.model, effort, agent, appendSystemPromptFile, settingsFile, timeoutMin = HEADLESS.timeoutMin, stallMin = HEADLESS.stallMin, env = process.env, onStart, resume } = opts;
  const { bin = resolveBin(), pollMs = HEADLESS.pollMs, killGraceMs = HEADLESS.killGraceMs, closeGraceMs = HEADLESS.closeGraceMs, kill = killTree } = deps;
  if (!(typeof timeoutMin === 'number' && timeoutMin > 0 && typeof stallMin === 'number' && stallMin > 0)) throw new Error('headless: timeoutMin and stallMin must be positive numbers of minutes');
  let isDir = false;
  try {
    isDir = fs.statSync(cwd).isDirectory();
  } catch { /* missing */ }
  if (!isDir) throw new Error(`headless: cwd ${cwd} is not a directory`);
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('headless: the prompt must be a non-empty string');
  if (bin.unsupported) throw new Error(bin.unsupported);
  const args = buildHeadlessArgs({ model, effort, settingsFile, agent, appendSystemPromptFile, resume });
  const childEnv = headlessEnv(env);
  const home = claudeHome(childEnv);
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const state = newStreamState();
    let child;
    let spawned = false;
    let settled = false;
    let exitCode = null;
    let tail = '';
    let stderr = '';
    let transcript = null;
    let closeTimer = null;
    let killTimer = null;
    let watch = null;
    let stopped = null; // 'timedOut' | 'stalled'
    let lastStdoutMs = start;
    const clearTimers = () => {
      clearTimeout(closeTimer);
      clearTimeout(killTimer);
      clearInterval(watch);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(new Error(`claude -p failed to start: ${err?.code || err?.message || err}`));
    };
    const line = (s) => {
      const ev = parseStreamLine(s);
      if (!ev) return;
      foldEvent(state, ev);
      if (transcript === null && state.sessionId) {
        transcript = transcriptPath({ home, cwd, sessionId: state.sessionId });
        try {
          onStart?.({ sessionId: state.sessionId, pid: child.pid, transcript });
        } catch { /* the caller's problem, not the session's */ }
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      child.stdout.destroy();
      child.stderr.destroy();
      if (tail) line(tail);
      const sessionId = state.sessionId ?? resume ?? null;
      const timedOut = stopped === 'timedOut';
      const stalled = stopped === 'stalled';
      resolve({
        sessionId,
        transcript: sessionId ? transcriptPath({ home, cwd, sessionId }) : null,
        result: state.result,
        usage: usageOf(state),
        exitCode,
        timedOut,
        stalled,
        wallMs: Date.now() - start,
        ownerQuestion: state.result !== null && !timedOut && !stalled ? parseOwnerQuestion(state.result) : null,
        isError: state.isError ?? true,
        role,
        stderrTail: maskSecrets(stderr).slice(-STDERR_TAIL),
      });
    };
    try {
      child = spawn(bin.cmd, [...bin.prefix, ...args], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32' });
    } catch (err) {
      fail(err);
      return;
    }
    child.on('spawn', () => { spawned = true; });
    child.on('error', (err) => {
      if (!spawned) fail(err);
    });
    child.stdin.on('error', () => {}); // EPIPE: claude ended before reading it all
    child.stdin.end(Buffer.from(prompt, 'utf8'));
    // Stops the session once: the whole process tree is killed; a claude that has not exited after killGraceMs is
    // killed alone and the session finished anyway.
    const stop = (why) => {
      if (stopped || settled) return;
      stopped = why;
      clearInterval(watch);
      kill(child.pid);
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch { /* gone */ }
        finish();
      }, killGraceMs);
    };
    // Activity: any stdout chunk, or a write anywhere in the session's transcript tree (its subagents included).
    watch = setInterval(() => {
      const now = Date.now();
      let last = lastStdoutMs;
      if (transcript) {
        // the path known at the start is computed before Claude Code writes the file: looked up again while it is
        // missing (Claude Code may spell the directory otherwise: a link, an 8.3 name)
        if (!fs.existsSync(transcript)) transcript = transcriptPath({ home, cwd, sessionId: state.sessionId });
        try {
          last = Math.max(last, sessionTreeMtimeMs({ file: transcript, sessionId: state.sessionId }) ?? 0);
        } catch { /* a vanished file is no activity */ }
      }
      if (now - start >= timeoutMin * 60000) stop('timedOut');
      else if (now - last >= stallMin * 60000) stop('stalled');
    }, pollMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      lastStdoutMs = Date.now();
      const parts = (tail + d).split('\n');
      tail = parts.pop();
      for (const p of parts) line(p);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2 * STDERR_TAIL); });
    child.on('exit', (code) => {
      exitCode = code;
      clearTimeout(killTimer);
      clearInterval(watch);
      if (spawned) closeTimer = setTimeout(finish, closeGraceMs);
    });
    child.on('close', () => {
      if (spawned) finish();
    });
  });
}

// Continues the same session with the owner's answer on stdin (spec §6.5): opts carry the first run's cwd and flags.
export async function resumeSession(sessionId, answer, opts = {}, deps = {}) {
  if (!NAME.test(String(sessionId ?? ''))) throw new Error(`headless: bad session id ${JSON.stringify(sessionId)}`);
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('headless: the answer must be a non-empty string');
  return runSession({ ...opts, prompt: answer, resume: String(sessionId) }, deps);
}

// spec §6.2 build.max_sessions: how many headless sessions run on the machine at once. Numbered slot files
// <turbo home>/sessions/slot-<n>.json, scanned under a short mutex. A slot is free when its file is missing or
// unreadable, its holder's pid is dead, or it was not refreshed for staleMs (a heartbeat touches it every heartbeatMs:
// Windows reuses pids). Slots above a caller's max are never looked at: projects with different max share one numbered
// pool, so the machine never runs more than the largest max (one pool per Claude config directory).
export const SLOT = Object.freeze({ pollMs: 2000, heartbeatMs: 60000, staleMs: 30 * 60000 });
// The mutex guards a scan of a few small files: held for milliseconds, so one older than staleMs was left by a crash
// whatever its pid says (Windows reuses pids: an owner check could keep a dead holder's mutex forever).
const SLOT_MUTEX = { waitMs: 1000, staleMs: 60000 };
const SLOT_RELEASE_TRIES = 30;
class SlotMutexBusy extends Error {}

// Waits for a free slot and takes it: resolves to release() (idempotent; release.slot is the slot number).
export async function acquireSessionSlot({ max, dir = path.join(turboHome(), 'sessions'), pollMs = SLOT.pollMs, heartbeatMs = SLOT.heartbeatMs, staleMs = SLOT.staleMs, alive = pidAlive, label = '' } = {}) {
  if (!Number.isInteger(max) || max < 1) throw new Error(`session slots: max must be an integer of at least 1, got ${JSON.stringify(max)}`);
  ensureDir(dir);
  const token = `${process.pid}-${randomUUID()}`;
  const mutex = path.join(dir, '.mutex');
  const underMutex = (fn) => withFileLock(mutex, fn, { ...SLOT_MUTEX, locked: () => new SlotMutexBusy(`session slots: the mutex ${mutex} stayed busy`) });
  const slotFile = (n) => path.join(dir, `slot-${n}.json`);
  const free = (n) => {
    let st;
    try {
      st = fs.statSync(slotFile(n));
    } catch {
      return true; // missing
    }
    const rec = readJson(slotFile(n), null);
    const pid = rec?.pid;
    if (!Number.isInteger(pid) || pid < 1 || typeof rec.token !== 'string') return true; // unreadable
    return !alive(pid) || Date.now() - st.mtimeMs > staleMs;
  };
  const take = () => {
    for (let n = 1; n <= max; n++) {
      if (!free(n)) continue;
      writeJsonAtomic(slotFile(n), { pid: process.pid, token, at: new Date().toISOString(), label: String(label), cwd: process.cwd() });
      return n;
    }
    return null;
  };
  // a busy mutex is waited on between polls: withFileLock's wait blocks the event loop, so it is kept short
  const tryTake = () => {
    try {
      return underMutex(take);
    } catch (err) {
      if (err instanceof SlotMutexBusy) return null;
      throw err;
    }
  };
  let slot = null;
  while ((slot = tryTake()) === null) await sleep(pollMs);
  const file = slotFile(slot);
  const holds = () => readJson(file, null)?.token === token;
  // The heartbeat stops only when the file is gone or holds another token: a read or touch that fails for a moment
  // (a scanner holding the file) is tried again at the next beat, or a live holder's slot would go stale.
  const beat = setInterval(() => {
    const st = readJsonState(file);
    if (st.state === 'missing' || (st.state === 'valid' && st.value.token !== token)) {
      clearInterval(beat);
      return;
    }
    if (st.state !== 'valid') return;
    try {
      const now = new Date();
      fs.utimesSync(file, now, now);
    } catch { /* again at the next beat */ }
  }, heartbeatMs);
  beat.unref();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    // a busy mutex is tried again later (a long-lived caller must not lose the slot until it goes stale)
    const drop = (tries) => {
      try {
        underMutex(() => {
          if (holds()) fs.rmSync(file, { force: true });
        });
      } catch {
        if (tries > 1) setTimeout(() => drop(tries - 1), pollMs).unref();
      }
    };
    drop(SLOT_RELEASE_TRIES);
  };
  release.slot = slot;
  return release;
}

// Every descendant of pid in the process table (ps), parents before their children; [] when ps cannot be read.
function descendants(pid, exec) {
  let text;
  try {
    text = String(exec('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }));
  } catch {
    return [];
  }
  const kids = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const parent = Number(m[2]);
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(Number(m[1]));
  }
  const out = [];
  const seen = new Set([pid]);
  for (const queue = [pid]; queue.length;) {
    for (const c of kids.get(queue.shift()) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

// Ends a process and everything it started. Windows: taskkill /T, which follows parent pids. Elsewhere callers spawn
// the child detached, so it leads its own process group, but Claude Code starts every shell-tool command detached too
// (a session and group of its own): the process table is read first, then the child's group and each descendant's
// group (a detached shell leads one), or the descendant alone, are killed parents first, so that nothing killed later
// starts more meanwhile. Never throws.
export function killTree(pid, { platform = process.platform, exec = execFileSync } = {}) {
  if (platform === 'win32') {
    try {
      exec('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    } catch { /* already gone, or not ours to end */ }
    return;
  }
  for (const p of [pid, ...descendants(pid, exec)]) {
    try {
      process.kill(-p, 'SIGKILL');
    } catch {
      try {
        process.kill(p, 'SIGKILL');
      } catch { /* already gone, or not ours to end */ }
    }
  }
}
