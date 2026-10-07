import fs from 'node:fs';
import path from 'node:path';

// A stub gsd-tools.cjs at the project-local install path; answers the verbs turbo uses (G15).
export function fakeGsdCore(root, { hooks = {}, goal = 'Ship the demo feature', version = '1.16.0' } = {}) {
  const core = path.join(root, '.claude', 'gsd-core');
  fs.mkdirSync(path.join(core, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(core, 'VERSION'), `${version}\n`);
  fs.writeFileSync(path.join(core, 'bin', 'gsd-tools.cjs'), STUB.replace('__HOOKS__', JSON.stringify(hooks)).replace('__GOAL__', JSON.stringify(goal)));
  return core;
}

// No template placeholders or backticks inside: plain CommonJS.
const STUB = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const HOOKS = __HOOKS__;
const GOAL = __GOAL__;
const argv = process.argv.slice(2);
const args = [];
let root = process.cwd();
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--raw') continue;
  if (argv[i] === '--cwd') { root = argv[++i]; continue; }
  args.push(argv[i]);
}
const cfgFile = path.join(root, '.planning', 'config.json');
const load = () => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { return {}; } };
const at = (o, k) => k.split('.').reduce((x, s) => (x && typeof x === 'object' && Object.prototype.hasOwnProperty.call(x, s) ? x[s] : undefined), o);
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const phaseDir = (n) => {
  const base = path.join(root, '.planning', 'phases');
  return path.join(base, fs.readdirSync(base).find((x) => Number(x.split('-')[0]) === Number(n)));
};
const cmd = args[0];
const sub = args[1];
if (cmd === 'config-get') {
  const v = at(load(), sub);
  const di = args.indexOf('--default');
  out(v === undefined ? (di >= 0 ? args[di + 1] : '') : typeof v === 'string' ? v : JSON.stringify(v));
} else if (cmd === 'config-set') {
  const c = load();
  const parts = sub.split('.');
  let cur = c;
  for (const s of parts.slice(0, -1)) cur = cur[s] && typeof cur[s] === 'object' ? cur[s] : (cur[s] = {});
  const raw = args[2];
  const key = parts[parts.length - 1];
  if (raw === 'null') delete cur[key];
  else cur[key] = raw === 'true' ? true : raw === 'false' ? false : raw;
  fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2));
  out({ updated: true });
} else if (cmd === 'loop') {
  out({ point: args[2], activeHooks: HOOKS[args[2]] || [] });
} else if (cmd === 'phase-plan-index') {
  const files = fs.readdirSync(phaseDir(sub));
  out({ phase: sub, plans: files.filter((f) => f.endsWith('-PLAN.md')).map((f) => {
    const id = f.slice(0, -'-PLAN.md'.length);
    return { id, files_modified: [], files_deleted: [], has_summary: files.includes(id + '-SUMMARY.md') };
  }) });
} else if (cmd === 'frontmatter') {
  const text = fs.readFileSync(path.resolve(root, args[2]), 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const o = {};
  let parent = null;
  for (const line of (m ? m[1] : '').split(/\r?\n/)) {
    const kv = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[1] && parent) o[parent][kv[2]] = kv[3];
    else if (!kv[1] && kv[3] === '') { parent = kv[2]; o[parent] = {}; }
    else if (!kv[1]) { parent = null; o[kv[2]] = kv[3]; }
  }
  out(o);
} else if (cmd === 'check') {
  out({ frontend: false, hasUiSpec: false, block: false });
} else if (cmd === 'roadmap') {
  out(GOAL);
} else if (cmd === 'commit') {
  const fi = args.indexOf('--files');
  const files = fi >= 0 ? args.slice(fi + 1) : [];
  cp.execFileSync('git', ['add', '-A', '--'].concat(files), { cwd: root });
  cp.execFileSync('git', ['commit', '-q', '-m', args.slice(1, fi >= 0 ? fi : args.length).join(' '), '--'].concat(files), { cwd: root });
  out({ committed: true });
} else {
  process.stderr.write('fake gsd-tools: unsupported ' + args.join(' ') + '\n');
  process.exit(2);
}
`;
