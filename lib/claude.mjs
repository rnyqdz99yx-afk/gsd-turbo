import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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

export function laneSessionName(root, phase) {
  const abs = path.resolve(root);
  const key = abs.replace(/\\/g, '/');
  const hash6 = createHash('sha1').update(process.platform === 'win32' ? key.toLowerCase() : key).digest('hex').slice(0, 6);
  const slug = path.basename(abs).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  return `turbo-${slug}-${hash6}-p${String(phase).replace(/\./g, '-')}`;
}

// Background sessions isolate edits in a worktree by default (worktree.bgIsolation, Claude Code >= 2.1.143);
// a lane must edit the main checkout, so only the lane's own session gets "none". User settings stay untouched.
const LANE_SETTINGS = JSON.stringify({ worktree: { bgIsolation: 'none' } });

export function buildBgArgs({ name, prompt, systemPrompt, permissionMode, model }) {
  return [
    '--bg', '--name', name,
    '--permission-mode', permissionMode,
    '--settings', LANE_SETTINGS,
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

export function createClaude({ bin = resolveBin(), exec = execFileSync } = {}) {
  const prefix = bin.prefix || [];
  const run = (args, { cwd, timeout = CMD_TIMEOUT_MS } = {}) => {
    if (bin.unsupported) throw new Error(bin.unsupported);
    try {
      return String(exec(bin.cmd, [...prefix, ...args], {
        cwd,
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
      const out = run(buildBgArgs(opts), { cwd, timeout: BG_TIMEOUT_MS });
      const id = parseBgLaunch(out);
      if (!id) throw new Error(`claude --bg did not report a session id: ${out.slice(0, 500)}`);
      return id;
    },
    list: () => parseAgents(run(['agents', '--json', '--all'])),
    stop: (id) => run(['stop', id]),
    rm: (id) => run(['rm', id]),
  };
}
