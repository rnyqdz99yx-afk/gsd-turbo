import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { SESSION, entry, jsonl, projectDirFor, setMtime, usage, writeAgent, writeJob, writeSession } from './helpers/transcripts.mjs';
import { completeStep } from '../lib/phase-progress.mjs';
import { writeLaneStatus } from '../lib/run-status.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';
import { maskSecrets } from '../lib/secrets.mjs';
import { buildView, formatView, openQuestions, pushOf, recentCommits, stallMs } from '../lib/view.mjs';
import { DEFAULTS, viewRefreshSeconds } from '../lib/config.mjs';

const NOW = new Date('2026-01-01T11:00:00.000Z');
const at = (hhmm) => `2026-01-01T${hhmm}:00.000Z`;
const COMMITS = () => [{ sha: 'abc1234', subject: 'feat: something' }];
const runDirOf = (root) => path.join(root, '.planning', 'turbo', 'run');
const LEAK = `ghp_${'s'.repeat(36)}`;

// A project with a supervisor lane for phase 32 and its transcripts in a separate Claude home.
function laneProject({ run = true } = {}) {
  const root = tmpDir('view');
  fs.mkdirSync(path.join(root, '.planning'));
  if (run) fs.mkdirSync(runDirOf(root), { recursive: true });
  const home = tmpDir('home');
  const dir = projectDirFor(home, root);
  const sup = { pid: 4242, updatedAt: at('10:59'), finished: false, halted: false, range: { from: '32', to: '34' }, lane: { phase: '32', sessionId: SESSION.slice(0, 8), launchedAt: at('09:48'), mode: 'full', restarts: 0 } };
  return { root, home, dir, sup, env: { CLAUDE_CONFIG_DIR: home } };
}

const agentEntries = (id, from, to, tokens = 166000) => [
  entry.agentUser(id, 'Execute the plan', at(from)),
  entry.assistant({ ts: at(to), tool: { name: 'Bash', input: { command: 'node --test test/x.test.mjs' } }, usage: usage(0, 0, tokens), sidechain: true }),
];

test('without supervisor.json the view has no supervisor and no lanes, and still lists questions and commits', () => {
  const { root, env } = laneProject();
  const v = buildView({ root, sup: null, env, now: NOW, commits: COMMITS });
  assert.deepEqual(v, { v: 1, at: NOW.toISOString(), supervisor: null, range: null, lanes: [], questions: [], commits: COMMITS(), ui: { lang: 'en', refreshSeconds: 3, utcOffsetMinutes: -NOW.getTimezoneOffset() } });
});

