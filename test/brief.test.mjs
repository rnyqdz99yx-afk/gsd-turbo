import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { briefText, nextSteps, spans } from '../lib/brief.mjs';
import { buildProject } from './helpers/build-fake.mjs';
import { setManager } from './helpers/fake-gsd.mjs';
import { tmpDir } from './helpers/tmp.mjs';
import { appendInbox } from '../lib/inbox.mjs';
import { writeLaneStatus } from '../lib/run-status.mjs';
import { gsdCoreDir } from '../lib/paths.mjs';

const BIN = fileURLToPath(new URL('../bin/turbo-run.mjs', import.meta.url));
const phase = (number, over = {}) => ({ number, name: `P${number}`, deps: [], complete: false, closed: false, diskStatus: 'planned', verification: null, ...over });

test('spans joins whole numbers that follow each other', () => {
  assert.equal(spans(['24', '25', '26', '28', '30', '31']), '24–26, 28, 30–31');
  assert.equal(spans(['3', '2.1', '2', '1']), '1–2, 2.1, 3');
  assert.equal(spans([]), '');
});

test('nextSteps: questions first, then what waits for the owner, then what the supervisor would do', () => {
  const phases = [phase('1', { complete: true }), phase('2'), phase('3')];
  assert.deepEqual(nextSteps({ supervisor: { running: false }, phases, lanes: [], questions: [] }), ['nothing runs: /turbo-autonomous starts the next phase (2 P2)']);
  assert.deepEqual(nextSteps({ supervisor: { running: true }, phases, lanes: [], questions: [] }), ['the supervisor runs: nothing to do until it asks (turbo-run status --watch shows it)']);
  const busy = nextSteps({ supervisor: { running: true }, phases, lanes: [{ phase: '2', status: 'needs-owner', reason: 'UAT sign-off' }, { phase: '3', status: 'failed', reason: 'build refused' }], questions: [{ id: 'ask-1' }] });
  assert.deepEqual(busy, [
    '1 question(s) wait for an answer: judge each from the logs, then /turbo-autonomous answer (turbo-run questions --json has the details)',
    'phase 2 waits for the owner: UAT sign-off',
    'phase 3 failed: build refused (turbo-run resume 3 after the cause is removed)',
  ]);
  // built and verified, not merged yet; a closed phase's old ready record says nothing
  const ready = nextSteps({ supervisor: { running: false }, phases, lanes: [{ phase: '2', status: 'ready', reason: '' }, { phase: '1', status: 'ready', reason: '' }], questions: [] });
  assert.equal(ready.length, 1);
  assert.match(ready[0], /^phase 2 is built and waits for its merge and close: the supervisor does both once it runs \(\/turbo-autonomous\)/);
  assert.deepEqual(nextSteps({ supervisor: { running: false }, phases: [phase('1', { closed: true })], lanes: [], questions: [] }), ['every phase of the milestone is complete: /gsd-complete-milestone']);
  assert.deepEqual(nextSteps({ supervisor: { running: false, damaged: true }, phases, lanes: [], questions: [] }), ['the supervisor state is damaged: turbo-run start keeps the file aside and rebuilds the lanes']);
});

