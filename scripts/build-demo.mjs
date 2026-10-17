#!/usr/bin/env node
// The build path's live demo (Stage 6 B4, spec §6.11 item 1): a scratch GSD project with two phases, built phase by
// phase with `turbo-run build <N>` and the real claude (about 20–40 Opus sessions, 30–90 min). Phase 1 has four or more
// slices, one decision that makes a builder ask the owner (answered here with option 1, as the owner would), and a
// committed contract test that the farewell slice turns red, for the fixer to settle by the phase's decision. Then one
// PASS|FAIL line per check; exit 0 only when every check passed. A manual controller step: not installed (install.mjs
// copies bin/, lib/ and roles/ only), never run by the tests (they run --dry-run). The build runs as it would for the
// owner: its sessions use the real Claude config directory and turbo's own home there (session slots, settings).
// --crash (spec §6.11 item 2): once phase 1 has a merged slice and a running one, the build process alone is killed (its
// sessions left as a crash leaves them) and `build 1 --resume` continues; extra checks: no slice merged twice, no step or
// merged slice of before the crash run again.
// Usage: node scripts/build-demo.mjs [--dry-run] [--keep] [--crash] [--dir <path>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { gsdCoreDir } from '../lib/paths.mjs';
import { sessionFreeEnv } from '../lib/claude.mjs';

const BIN = fileURLToPath(new URL('../bin/turbo-run.mjs', import.meta.url));
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
let keep = args.includes('--keep');
const crash = args.includes('--crash');
const at = args.indexOf('--dir');
const dir = path.resolve(at >= 0 && args[at + 1] ? args[at + 1] : path.join(os.tmpdir(), `turbo-build-demo-${randomBytes(3).toString('hex')}`));

const put = (rel, text) => {
  const f = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const git = (...a) => String(execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })).trim();

const ROADMAP = `# Roadmap: Greeting

## Phases

- [ ] **Phase 1: Greeting library** - greet, farewell, shout and format
- [ ] **Phase 2: Greeting CLI** - a command line for the library

## Phase Details

### Phase 1: Greeting library
**Goal**: A small greeting library: greet, farewell, shout and format
**Depends on**: Nothing (first phase)
**Requirements**: GREET-01, GREET-02, GREET-03, GREET-04
**Success Criteria** (what must be TRUE):
  1. greet('Ann') returns Hello, Ann!
  2. farewell('Ann') returns Goodbye, Ann.
  3. node --test passes

### Phase 2: Greeting CLI
**Goal**: A command line for the greeting library
**Depends on**: Phase 1
**Requirements**: CLI-01, CLI-02
**Success Criteria** (what must be TRUE):
  1. node cli.js greet Ann prints Hello, Ann!
  2. node --test passes

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Greeting library | 0/0 | Not started | - |
| 2. Greeting CLI | 0/0 | Not started | - |
`;

const REQUIREMENTS = `# Requirements: Greeting

## v1 Requirements

- [ ] **GREET-01**: greet(name) greets by name
- [ ] **GREET-02**: farewell(name) says goodbye by name
- [ ] **GREET-03**: shout(text) upper-cases a greeting
- [ ] **GREET-04**: format(name) formats a greeting in the chosen language
- [ ] **CLI-01**: node cli.js greet <name> prints the greeting
- [ ] **CLI-02**: node cli.js farewell <name> prints the farewell

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| GREET-01 | Phase 1 | Pending |
| GREET-02 | Phase 1 | Pending |
| GREET-03 | Phase 1 | Pending |
| GREET-04 | Phase 1 | Pending |
| CLI-01 | Phase 2 | Pending |
| CLI-02 | Phase 2 | Pending |
`;

const STATE = `---
gsd_state_version: '1.0'
status: planning
---

# Project State

## Current Position

Phase: 1 of 2 (Greeting library)
Plan: 0 of 0 in current phase
Status: Ready to plan
Last activity: 2026-10-17 — context gathered

## Session Continuity

Last session: 2026-10-17
Stopped at: context gathered
Resume file: None
`;

const context = (n, name, decisions) => `# Phase ${n}: ${name} - Context

**Gathered:** 2026-10-17
**Status:** Ready for planning

<domain>
## Phase Boundary

${name}, in plain Node.js (CommonJS, no dependencies), tested with node --test.

</domain>

<decisions>
## Implementation Decisions

### ${name}
${decisions.map(([id, text]) => `- **${id}:** ${text}`).join('\n')}

### Claude's Discretion
File layout under src/ and test/.

</decisions>
`;