test('the view shows supervisor, range, the lane with its step, record and subagents, open questions and commits', () => {
  const { root, dir, sup, env } = laneProject();
  for (const s of ['freshness', 'discuss', 'prologue', 'plan', 'gates-off']) completeStep(root, '32', s, { note: s === 'plan' ? `path same-agent ${LEAK}` : '' });
  writeLaneStatus(root, '32', 'needs-owner', { reason: `checkpoint 32-09 (${LEAK})`, at: at('10:40') });
  writeSession(dir, SESSION, [entry.user('run phase 32', at('09:48')), entry.launched('toolu_1', 'a2000000000000001', at('10:00')), entry.launched('toolu_2', 'a2000000000000002', at('10:20')), entry.note('a2000000000000001', 'completed', at('10:30'))]);
  setMtime(writeAgent(dir, SESSION, 'a2000000000000001', agentEntries('a2000000000000001', '10:00', '10:30')), new Date(at('10:30')));
  setMtime(writeAgent(dir, SESSION, 'a2000000000000002', agentEntries('a2000000000000002', '10:20', '10:58', 41000), { agentType: 'gsd-executor', description: 'Continue plan 32-08 from Task 2', spawnDepth: 1 }), new Date(at('10:58')));
  writeJsonAtomic(path.join(runDirOf(root), 'p32-questions.json'), [
    { id: 'q1', phase: '32', plan: '32-09', task: '3', kind: 'decision', header: 'Deploy', question: 'Deploy after green CI?', options: [], state: 'open' },
    { id: 'q2', phase: '32', plan: '32-10', task: '1', kind: 'verify', header: 'Check', question: 'Looks right?', options: [], state: 'answered' },
  ]);
  const v = buildView({ root, sup, running: true, config: { stall_minutes: 15 }, env, now: NOW, commits: COMMITS });
  assert.deepEqual(v.supervisor, { running: true, pid: 4242, finished: false, halted: false, failingSince: null, updatedAt: at('10:59') });
  assert.deepEqual(v.range, { from: '32', to: '34' });
  const [lane] = v.lanes;
  assert.deepEqual([lane.phase, lane.step, lane.status, lane.mode, lane.sessionId, lane.elapsedMs], ['32', 'execute', 'needs-owner', 'full', SESSION.slice(0, 8), 72 * 60000]);
  assert.equal(lane.reason, `checkpoint 32-09 (${maskSecrets(LEAK)})`);
  assert.equal(lane.notes.plan, `path same-agent ${maskSecrets(LEAK)}`);
  assert.deepEqual(lane.agents.map((a) => [a.agentId, a.state, a.plan, a.task, a.tokens]), [['a2000000000000002', 'running', '32-08', '2', 41000], ['a2000000000000001', 'completed', '32-07', null, 166000]]);
  assert.deepEqual(v.questions.map((q) => q.id), ['q1']);
  assert.deepEqual(v.commits, COMMITS());
  assert.equal(JSON.stringify(v).includes(LEAK), false);
});

test('a lane record from before the lane launched does not count; a lane without its transcript has no agents', () => {
  const { root, sup, env } = laneProject();
  writeLaneStatus(root, '32', 'failed', { at: at('09:00') });
  const [lane] = buildView({ root, sup, env, now: NOW, commits: COMMITS }).lanes;
  assert.deepEqual([lane.status, lane.reason, lane.transcript, lane.agents, lane.quiet], ['running', '', null, [], false]);
});

test('a woken or resumed lane: the view follows the job state to the transcript the job runs on, not the stale file its id prefixes', () => {
  const { root, home, dir, sup, env } = laneProject();
  const current = '99999999-8888-4777-8666-555555555555';
  setMtime(writeSession(dir, SESSION, [entry.launched('toolu_1', 'a2000000000000001', at('10:00'))]), new Date(at('10:59')));
  const file = writeSession(dir, current, [entry.launched('toolu_2', 'a2000000000000002', at('10:40'))]);
  setMtime(file, new Date(at('10:50')));
  writeAgent(dir, SESSION, 'a2000000000000001', agentEntries('a2000000000000001', '10:00', '10:30'));
  writeAgent(dir, current, 'a2000000000000002', agentEntries('a2000000000000002', '10:40', '10:50'));
  writeJob(home, SESSION.slice(0, 8), { sessionId: SESSION, resumeSessionId: current, linkScanPath: file });
  const [lane] = buildView({ root, sup, env, now: NOW, commits: COMMITS }).lanes;
  assert.equal(lane.transcript, file);
  assert.deepEqual(lane.agents.map((a) => a.agentId), ['a2000000000000002']);
});

