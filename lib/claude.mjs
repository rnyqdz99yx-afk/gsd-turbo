import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const BG_TIMEOUT_MS = 120000;
const CMD_TIMEOUT_MS = 30000;
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

// A project's 6-hex key: its absolute root, forward slashes, lower case on win32. Lane session names and lane
// temp directories carry it, so two projects never share either.
export function projectHash(root) {
  const key = path.resolve(root).replace(/\\/g, '/');
  return createHash('sha1').update(process.platform === 'win32' ? key.toLowerCase() : key).digest('hex').slice(0, 6);
}

export function laneSessionName(root, phase) {
  const abs = path.resolve(root);
  const slug = path.basename(abs).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  return `turbo-${slug}-${projectHash(abs)}-p${String(phase).replace(/\./g, '-')}`;
}

// Background sessions isolate edits in a worktree by default (worktree.bgIsolation, Claude Code >= 2.1.143);
// a lane must edit the main checkout, so only the lane's own session gets "none". With tmpDir (absolute), the
// session's TMP, TEMP and TMPDIR point at the lane's own temp directory under turbo's run directory, so what it
// leaves behind is never in the system temp directory. TURBO_LANE marks every process of the lane session, its
// subagents included: turbo-run answer refuses to run there, so a lane never answers the owner's questions (spec
// §5.3). User settings stay untouched; a woken session keeps these settings.
function laneSettings(tmpDir) {
  return JSON.stringify({ worktree: { bgIsolation: 'none' }, env: { TURBO_LANE: '1', ...(tmpDir ? { TMP: tmpDir, TEMP: tmpDir, TMPDIR: tmpDir } : {}) } });
}

export function buildBgArgs({ name, prompt, systemPrompt, permissionMode, model, tmpDir }) {
  return [
    '--bg', '--name', name,
    '--permission-mode', permissionMode,
    '--settings', laneSettings(tmpDir),
    '--disallowedTools', 'AskUserQuestion',
    '--append-system-prompt', systemPrompt,
    ...(model ? ['--model', model] : []),
    prompt,
  ];
}

export function parseBgLaunch(stdout) {
  const m = /backgrounded\W+([0-9a-f]{6,})/i.exec(String(stdout));
  return m ? m[1] : null;
}

// Wakes a lane's own conversation (spec §5.5.1, the §9 spikes): no option but --bg and --resume. The session brings
// back its saved --name, --permission-mode, --settings, --append-system-prompt, --disallowedTools and --model; any
// flag passed here, even the same one, starts a copy instead.
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

export function createClaude({ bin = resolveBin(), exec = execFileSync, spawn = spawnSync } = {}) {
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
      const out = run(buildBgArgs(opts), { cwd, timeout: BG_TIMEOUT_MS, env: sessionFreeEnv() });
      const id = parseBgLaunch(out);
      if (!id) throw new Error(`claude --bg did not report a session id: ${out.slice(0, 500)}`);
      return id;
    },
    list: () => parseAgents(run(['agents', '--json', '--all'])),
    stop: (id) => run(['stop', id]),
    rm: (id) => run(['rm', id]),
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
