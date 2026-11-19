#!/usr/bin/env node
// The compatibility check of gsd-turbo against a GSD core it was not tested with (.github/workflows/gsd-compat.yml,
// nightly). It runs every gsd-tools call shape turbo makes, the writes included, on two copies of one synthetic GSD
// project: one with a GSD from the tested range (base), one with the GSD under test (head), and compares the two runs
// by a rule that needs no reader:
//   - a call that exits differently is a break;
//   - a write that leaves a different .planning tree is a break;
//   - an answer that differs in a field turbo's code reads (FIELDS) is a break;
//   - any other difference (a field GSD added, a reworded prompt) is listed and passes.
//
//   node scripts/gsd-compat.mjs versions                       the newest tested GSD and the newest released one
//   node scripts/gsd-compat.mjs diff --base <tools> --head <tools> [--report <file>]
//   node scripts/gsd-compat.mjs issue --verdict pass|fail --version <v> --report <file> [--run <url>] [--dry-run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { GSD_TESTED_RANGE, versionClass, versionInRange } from '../lib/gsd.mjs';
import { compactPlan } from '../test/helpers/slices.mjs';
import { summaryText } from '../test/helpers/build-fake.mjs';

const REPO = 'rnyqdz99yx-afk/gsd-turbo';
const PACKAGE = '@opengsd/gsd-core';
const P1 = '.planning/phases/01-greeting-library';
const P2 = '.planning/phases/02-greeting-cli';

// What turbo's code reads of each answer: paths into the JSON ('a.b', 'list[].field', '*' = all of it), or 'text'
// for an answer turbo takes as plain text. A call that is not listed is compared for its exit status (and its tree
// when it writes) only: its answer is read by GSD's own workflows or by nobody.
export const FIELDS = {
  'init manager': ['milestone_version', 'phases[].number', 'phases[].name', 'phases[].dep_phases', 'phases[].deps_display', 'phases[].disk_status', 'phases[].phase_complete', 'phases[].roadmap_complete', 'phases[].implementation_complete', 'phases[].verification_status', 'phases[].is_active'],
  'init phase-op': ['phase_found', 'phase_dir', 'phase_name', 'padded_phase'],
  'state json': ['current_phase'],
  'verification status': ['status'],
  'roadmap get-phase': 'text',
  'phase-plan-index': ['plans[].id', 'plans[].wave', 'plans[].depends_on', 'plans[].files_modified', 'plans[].has_summary'],
  'config-get': 'text',
  'resolve-model': 'text',
  'loop render-hooks': ['activeHooks[].kind', 'activeHooks[].capId', 'activeHooks[].ref.command'],
  'check ui-plan-gate': ['frontend'],
  'frontmatter get': ['*'],
  'query verification.fingerprint': 'text',
  'phase uat-passed': ['passed'],
  'verify plan-structure': ['valid', 'errors', 'task_count'],
  'check decision-coverage-plan': ['passed', 'skipped', 'uncovered'],
  commit: ['committed', 'skipped', 'reason'],
};

const kindOf = (name) => Object.keys(FIELDS).sort((a, b) => b.length - a.length).find((k) => name === k || name.startsWith(`${k} `)) ?? null;

const ROADMAP = `# Roadmap: Greeting

## Phases

- [ ] **Phase 1: Greeting library** - greet and farewell
- [ ] **Phase 2: Greeting CLI** - a command line for the library

## Phase Details

### Phase 1: Greeting library
**Goal**: A small greeting library: greet and farewell
**Depends on**: Nothing (first phase)
**Requirements**: GREET-01, GREET-02
**Success Criteria** (what must be TRUE):
  1. greet('Ann') returns Hello, Ann!
  2. node --test passes

### Phase 2: Greeting CLI
**Goal**: A command line for the greeting library
**Depends on**: Phase 1
**Requirements**: CLI-01
**Success Criteria** (what must be TRUE):
  1. node cli.js greet Ann prints Hello, Ann!

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Greeting library | 1/1 | In Progress | - |
| 2. Greeting CLI | 0/1 | Not started | - |
`;

