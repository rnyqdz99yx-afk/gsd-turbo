import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpGitRepo } from './helpers/tmp.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { gsdCoreDir } from '../lib/paths.mjs';
import { readVersion, versionInRange } from '../lib/gsd.mjs';

const PHASE_REL = '.planning/phases/05-demo';

// A project in the middle of phase 5: four plans, the first two with a SUMMARY.
function fixture({ summaries = 2, plans = 4 } = {}) {
  const root = tmpGitRepo();
  const dir = path.join(root, PHASE_REL);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{}\n');
  fs.writeFileSync(path.join(root, '.planning', 'ROADMAP.md'), [
    '# Roadmap: Demo', '', '## Phases', '', '- [ ] **Phase 5: Demo Feature** - the demo', '', '## Phase Details', '',
    '### Phase 5: Demo Feature', '**Goal**: ship the demo', '**Depends on**: Nothing (first phase)', 'Plans:',
    ...Array.from({ length: plans }, (_, i) => `- [ ] 05-0${i + 1}-PLAN.md`), '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, '.planning', 'STATE.md'), [
    '---', "gsd_state_version: '1.0'", 'status: planning', '---', '', '# Project State', '', '## Current Position', '',
    'Phase: 5 of 5 (Demo Feature)', `Plan: 0 of ${plans} in current phase`, 'Status: Ready to execute', 'Last activity: 2026-01-01 — planned', '',
    '## Session Continuity', '', 'Last session: 2026-01-01', 'Stopped at: planned', 'Resume file: None', '',
  ].join('\n'));
  for (let i = 1; i <= plans; i++) {
    fs.writeFileSync(path.join(dir, `05-0${i}-PLAN.md`), `---\nphase: 05-demo\nplan: 0${i}\nwave: ${i}\ndepends_on: []\nfiles_modified: [src/f${i}.js]\nautonomous: true\n---\n\n# Plan 0${i}\n`);
    if (i <= summaries) fs.writeFileSync(path.join(dir, `05-0${i}-SUMMARY.md`), `---\nphase: 05-demo\nplan: 0${i}\nstatus: complete\n---\n\n# Summary\n`);
  }
  return root;
}

// Answers like gsd-tools 1.16 for the fixture and records every call.
function fakeGsd(root, { found = true } = {}) {
  const calls = [];
  const gsd = (args) => {
    calls.push(args);
    const [cmd, sub] = args;
    if (cmd === 'init') return found ? { phase_found: true, phase_dir: `${root.replace(/\\/g, '/')}/${PHASE_REL}`, phase_number: '05', phase_name: 'Demo Feature' } : { phase_found: false, phase_dir: null, phase_number: null };
    if (cmd === 'phase-plan-index') {
      const files = fs.readdirSync(path.join(root, PHASE_REL));
      const plans = files.filter((f) => f.endsWith('-PLAN.md')).sort().map((f) => ({ id: f.slice(0, -8), has_summary: files.includes(f.replace('-PLAN.md', '-SUMMARY.md')) }));
      return { phase: sub, plans, incomplete: plans.filter((p) => !p.has_summary).map((p) => p.id) };
    }
    if (cmd === 'state') return sub === 'patch' ? { updated: ['Plan'], failed: [] } : { recorded: true };
    if (cmd === 'commit') return { committed: true, hash: 'abc1234', reason: 'committed' };
    throw new Error(`unexpected gsd-tools ${args.join(' ')}`);
  };
  return { gsd, calls };
}

async function sync(root, deps, phase = '05') {
  const lines = [];
  const code = await runPhaseCommand('state-sync', [phase], { root, out: (l) => lines.push(l), err: (l) => lines.push(l), deps });
  return { code, lines };
}

test('state-sync names the real position through GSD\'s own state commands: phase, executing, the first plan without a SUMMARY', async () => {
  const root = fixture();
  const { gsd, calls } = fakeGsd(root);
  const r = await sync(root, { gsd, now: new Date(2026, 9, 10, 12) });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['init', 'execute-phase'], ['phase-plan-index', '05'], ['state', 'patch'], ['state', 'record-session'], ['commit', 'docs(phase-05): record the resume position in STATE.md']]);
  assert.equal(calls[0][2], '5', 'init gets the phase as given; GSD answers with its own token');
  assert.deepEqual(JSON.parse(calls[2][2]), {
    Phase: '05 (Demo Feature) — EXECUTING',
    Plan: '3 of 4',
    'Current Plan': '3',
    'Total Plans in Phase': '4',
    Status: 'Executing Phase 05',
    'Last activity': '2026-10-10 — Phase 05 stopped; next plan 05-03',
  });
  assert.deepEqual(calls[3].slice(2), ['--stopped-at', 'Phase 05: 2 of 4 plans done; next plan 05-03', '--resume-file', `${PHASE_REL}/05-03-PLAN.md`]);
  assert.deepEqual(calls[4].slice(2), ['--files', '.planning/STATE.md']);
  assert.deepEqual(r.lines, ['STATE.md: phase 05 executing, next plan 05-03 (3 of 4); committed']);
  assert.ok(!calls.some((c) => c[0] === 'state' && ['begin-phase', 'planned-phase', 'advance-plan', 'sync'].includes(c[1])));
});

