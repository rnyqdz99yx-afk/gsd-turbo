import path from 'node:path';
import { dirKey } from './paths.mjs';

// Smoke F2: GSD executors in lanes wrote TDD scratch files into the folder above the slots (on the owner's machine,
// the Desktop). The lane rules (lib/lane-prompt.mjs tmpRule) say where temporary files go; this is the mechanical half:
// a PreToolUse hook that only lane sessions get (lib/claude.mjs laneSettings, through --settings, so every subagent of
// the lane runs it too). It denies a file tool's write to any path outside the lane's own places: its checkout (the
// slot, or the main checkout of a v0.3 lane), its temporary directory, and the control root's .planning/turbo where a
// slot lane's turbo state lives. Bash writes (a redirect, a script that writes) are not seen by it: the supervisor's
// sweep (lib/strays.mjs) reports what appears next to the project instead.
export const GUARDED_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export const GUARD_MATCHER = GUARDED_TOOLS.join('|');

// A Windows path as the agent may spell it: Git Bash's /c/… and Cygwin's /cygdrive/c/… for a drive, the \\?\ prefix
// (\\?\UNC\server\share is \\server\share).
export function windowsPath(p) {
  let s = String(p);
  s = s.replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/i, '\\\\').replace(/^[\\/]{2}[?.][\\/](?=[A-Za-z]:)/, '');
  const drive = /^\/(?:cygdrive\/)?([A-Za-z])(?:\/(.*))?$/.exec(s.replace(/\\/g, '/'));
  return drive ? `${drive[1]}:\\${(drive[2] ?? '').replace(/\//g, '\\')}` : s;
}

const within = (key, root) => key === root || key.startsWith(root.endsWith('/') ? root : `${root}/`);

// The hook's decision for one tool call: { allow: true }, or { allow: false, reason } for the agent. tool and input are
// the hook input's tool_name and tool_input; cwd the directory a relative path counts from (the hook input's cwd);
// roots the lane's own places, tmp its temporary directory. Paths are compared as lib/paths.mjs dirKey keys them: the
// real path of the nearest existing parent (links, junctions and 8.3 short names resolved), forward slashes, lower case
// on Windows (drive letters included). Nothing to compare (no roots, no path, another tool) allows: the tool decides.
export function guardDecision({ tool, input, cwd = '', roots = [], tmp = '', platform = process.platform, realpath } = {}) {
  if (!GUARDED_TOOLS.includes(tool)) return { allow: true };
  const target = tool === 'NotebookEdit' ? input?.notebook_path : input?.file_path;
  const own = roots.filter((r) => typeof r === 'string' && r);
  if (typeof target !== 'string' || !target.trim() || !own.length) return { allow: true };
  const P = platform === 'win32' ? path.win32 : path.posix;
  const fix = (p) => (platform === 'win32' ? windowsPath(p) : String(p));
  const abs = P.resolve(fix(cwd || own[0]), fix(target));
  const opts = { platform, ...(realpath ? { realpath } : {}) };
  const key = dirKey(abs, opts);
  if (own.some((r) => within(key, dirKey(fix(r), opts)))) return { allow: true };
  const slash = (p) => String(p).replace(/\\/g, '/');
  const where = tmp ? `Write temporary files (scratch scripts, captured output, test data, copies) under ${slash(tmp)}: TMP, TEMP and TMPDIR point there. ` : '';
  return {
    allow: false,
    reason: `gsd-turbo lane guard: ${slash(abs)} lies outside this lane's checkout ${slash(own[0])}. ${where}Files of the project go inside the checkout. Nothing goes next to the checkout, in a folder above it or in the home directory.`,
  };
}

// The guard's settings travel in one argument, base64url JSON: no shell (bash, cmd or PowerShell) changes it.
export const encodeGuardArg = ({ roots, tmp }) => Buffer.from(JSON.stringify({ roots, tmp })).toString('base64url');
export function decodeGuardArg(arg) {
  const v = JSON.parse(Buffer.from(String(arg ?? ''), 'base64url').toString('utf8'));
  return { roots: Array.isArray(v?.roots) ? v.roots.filter((r) => typeof r === 'string') : [], tmp: typeof v?.tmp === 'string' ? v.tmp : '' };
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// The hook command: node on PATH (as the lane's turbo-run calls), the script in double quotes with forward slashes on
// Windows (the same in Git Bash, cmd and PowerShell), single quotes elsewhere.
export function guardCommand({ script, roots, tmp, platform = process.platform }) {
  const q = platform === 'win32' ? `"${String(script).replace(/\\/g, '/')}"` : shQuote(script);
  return `node ${q} ${encodeGuardArg({ roots, tmp })}`;
}

// The hooks entry of a lane's --settings.
export function guardHooks(opts) {
  return { PreToolUse: [{ matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: guardCommand(opts), timeout: 10 }] }] };
}

// What the hook prints for one call: '' allows (exit 0, no output), a deny is Claude Code's PreToolUse JSON. Anything
// it cannot read allows: a broken guard must never stop a lane.
export function hookOutput(stdin, arg, opts = {}) {
  let decision;
  try {
    const input = JSON.parse(String(stdin));
    const { roots, tmp } = decodeGuardArg(arg);
    decision = guardDecision({ tool: input?.tool_name, input: input?.tool_input, cwd: typeof input?.cwd === 'string' ? input.cwd : '', roots, tmp, ...opts });
  } catch {
    return '';
  }
  if (decision.allow) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason } });
}