// GREET-02 carries a note in its Status: what a GSD does to such a row at phase.complete is part of the comparison.
const REQUIREMENTS = `# Requirements: Greeting

## v1 Requirements

- [ ] **GREET-01**: greet(name) greets by name
- [ ] **GREET-02**: farewell(name) says goodbye by name
- [ ] **CLI-01**: node cli.js greet <name> prints the greeting

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| GREET-01 | Phase 1 | Pending |
| GREET-02 | Phase 1 | Pending (waits for a live check) |
| CLI-01 | Phase 2 | Pending |
`;

const STATE = `---
gsd_state_version: '1.0'
status: executing
---

# Project State

## Current Position

Phase: 1 of 2 (Greeting library)
Plan: 1 of 1 in current phase
Status: Ready to execute
Last activity: 2026-01-01 — context gathered

## Session Continuity

Last session: 2026-01-01
Stopped at: context gathered
Resume file: None
`;

const context = (n, name, decisions) => `# Phase ${n}: ${name} - Context

**Gathered:** 2026-01-01
**Status:** Ready for planning

<domain>
## Phase Boundary

${name}, in plain Node.js, tested with node --test.

</domain>

<decisions>
## Implementation Decisions

### ${name}
${decisions.map(([id, text]) => `- **${id}:** ${text}`).join('\n')}

### Claude's Discretion
File layout.

</decisions>
`;

const UAT = ['---', 'status: testing', 'phase: 01-greeting-library', '---', '', '## Tests', '', '### 1. the greeting shows', 'expected: Hello, Ann!', 'result: pass', '', '## Summary', '', 'total: 1', 'passed: 1', 'issues: 0', 'pending: 0', 'skipped: 0', ''].join('\n');