test('state-sync points the resume file at the handoff gsd-pause-work wrote, when there is one', async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, PHASE_REL, '.continue-here.md'), '# handoff\n');
  const { gsd, calls } = fakeGsd(root);
  await sync(root, { gsd });
  assert.deepEqual(calls.find((c) => c[1] === 'record-session').slice(-2), ['--resume-file', `${PHASE_REL}/.continue-here.md`]);
});

test('state-sync leaves STATE.md alone without plans, with every plan summarized, or without a phase directory', async () => {
  for (const [opts, why] of [[{ plans: 0, summaries: 0 }, 'no plans yet'], [{ summaries: 4 }, 'every plan has a summary'], [{ found: false }, 'phase 5 has no phase directory']]) {
    const root = fixture(opts);
    const { gsd, calls } = fakeGsd(root, opts);
    const r = await sync(root, { gsd }, '5');
    assert.equal(r.code, 0);
    assert.deepEqual(r.lines, [`STATE.md: left as it is (${why})`]);
    assert.ok(!calls.some((c) => c[0] === 'state' || c[0] === 'commit'), why);
  }
});

// begin-phase must take its first-run branch for a phase whose execution never started
test('state-sync does nothing before execution started (no SUMMARY, step gates-off not done); gates-off done is enough', async () => {
  const root = fixture({ summaries: 0 });
  let { gsd, calls } = fakeGsd(root);
  let r = await sync(root, { gsd });
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, ['STATE.md: left as it is (execution of phase 05 has not started: no plan has a SUMMARY and step gates-off is not done)']);
  assert.ok(!calls.some((c) => c[0] === 'state' || c[0] === 'commit'));
  fs.mkdirSync(path.join(root, '.planning', 'turbo', 'run'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'run', 'phase-p5.json'), JSON.stringify({ phase: '5', done: ['freshness', 'discuss', 'prologue', 'plan', 'gates-off'] }));
  ({ gsd, calls } = fakeGsd(root));
  r = await sync(root, { gsd });
  assert.deepEqual(r.lines, ['STATE.md: phase 05 executing, next plan 05-01 (1 of 4); committed']);
});

test('state-sync fails with GSD\'s error line when a state command fails', async () => {
  const root = fixture();
  const { gsd } = fakeGsd(root);
  const broken = (args) => (args[0] === 'state' ? { error: 'STATE.md not found' } : gsd(args));
  const r = await sync(root, { gsd: broken });
  assert.equal(r.code, 1);
  assert.match(r.lines.at(-1), /^turbo-run state-sync: gsd-tools state patch: STATE\.md not found$/);
});

// Against the installed GSD core when it is the tested version (skipped elsewhere): the position state-sync
// writes survives the begin-phase call every execute-phase run starts with, and undoes planned-phase's flip.
const core = gsdCoreDir(null);
const realGsd = core && versionInRange(readVersion(core) || '');
test('state-sync with the installed GSD 1.16: begin-phase keeps the synced plan; planned-phase\'s flip is undone', { skip: !realGsd && 'GSD 1.16 is not installed' }, async () => {
  const root = fixture();
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: root });
  const tool = (...args) => execFileSync(process.execPath, [path.join(core, 'bin', 'gsd-tools.cjs'), ...args, '--cwd', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const position = () => /## Current Position\r?\n\r?\n([\s\S]*?)\r?\n\r?\n/.exec(fs.readFileSync(path.join(root, '.planning', 'STATE.md'), 'utf8'))[1].split(/\r?\n/);
  tool('state', 'begin-phase', '--phase', '05', '--name', 'Demo Feature', '--plans', '4');
  assert.equal(position()[1], 'Plan: 1 of 4', 'what a first begin-phase leaves mid-phase');
  let r = await sync(root, {});
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.deepEqual(position().slice(0, 3), ['Phase: 05 (Demo Feature) — EXECUTING', 'Plan: 3 of 4', 'Status: Executing Phase 05']);
  const state = fs.readFileSync(path.join(root, '.planning', 'STATE.md'), 'utf8');
  assert.match(state, /^status: executing$/m);
  assert.match(state, /^Stopped at: Phase 05: 2 of 4 plans done; next plan 05-03$/m);
  assert.match(state, /^Resume file: \.planning\/phases\/05-demo\/05-03-PLAN\.md$/m);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', '.planning/STATE.md'], { cwd: root, encoding: 'utf8' }), '', 'committed');
  tool('state', 'begin-phase', '--phase', '05', '--name', 'Demo Feature', '--plans', '4');
  assert.deepEqual(position().slice(0, 3), ['Phase: 05 (Demo Feature) — EXECUTING', 'Plan: 3 of 4', 'Status: Executing Phase 05'], 'the resume branch keeps the plan');
  tool('state', 'planned-phase', '--phase', '05', '--name', 'Demo Feature', '--plans', '4');
  assert.equal(position()[0], 'Phase: 05 (Demo Feature) — READY TO EXECUTE');
  r = await sync(root, {});
  assert.deepEqual(position().slice(0, 3), ['Phase: 05 (Demo Feature) — EXECUTING', 'Plan: 3 of 4', 'Status: Executing Phase 05']);
});
