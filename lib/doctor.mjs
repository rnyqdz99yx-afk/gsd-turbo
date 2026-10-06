import { execFileSync } from 'node:child_process';
import { gsdCoreDir } from './paths.mjs';
import { readVersion, versionInRange, runGsdJson } from './gsd.mjs';
import { resolveBin } from './claude.mjs';

const MIN_CLAUDE = '2.1.234';
const CLAUDE_TIMEOUT_MS = 30000;
const v = (s) => (/(\d+)\.(\d+)\.(\d+)/.exec(String(s)) || []).slice(1).map(Number);
const gte = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
const oneLine = (s) => String(s ?? '').replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, 500);

export function doctor({ root, env = process.env, exec = execFileSync, claudeBin = resolveBin() } = {}) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  const sh = (cmd, args, opts = {}) => String(exec(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, ...opts }));
  // claude never runs through a shell: the resolved binary plus its prefix args (e.g. node + cli.js).
  const claude = (args) => sh(claudeBin.cmd, [...(claudeBin.prefix || []), ...args], { timeout: CLAUDE_TIMEOUT_MS });

  add('node', gte(v(process.versions.node), [20, 0, 0]), process.versions.node);
  try { add('git', /git version/.test(sh('git', ['--version']))); } catch { add('git', false, 'git not found'); }
  if (claudeBin.unsupported) {
    add('claude-version', false, claudeBin.unsupported);
    add('claude-agents', false, 'skipped: claude cannot be run');
  } else {
    try {
      const out = claude(['--version']);
      add('claude-version', gte(v(out), v(MIN_CLAUDE)), `${out.trim()} (need >=${MIN_CLAUDE})`);
    } catch { add('claude-version', false, 'claude not found'); }
    try { JSON.parse(claude(['agents', '--json'])); add('claude-agents', true); } catch { add('claude-agents', false, 'claude agents --json failed'); }
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
  const hard = ['node', 'git', 'claude-version', 'claude-agents', 'project', 'gsd-core', 'gsd-init-manager'];
  const failedHard = checks.some((c) => hard.includes(c.name) && !c.ok) || !initOk;
  return { mode: failedHard ? 'unsupported' : inRange ? 'full' : 'safe', checks };
}