// A synthetic GSD project in dir: phase 1 built and verified (one plan with its summary, a verification report, a
// UAT file), phase 2 planned (one plan, no summary). Everything committed.
export function makeProject(dir) {
  const put = (rel, text) => {
    const f = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  fs.mkdirSync(dir, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'compat@example.invalid');
  git('config', 'user.name', 'gsd compat');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  put('package.json', `${JSON.stringify({ name: 'greeting', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`);
  put('src/a.js', "module.exports = (name) => `Hello, ${name}!`;\n");
  put('test/a.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\ntest('greet', () => assert.equal(require('../src/a.js')('Ann'), 'Hello, Ann!'));\n");
  put('.planning/PROJECT.md', '# Greeting\n\nA tiny greeting library and its command line: the compatibility check project of gsd-turbo.\n');
  put('.planning/ROADMAP.md', ROADMAP);
  put('.planning/REQUIREMENTS.md', REQUIREMENTS);
  put('.planning/STATE.md', STATE);
  put('.planning/config.json', '{}\n');
  put(`${P1}/01-CONTEXT.md`, context(1, 'Greeting library', [['D-01', 'greet(name) returns `Hello, <name>!`'], ['D-02', 'farewell(name) returns `Goodbye, <name>.`']]));
  put(`${P1}/01-01-PLAN.md`, compactPlan({ id: '01-01', reqs: ['GREET-01', 'GREET-02'], decisions: ['D-01', 'D-02'] }));
  put(`${P1}/01-01-SUMMARY.md`, summaryText({ phaseSlug: '01-greeting-library', plan: '01-01', reqs: ['GREET-01', 'GREET-02'] }));
  put(`${P1}/01-VERIFICATION.md`, ['---', 'phase: 01-greeting-library', 'verified: 2026-01-02T00:00:00Z', 'status: human_needed', 'score: 1/1 must-haves verified', '---', '', '# Phase 1: Verification', ''].join('\n'));
  put(`${P1}/01-UAT.md`, UAT);
  put(`${P2}/02-CONTEXT.md`, context(2, 'Greeting CLI', [['D-01', '`node cli.js greet <name>` prints greet(name)']]));
  put(`${P2}/02-01-PLAN.md`, compactPlan({ id: '02-01', reqs: ['CLI-01'], decisions: ['D-01'], files: ['src/cli.js', 'test/cli.test.js'] }));
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: greeting project');
  return dir;
}

// Every gsd-tools call shape turbo makes: the reads first, then the writes in the order a phase makes them.
export const STEPS = [
  ['runtime-identity --raw'],
  ['init manager'],
  ['init phase-op 1'], ['init phase-op 2'],
  ['init plan-phase 2'],
  ['init execute-phase 2'], ['query init.execute-phase 2'],
  ['state json'],
  ['verification status', P1], ['verification status', P2],
  ['roadmap get-phase 2 --pick section'], ['roadmap get-phase 2 --pick goal'],
  ['roadmap analyze'],
  ['phase-plan-index 1'], ['phase-plan-index 2'],
  ['config-get workflow.security_enforcement'],
  ['config-get context_window --raw'],
  ['config-get git.branching_strategy --default none --raw'],
  ['config-get workflow.security_asvs_level --default 1 --raw'],
  ['config-get workflow.security_block_on --default high --raw'],
  ['config-get workflow.nyquist_validation --default __turbo_absent__ --raw'],
  ['config-get workflow.no_such_key_turbo --default __turbo_absent__ --raw'],
  ['resolve-model gsd-planner --raw'],
  ['validate consistency'],
  ['query init.resume'],
  ['audit-uat'],
  ['loop render-hooks verify:post'], ['loop render-hooks plan:pre'], ['loop render-hooks execute:wave:post'],
  ['check ui-plan-gate 2'],
  ['frontmatter get', `${P1}/01-VERIFICATION.md`],
  ['query verification.fingerprint', P1, 'src/a.js', '--raw'],
  ['phase uat-passed 1 --uat-only'],
  ['verify plan-structure', `${P2}/02-01-PLAN.md`],
  ['check decision-coverage-plan', P2, `${P2}/02-CONTEXT.md`],
  ['check evaluation-scope --phase 2 --raw'],
  ['query dispatch-isolation --raw --phase 2 --plan 02-01 --force-isolation none'],
  // writes
  ['WRITE query state.begin-phase', '--phase', '2', '--name', 'Greeting CLI', '--plans', '1'],
  ['WRITE query state.planned-phase', '--phase', '2', '--name', 'Greeting CLI', '--plans', '1'],
  ['WRITE query roadmap.annotate-dependencies 2'],
  ['WRITE roadmap update-plan-progress 1'],
  ['WRITE state patch', JSON.stringify({ 'Current Plan': '1', Status: 'Phase complete — ready for verification' })],
  ['WRITE state record-session', '--stopped-at', 'Phase 1: 1 of 1 plans done; next plan none', '--resume-file', 'None'],
  ['WRITE config-set workflow.ui_review false'],
  ['WRITE config-set workflow.ui_review null'],
  ['WRITE query uat.complete-session', `${P1}/01-UAT.md`, '--message', 'test(1): complete UAT'],
  ['WRITE query frontmatter.set', `${P1}/01-VERIFICATION.md`, '--field', 'status', '--value', 'passed'],
  ['WRITE commit', 'docs(1): the verification passed', '--files', `${P1}/01-VERIFICATION.md`, `${P1}/01-UAT.md`, '.planning/STATE.md', '.planning/ROADMAP.md', '.planning/config.json'],
  ['WRITE query phase.complete 1'],
  ['WRITE state add-decision', '--phase', '1', '--summary', 'compat decision line'],
  ['WRITE commit', 'docs(phase-1): complete phase', '--files', '.planning/STATE.md', '.planning/ROADMAP.md', '.planning/REQUIREMENTS.md'],
].map(([head, ...rest]) => {
  const write = head.startsWith('WRITE ');
  const words = head.replace(/^WRITE /, '').split(' ');
  return { name: [head, ...rest].join(' ').slice(0, 110), kind: kindOf(words.join(' ')), write, args: [...words, ...rest] };
});

// tool: a gsd-tools.cjs. -> one record per step, and the final git state.
export function runSteps(tool, dir) {
  const out = [];
  for (const s of STEPS) {
    const r = spawnSync(process.execPath, [tool, ...s.args, '--cwd', dir], { cwd: dir, encoding: 'utf8', timeout: 120000, windowsHide: true });
    const tree = s.write ? execFileSync('git', ['-C', dir, 'diff', 'HEAD', '--', '.planning'], { encoding: 'utf8', maxBuffer: 1 << 26 }) : null;
    out.push({ name: s.name, kind: s.kind, write: s.write, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', tree });
  }
  out.push({ name: 'git log', kind: null, write: true, status: 0, stdout: '', stderr: '', tree: execFileSync('git', ['-C', dir, 'log', '--format=%s', '--name-status'], { encoding: 'utf8' }) });
  out.push({ name: 'git status', kind: null, write: true, status: 0, stdout: '', stderr: '', tree: execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }) });
  return out;
}

// What differs between two runs by itself: the project's path, times, commit ids.
// roots: { '<path>': '<mark>' }, the run's own directories (its project, its GSD).
export function normalize(text, roots) {
  let s = String(text ?? '').replace(/\r\n/g, '\n');
  for (const [dir, mark] of Object.entries(roots ?? {})) {
    for (const d of new Set([dir, dir.replace(/\\/g, '/'), dir.replace(/\\/g, '\\\\'), fs.existsSync(dir) ? fs.realpathSync.native(dir) : dir])) s = s.split(d).join(mark);
  }
  return s
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>')
    .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
    .replace(/("(?:hash|commit|sha|state_head)":\s*")[0-9a-f]{7,40}(")/g, '$1<sha>$2')
    .replace(/^(state_head:\s*)[0-9a-f]{7,40}$/gm, '$1<sha>')
    .replace(/^(index )[0-9a-f]{7,}\.\.[0-9a-f]{7,}/gm, '$1<blob>');
}

const jsonOf = (text) => {
  const at = text.search(/[{[]/);
  if (at < 0) return undefined;
  try {
    return JSON.parse(text.slice(at));
  } catch {
    return undefined;
  }
};

// The values at a FIELDS path ('a.b', 'list[].x', '*'); undefined where the path leads nowhere.
export function pick(value, fieldPath) {
  if (fieldPath === '*') return value;
  let cur = [value];
  for (const part of fieldPath.split('.')) {
    const many = part.endsWith('[]');
    const key = many ? part.slice(0, -2) : part;
    cur = cur.flatMap((v) => {
      const next = v !== null && typeof v === 'object' ? v[key] : undefined;
      return many ? (Array.isArray(next) ? next : [undefined]) : [next];
    });
  }
  return cur;
}

const keysOf = (v, prefix = '', acc = new Set()) => {
  if (Array.isArray(v)) for (const x of v) keysOf(x, `${prefix}[]`, acc);
  else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(`${prefix}${prefix ? '.' : ''}${k}`); keysOf(x, `${prefix}${prefix ? '.' : ''}${k}`, acc); }
  return acc;
};
const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? 'nothing' : s.length > 160 ? `${s.slice(0, 160)}…` : s;
};

// base, head: runSteps results. baseRoots, headRoots: each run's own directories for normalize, so that a path in an
// answer is not a difference. -> { breaks: [{ step, why }], notes: [{ step, what }] }
export function compare(base, head, { baseRoots: baseDir = {}, headRoots: headDir = {} } = {}) {
  const breaks = [];
  const notes = [];
  // a write that left a different tree shows in every later write until a commit: said once
  const treesSaid = new Set();
  const byName = new Map(head.map((r) => [r.name, r]));
  for (const b of base) {
    const h = byName.get(b.name);
    if (!h) {
      breaks.push({ step: b.name, why: 'the step did not run on the GSD under test' });
      continue;
    }
    if (b.status !== h.status) {
      breaks.push({ step: b.name, why: `exit ${b.status} on the tested GSD, exit ${h.status} on the GSD under test: ${short(normalize(h.stderr || h.stdout, headDir).trim().split('\n')[0] ?? '')}` });
      continue;
    }
    if (b.write && normalize(b.tree, baseDir) !== normalize(h.tree, headDir)) {
      const bl = normalize(b.tree, baseDir).split('\n');
      const hl = new Set(normalize(h.tree, headDir).split('\n'));
      const only = bl.filter((l) => /^[+-][^+-]/.test(l) && !hl.has(l));
      const onlyHead = normalize(h.tree, headDir).split('\n').filter((l) => /^[+-][^+-]/.test(l) && !new Set(bl).has(l));
      const said = JSON.stringify([only, onlyHead]);
      if (treesSaid.has(said)) continue;
      treesSaid.add(said);
      breaks.push({ step: b.name, why: `the write leaves a different .planning tree; tested GSD only: ${short(only.slice(0, 3).join(' ⏎ ') || 'nothing')}; GSD under test only: ${short(onlyHead.slice(0, 3).join(' ⏎ ') || 'nothing')}` });
      continue;
    }
    const fields = b.kind ? FIELDS[b.kind] : null;
    const bo = normalize(b.stdout, baseDir);
    const ho = normalize(h.stdout, headDir);
    if (bo === ho) continue;
    if (fields === 'text') {
      breaks.push({ step: b.name, why: `turbo reads this answer as text and it differs: ${short(bo.trim())} → ${short(ho.trim())}` });
      continue;
    }
    const bj = jsonOf(bo);
    const hj = jsonOf(ho);
    let broke = false;
    if (fields) {
      if (bj === undefined || hj === undefined) {
        breaks.push({ step: b.name, why: 'turbo reads this answer as JSON and one side printed none' });
        continue;
      }
      for (const f of fields) {
        const bv = JSON.stringify(pick(bj, f));
        const hv = JSON.stringify(pick(hj, f));
        if (bv !== hv) {
          breaks.push({ step: b.name, why: `${f} (read by turbo): ${short(bv)} → ${short(hv)}` });
          broke = true;
        }
      }
    }
    if (broke) continue;
    if (bj !== undefined && hj !== undefined) {
      const bk = keysOf(bj);
      const hk = keysOf(hj);
      const added = [...hk].filter((k) => !bk.has(k)).sort();
      const gone = [...bk].filter((k) => !hk.has(k)).sort();
      const parts = [added.length ? `added: ${added.slice(0, 8).join(', ')}${added.length > 8 ? ` and ${added.length - 8} more` : ''}` : '', gone.length ? `gone: ${gone.slice(0, 8).join(', ')}${gone.length > 8 ? ` and ${gone.length - 8} more` : ''}` : ''].filter(Boolean);
      notes.push({ step: b.name, what: parts.length ? parts.join('; ') : 'values differ in fields turbo does not read' });
    } else notes.push({ step: b.name, what: 'the text differs; turbo does not read it' });
  }
  return { breaks, notes };
}

export function reportText({ baseVersion, headVersion, result, steps }) {
  const lines = [
    `## GSD ${headVersion} against gsd-turbo (compared with GSD ${baseVersion})`, '',
    `${steps} gsd-tools calls on a synthetic project, the writes included. Tested range of this turbo: \`${GSD_TESTED_RANGE}\`.`, '',
    result.breaks.length ? `**${result.breaks.length} break(s):**` : '**No break:** every call exits the same way, every write leaves the same tree, every field turbo reads is the same.', '',
    ...result.breaks.map((b) => `- \`${b.step}\`: ${b.why}`),
    ...(result.breaks.length ? [''] : []),
    ...(result.notes.length ? [`Differences that are not breaks (${result.notes.length}):`, '', ...result.notes.map((n) => `- \`${n.step}\`: ${n.what}`), ''] : []),
  ];
  return `${lines.join('\n')}\n`;
}

// The newest GSD inside the tested range and the newest released one. versions: every published version.
export function pickVersions(versions, latest) {
  const stable = versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  const num = (v) => v.split('.').map(Number);
  const cmp = (a, b) => { const x = num(a); const y = num(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
  const base = stable.filter((v) => versionInRange(v)).sort(cmp).at(-1) ?? null;
  return { base, head: latest, cls: versionClass(latest) };
}

const TITLE_FAIL = (v) => `GSD ${v}: the compatibility check fails`;
const TITLE_PASS = (v) => `GSD ${v} passes the compatibility check: the tested range can take it`;

// What to do in the issue tracker. open: titles of the open issues. -> { action: 'none' | 'create' | 'comment', title }
// A failure opens one issue per GSD version and comments on it on later nights; a pass of a version above the tested
// range opens one issue saying the range can be widened; a pass of a tested version does nothing.
export function issuePlan({ verdict, version, cls, open }) {
  if (verdict === 'fail') return { action: open.includes(TITLE_FAIL(version)) ? 'comment' : 'create', title: TITLE_FAIL(version) };
  if (cls !== 'tested' && !open.includes(TITLE_PASS(version))) return { action: 'create', title: TITLE_PASS(version) };
  return { action: 'none', title: null };
}

function arg(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'versions') {
    // the registry's short form of the package: every version and the dist-tags
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE.replace('/', '%2f')}`, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
    if (!res.ok) throw new Error(`the npm registry answered ${res.status} for ${PACKAGE}`);
    const meta = await res.json();
    const v = pickVersions(Object.keys(meta.versions ?? {}), meta['dist-tags']?.latest);
    if (!v.base || !v.head) throw new Error(`no version of ${PACKAGE} to compare (base ${v.base}, head ${v.head})`);
    process.stdout.write(`base=${v.base}\nhead=${v.head}\nclass=${v.cls}\n`);
    return 0;
  }
  if (cmd === 'diff') {
    const base = arg(args, '--base');
    const head = arg(args, '--head');
    if (!base || !head) throw new Error('diff needs --base <gsd-tools.cjs> and --head <gsd-tools.cjs>');
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'gsd-compat-'));
    const baseDir = makeProject(path.join(tmp, 'base'));
    const headDir = makeProject(path.join(tmp, 'head'));
    // <package>/gsd-core/bin/gsd-tools.cjs: the GSD's own directory shows in some answers
    const gsdOf = (tool) => path.dirname(path.dirname(path.dirname(path.resolve(tool))));
    const result = compare(runSteps(base, baseDir), runSteps(head, headDir), { baseRoots: { [baseDir]: '<root>', [gsdOf(base)]: '<gsd>' }, headRoots: { [headDir]: '<root>', [gsdOf(head)]: '<gsd>' } });
    const text = reportText({ baseVersion: arg(args, '--base-version') ?? 'base', headVersion: arg(args, '--head-version') ?? 'head', result, steps: STEPS.length });
    if (arg(args, '--report')) fs.writeFileSync(arg(args, '--report'), text);
    process.stdout.write(text);
    if (!args.includes('--keep')) fs.rmSync(tmp, { recursive: true, force: true });
    return result.breaks.length ? 1 : 0;
  }
  if (cmd === 'issue') {
    const verdict = arg(args, '--verdict');
    const version = arg(args, '--version');
    const report = arg(args, '--report');
    if (!['pass', 'fail'].includes(verdict) || !version) throw new Error('issue needs --verdict pass|fail and --version <v>');
    const gh = (...a) => String(execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const open = JSON.parse(gh('issue', 'list', '-R', REPO, '--state', 'open', '--limit', '200', '--json', 'title')).map((i) => i.title);
    const plan = issuePlan({ verdict, version, cls: versionClass(version), open });
    const run = arg(args, '--run');
    const body = `${report && fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : `GSD ${version}: ${verdict}.\n`}${verdict === 'fail' ? '\nThe log of the run names the failing suite or call.\n' : ''}${run ? `\nRun: ${run}\n` : ''}`;
    process.stdout.write(`${plan.action}${plan.title ? `: ${plan.title}` : ''}\n`);
    if (plan.action === 'none' || args.includes('--dry-run')) return 0;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-compat-issue-')), 'body.md');
    fs.writeFileSync(file, body);
    if (plan.action === 'create') process.stdout.write(gh('issue', 'create', '-R', REPO, '--title', plan.title, '--body-file', file));
    else {
      const number = JSON.parse(gh('issue', 'list', '-R', REPO, '--state', 'open', '--limit', '200', '--json', 'title,number')).find((i) => i.title === plan.title).number;
      process.stdout.write(gh('issue', 'comment', String(number), '-R', REPO, '--body-file', file));
    }
    return 0;
  }
  process.stderr.write('usage: gsd-compat.mjs versions | diff --base <gsd-tools.cjs> --head <gsd-tools.cjs> [--report <file>] | issue --verdict pass|fail --version <v> [--report <file>] [--run <url>] [--dry-run]\n');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${String(err?.message ?? err)}\n`);
    process.exitCode = 2;
  }
}