test('the cache lets the next view read only what was appended; it is written only into an existing run directory and a corrupt one is ignored', () => {
  const { root, dir, sup, env } = laneProject();
  const laneFile = writeSession(dir, SESSION, [entry.launched('toolu_1', 'a2000000000000001', at('10:00'))]);
  writeAgent(dir, SESSION, 'a2000000000000001', agentEntries('a2000000000000001', '10:00', '10:30'));
  const cacheFile = path.join(runDirOf(root), 'view-cache.json');
  buildView({ root, sup, env, now: NOW, commits: COMMITS });
  const first = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(first.files[laneFile].read, fs.statSync(laneFile).size);
  fs.appendFileSync(laneFile, jsonl([entry.note('a2000000000000001', 'completed', at('10:31'))]));
  const v = buildView({ root, sup, env, now: NOW, commits: COMMITS });
  assert.equal(v.lanes[0].agents[0].state, 'completed');
  const second = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(second.files[laneFile].read, fs.statSync(laneFile).size - first.files[laneFile].size);
  fs.writeFileSync(cacheFile, '{"v":1,"files":{"x":');
  assert.equal(buildView({ root, sup, env, now: NOW, commits: COMMITS }).lanes[0].agents[0].state, 'completed');
  const bare = laneProject({ run: false });
  writeSession(bare.dir, SESSION, [entry.user('go', at('10:00'))]);
  buildView({ root: bare.root, sup: bare.sup, env: bare.env, now: NOW, commits: COMMITS });
  assert.equal(fs.existsSync(path.join(bare.root, '.planning', 'turbo')), false);
});

test('stall_minutes sets the quiet threshold; a value below 1 or not a number takes the default 15', () => {
  assert.equal(stallMs({ stall_minutes: 1 }), 60000);
  assert.equal(stallMs({ stall_minutes: 0 }), 15 * 60000);
  assert.equal(stallMs({ stall_minutes: 'x' }), 15 * 60000);
  assert.equal(stallMs({}), 15 * 60000);
  const { root, dir, sup, env } = laneProject();
  writeSession(dir, SESSION, [entry.launched('toolu_1', 'a2000000000000001', at('10:00'))]);
  setMtime(writeAgent(dir, SESSION, 'a2000000000000001', agentEntries('a2000000000000001', '10:00', '10:55')), new Date(at('10:55')));
  assert.equal(buildView({ root, sup, config: { stall_minutes: 15 }, env, now: NOW, commits: COMMITS }).lanes[0].agents[0].state, 'running');
  assert.equal(buildView({ root, sup, config: { stall_minutes: 2 }, env, now: NOW, commits: COMMITS }).lanes[0].agents[0].state, 'quiet');
});

test('openQuestions reads every phase file in phase order and skips files that are not a list', () => {
  const root = tmpDir('q');
  const run = runDirOf(root);
  fs.mkdirSync(run, { recursive: true });
  writeJsonAtomic(path.join(run, 'p10-questions.json'), [{ id: 'b', state: 'open' }]);
  writeJsonAtomic(path.join(run, 'p9-questions.json'), [{ id: 'a', state: 'open' }, { id: 'n', state: 'answered' }, null, { state: 'open' }]);
  writeJsonAtomic(path.join(run, 'p11-questions.json'), { questions: [] });
  assert.deepEqual(openQuestions(root).map((q) => q.id), ['a', 'b']);
  assert.deepEqual(openQuestions(tmpDir('none')), []);
});

test('open questions show their text and signals with secrets masked; ids, rev, state, plan, task and agentId stay as written', () => {
  const root = tmpDir('qm');
  const run = runDirOf(root);
  fs.mkdirSync(run, { recursive: true });
  // view only displays: an answer is given from the questions file, not from what view prints
  const option = { label: `Use ${LEAK}`, description: `rotate ${LEAK} first`, recommended: true, signal: `approved ${LEAK}` };
  const q = { id: 'q1', rev: 3, phase: '32', plan: '32-09', task: '3', kind: 'decision', header: `H ${LEAK}`, question: `Deploy with ${LEAK}?`, context: `the deploy key is ${LEAK}`, condition: `CI green for ${LEAK}`, options: [option, 'odd'], allowOther: true, agentId: 'a2000000000000001', state: 'open' };
  writeJsonAtomic(path.join(run, 'p32-questions.json'), [q]);
  const [shown] = openQuestions(root);
  assert.equal(JSON.stringify(shown).includes(LEAK), false);
  const m = maskSecrets;
  assert.deepEqual(shown, {
    ...q,
    header: m(q.header), question: m(q.question), context: m(q.context), condition: m(q.condition),
    options: [{ ...option, label: m(option.label), description: m(option.description), signal: m(option.signal) }, 'odd'],
  });
});

