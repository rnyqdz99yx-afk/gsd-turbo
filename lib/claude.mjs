import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTROL_ENV } from './paths.mjs';
import { guardHooks } from './lane-guard.mjs';
import { turnEnded } from './run-status.mjs';
import { serviceGone } from './daemon-probe.mjs';

const BG_TIMEOUT_MS = 120000;
const CMD_TIMEOUT_MS = 30000;
// How long kick waits for claude agents --json to list its session, and how often it looks.
const KICK_WAIT_MS = 20000;
const KICK_STEP_MS = 500;
const SHIM_UNSUPPORTED = 'claude is installed as an unrecognized .cmd shim; install the native Claude Code build';
// npm cmd-shim targets: "%dp0%\node_modules\…\cli.js" (current) or "%~dp0\…" (older shims).
const SHIM_TARGET = /%(?:~dp0|dp0%)\\*([^"%*<>|\r\n]+?\.(?:mjs|cjs|js|exe))(?=["\s]|$)/gi;

// Never run claude through cmd.exe: it splits args at spaces and drops everything after a newline.
// Resolve the shim to what it launches and spawn that directly.
function resolveShim(shim) {
  let text = '';
  try {
    text = fs.readFileSync(shim, 'utf8');
  } catch {
    // unreadable shim: reported as unsupported below
  }
  const rel = [...text.matchAll(SHIM_TARGET)].map((m) => m[1]).filter((t) => !/(^|[\\/])node\.exe$/i.test(t)).at(-1);
  if (rel) {
    const abs = path.resolve(path.dirname(shim), ...rel.split(/[\\/]+/).filter(Boolean));
    if (fs.existsSync(abs)) {
      return /\.exe$/i.test(abs)
        ? { cmd: abs, prefix: [], shell: false }
        : { cmd: process.execPath, prefix: [abs], shell: false };
    }
  }
  return { cmd: shim, prefix: [], shell: false, unsupported: SHIM_UNSUPPORTED };
}

export function resolveBin(name = 'claude', { platform = process.platform, exec = execFileSync } = {}) {
  let lines = [];
  try {
    const out = String(exec(platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }));
    lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    // not on PATH: fall through to the bare name
  }
  if (platform === 'win32') {
    const pick = lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) || lines[0];
    if (pick) return /\.(cmd|bat)$/i.test(pick) ? resolveShim(pick) : { cmd: pick, prefix: [], shell: false };
  } else if (lines[0]) {
    return { cmd: lines[0], prefix: [], shell: false };
  }
  return { cmd: name, prefix: [], shell: false };
}

const str = (v) => (typeof v === 'string' ? v : '');

// Throws unless the output is a JSON array of objects. Interactive sessions (pid + status, no id)
// are skipped: lanes are always background sessions. Every other entry, whatever its kind, must
// have a non-empty string id and a string state or status (the fields the state below is read
// from). An empty list, a renamed id or state field, or a renamed kind value would make every
// lane session look ended (an unlisted lane session counts as ended), and the supervisor would
// remove live sessions. An empty state string still means finished. Messages never echo the
// output.
export function parseAgents(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('claude agents output is not a JSON array (not JSON)');
  }
  if (!Array.isArray(data)) throw new Error(`claude agents output is not a JSON array (got ${data === null ? 'null' : typeof data})`);
  const lanes = [];
  data.forEach((a, i) => {
    if (a === null || typeof a !== 'object' || Array.isArray(a)) throw new Error(`claude agents entry ${i} is not an object`);
    if (a.kind === 'interactive') return;
    if (typeof a.id !== 'string' || !a.id) throw new Error(`claude agents entry ${i} has no string id`);
    if (typeof a.state !== 'string' && typeof a.status !== 'string') throw new Error(`claude agents entry ${i} has no string state or status`);
    lanes.push(a);
  });
  return lanes.map((a) => ({
    id: String(a.id || ''),
    name: a.name || '',
    kind: a.kind || '',
    // a state only from a string field: any other value is no state
    state: str(a.state) || str(a.status),
    status: str(a.status),
    cwd: a.cwd || '',
    startedAt: a.startedAt || 0,
    sessionId: String(a.sessionId || ''),
    pid: a.pid || 0,
  }));
}