function scaffold() {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, windowsHide: true });
  git('config', 'user.email', 'demo@example.invalid');
  git('config', 'user.name', 'turbo build demo');
  git('config', 'commit.gpgsign', 'false');
  put('package.json', `${JSON.stringify({ name: 'greeting', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`);
  put('.gitignore', 'node_modules/\n');
  put('.planning/PROJECT.md', '# Greeting\n\nA tiny greeting library and its command line: the build path demo of gsd-turbo.\n');
  put('.planning/ROADMAP.md', ROADMAP);
  put('.planning/REQUIREMENTS.md', REQUIREMENTS);
  put('.planning/STATE.md', STATE);
  put('.planning/config.json', '{}\n');
  put('.planning/phases/01-greeting-library/01-CONTEXT.md', context(1, 'Greeting library', [
    ['D-01', 'greet(name) returns `Hello, <name>!`'],
    ['D-02', 'farewell(name) returns `Goodbye, <name>.`'],
    ['D-03', 'shout(text) returns the text upper-cased'],
    ['D-04', 'the language of format is the owner\'s choice: the builder of format asks the owner before building it'],
  ]));
  put('.planning/phases/02-greeting-cli/02-CONTEXT.md', context(2, 'Greeting CLI', [
    ['D-01', '`node cli.js greet <name>` prints greet(name); `node cli.js farewell <name>` prints farewell(name)'],
  ]));
  // the deliberate red: D-02 says otherwise, so the merge of the farewell slice turns it red
  put('test/contract.test.js', "const test = require('node:test');\nconst assert = require('node:assert');\ntest('farewell contract', () => assert.equal(require('../src/farewell.js')('Ann'), 'Bye, Ann!'));\n");
  put('.planning/turbo/.gitignore', 'run/\nlogs/\nlocks/\n');
  put('.planning/turbo/config.json', `${JSON.stringify({ lang: 'en', build: { enabled: true, max_builders: 4 }, test: { full: 'node --test' } }, null, 2)}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: greeting demo project');
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const runDir = path.join(dir, '.planning', 'turbo', 'run');

const stepSessions = (p) => {
  const n = {};
  for (const c of readJson(path.join(runDir, `cost-p${p}.json`))?.sessions ?? []) n[c.step] = (n[c.step] ?? 0) + 1;
  return n;
};
// What the crash leaves: the merged slices and their sessions, the steps done and their session counts.
let crashed = null;
const crashSnapshot = (p, state, pid) => ({
  phase: p,
  pid,
  at: new Date().toISOString(),
  merged: Object.fromEntries(Object.entries(state.slices ?? {}).filter(([, s]) => s.state === 'merged').map(([id, s]) => [id, (s.sessions ?? []).length])),
  running: Object.entries(state.slices ?? {}).filter(([, s]) => ['dispatched', 'running'].includes(s.state)).map(([id]) => id),
  steps: Object.entries(state.steps ?? {}).filter(([, s]) => s.state === 'done' || s.state === 'skipped').map(([k]) => k),
  sessions: stepSessions(p),
});

// One phase built by `turbo-run build <p>`, its output mirrored; open cards answered with option 1 every 10 s.
async function buildPhase(p) {
  const env = sessionFreeEnv();
  const answered = new Set();
  const once = async (resume) => {
    console.log(`build ${p}: turbo-run build ${p}${resume ? ' --resume' : ''} --project ${dir}`);
    const child = spawn(process.execPath, [BIN, 'build', String(p), '--project', dir, ...(resume ? ['--resume'] : [])], { cwd: dir, env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    const watch = crash && p === 1 && !crashed && setInterval(() => {
      const st = readJson(path.join(runDir, `build-p${p}.json`));
      const slices = Object.values(st?.slices ?? {});
      if (st?.step !== 'build' || !slices.some((s) => s.state === 'merged') || !slices.some((s) => s.state === 'running')) return;
      crashed = crashSnapshot(p, st, child.pid);
      clearInterval(watch);
      console.log(`crash: kills build ${p} (pid ${child.pid}) with merged ${Object.keys(crashed.merged).join(', ')} and running ${crashed.running.join(', ')}`);
      child.kill('SIGKILL');
    }, 5000);
    const code = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? 1)));
    if (watch) clearInterval(watch);
    return code;
  };
  const timer = setInterval(() => {
    for (const q of readJson(path.join(runDir, `p${p}-questions.json`)) ?? []) {
      if (q?.state !== 'open' || answered.has(q.id)) continue;
      const r = spawnSync(process.execPath, [BIN, 'answer', String(p), q.id, '--option', '1', '--by', 'session', '--project', dir], { cwd: dir, env, encoding: 'utf8', windowsHide: true });
      if (r.status === 0) {
        answered.add(q.id);
        console.log(`answered ${q.id}: ${q.question}`);
      }
    }
  }, 10000);
  let code = await once(false);
  if (crashed && crashed.phase === p && !crashed.resumed) {
    crashed.resumed = true;
    code = await once(true);
  }
  clearInterval(timer);
  return code;
}

function gsd(...a) {
  const core = gsdCoreDir(dir);
  if (!core) return null;
  const r = spawnSync(process.execPath, [path.join(core, 'bin', 'gsd-tools.cjs'), ...a, '--cwd', dir], { encoding: 'utf8', windowsHide: true });
  const s = String(r.stdout ?? '');
  try {
    return JSON.parse(s.slice(s.search(/[{[]/)));
  } catch {
    return null;
  }
}

async function main() {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} exists and is not empty`);
  scaffold();
  if (dry) {
    console.log(`DRY ${dir}: 2 phases, ready to build`);
    if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    return 0;
  }
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  const codes = {};
  for (const p of [1, 2]) {
    codes[p] = await buildPhase(p);
    check(`build ${p} exit 0`, codes[p] === 0, `exit ${codes[p]}`);
    if (codes[p] !== 0) break;
  }
  const s1 = readJson(path.join(runDir, 'build-p1.json'));
  const slices = Object.entries(s1?.slices ?? {});
  check('phase 1 merged ≥ 4 slices', slices.filter(([, s]) => s.state === 'merged').length >= 4, `${slices.length} slices`);
  const spans = slices.map(([, s]) => [Date.parse(s.at?.running), Date.parse(s.at?.merged)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  check('two slices of phase 1 built at the same time', spans.some(([a, b], i) => spans.some(([c, d], j) => i !== j && a < d && c < b)));
  const cards = [1, 2].flatMap((p) => readJson(path.join(runDir, `p${p}-questions.json`)) ?? []);
  check('a card was asked and answered', cards.some((q) => q.held && q.state === 'delivered'));
  const cost1 = readJson(path.join(runDir, 'cost-p1.json'))?.sessions ?? [];
  check('a red merge was fixed by one fixer', cost1.some((c) => c.step === 'build' && c.role === 'fixer') && !slices.some(([, s]) => s.tests === 'red'));
  check('review and verification ran', cost1.some((c) => c.step === 'review') && cost1.some((c) => c.step === 'verify'));
  const manager = gsd('init', 'manager')?.phases ?? [];
  check('GSD sees both phases complete', ['1', '2'].every((n) => manager.some((x) => String(x.number) === n && x.disk_status === 'complete' && x.roadmap_complete === true)));
  for (const [n, rel] of [['1', '.planning/phases/01-greeting-library'], ['2', '.planning/phases/02-greeting-cli']]) {
    check(`phase ${n} verification status passed`, gsd('verification', 'status', rel)?.status === 'passed');
  }
  if (crash) {
    check('crash: build 1 was killed mid-build and resumed', crashed?.resumed, crashed ? `at ${crashed.at}` : 'no moment with a merged and a running slice');
    if (crashed) {
      const merges = git('log', '--format=%s', '--merges').split(/\r?\n/).map((l) => /merge slice (\S+)$/.exec(l)?.[1]).filter(Boolean);
      const twice = [...new Set(merges.filter((id, i) => merges.indexOf(id) !== i))];
      check('crash: no slice merged twice', twice.length === 0, twice.join(', '));
      const rebuilt = Object.entries(crashed.merged).filter(([id, n]) => (s1?.slices?.[id]?.sessions ?? []).length !== n).map(([id]) => id);
      check('crash: no slice merged before the crash built again', rebuilt.length === 0, rebuilt.join(', '));
      const after = stepSessions(1);
      const again = crashed.steps.filter((k) => (after[k] ?? 0) !== (crashed.sessions[k] ?? 0));
      check('crash: no step done before the crash ran again', again.length === 0, again.join(', '));
      console.log(`crash: snapshot ${JSON.stringify(crashed)}`);
    }
  }
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
  for (const p of [1, 2]) spawnSync(process.execPath, [BIN, 'cost', String(p), '--project', dir], { cwd: dir, stdio: 'inherit', windowsHide: true });
  const all = checks.every((c) => c.ok);
  if (!all) keep = true;
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  else console.log(`kept: ${dir} (logs: .planning/turbo/logs/supervisor.log, build-p<N>.log; state: .planning/turbo/run/build-p<N>.json)`);
  return all ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (err) => {
  console.error(`build-demo: ${err?.stack || err}`);
  process.exitCode = 1;
});
