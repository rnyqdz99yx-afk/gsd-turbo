import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { briefText, capPage, nextSteps, spans } from '../lib/brief.mjs';
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
  // v0.9.1: merged into the main branch with the close still owed (the lane record stays `ready`): never «waits for its merge»
  const merged = nextSteps({ supervisor: { running: false }, phases, lanes: [{ phase: '2', status: 'ready', reason: '', merged: true, closed: false, mergeNote: 'phase.complete failed after the merge of phase 2:\nverification is incomplete; the merge stays' }], questions: [] });
  assert.deepEqual(merged, ["phase 2 is merged into the main branch and not closed yet (GSD's phase.complete is still owed): phase.complete failed after the merge of phase 2: verification is incomplete; the merge stays"]);
  assert.deepEqual(nextSteps({ supervisor: { running: true }, phases, lanes: [{ phase: '2', status: 'ready', reason: '', merged: true, closed: false, mergeNote: '' }], questions: [] }), ["phase 2 is merged into the main branch and not closed yet (GSD's phase.complete is still owed)"]);
  // merged and closed by turbo, GSD not yet reporting it complete: nothing to say about the merge
  assert.deepEqual(nextSteps({ supervisor: { running: true }, phases, lanes: [{ phase: '2', status: 'ready', reason: '', merged: true, closed: true }], questions: [] }), ['the supervisor runs: nothing to do until it asks (turbo-run status --watch shows it)']);
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

test('v0.9.2: the brief names no owner request file of a closed phase, in its own list or in the status lines', () => {
  // seen on obs-chat 2026-11-19: «owner request: .planning/turbo/run/p33-owner.md» for phase 33, closed weeks before
  const page = briefText({
    project: 'demo', at: '2026-11-20T00:00:00.000Z', turbo: '0.9.2', gsd: '1.22.0 (tested)', milestone: 'v1',
    phases: [phase('33', { complete: true }), phase('36', { closed: true }), phase('37')],
    status: ['supervisor: not running', 'owner request: .planning/turbo/run/p33-owner.md', 'owner request: .planning/turbo/run/p37-owner.md'],
    ownerRequests: ['.planning/turbo/run/p33-owner.md', '.planning/turbo/run/p36-owner.md', '.planning/turbo/run/p37-owner.md'],
  });
  assert.ok(!page.includes('p33-owner.md') && !page.includes('p36-owner.md'), page);
  assert.equal(page.split('p37-owner.md').length - 1, 2, page);
  // no phases read (GSD did not answer): every file stays
  const blind = briefText({ project: 'demo', at: 'x', turbo: '0.9.2', gsd: '?', phases: [], ownerRequests: ['.planning/turbo/run/p33-owner.md'] });
  assert.ok(blind.includes('p33-owner.md'), blind);
});