// A project's key: its absolute root, forward slashes, lower case on win32. Lane session names carry 6 hex; what
// all projects share in turbo's own directory (lane temp directories, push allow files) is keyed by 16, so two
// projects never meet there by a hash collision.
export function projectHash(root, length = 6) {
  const key = path.resolve(root).replace(/\\/g, '/');
  return createHash('sha1').update(process.platform === 'win32' ? key.toLowerCase() : key).digest('hex').slice(0, length);
}

export function laneSessionName(root, phase) {
  const abs = path.resolve(root);
  const slug = path.basename(abs).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  return `turbo-${slug}-${projectHash(abs)}-p${String(phase).replace(/\./g, '-')}`;
}

// Background sessions isolate edits in a worktree by default (worktree.bgIsolation, Claude Code >= 2.1.143);
// a lane must edit the main checkout, so only the lane's own session gets "none". With tmpDir (absolute), the
// session's TMP, TEMP and TMPDIR point at the lane's own temp directory under turbo's own directory, outside the
// checkout (lib/lane-tmp.mjs), so what it leaves behind is never in the system temp directory or the project.
// TURBO_LANE marks every process of the lane session, its subagents included: turbo-run answer refuses to run there,
// so a lane never answers the owner's questions (spec §5.3). User settings stay untouched; a woken session keeps
// these settings.
// Stage 4 (spec §4.2): a lane in a slot also gets its control root, where every turbo-run command it calls keeps
// turbo's state; given only when the supervisor passes one, so a v0.3 launch stays as it was.
// Smoke F2 (lib/lane-guard.mjs): with its temporary directory and its checkout (cwd) known, a lane also gets the write
// guard, a PreToolUse hook that denies file-tool writes outside the checkout, that directory and the control root's
// .planning/turbo (lanes.write_guard false: none). Hooks from --settings join the user's own; a woken session keeps it.
export const GUARD_SCRIPT = fileURLToPath(new URL('./lane-guard-hook.mjs', import.meta.url));
function laneSettings({ tmpDir, controlRoot, cwd, guard = true, platform = process.platform }) {
  const hooks = guard && tmpDir && cwd
    ? { hooks: guardHooks({ script: GUARD_SCRIPT, roots: [path.resolve(cwd), tmpDir, ...(controlRoot ? [path.join(controlRoot, '.planning', 'turbo')] : [])], tmp: tmpDir, platform }) }
    : {};
  return JSON.stringify({ worktree: { bgIsolation: 'none' }, env: { TURBO_LANE: '1', ...(tmpDir ? { TMP: tmpDir, TEMP: tmpDir, TMPDIR: tmpDir } : {}), ...(controlRoot ? { [CONTROL_ENV]: controlRoot } : {}) }, ...hooks });
}

// effort (Stage 6 D9, lanes.effort): the session's --effort, which beats the owner's per-model effortLevel.
export function buildBgArgs({ name, prompt, systemPrompt, permissionMode, model, effort, tmpDir, controlRoot, cwd, guard, platform }) {
  return [
    '--bg', '--name', name,
    '--permission-mode', permissionMode,
    '--settings', laneSettings({ tmpDir, controlRoot, cwd, guard, platform }),
    '--disallowedTools', 'AskUserQuestion',
    '--append-system-prompt', systemPrompt,
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    prompt,
  ];
}

export function parseBgLaunch(stdout) {
  const m = /backgrounded\W+([0-9a-f]{6,})/i.exec(String(stdout));
  return m ? m[1] : null;
}