test('briefText is one page: the milestone, turbo now, the questions, the newest notes of each open phase, the log, what is next', () => {
  const note = (n) => ({ phase: '2', by: 'owner', at: `2026-11-1${n}T10:00:00.000Z`, text: `note ${n}\nsecond line` });
  const text = briefText({
    project: 'app', at: '2026-11-19T12:34:56.000Z', turbo: '0.9.0', gsd: '1.22.0 (tested)', supervisor: { running: false }, milestone: 'v1.0',
    phases: [phase('1', { complete: true }), phase('2', { diskStatus: 'executed', verification: 'gaps_found', deps: ['1'] }), phase('3')],
    status: ['supervisor: not running', 'lane 2: phase 2', '  build over'],
    lanes: [{ phase: '2', status: 'needs-owner', reason: 'a live step' }],
    questions: [{ id: 'ask-4', phase: '2', question: 'Which greeting?\nTwo styles fit.' }],
    ownerRequests: ['.planning/turbo/run/p2-owner.md'],
    notes: [1, 2, 3, 4].map(note),
    kept: [{ phase: '2', rows: [{ id: 'REQ-1', status: 'Pending (waits for a live check)' }] }],
    reports: 'turbo failure reports: 1 not sent',
    log: ['2026-11-19T12:00:00.000Z daemon start pid 1'],
  });
  assert.equal(text, [
    '# turbo brief: app (2026-11-19 12:34 UTC)', '',
    'gsd-turbo 0.9.0 · GSD core 1.22.0 (tested)', '',
    '## Milestone v1.0', '',
    '- 1 of 3 phases closed: 1',
    '- open: 2 P2 · executed · verification gaps_found · after 1',
    '- open: 3 P3 · planned', '',
    '## Turbo now', '',
    '- supervisor: not running', '- lane 2: phase 2', '    build over', '- turbo failure reports: 1 not sent', '',
    '## Waiting for an answer (1)', '',
    '- ask-4 · phase 2: Which greeting? Two styles fit.', '',
    '## Owner request files', '',
    '- .planning/turbo/run/p2-owner.md', '',
    '## Standing notes of the open phases (every role of the phase reads them)', '',
    '- phase 2: 1 earlier note(s) not shown (turbo-run brief --all-notes shows them)',
    '- phase 2, owner, 2026-11-12 10:00 UTC: note 2 second line',
    '- phase 2, owner, 2026-11-13 10:00 UTC: note 3 second line',
    '- phase 2, owner, 2026-11-14 10:00 UTC: note 4 second line', '',
    '## Requirement rows kept open at a phase close', '',
    '- phase 2: REQ-1 «Pending (waits for a live check)»', '',
    '## Last lines of the supervisor log', '',
    '    2026-11-19T12:00:00.000Z daemon start pid 1', '',
    '## Next', '',
    '- 1 question(s) wait for an answer: judge each from the logs, then /turbo-autonomous answer (turbo-run questions --json has the details)',
    '- phase 2 waits for the owner: a live step', '',
  ].join('\n'));
  assert.match(briefText({ project: 'app', at: '2026-11-19T12:34:56.000Z', turbo: '0.9.0', gsd: 'x', notes: [1, 2, 3, 4].map(note) }, { allNotes: true }), /UTC: note 1 second line\n- phase 2, owner/);
  // GSD did not answer: said, and the rest still stands
  const bare = briefText({ project: 'app', at: '2026-11-19T12:34:56.000Z', turbo: '0.9.0', gsd: 'not found', supervisor: { running: false }, phasesError: 'gsd-core not found (run turbo-run doctor)' });
  assert.match(bare, /## Milestone\n\n- GSD did not list the phases: gsd-core not found \(run turbo-run doctor\)\n\n## Turbo now\n\n- no status\n\n## Next\n\n- nothing waits\n$/);
});

test('turbo-run brief prints the page of a project from its own records, and --json the data', () => {
  const p = buildProject();
  setManager(gsdCoreDir(p.root), { milestone_version: 'v1.0', phases: [
    { number: '4', name: 'Before', dep_phases: [], deps_display: '', phase_complete: true, disk_status: 'complete', verification_status: 'passed', is_active: false },
    { number: '5', name: 'Demo Feature', dep_phases: ['4'], deps_display: '4', phase_complete: false, disk_status: 'planned', verification_status: 'missing', is_active: true },
  ] });
  appendInbox(p.root, '5', { kind: 'note', by: 'owner', text: 'no role of this phase deploys anything' });
  writeLaneStatus(p.root, '5', 'needs-owner', { reason: 'a live step is the owner\'s' });
  const run = (...args) => spawnSync(process.execPath, [BIN, 'brief', ...args], { cwd: p.root, encoding: 'utf8', windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir('home') } });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^# turbo brief: ${path.basename(p.root)} \\(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\)\\n\\ngsd-turbo \\d+\\.\\d+\\.\\d+ · GSD core 1\\.16\\.0 \\(tested\\)\\n`));
  assert.match(r.stdout, /## Milestone v1\.0\n\n- 1 of 2 phases closed: 4\n- open: 5 Demo Feature · planned · verification missing · after 4\n/);
  assert.match(r.stdout, /## Turbo now\n\n- supervisor: not running \(never started\)\n/);
  assert.match(r.stdout, /- phase 5, owner, \d{4}-\d\d-\d\d \d\d:\d\d UTC: no role of this phase deploys anything\n/);
  assert.match(r.stdout, /## Next\n\n- nothing runs: \/turbo-autonomous starts the next phase \(5 Demo Feature\)\n$/, 'a lane record without a lane is not a lane');
  const j = JSON.parse(run('--json').stdout);
  assert.deepEqual([j.milestone, j.phases.length, j.notes.length, j.supervisor.running], ['v1.0', 2, 1, false]);
});