test('recentCommits lists the last five subjects with secrets masked; none outside a repository', () => {
  const repo = tmpGitRepo();
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  for (let i = 1; i <= 6; i++) git('commit', '-q', '--allow-empty', '-m', i === 6 ? `fix: rotate ${LEAK}` : `feat: step ${i}`);
  const c = recentCommits(repo);
  assert.equal(c.length, 5);
  assert.equal(c[0].subject, `fix: rotate ${maskSecrets(LEAK)}`);
  assert.equal(c[4].subject, 'feat: step 2');
  assert.match(c[0].sha, /^[0-9a-f]{7,}$/);
  assert.deepEqual(recentCommits(tmpDir('nogit')), []);
});

test('a warm view of a lane with 20 subagents and large transcripts, in a project with 300 older sessions, answers within 300 ms (Review Focus 3)', () => {
  const { root, dir, sup, env } = laneProject();
  const pad = entry.user('p'.repeat(4000), at('10:00'));
  const ids = Array.from({ length: 20 }, (_, i) => `a3${String(i).padStart(15, '0')}`);
  writeSession(dir, SESSION, [...Array(1200).fill(pad), ...ids.map((id, i) => entry.launched(`toolu_${i}`, id, at('10:00')))]);
  for (const id of ids) writeAgent(dir, SESSION, id, [...Array(250).fill(entry.agentUser(id, 'q'.repeat(4000), at('10:00'))), ...agentEntries(id, '10:00', '10:50')]);
  for (let i = 0; i < 300; i++) {
    const old = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    writeSession(dir, old, [entry.user('old', at('08:00'))]);
    writeAgent(dir, old, `a5${String(i).padStart(15, '0')}`, agentEntries('a5', '08:00', '08:30'));
  }
  buildView({ root, sup, env, now: NOW, commits: COMMITS });
  const t0 = process.hrtime.bigint();
  const v = buildView({ root, sup, env, now: NOW, commits: COMMITS });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(v.lanes[0].agents.length, 20);
  // the spec's 300 ms on a developer machine; shared CI runners (slow Windows ones above all) get more room
  const budget = process.env.CI ? 1500 : 300;
  assert.ok(ms < budget, `warm view took ${ms.toFixed(0)} ms (budget ${budget} ms)`);
});

// A view as buildView returns it, for the text form: phase 32 executing, a question waiting.
function textView(over = {}, lane = {}) {
  return {
    v: 1, at: NOW.toISOString(),
    supervisor: { running: true, pid: 4242, finished: false, halted: false, failingSince: null, updatedAt: null },
    range: { from: '32', to: null },
    lanes: [{
      phase: '32', step: 'execute', status: 'running', reason: '', quiet: false, sessionId: '1a2b3c4d', elapsedMs: 72 * 60000, lastAt: at('10:59'),
      agents: [
        { type: 'gsd-executor', plan: '32-07', task: '2', state: 'running', action: { tool: 'Edit', detail: 'lib/x.mjs' }, elapsedMs: 6 * 60000, tokens: 166000 },
        { type: 'gsd-verifier', plan: null, task: null, state: 'quiet', action: { tool: 'Bash', detail: 'npm test' }, lastAt: at('10:44'), elapsedMs: 16 * 60000, tokens: null },
        { type: null, plan: '32-06', task: null, state: 'completed', action: null, elapsedMs: 45000, tokens: 950 },
      ],
      ...lane,
    }],
    questions: [{ id: 'q1', phase: '32', plan: '32-09', task: '3', question: 'Deploy after green CI?', context: 'The deploy reaches every user.', options: [{ label: 'Yes, by the gate', recommended: true }, { label: 'Stop', description: 'the phase waits' }] }],
    commits: [{ sha: 'a1b2c3d', subject: 'fix: something' }],
    ui: { lang: 'en', refreshSeconds: 3 },
    ...over,
  };
}