// Wakes a lane's own conversation (spec §5.5.1, the §9 spikes): no option but --bg and --resume. The session brings
// back its saved --name, --permission-mode, --settings, --append-system-prompt, --disallowedTools and --model; any
// flag passed here, even the same one, starts a copy instead. It keeps its --effort (lanes.effort) too: Claude Code
// 2.1.302 lists --effort among the saved options it woke the session with, and the woken turns carry it (Stage 6
// D9 live check). A copy (a resume while the job still runs) takes the owner's own effort: wakeSession stops it.
export function buildResumeArgs(sessionId, prompt) {
  return ['--bg', '--resume', String(sessionId), String(prompt)];
}

const ID = '([0-9A-Za-z][0-9A-Za-z-]{5,})';
const WOKE_RE = new RegExp(`\\bwoke session\\s+${ID}`, 'i');
const COPY_AS_RE = new RegExp(`started a copy as\\s+${ID}`, 'i');

// What claude --bg --resume reported, read from its whole output: "note: woke session <id>" is the session itself;
// "started a copy as <id>", or a backgrounded id that is neither the job nor its session, is a copy. Anything else
// is neither: the caller counts the attempt as failed, never as a wake. A backgrounded id that is exactly the job id
// or the session id (its first segment, as backgrounded prints a UUID) without the note is a wake too: a copy always
// gets a new id (a deviation from D11, which counts only the note).
export function parseResume(text, { jobId = '', sessionId = '' } = {}) {
  const s = String(text ?? '');
  if (WOKE_RE.test(s)) return { woke: true, copyId: null };
  const launched = parseBgLaunch(s);
  const copy = COPY_AS_RE.exec(s);
  if (copy) return { woke: false, copyId: copy[1] };
  if (/started a copy/i.test(s)) return { woke: false, copyId: launched };
  if (launched) {
    const own = launched === jobId || launched === sessionId || (Boolean(sessionId) && sessionId.startsWith(`${launched}-`));
    return own ? { woke: true, copyId: null } : { woke: false, copyId: launched };
  }
  return { woke: false, copyId: null };
}

// Node's "Command failed: <argv>" message would put the prompt in logs; report only CLI output or exit facts.
function runFailure(args, err, timeout) {
  const tail = (s) => String(s ?? '').trim().slice(-500);
  let why;
  if (err?.code === 'ETIMEDOUT') why = `timed out after ${timeout} ms`;
  else if (tail(err?.stderr)) why = tail(err.stderr);
  else if (typeof err?.code === 'string') why = tail(err.message); // spawn errors name only the binary
  else if (typeof err?.status === 'number') why = `exit status ${err.status}`;
  else if (err?.signal) why = `killed by ${err.signal}`;
  else why = 'unknown error';
  return new Error(`claude ${args[0]} failed: ${why}`);
}

// The calling session's ids (set in a Claude Code session's Bash tool). The supervisor may be started from the
// owner's own session; its daemon and its lanes never carry them, or turbo-run context inside a lane could
// measure the owner's transcript. Case-insensitive: Windows env names are.
const SESSION_VARS = new Set(['CLAUDE_CODE_SESSION_ID', 'CLAUDE_JOB_DIR']);
export const sessionFreeEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !SESSION_VARS.has(k.toUpperCase())));

// Claude Code's background service idle-exits when no session is its client ("[supervisor] idle 5s with no clients —
// exiting"). Until any claude --bg starts it again, claude stop and claude rm fail with this text, whatever the job's
// state, and claude agents --all still lists the jobs (from disk, without a pid).
const DAEMON_DOWN_RE = /background service may be restarting/i;
export const isDaemonDown = (err) => Boolean(err?.daemonDown) || DAEMON_DOWN_RE.test(String(err?.message ?? err ?? ''));
// What daemonAware's stop returns for a job that is not running while the service is down: nothing to stop.
export const NOT_RUNNING = 'not-running';
// What it returns when the service is gone for this config directory and no process carries the session, while
// claude agents still lists it alive (a stale record): nothing runs it, so it counts as stopped (lib/daemon-probe.mjs).
export const SERVICE_GONE = 'service-gone';
export const goneLine = (id) => `Claude Code's background service is not running and no process carries session ${id}: counted as stopped`;
export const KICK_NAME = 'turbo-daemon-kick';

