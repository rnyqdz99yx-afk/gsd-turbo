import fs from 'node:fs';
import path from 'node:path';

// A stub gsd-tools.cjs at the project-local install path; answers the verbs turbo uses (G15). manager: what
// init manager prints (setManager changes it later); verification status reads the status: line of the phase
// directory's *-VERIFICATION.md frontmatter (missing without one). Stage 6 B4 (the build path): init phase-op,
// query state.begin-phase / phase.complete / uat.complete-session, commit <msg> --files, verify plan-structure and
// check decision-coverage-plan.
export function fakeGsdCore(root, { hooks = {}, goal = 'Ship the demo feature', version = '1.16.0', manager = null } = {}) {
  const core = path.join(root, '.claude', 'gsd-core');
  fs.mkdirSync(path.join(core, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(core, 'VERSION'), `${version}\n`);
  if (manager) setManager(core, manager);
  // function replacers: "$&" and the like inside the JSON are never expanded
  fs.writeFileSync(path.join(core, 'bin', 'gsd-tools.cjs'), STUB.replace('__HOOKS__', () => JSON.stringify(hooks)).replace('__GOAL__', () => JSON.stringify(goal)));
  return core;
}

export const setManager = (core, manager) => fs.writeFileSync(path.join(core, 'bin', 'manager.json'), JSON.stringify(manager));

// No template placeholders or backticks inside: plain CommonJS.
const STUB = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const HOOKS = __HOOKS__;
const GOAL = __GOAL__;
// the capability registry's "when:" keys of the four built-in gates (G6): a step hook whose key is false is inactive
const GATE = { nyquist: 'workflow.nyquist_validation', security: 'workflow.security_enforcement', ui: 'workflow.ui_review', 'code-review': 'workflow.code_review' };
const argv = process.argv.slice(2);
const args = [];
let root = process.cwd();
let raw = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--raw') { raw = true; continue; }
  if (argv[i] === '--cwd') { root = argv[++i]; continue; }
  args.push(argv[i]);
}
const cfgFile = path.join(root, '.planning', 'config.json');
const load = () => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { return {}; } };
const at = (o, k) => k.split('.').reduce((x, s) => (x && typeof x === 'object' && Object.prototype.hasOwnProperty.call(x, s) ? x[s] : undefined), o);
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const phaseDir = (n) => {
  const base = path.join(root, '.planning', 'phases');
  let names = [];
  try { names = fs.readdirSync(base); } catch (e) { return null; }
  const hit = names.find((x) => Number(x.split('-')[0]) === Number(n));
  return hit ? path.join(base, hit) : null;
};
// frontmatter as flat strings plus one level of nested maps (G15)
const frontmatter = (text) => {
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
  return o;
};
// a flow list "[a, b]" as an array of strings
const list = (v) => {
  const m = /^\[(.*)\]$/.exec(String(v || '').trim());
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
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
  // GSD 1.17 cmdConfigSet: true/false, finite numbers as numbers, the rest as written
  else cur[key] = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2));
  out({ updated: true });
} else if (cmd === 'loop') {
  const cfg = load();
  out({ point: args[2], activeHooks: (HOOKS[args[2]] || []).filter((h) => !(GATE[h.capId] && at(cfg, GATE[h.capId]) === false)) });
} else if (cmd === 'phase-plan-index') {
  const dir = phaseDir(sub);
  // a missing phase still exits 0, as gsd-core phase.cjs answers it
  if (!dir) {
    out({ phase: sub, error: 'Phase not found', plans: [] });
  } else {
    const files = fs.readdirSync(dir);
    out({ phase: sub, plans: files.filter((f) => f.endsWith('-PLAN.md')).map((f) => {
      const id = f.slice(0, -'-PLAN.md'.length);
      const fm = frontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { id, files_modified: list(fm.files_modified), files_deleted: list(fm.files_deleted), has_summary: files.includes(id + '-SUMMARY.md') };
    }) });
  }
} else if (cmd === 'frontmatter') {
  out(frontmatter(fs.readFileSync(path.resolve(root, args[2]), 'utf8')));
} else if (cmd === 'check' && sub === 'decision-coverage-plan') {
  out({ passed: true, skipped: false, total: 0, covered: 0, uncovered: [] });
} else if (cmd === 'check') {
  out({ frontend: false, hasUiSpec: false, block: false });
} else if (cmd === 'init' && sub === 'phase-op') {
  // Stage 6 B4: what the build path reads of init phase-op
  const dir = phaseDir(args[2]);
  let name = '';
  try {
    const rm = fs.readFileSync(path.join(root, '.planning', 'ROADMAP.md'), 'utf8');
    const m = new RegExp('^#{2,4}\\s*Phase\\s+0*' + String(Number(args[2])) + ':\\s*(.+?)\\s*$', 'm').exec(rm);
    if (m) name = m[1];
  } catch (e) { /* no roadmap */ }
  const files = dir ? fs.readdirSync(dir) : [];
  const has = (suffix) => files.some((f) => f.endsWith(suffix));
  out({
    phase_found: Boolean(dir), phase_number: args[2], phase_name: name,
    phase_dir: dir ? path.relative(root, dir).split(path.sep).join('/') : null,
    padded_phase: dir ? path.basename(dir).split('-')[0] : null,
    has_context: has('-CONTEXT.md'), has_research: has('-RESEARCH.md'), has_plans: has('-PLAN.md'),
  });
} else if (cmd === 'query' && sub === 'state.begin-phase') {
  // GSD 1.17: --raw prints only true
  out(raw ? 'true' : { updated: true });
} else if (cmd === 'query' && sub === 'phase.complete') {
  const file = path.join(root, '.planning', 'ROADMAP.md');
  const n = String(Number(args[2]));
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('- [ ] **Phase ' + n + ':').join('- [x] **Phase ' + n + ':'));
  out({ completed: true, phase: args[2] });
} else if (cmd === 'query' && sub === 'uat.complete-session') {
  out({ completed: true });
} else if (cmd === 'commit') {
  const { execFileSync } = require('child_process');
  const fi = args.indexOf('--files');
  const files = fi >= 0 ? args.slice(fi + 1) : [];
  const git = (a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  for (const f of files) { try { git(['add', '-A', '--', f]); } catch (e) { /* a path git does not know */ } }
  let staged = false;
  try { git(['diff', '--cached', '--quiet']); } catch (e) { staged = true; }
  if (staged) {
    git(['commit', '-q', '-m', sub]);
    out({ committed: true, hash: git(['rev-parse', '--short', 'HEAD']).trim() });
  } else {
    out({ committed: false, reason: 'nothing_to_commit' });
  }
} else if (cmd === 'verify' && sub === 'plan-structure') {
  const text = fs.readFileSync(path.resolve(root, args[2]), 'utf8');
  out({ valid: true, errors: [], warnings: [], task_count: text.split('<task ').length - 1 });
} else if (cmd === 'roadmap') {
  out(GOAL);
} else if (cmd === 'init' && sub === 'manager') {
  let m = { milestone_version: 'v1', phases: [] };
  try { m = JSON.parse(fs.readFileSync(path.join(__dirname, 'manager.json'), 'utf8')); } catch (e) { /* no phases */ }
  out(m);
} else if (cmd === 'phase' && sub === 'uat-passed') {
  // GSD 1.17 uat-predicate, --uat-only: passed with at least one pass and no row pending, issue, blocked or skipped
  // without a reason (the fake reads result and reason lines only)
  const dir = phaseDir(args[2]);
  let names = [];
  try { names = fs.readdirSync(dir).filter((x) => /-UAT\.md$/.test(x)).sort(); } catch (e) { /* no directory */ }
  const text = names.length ? fs.readFileSync(path.join(dir, names[0]), 'utf8') : '';
  const rows = text.split(/^### /m).slice(1).map((b) => ({ n: b.split(/[.\s]/)[0], result: ((/^result:\s*\[?(\w+)/m.exec(b) || [])[1] || 'missing').toLowerCase(), reason: /^reason:/m.test(b) }));
  const blockers = rows.filter((r) => !(r.result === 'pass' || (r.result === 'skipped' && r.reason))).map((r) => r.n);
  out({ passed: rows.some((r) => r.result === 'pass') && !blockers.length, blockers });
} else if (cmd === 'query' && sub === 'frontmatter.set') {
  const file = path.resolve(root, args[2]);
  const field = args[args.indexOf('--field') + 1];
  const value = args[args.indexOf('--value') + 1];
  const text = fs.readFileSync(file, 'utf8');
  const end = text.indexOf('\n---', 3);
  const head = text.slice(0, end).split('\n').map((l) => (l.startsWith(field + ':') ? field + ': ' + value : l)).join('\n');
  fs.writeFileSync(file, head + text.slice(end));
  out({ updated: true });
} else if (cmd === 'verification' && sub === 'status') {
  const dir = path.resolve(root, args[2]);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /-VERIFICATION\.md$/.test(f)).sort(); } catch (e) { /* no directory */ }
  const fm = names.length ? frontmatter(fs.readFileSync(path.join(dir, names[0]), 'utf8')) : {};
  out({ status: fm.status || 'missing' });
} else {
  process.stderr.write('fake gsd-tools: unsupported ' + args.join(' ') + '\n');
  process.exit(2);
}
`;