test('formatView, what turbo-run view and status --watch print, is the pane in plain lines: verdict, helpers, the questions with their options, latest changes, supervisor', () => {
  assert.equal(formatView(textView()), [
    'Phase 32 — running plans · 1h 12m so far · needs your answer (1)',
    '  Executor · plan 32-07, task 2 · editing lib/x.mjs · 6m',
    '  ⚠️ Verifier silent for 16m — may be stuck',
    '  Helper · plan 32-06 · done · 45s',
    '',
    'Needs your answer (1):',
    '  Deploy after green CI? (plan 32-09, task 3)',
    '    The deploy reaches every user.',
    '    1. Yes, by the gate ★ recommended',
    '    2. Stop — the phase waits',
    '',
    'Latest changes:',
    '  a1b2c3d fix: something',
    '',
    'Supervisor running · phases 32–…',
  ].join('\n'));
  const ru = (over, lane) => formatView(textView({ ui: { lang: 'ru', refreshSeconds: 3 }, ...over }, lane));
  assert.equal(ru(), [
    'Фаза 32 — выполняются планы · идёт 1 ч 12 мин · нужен ваш ответ (1)',
    '  Исполнитель · план 32-07, задача 2 · правит lib/x.mjs · 6 мин',
    '  ⚠️ Проверяющий молчит 16 мин — возможно, завис',
    '  Помощник · план 32-06 · готов · 45 с',
    '',
    'Нужен ваш ответ (1):',
    '  Deploy after green CI? (план 32-09, задача 3)',
    '    The deploy reaches every user.',
    '    1. Yes, by the gate ★ рекомендуется',
    '    2. Stop — the phase waits',
    '',
    'Последние изменения:',
    '  a1b2c3d fix: something',
    '',
    'Супервизор работает · фазы 32–…',
  ].join('\n'));
  assert.equal(ru({ questions: [] }, { status: 'failed', reason: 'tests fail after 3 fix rounds' }).split('\n').slice(0, 2).join('\n'), 'Фаза 32 остановилась из-за сбоя · шаг: выполнение планов · 1 ч 12 мин\n  Причина: tests fail after 3 fix rounds');
  assert.equal(ru({ questions: [] }, { status: 'needs-owner', reason: 'owner question 32-09-t3' }).split('\n')[1], '  Исполнитель · план 32-07, задача 2 · правит lib/x.mjs · 6 мин', 'no internal id: the verdict says it');
  assert.equal(formatView({ supervisor: null, range: null, lanes: [], questions: [], commits: [] }), 'Run — supervisor never started');
  assert.equal(formatView({ supervisor: null, range: null, lanes: [], questions: [], commits: [], ui: { lang: 'ru' } }), 'Прогон — супервизор не запускался');
});