// A no-op background session whose only use is to start the background service; never a worktree of its own.
export function buildKickArgs() {
  return ['--bg', '--name', KICK_NAME, '--settings', JSON.stringify({ worktree: { bgIsolation: 'none' } }), '--disallowedTools', 'AskUserQuestion', 'Reply with the single word OK. Do nothing else.'];
}

const firstLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0];
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// stop, rm and resume over any claude (deps.claude included) that bring the background service up when it is down.
// stop: a job the list shows without a pid whose turn ended (blocked, done, ...), or not at all, is not running: it
// is stopped as it is (NOT_RUNNING), and the next resume is made inside a kick (the resume needs the service up).
// A job listed otherwise (with a pid, or working) is stopped as it is too (SERVICE_GONE, told through onGone, by
// default one log line) when claude.serviceGone (createClaude's probe) finds no control channel of this config
// directory's service and no process that carries the session: the record is stale, nothing runs it. The next resume
// is made inside a kick as well.
// Otherwise the command is tried once more inside claude.kick(during), while the kick session still holds the service
// up (it idle-exits 5 s after its last client). A service still down throws the error marked daemonDown: the caller
// tries again at its next tick, never counts it as a wake, a stop or the owner's. A kick refused because Claude Code
// does not trust the folder is no outage: that error is thrown as it is. The outage is logged once; any stop, rm or
// resume that succeeds ends it (a kick alone proves nothing).
const AWARE = Symbol('daemonAware');
const UNTRUSTED_RE = /workspace not trusted/i;
export function daemonAware(claude, { log = () => {}, onGone = (id) => log(goneLine(id)) } = {}) {
  if (!claude || claude[AWARE]) return claude;
  let down = false;
  let kickNextResume = false;
  const ok = (r) => {
    down = false;
    return r;
  };
  const giveUp = (what, err) => {
    if (!down) log(`the background service is down: claude ${what} failed (${firstLine(err)}); retrying next tick`);
    down = true;
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { daemonDown: true });
  };
  const viaKick = (what, fn, err) => {
    if (!claude.kick) return giveUp(`${what} (this claude cannot start the background service)`, err);
    let ran = false;
    try {
      return ok(claude.kick(() => {
        ran = true;
        return fn();
      }));
    } catch (e) {
      if (!ran) {
        if (UNTRUSTED_RE.test(String(e?.message ?? e))) throw e;
        return giveUp(`${what} (kick: ${firstLine(e)})`, err);
      }
      if (!isDaemonDown(e)) throw e;
      return giveUp(what, e);
    }
  };
  const call = (what, fn, before) => {
    try {
      return ok(fn());
    } catch (err) {
      if (!isDaemonDown(err)) throw err;
      const early = before?.();
      if (early !== undefined) return early;
      return viaKick(what, fn, err);
    }
  };
  const notRunning = (id) => {
    let agent;
    let listed = true;
    try {
      agent = claude.list().find((a) => a.id === id);
    } catch {
      listed = false;
    }
    if (listed && !(agent && (agent.pid || !turnEnded(agent)))) {
      kickNextResume = true;
      return NOT_RUNNING;
    }
    let gone = false;
    try {
      gone = Boolean(claude.serviceGone?.(id, agent));
    } catch { /* unknown: not gone */ }
    if (!gone) return undefined;
    kickNextResume = true;
    onGone(id);
    return SERVICE_GONE;
  };
  const resume = (...args) => {
    const fn = () => claude.resume(...args);
    if (!kickNextResume) return call('--resume', fn);
    kickNextResume = false;
    return viaKick('--resume', fn, new Error('the background service is down'));
  };
  return {
    ...claude,
    [AWARE]: true,
    isDown: () => down,
    stop: (id) => call(`stop ${id}`, () => claude.stop(id), () => notRunning(id)),
    rm: (id) => call(`rm ${id}`, () => claude.rm(id)),
    // only over a claude that can resume: the supervisor wakes nothing without one
    ...(claude.resume ? { resume } : {}),
  };
}

