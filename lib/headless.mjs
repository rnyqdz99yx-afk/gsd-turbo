import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { laneSettings, sessionFreeEnv } from './claude.mjs';
import { laneTmpBase, prepareLaneTmp } from './lane-tmp.mjs';
import { writeJsonAtomic } from './fsx.mjs';

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
// the same file.
export function sessionSettings({ root, key, cwd, controlRoot, guard = true, platform = process.platform }) {
  if (!KEY.test(String(key ?? ''))) throw new Error(`headless: bad session key ${JSON.stringify(key)}`);
  const tmpDir = prepareLaneTmp(root, key);
  const settingsFile = path.join(laneTmpBase(root), `p${key}.settings.json`);
  writeJsonAtomic(settingsFile, JSON.parse(laneSettings({ tmpDir, controlRoot, cwd, guard, platform })));
  return { settingsFile, tmpDir };
}

// Ends a process and everything it started (lib/tree-timeout.mjs's algorithm): taskkill /T on Windows, the process
// group elsewhere (callers spawn detached off Windows, so the child leads its group). Never throws.
export function killTree(pid, { platform = process.platform, exec = execFileSync } = {}) {
  try {
    if (platform === 'win32') {
      exec('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (err) {
      if (err?.code !== 'ESRCH') throw err;
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // already gone, or not ours to end
  }
}