test('turbo-run view and status --watch speak the pane\'s words: the same tables, and for a view without questions the same lines', async () => {
  const pane = await import('../mod/hooks/view-model.mjs');
  const { WORDS } = await import('../lib/view.mjs');
  assert.deepEqual(WORDS, pane.WORDS);
  const done = Array.from({ length: 5 }, (_, i) => ({ type: 'gsd-planner', plan: `32-0${i}`, task: null, state: 'completed', action: null, elapsedMs: 60000, tokens: 1 }));
  const views = [
    textView({ questions: [] }),
    textView({ questions: [] }, { status: 'needs-owner', reason: 'checkpoint 32-09 Task 3', agents: done }),
    textView({ questions: [] }, { status: 'needs-owner', reason: 'owner question 32-09-t3' }),
    textView({ questions: [] }, { status: 'failed', reason: 'owner question 32-09-t3: app.exe holds release/app.exe' }),
    textView({ questions: [] }, { status: 'done', step: null, agents: [] }),
    textView({ questions: [] }, { quiet: true, lastAt: at('10:40'), agents: [{ type: 'turbo-uat', plan: null, state: 'running', action: { tool: 'Bash', detail: 'git commit -m x' }, elapsedMs: 1000 }] }),
    textView({ questions: [] }, { push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' }, step: 'fanout', agents: [{ type: 'gsd-code-reviewer', state: 'running', action: { tool: 'Grep', detail: 'x' }, elapsedMs: 5000 }] }),
    textView({ questions: [], supervisor: { running: false, finished: true, halted: false }, lanes: [], commits: [] }),
    textView({ questions: [], supervisor: { running: false, finished: false, halted: true }, range: null }),
  ];
  for (const lang of ['en', 'ru']) {
    for (const v of views) {
      const view = { ...v, ui: { lang, refreshSeconds: 3 } };
      assert.equal(formatView(view), pane.paneLines(pane.render(view)).join('\n'), `${lang}: ${JSON.stringify(v.lanes[0]?.status)}`);
    }
  }
});

test('the view carries the live view settings (ui) and each lane its last push as S2 recorded it', () => {
  const { root, sup, env } = laneProject();
  const v = buildView({ root, sup, config: { lang: 'ru', view: { refresh_seconds: 5 } }, env, now: NOW, commits: COMMITS });
  // the owner's zone: the mod tells the local time by it whatever zone its own runtime keeps
  assert.deepEqual(v.ui, { lang: 'ru', refreshSeconds: 5, utcOffsetMinutes: -NOW.getTimezoneOffset() });
  assert.equal(v.lanes[0].push, null);
  // S2's record (lib/push.mjs): the latest request's outcome and time at the top, the last push and its CI watch in
  // lastPush, carried over by later requests
  const record = path.join(runDirOf(root), 'p32-push.json');
  const sha = 'f'.repeat(40);
  const lastPush = { requestId: 'r1', sha, branch: 'main', remote: 'origin', at: at('10:50'), ci: { state: 'red', since: at('10:50'), runs: [] } };
  writeJsonAtomic(record, { requestId: 'r1', phase: '32', remote: 'origin', at: at('10:50'), outcome: 'pushed', branch: 'main', sha, lastPush });
  assert.deepEqual(buildView({ root, sup, env, now: NOW, commits: COMMITS }).lanes[0].push, { outcome: 'pushed', at: at('10:50'), sha: 'fffffff', ci: 'red' });
  writeJsonAtomic(record, { requestId: 'r2', phase: '32', remote: 'origin', at: at('10:55'), outcome: 'refused', findings: [{ file: '.env', kind: 'forbidden name' }], lastPush });
  assert.deepEqual(pushOf(root, '32'), { outcome: 'refused', at: at('10:55'), sha: 'fffffff', ci: 'red' }, 'a refused request keeps the last push and its CI');
  writeJsonAtomic(record, { requestId: 'r1', phase: '32', remote: 'origin', at: at('10:50'), outcome: 'refused', findings: [] });
  assert.deepEqual(pushOf(root, '32'), { outcome: 'refused', at: at('10:50'), sha: null, ci: null }, 'refused before any push');
  fs.writeFileSync(record, '{"outcome":');
  assert.equal(pushOf(root, '32'), null);
  writeJsonAtomic(record, { outcome: 'exploded' });
  assert.equal(pushOf(root, '32'), null);
});

test('view.refresh_seconds is a whole number of seconds from 1 to 60; anything else counts as 3', () => {
  assert.equal(DEFAULTS.view.refresh_seconds, 3);
  assert.equal(viewRefreshSeconds({ view: { refresh_seconds: 1 } }), 1);
  assert.equal(viewRefreshSeconds({ view: { refresh_seconds: 60 } }), 60);
  for (const bad of [0, 61, 2.5, null, 'x']) assert.equal(viewRefreshSeconds({ view: { refresh_seconds: bad } }), 3, String(bad));
  assert.equal(viewRefreshSeconds({}), 3);
});

test('open questions reach the view as S1 writes them, rev included: the pane answers with that rev', () => {
  const { root, sup, env } = laneProject();
  const q = { id: '32-09-t2', phase: '32', plan: '32-09', task: '2', kind: 'decision', header: '32-09 T2', question: 'Select the provider', context: '', options: [{ label: 'Clerk', description: '', recommended: true, signal: 'clerk', defer: false }], allowOther: true, condition: null, class: 'decision', agentId: null, stopped: false, state: 'open', answer: null, delivery: null, rev: 2, source: 'plan' };
  writeJsonAtomic(path.join(runDirOf(root), 'p32-questions.json'), [q, { ...q, id: '32-09-t3', state: 'answered', rev: 1 }]);
  assert.deepEqual(buildView({ root, sup, env, now: NOW, commits: COMMITS }).questions, [q]);
});

test('recentCommits never runs a git planted in the project (Windows looks for a bare program in the working directory first)', { skip: process.platform !== 'win32' && 'only Windows looks in the working directory' }, () => {
  const repo = tmpGitRepo();
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'feat: real'], { cwd: repo });
  // a small program that is not git and fails on `git log` arguments
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), path.join(repo, 'git.exe'));
  // a Node whose environment lacks NoDefaultCurrentDirectoryInExePath: the default, where Windows looks in the cwd
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'nodefaultcurrentdirectoryinexepath'));
  const script = `import { recentCommits } from ${JSON.stringify(new URL('../lib/view.mjs', import.meta.url).href)}; process.stdout.write(String(recentCommits(process.argv[1])[0]?.subject));`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script, repo], { env, encoding: 'utf8' }), 'feat: real');
});