// probe: lib/daemon-probe.mjs serviceGone, injected by tests.
export function createClaude({ bin = resolveBin(), exec = execFileSync, spawn = spawnSync, root = process.cwd(), sleep = sleepSync, clock = Date.now, kickWaitMs = KICK_WAIT_MS, probe = serviceGone } = {}) {
  const prefix = bin.prefix || [];
  const run = (args, { cwd, timeout = CMD_TIMEOUT_MS, env } = {}) => {
    if (bin.unsupported) throw new Error(bin.unsupported);
    try {
      return String(exec(bin.cmd, [...prefix, ...args], {
        cwd,
        ...(env ? { env } : {}),
        encoding: 'utf8',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout,
        killSignal: 'SIGKILL',
      }));
    } catch (err) {
      throw runFailure(args, err, timeout);
    }
  };
  return {
    launchBg(opts, cwd) {
      const out = run(buildBgArgs({ ...opts, cwd: opts.cwd ?? cwd }), { cwd, timeout: BG_TIMEOUT_MS, env: sessionFreeEnv() });
      const id = parseBgLaunch(out);
      if (!id) throw new Error(`claude --bg did not report a session id: ${out.slice(0, 500)}`);
      return id;
    },
    list: () => parseAgents(run(['agents', '--json', '--all'])),
    stop: (id) => run(['stop', id]),
    rm: (id) => run(['rm', id]),
    // true only when this config directory's background service has no control channel and no process carries the
    // session (agent: its claude agents entry, if listed)
    serviceGone: (id, agent) => probe(id, agent),
    // Starts the background service: a no-op claude --bg in the project root (a folder Claude Code trusts), waited
    // for until claude agents --json lists it. during(), when given, runs while the kick session holds the service up;
    // its result is returned (else the kick's id). The kick session is stopped and removed in any case. Throws when it
    // is never listed.
    kick(during) {
      const id = parseBgLaunch(run(buildKickArgs(), { cwd: root, timeout: BG_TIMEOUT_MS, env: sessionFreeEnv() }));
      if (!id) throw new Error('claude --bg (kick) did not report a session id');
      try {
        const end = clock() + kickWaitMs;
        let seen = false;
        for (;;) {
          try {
            seen = parseAgents(run(['agents', '--json'])).some((a) => a.id === id);
          } catch { /* not listed yet */ }
          if (seen || clock() >= end) break;
          sleep(KICK_STEP_MS);
        }
        if (!seen) throw new Error(`the background service did not list the kick session ${id} within ${kickWaitMs} ms`);
        return during ? during() : id;
      } finally {
        for (const f of ['stop', 'rm']) {
          try {
            run([f, id]);
          } catch { /* a kick session left behind is harmless */ }
        }
      }
    },
    // spawnSync, not execFileSync: the note may come on stdout or stderr, and both are read
    resume(sessionId, prompt, cwd) {
      if (bin.unsupported) throw new Error(bin.unsupported);
      const r = spawn(bin.cmd, [...prefix, ...buildResumeArgs(sessionId, prompt)], {
        cwd,
        env: sessionFreeEnv(),
        encoding: 'utf8',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout: BG_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      if (r.error || r.status !== 0) {
        throw runFailure(['--resume'], r.error ? Object.assign(r.error, { stderr: r.stderr }) : { status: r.status, signal: r.signal, stderr: r.stderr }, BG_TIMEOUT_MS);
      }
      return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    },
  };
}
