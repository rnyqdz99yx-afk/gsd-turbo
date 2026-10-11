import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { claudeHome, gsdCoreDir } from './paths.mjs';
import { readVersion, versionInRange, runGsdJson } from './gsd.mjs';
import { parseAgents, resolveBin } from './claude.mjs';
import { loadConfig, fullEntries, pushSettings } from './config.mjs';
import { nestedTestPackages } from './test-changed.mjs';
import { telegramOff } from './telegram.mjs';

const MIN_CLAUDE = '2.1.234';
// the first Claude Code that loads mods; the turbo-view live view (spec §7) needs it
export const MIN_CLAUDE_MODS = '2.1.290';
const CLAUDE_TIMEOUT_MS = 30000;
const AGENTS_ARGS = ['agents', '--json', '--all'];
const v = (s) => (/(\d+)\.(\d+)\.(\d+)/.exec(String(s)) || []).slice(1).map(Number);
const gte = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
// Whether a `claude --version` output names a Claude Code that loads mods; false when it names no version.
export const supportsMods = (text) => v(text).length === 3 && gte(v(text), v(MIN_CLAUDE_MODS));

// `claude --version` output, trimmed; null when claude cannot be run.
export function claudeVersionText({ claudeBin = resolveBin(), exec = execFileSync } = {}) {
  if (claudeBin.unsupported) return null;
  try {
    return String(exec(claudeBin.cmd, [...(claudeBin.prefix || []), '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, timeout: CLAUDE_TIMEOUT_MS })).trim() || null;
  } catch {
    return null;
  }
}

const oneLine = (s) => String(s ?? '').replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, 500);
// Why a command failed: spawn code (ENOENT, ETIMEDOUT, …), exit status, signal, stderr tail.
function failure(err) {
  const parts = [];
  if (typeof err?.code === 'string') parts.push(err.code === 'ENOENT' ? 'not found (ENOENT)' : err.code);
  if (typeof err?.status === 'number') parts.push(`exit status ${err.status}`);
  if (err?.signal) parts.push(`signal ${err.signal}`);
  const tail = oneLine(err?.stderr).slice(-200);
  if (tail) parts.push(tail);
  return parts.length ? parts.join(', ') : oneLine(err?.message) || 'unknown error';
}

// GSD's adaptive prompts key on GSD's own context_window (its workflows read it with config-get, 200000 when
// unset). Different from turbo's: a warning only, never part of the mode; nothing when either cannot be read.
function contextWindowCheck({ core, root, sh, add }) {
  let gsd;
  let turbo;
  try {
    gsd = sh(process.execPath, [path.join(core, 'bin', 'gsd-tools.cjs'), 'config-get', 'context_window', '--raw', '--cwd', root], { timeout: CLAUDE_TIMEOUT_MS }).trim();
    turbo = String(loadConfig(root).context_window);
  } catch {
    return;
  }
  if (!gsd) return;
  if (gsd === turbo) add('context-window', true, gsd);
  else add('context-window', true, `GSD's context_window is ${gsd}, turbo's is ${turbo}; GSD sizes its prompts by its own value (500000 or more gives executors the larger reads): make them agree with gsd-tools config-set context_window <tokens> or context_window in .planning/turbo/config.json`, { warn: true });
}

export function doctor({ root, env = process.env, exec = execFileSync, claudeBin = resolveBin() } = {}) {
  const checks = [];
  // warn: true marks a check that passes with a warning (it never changes the mode)
  const add = (name, ok, detail = '', extra = {}) => checks.push({ name, ok, detail, ...extra });
  const sh = (cmd, args, opts = {}) => String(exec(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, ...opts }));
  // claude never runs through a shell: the resolved binary plus its prefix args (e.g. node + cli.js).
  const claude = (args) => sh(claudeBin.cmd, [...(claudeBin.prefix || []), ...args], { timeout: CLAUDE_TIMEOUT_MS });

  add('node', gte(v(process.versions.node), [20, 0, 0]), process.versions.node);
  let claudeOut = null; // claude --version output, for the turbo-view-mod check
  let gitVersion = null;
  try {
    const out = sh('git', ['--version']);
    add('git', /git version/.test(out));
    gitVersion = v(out);
  } catch (e) { add('git', false, `git --version failed: ${failure(e)}`); }
  if (claudeBin.unsupported) {
    add('claude-version', false, claudeBin.unsupported);
    add('claude-agents', false, 'skipped: claude cannot be run');
  } else {
    try {
      const out = claude(['--version']);
      claudeOut = out.trim();
      add('claude-version', gte(v(out), v(MIN_CLAUDE)), `${out.trim()} (need >=${MIN_CLAUDE})`);
    } catch (e) { add('claude-version', false, `claude --version failed: ${failure(e)}`); }
    // The exact call the supervisor makes; an output format it cannot read makes `start` refuse.
    let agents = null;
    try { agents = claude(AGENTS_ARGS); } catch (e) { add('claude-agents', false, `claude ${AGENTS_ARGS.join(' ')} failed: ${failure(e)}`); }
    if (agents !== null) {
      // the supervisor's own parser; its messages never contain the CLI output
      try { parseAgents(agents); add('claude-agents', true); } catch (e) { add('claude-agents', false, `claude ${AGENTS_ARGS.join(' ')}: ${oneLine(e.message)}`); }
    }
  }
  add('project', !!root, root || 'no .planning directory found');
  const core = root ? gsdCoreDir(root, env) : null;
  const ver = core ? readVersion(core) : null;
  add('gsd-core', !!core, core || 'gsd-core not found');
  const inRange = !!ver && versionInRange(ver);
  add('gsd-version', inRange, `${ver || '?'} (tested >=1.16.0 <1.17.0)`);
  let initOk = false;
  if (core && root) {
    try { runGsdJson(core, ['init', 'manager'], { cwd: root, exec }); initOk = true; } catch (e) { add('gsd-init-manager', false, oneLine(e.message)); }
    if (initOk) add('gsd-init-manager', true);
  }
  // Stage 2: /turbo-phase needs its skill, the turbo-uat agent and GSD's hook listing (G6).
  const home = claudeHome(env);
  for (const [name, file] of [['turbo-phase-skill', path.join(home, 'skills', 'turbo-phase', 'SKILL.md')], ['turbo-uat-agent', path.join(home, 'agents', 'turbo-uat.md')]]) {
    const ok = fs.existsSync(file);
    add(name, ok, ok ? '' : `${file} missing (run node install.mjs)`);
  }
  // Stage 3: the turbo-view mod (spec §7) loads on Claude Code >= 2.1.290 only; this check never changes the mode.
  const modFile = path.join(home, 'skills', 'turbo-view', 'hooks', 'hooks.json');
  if (!supportsMods(claudeOut)) add('turbo-view-mod', true, `${claudeOut ? `Claude Code ${claudeOut} has no mods (need >=${MIN_CLAUDE_MODS})` : 'Claude Code version unknown'}: turbo-run status --watch shows the run`);
  else if (fs.existsSync(modFile)) add('turbo-view-mod', true);
  else add('turbo-view-mod', false, `${modFile} missing (run node install.mjs)`);
  if (core && root && initOk) {
    try {
      const listed = Array.isArray(runGsdJson(core, ['loop', 'render-hooks', 'verify:post'], { cwd: root, exec }).activeHooks);
      add('gsd-render-hooks', listed, listed ? '' : 'loop render-hooks verify:post returned no activeHooks list');
    } catch (e) {
      add('gsd-render-hooks', false, oneLine(e.message));
    }
  }
  if (core && root && initOk) contextWindowCheck({ core, root, sh, add });
  // test.full: a list that is not valid, and each nested package with its own test script that no entry runs, are
  // warnings; they do not change the mode
  const warnings = [];
  if (root) {
    try {
      const entries = fullEntries(loadConfig(root).test?.full, root);
      let files = [];
      try { files = sh('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean); } catch { /* not a git repository: nothing is tracked */ }
      for (const p of nestedTestPackages(root, files)) {
        if (!entries.some((e) => e.dir === p.dir)) warnings.push(`nested package ${p.dir} has its own test script that test.full does not run`);
      }
    } catch (e) {
      warnings.push(oneLine(e.message));
    }
  }
  // push (spec §6, S2): the scan shows merges with --diff-merges, git 2.31 and newer. A failed check while push.mode is
  // on, a warning while it is off; never part of the mode
  if (root && gitVersion?.length === 3) {
    let mode = 'off';
    try {
      mode = pushSettings(loadConfig(root).push).mode;
    } catch {
      // a broken push setting is reported by start and status
    }
    const shown = gitVersion.join('.');
    const scanOk = gte(gitVersion, [2, 31, 0]);
    if (mode !== 'off') add('git-push-scan', scanOk, scanOk ? `git ${shown}` : `git ${shown}; push.mode ${mode} needs git 2.31 or newer (the push scan uses --diff-merges)`);
    else if (!scanOk) warnings.push(`git ${shown} is older than 2.31: push.mode other than off would not work (the push scan uses --diff-merges)`);
  }
  // Telegram answers (S1b): answer.telegram on while the channel cannot work is a warning naming why, never a value
  if (root) {
    let why = null;
    try {
      why = telegramOff(loadConfig(root), env);
    } catch {
      // a broken config is reported above
    }
    if (why) warnings.push(`answer.telegram is on, but Telegram answers are off: ${why}`);
  }
  const stage2 = ['turbo-phase-skill', 'turbo-uat-agent', 'gsd-render-hooks'].every((n) => checks.some((c) => c.name === n && c.ok));
  const hard = ['node', 'git', 'claude-version', 'claude-agents', 'project', 'gsd-core', 'gsd-init-manager'];
  const failedHard = checks.some((c) => hard.includes(c.name) && !c.ok) || !initOk;
  return { mode: failedHard ? 'unsupported' : inRange && stage2 ? 'full' : 'safe', checks, warnings };
}