test('escape sequences and bidi overrides in repository data are dropped where the view reads them, so view --json, view and status --watch draw none', () => {
  // OSC 52 (clipboard), ESC[2J (clear), colors and U+202E, built at run time
  const E = String.fromCharCode(27);
  const evil = `${E}]52;c;SGVsbG8=${String.fromCharCode(7)}${E}[2J${E}[31mred${E}[0m‮evil`;
  const unsafe = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
  const strings = (x) => (typeof x === 'string' ? [x] : x && typeof x === 'object' ? Object.values(x).flatMap(strings) : []);
  const { root, dir, sup, env } = laneProject();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', `fix: ${evil}`], { cwd: root });
  writeLaneStatus(root, '32', 'needs-owner', { reason: `checkpoint ${evil}`, at: at('10:40') });
  writeSession(dir, SESSION, [entry.user('run phase 32', at('09:48')), entry.launched('toolu_1', 'a2000000000000001', at('10:00'))]);
  setMtime(writeAgent(dir, SESSION, 'a2000000000000001', [entry.agentUser('a2000000000000001', `Execute ${evil}`, at('10:00')), entry.assistant({ ts: at('10:58'), tool: { name: 'Bash', input: { command: `echo ${evil}` } }, usage: usage(0, 0, 1000), sidechain: true })], { agentType: `gsd-executor${evil}`, description: `Plan 32-07 ${evil}`, spawnDepth: 1 }), new Date(at('10:58')));
  writeJsonAtomic(path.join(runDirOf(root), 'p32-questions.json'), [{ id: 'q1', phase: '32', plan: '32-09', task: '3', header: `H ${evil}`, question: `Deploy? ${evil}`, context: evil, options: [{ label: `Yes ${evil}`, description: evil, signal: evil }], state: 'open' }]);
  const v = buildView({ root, sup, env, now: NOW });
  for (const s of strings(v)) assert.ok(!unsafe.test(s), JSON.stringify(s));
  assert.equal(v.commits[0].subject, 'fix: redevil');
  assert.equal(v.lanes[0].reason, 'checkpoint redevil');
  assert.equal(v.questions[0].question, 'Deploy? redevil');
  assert.ok(v.lanes[0].agents[0].action.detail.includes('echo redevil'), JSON.stringify(v.lanes[0].agents[0]));
  assert.ok(!unsafe.test(formatView({ ...v, commits: [{ sha: 'abc1234', subject: `raw ${evil}` }] })), 'formatView drops them from a view built elsewhere too');
});