test('v0.10.0: brief --session-start prints the page, framed, for a project turbo runs in; nothing anywhere else, exit 0 always', () => {
  const home = tmpDir('home');
  const run = (cwd, env = {}) => spawnSync(process.execPath, [BIN, 'brief', '--session-start'], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, TURBO_LANE: '', TURBO_BUILD_LANE: '', CLAUDE_CONFIG_DIR: home, ...env } });
  const silent = (r, why) => {
    assert.equal(r.status, 0, `${why}: ${r.stderr}`);
    assert.equal(r.stdout, '', why);
  };
  const p = buildProject();
  setManager(gsdCoreDir(p.root), { milestone_version: 'v1.0', phases: [{ number: '5', name: 'Demo Feature', dep_phases: [], deps_display: '', phase_complete: false, disk_status: 'planned', verification_status: 'missing', is_active: true }] });
  writeLaneStatus(p.root, '5', 'needs-owner', { reason: 'a live step is the owner\'s' });
  const r = run(p.root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^gsd-turbo shows this page at each session start: the state of this project's turbo run, information, not a request\. To turn it off: "brief": \{ "session_start": false \} in \.planning\/turbo\/config\.json\.\n\n# turbo brief: /);
  assert.match(r.stdout, /## Next\n/);
  // turbo's own sessions never get it: the page's Next lines read as licence to a role
  silent(run(p.root, { TURBO_LANE: '1' }), 'a lane, prep or markup session');
  silent(run(p.root, { TURBO_BUILD_LANE: '1' }), 'a build role');
  // the owner turned it off
  const cfg = path.join(p.root, '.planning', 'turbo', 'config.json');
  const before = fs.readFileSync(cfg, 'utf8');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(before), brief: { session_start: false } }));
  silent(run(p.root), 'brief.session_start false');
  // a config turbo cannot read: still no failure of the session start
  fs.writeFileSync(cfg, '{ not json');
  silent(run(p.root), 'a broken config');
  fs.writeFileSync(cfg, before);
  // no turbo here, or turbo set up and never run
  const plain = tmpDir('plain');
  silent(run(plain), 'no .planning at all');
  fs.mkdirSync(path.join(plain, '.planning'));
  silent(run(plain), 'a GSD project without turbo');
  fs.mkdirSync(path.join(plain, '.planning', 'turbo'));
  fs.writeFileSync(path.join(plain, '.planning', 'turbo', 'config.json'), '{}');
  silent(run(plain), 'turbo set up, never run');
});

test('v0.10.0: brief keeps GSD\'s phase list while the roadmap and the phase files stay the same; the session start reads only that', () => {
  // obs-chat 2026-11-20: turbo-run brief took 10.2 s, 9.8 of them gsd-tools init manager: too long for a session start
  const p = buildProject();
  const core = gsdCoreDir(p.root);
  const manager = (v) => setManager(core, { milestone_version: v, phases: [{ number: '5', name: 'Demo Feature', dep_phases: [], deps_display: '', phase_complete: false, disk_status: 'planned', verification_status: 'missing', is_active: true }] });
  writeLaneStatus(p.root, '5', 'needs-owner', { reason: 'x' });
  const run = (...args) => spawnSync(process.execPath, [BIN, 'brief', ...args], { cwd: p.root, encoding: 'utf8', windowsHide: true, env: { ...process.env, TURBO_LANE: '', TURBO_BUILD_LANE: '', CLAUDE_CONFIG_DIR: tmpDir('home') } });
  manager('v1.0');
  assert.match(run().stdout, /## Milestone v1\.0\n/);
  // GSD would answer otherwise now, but nothing GSD reads changed: the kept list
  manager('v2.0');
  assert.match(run('--cached-only').stdout, /## Milestone v1\.0\n/);
  assert.match(run().stdout, /## Milestone v1\.0\n/);
  // the roadmap changed: the session start does not wait for GSD and says so; a plain brief reads GSD again
  fs.appendFileSync(path.join(p.root, '.planning', 'ROADMAP.md'), '\n<!-- changed -->\n');
  assert.match(run('--cached-only').stdout, /- GSD did not list the phases: not read at the session start \(the roadmap or a phase file changed since the last turbo-run brief; it reads them\)\n/);
  assert.match(run().stdout, /## Milestone v2\.0\n/);
  assert.match(run('--cached-only').stdout, /## Milestone v2\.0\n/);
});

test('v0.10.0: the session-start page is capped at a line, and says where the whole page is', () => {
  const page = Array.from({ length: 400 }, (_, i) => `- line ${i} ${'x'.repeat(40)}`).join('\n');
  const capped = capPage(page, 8192);
  assert.ok(Buffer.byteLength(capped) <= 8192, String(Buffer.byteLength(capped)));
  assert.match(capped, /\n- line \d+ x+\n… \(cut at 8 KB: turbo-run brief prints the whole page\)\n$/);
  assert.equal(capPage('short\n', 8192), 'short\n');
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
