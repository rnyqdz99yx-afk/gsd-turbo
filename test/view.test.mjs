import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { SESSION, entry, jsonl, projectDirFor, setMtime, usage, writeAgent, writeJob, writeSession } from './helpers/transcripts.mjs';
import { completeStep, countAttempt } from '../lib/phase-progress.mjs';
import { writeAttend } from '../lib/attend.mjs';
import { watch } from '../lib/watch.mjs';
import { writeLaneStatus } from '../lib/run-status.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';
import { writeOwnerStop } from '../lib/autostart.mjs';
import { maskSecrets } from '../lib/secrets.mjs';
import { buildView, formatView, openQuestions, plansOf, pushOf, recentCommits, stallMs } from '../lib/view.mjs';
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
  assert.deepEqual(v, { v: 1, at: NOW.toISOString(), supervisor: null, range: null, lanes: [], next: null, questions: [], commits: COMMITS(), attended: [], away: null, autoAnswered: [], ui: { lang: 'en', refreshSeconds: 3, utcOffsetMinutes: -NOW.getTimezoneOffset() } });
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

test('the view says when the owner stopped the run (turbo-run stop\'s mark): the pane does not open by itself for its lanes (Gap 1)', () => {
  const { root, sup, env } = laneProject();
  assert.equal('stoppedByOwner' in buildView({ root, sup, env, now: NOW, commits: COMMITS }).supervisor, false);
  writeOwnerStop(root, at('10:30'));
  assert.equal(buildView({ root, sup, env, now: NOW, commits: COMMITS }).supervisor.stoppedByOwner, true);
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
  // its last command came back (a tool result): nothing in flight, the write alone counts
  const finished = [...agentEntries('a2000000000000001', '10:00', '10:55'), { ...entry.toolResult('toolu_01BBBBBBBBBBBBBBBBBBBBBB', 'ok', at('10:55')), isSidechain: true }];
  setMtime(writeAgent(dir, SESSION, 'a2000000000000001', finished), new Date(at('10:55')));
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
  // The budget holds the work a warm view does: the CPU time of this process (all its threads), the fastest of five
  // views. Under load the clock also counts the time other processes held the cores, which a view cannot cause and
  // which swelled one view to several times the budget in a full parallel run; more work shows in every one of the
  // five. The fastest view by the clock still has to stay within three budgets, which catches waits on something
  // outside the process (a child process's CPU time is not counted here). (Windows counts CPU time in steps of about
  // 16 ms, far below the budget.)
  const runs = Array.from({ length: 5 }, () => {
    const t0 = process.hrtime.bigint();
    const c0 = process.cpuUsage();
    const v = buildView({ root, sup, env, now: NOW, commits: COMMITS });
    const c = process.cpuUsage(c0);
    assert.equal(v.lanes[0].agents.length, 20);
    return { cpu: (c.user + c.system) / 1000, wall: Number(process.hrtime.bigint() - t0) / 1e6 };
  });
  const cpu = Math.min(...runs.map((r) => r.cpu));
  const wall = Math.min(...runs.map((r) => r.wall));
  const shown = runs.map((r) => `${r.cpu.toFixed(0)}/${r.wall.toFixed(0)}`).join(', ');
  // the spec's 300 ms on a developer machine; shared CI runners (slow Windows ones above all) get more room
  const budget = process.env.CI ? 1500 : 300;
  assert.ok(cpu < budget, `a warm view took ${cpu.toFixed(0)} ms of CPU at best (budget ${budget} ms; cpu/clock per view: ${shown})`);
  assert.ok(wall < 3 * budget, `a warm view took ${wall.toFixed(0)} ms by the clock at best (limit ${3 * budget} ms; cpu/clock per view: ${shown})`);
});

// A view as buildView returns it, for the text form: phase 32 executing, a question waiting.
function textView(over = {}, lane = {}) {
  return {
    v: 1, at: NOW.toISOString(),
    supervisor: { running: true, pid: 4242, finished: false, halted: false, failingSince: null, updatedAt: null },
    range: { from: '32', to: null },
    lanes: [{
      phase: '32', step: 'execute', status: 'running', reason: '', quiet: false, sessionId: '1a2b3c4d', elapsedMs: 72 * 60000, launchedAt: at('09:48'), lastAt: at('10:59'),
      agents: [
        { type: 'gsd-executor', plan: '32-07', task: '2', state: 'running', action: { tool: 'Edit', detail: 'lib/x.mjs' }, lastAt: at('10:58'), elapsedMs: 6 * 60000, tokens: 166000 },
        { type: 'gsd-verifier', plan: null, task: null, state: 'quiet', action: { tool: 'Bash', detail: 'npm test' }, lastAt: at('10:44'), elapsedMs: 16 * 60000, tokens: null },
        { type: null, plan: '32-06', task: null, state: 'completed', action: null, elapsedMs: 45000, tokens: 950 },
      ],
      plans: { done: 5, total: 9 },
      ci: { fixes: 0, rounds: 2 },
      ...lane,
    }],
    questions: [{ id: 'q1', phase: '32', plan: '32-09', task: '3', question: 'Deploy after green CI?', context: 'The deploy reaches every user.', options: [{ label: 'Yes, by the gate', recommended: true }, { label: 'Stop', description: 'the phase waits' }] }],
    commits: [{ sha: 'a1b2c3d', at: at('10:48'), subject: 'fix: something' }],
    attended: [],
    ui: { lang: 'en', refreshSeconds: 3 },
    ...over,
  };
}

test('formatView, what turbo-run view and status --watch print, is the pane in plain lines: verdict, now, sign of life, helpers, the questions (the held one first) with their options, what comes next, the steps, latest changes by kind, supervisor', () => {
  assert.equal(formatView(textView()), [
    'Phase 32 — running plans · 5 of 9 plans done · 1h 12m · needs your answer (1)',
    '  Now: writing code for a plan',
    '  last activity 1m ago',
    '  Executor · plan 32-07, task 2 · editing lib/x.mjs · 6m',
    '  ⚠️ Verifier silent for 16m',
    '  1 more helper finished',
    '',
    'Needs your answer (1):',
    '  you can answer ahead — the phase is not waiting',
    '  Deploy after green CI? (plan 32-09, task 3)',
    '    The deploy reaches every user.',
    '    1. Yes, by the gate ★ recommended',
    '    2. Stop — the phase waits',
    '',
    'What comes next:',
    '  quality checks → fixes → final check → acceptance → wrap-up → next phase',
    '  You can answer the question above ahead',
    '',
    'Phase steps:',
    '  ✓ freshness check',
    '  ✓ discussion',
    '  ✓ planning prep',
    '  ✓ planning',
    '  ▶ running plans — now',
    '  · quality checks',
    '  · fixes',
    '  · final check',
    '  · acceptance',
    '  · wrap-up',
    '',
    'Latest changes: 1 fix · latest 12m ago',
    '',
    'Supervisor running · phases 32–…',
  ].join('\n'));
  const ru = (over, lane) => formatView(textView({ ui: { lang: 'ru', refreshSeconds: 3 }, ...over }, lane));
  const held = { id: 'q2', phase: '32', plan: '32-10', task: '1', question: 'Страница экспорта выглядит верно?', options: [{ label: 'Принять' }], stopped: true };
  assert.equal(ru({ questions: [textView().questions[0], held] }, { status: 'needs-owner', reason: 'owner question 32-10-t1' }), [
    'Фаза 32 остановилась — ждёт вашего ответа · шаг: выполнение планов · 5 из 9 планов готово · 1 ч 11 мин',
    '  последнее действие 1 мин назад',
    '  Исполнитель · план 32-07, задача 2 · правит lib/x.mjs · 6 мин',
    '  ⚠️ Проверяющий молчит 16 мин',
    '  ещё 1 помощник закончил',
    '',
    'Нужен ваш ответ (2):',
    '  Фаза ждёт этот ответ',
    '  Страница экспорта выглядит верно? (план 32-10, задача 1)',
    '    1. Принять',
    '  можно ответить заранее',
    '  Deploy after green CI? (план 32-09, задача 3)',
    '    The deploy reaches every user.',
    '    1. Yes, by the gate ★ рекомендуется',
    '    2. Stop — the phase waits',
    '',
    'Что дальше:',
    '  проверки качества → исправления → финальная проверка → приёмка → завершение → следующая фаза',
    '  Нужны вы: ответить на вопрос выше — фаза ждёт его',
    '  На вопрос выше можно ответить заранее',
    '',
    'Шаги фазы:',
    '  ✓ проверка актуальности',
    '  ✓ обсуждение',
    '  ✓ подготовка к планированию',
    '  ✓ планирование',
    '  ■ выполняются планы — остановилась здесь',
    '  · проверки качества',
    '  · исправления',
    '  · финальная проверка',
    '  · приёмка',
    '  · завершение',
    '',
    'Последние изменения: 1 исправление · последнее 12 мин назад',
    '',
    'Супервизор работает · фазы 32–…',
  ].join('\n'));
  assert.equal(ru({ questions: [] }, { status: 'failed', reason: 'tests fail after 3 fix rounds' }).split('\n').slice(0, 3).join('\n'), 'Фаза 32 остановилась из-за сбоя · шаг: выполнение планов · 5 из 9 планов готово · 1 ч 11 мин\n  последнее действие 1 мин назад\n  Причина: tests fail after 3 fix rounds');
  // v0.3.3: a lane question's stop shows no reason line: its card says it
  assert.ok(!ru({ questions: [] }, { status: 'needs-owner', reason: 'owner question ask-3' }).includes('Причина'));
  // after turbo-run stop: never "running", never "stuck", the time frozen at the last activity
  assert.equal(ru({ questions: [], at: at('15:00'), supervisor: { running: false, pid: null, finished: false, halted: false } }, { quiet: true }).split('\n')[0], 'Фаза 32 остановлена на шаге: выполнение планов · 5 из 9 планов готово · 1 ч 11 мин · супервизор не работает');
  assert.deepEqual(ru({ questions: [] }, { push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' }, ci: { fixes: 1, rounds: 2 } }).split('\n').slice(0, 2), ['Фаза 32 — выполняются планы · 5 из 9 планов готово · 1 ч 12 мин · CI красный — фаза чинит сама (попытка 1 из 2), от вас ничего не нужно', '  Сейчас: чинит красный CI — попытка 1 из 2']);
  assert.equal(formatView({ supervisor: null, range: null, lanes: [], questions: [], commits: [] }), 'Run — supervisor never started');
  assert.equal(formatView({ supervisor: null, range: null, lanes: [], questions: [], commits: [], ui: { lang: 'ru' } }), 'Прогон — супервизор не запускался');
  assert.equal(formatView({ supervisor: null, range: null, lanes: [], questions: [], commits: [{ sha: 'a1b2c3d', subject: 'old view' }] }), 'Run — supervisor never started\n\nLatest changes: 1 other change', 'a view without commit times: the count alone');
});

// Every value of a words table, functions called with fixed arguments, as [path, value] pairs.
function flatWords(o, prefix = '') {
  const ARGS = [[1, 'a', 2], [3, 'x', 0], [0, null, 7], [12, '', 25], [true, 'b', 1], [false, 'c', 5]];
  return Object.entries(o).flatMap(([k, v]) => {
    const p = `${prefix}.${k}`;
    if (typeof v === 'function') return ARGS.map((a) => [`${p}(${JSON.stringify(a)})`, v(...a)]);
    return v && typeof v === 'object' ? flatWords(v, p) : [[p, v]];
  });
}

test('turbo-run view and status --watch speak the pane\'s words: every phrase equal (functions called alike), and for a view without questions the same lines (review m3)', async () => {
  const pane = await import('../mod/hooks/view-model.mjs');
  const { WORDS, TEXT } = await import('../lib/view.mjs');
  assert.deepEqual(WORDS, pane.WORDS);
  for (const lang of ['en', 'ru']) {
    const mine = flatWords(TEXT[lang]);
    assert.ok(mine.length > 150, `${lang}: ${mine.length} phrases compared`);
    const theirs = Object.fromEntries(flatWords(pane.TEXT[lang]));
    for (const [key, value] of mine) assert.deepEqual(value, theirs[key], `${lang}${key}`);
  }
  const done = Array.from({ length: 5 }, (_, i) => ({ type: 'gsd-planner', plan: `32-0${i}`, task: null, state: 'completed', action: null, elapsedMs: 60000, tokens: 1 }));
  const stoppedSup = { running: false, pid: null, finished: false, halted: false };
  const views = [
    textView({ questions: [] }),
    textView({ questions: [] }, { status: 'needs-owner', reason: 'checkpoint 32-09 Task 3', agents: done }),
    textView({ questions: [] }, { status: 'needs-owner', reason: 'owner question 32-09-t3' }),
    textView({ questions: [] }, { status: 'failed', reason: 'owner question 32-09-t3: app.exe holds release/app.exe' }),
    textView({ questions: [] }, { status: 'done', step: null, agents: [] }),
    textView({ questions: [] }, { status: 'paused-context', plans: null }),
    textView({ questions: [] }, { quiet: true, lastAt: at('10:40'), agents: [{ type: 'turbo-uat', plan: null, state: 'running', action: { tool: 'Bash', detail: 'git commit -m x' }, elapsedMs: 1000 }] }),
    textView({ questions: [] }, { push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' }, step: 'fanout', agents: [{ type: 'gsd-code-reviewer', state: 'running', action: { tool: 'Grep', detail: 'x' }, elapsedMs: 5000 }] }),
    textView({ questions: [] }, { push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' }, ci: { fixes: 1, rounds: 2 } }),
    textView({ questions: [] }, { push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' }, status: 'needs-owner' }),
    textView({ questions: [] }, { push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' }, ci: { fixes: 2, rounds: 2 } }),
    textView({ questions: [] }, { push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' }, status: 'done', step: null }),
    textView({ questions: [] }, { status: 'paused-context', held: 'fullMode' }),
    textView({ questions: [], supervisor: { ...textView().supervisor, halted: true, running: false } }, { push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' }, ci: { fixes: 1, rounds: 2 } }),
    textView({ questions: [], supervisor: { running: false, finished: true, halted: false }, lanes: [], commits: [] }),
    textView({ questions: [], supervisor: { ...stoppedSup, halted: true }, range: null }),
    textView({ questions: [], supervisor: stoppedSup, at: at('15:00') }, { quiet: true }),
    textView({ questions: [], supervisor: stoppedSup, attended: ['32'] }),
    textView({ questions: [], supervisor: { ...textView().supervisor, failingSince: at('10:10') } }),
    textView({ questions: [], commits: [{ sha: 'a1b2c3d', at: '2025-12-28T10:00:00.000Z', subject: 'old' }, { sha: 'b', at: at('10:59'), subject: 'new' }, { sha: 'c', subject: 'no time' }] }),
    // v0.3.3: now, what comes next, the steps, commits by kind
    textView({ questions: [], range: { from: '32', to: '32' } }, { step: 'uat', agents: [{ type: 'turbo-uat', state: 'running', action: { tool: 'Bash', detail: 'curl x' }, elapsedMs: 5000 }] }),
    textView({ questions: [] }, { step: 'final-gate', agents: [], push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'pending' } }),
    textView({ questions: [] }, { step: 'restore', agents: [{ type: 'gsd-code-fixer', state: 'running', action: null, elapsedMs: 5000 }, { type: 'gsd-executor', state: 'running', action: null, elapsedMs: 5000 }] }),
    textView({ questions: [] }, { step: 'odd-step', status: 'needs-owner', reason: 'a live check' }),
    textView({ questions: [], supervisor: null }, { push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' }, ci: { fixes: 1, rounds: 2 } }),
    textView({ questions: [], commits: [{ sha: 'a', at: at('10:59'), subject: 'feat(32): x' }, { sha: 'b', at: at('10:58'), subject: 'docs(phase-32): y' }, { sha: 'c', at: at('10:57'), subject: 'feat: z' }] }),
    // liveness: a long command in flight (the lane and its helper), and a silent lane with what turbo did about it
    textView({ questions: [] }, { lastAt: at('10:54'), busy: { since: at('10:54') }, agents: [{ type: 'gsd-executor', plan: '32-05', task: null, state: 'running', busy: { since: at('10:54') }, action: { tool: 'Bash', detail: 'node -e x' }, lastAt: at('10:54'), elapsedMs: 18 * 60000 }] }),
    textView({ questions: [] }, { quiet: true, lastAt: at('10:40'), wake: { count: 1, how: 'restarted', told: false }, agents: [] }),
    textView({ questions: [] }, { quiet: true, lastAt: at('10:40'), wake: { count: 1, how: 'tried', told: false }, agents: [] }),
    textView({ questions: [] }, { quiet: true, lastAt: at('10:40'), wake: { count: 2, how: 'woke', told: true }, agents: [] }),
    textView({ questions: [], lanes: [textView().lanes[0], { ...textView().lanes[0], phase: '34', quiet: true, lastAt: at('10:40'), wake: { count: 2, how: 'woke', told: true }, agents: [] }] }),
  ];
  for (const lang of ['en', 'ru']) {
    for (const v of views) {
      // the owner's zone for the supervisor's failing time: the pane reads it from the view, turbo-run is in it
      const view = { ...v, ui: { lang, refreshSeconds: 3, utcOffsetMinutes: -new Date(at('10:10')).getTimezoneOffset() } };
      assert.equal(formatView(view), pane.paneLines(pane.render(view)).join('\n'), `${lang}: ${JSON.stringify(v.lanes[0]?.status)} ${JSON.stringify(v.supervisor)}`);
    }
  }
});

test('formatView in colour (status --watch on a terminal): each line wrapped in the SGR of its tone, reset at its end; the text unchanged; plain lines bare', () => {
  const E = '\x1b';
  const view = textView({ questions: [] }, { step: 'fanout', push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' }, ci: { fixes: 1, rounds: 2 }, agents: [{ type: 'gsd-code-reviewer', state: 'running', action: { tool: 'Grep', detail: 'x' }, elapsedMs: 5000 }, { type: 'gsd-verifier', state: 'quiet', lastAt: at('10:44'), elapsedMs: 5000 }] });
  const plain = formatView(view).split('\n');
  const color = formatView(view, { color: true }).split('\n');
  assert.deepEqual(color.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')), plain, 'the same text');
  const toneOf = (prefix) => {
    const line = color.find((l) => l.replace(/\x1b\[[0-9;]*m/g, '').startsWith(prefix));
    return /^\x1b\[([0-9;]+)m.*\x1b\[0m$/.exec(line)?.[1] ?? 'none';
  };
  assert.deepEqual(['Phase 32', '  Now:', '  last activity', '  Reviewer', '  ⚠️ Verifier', 'What comes next', '  Nothing needed', '  ✓ freshness', '  ▶ quality', '  · fixes', 'Latest changes', 'Supervisor'].map(toneOf), ['33', '33', '2', 'none', '33', '1', '32', '2', '1', '2', 'none', '2']);
  assert.equal(color.filter((l) => l === '').length, plain.filter((l) => l === '').length, 'blank lines stay bare');
  const stopped = formatView(textView({ questions: [] }, { status: 'needs-owner', reason: 'a live check', step: 'uat' }), { color: true }).split('\n');
  assert.ok(stopped.includes(`${E}[31m  Reason: a live check${E}[0m`));
  assert.ok(stopped.includes(`${E}[31m  ■ acceptance — stopped here${E}[0m`));
  assert.ok(stopped[0].startsWith(`${E}[31mPhase 32 stopped`));
  // repository text never brings its own escapes, coloured or not
  const evil = formatView(textView({ questions: [] }, { status: 'failed', reason: `x${E}[2Jy` }), { color: true });
  assert.ok(evil.includes('Reason: xy'));
  assert.ok(!evil.includes(`${E}[2J`));
});

test('the view carries what the pane needs to judge: plans done, the CI fix rounds left, attended phases, commit times', () => {
  const { root, sup, env } = laneProject();
  const phaseDir = path.join(root, '.planning', 'phases', '32-export');
  fs.mkdirSync(phaseDir, { recursive: true });
  for (const f of ['32-01-PLAN.md', '32-01-SUMMARY.md', '32-02-PLAN.md', '32-02-SUMMARY.md', '32-03-PLAN.md', '32-CONTEXT.md']) fs.writeFileSync(path.join(phaseDir, f), '# x\n');
  countAttempt(root, '32', 'ci');
  writeAttend(root, '33');
  const v = buildView({ root, sup, config: { push: { ci_fix_rounds: 3 } }, env, now: NOW, commits: COMMITS });
  assert.deepEqual([v.lanes[0].plans, v.lanes[0].ci, v.attended], [{ done: 2, total: 3 }, { fixes: 1, rounds: 3 }, ['33']]);
  assert.deepEqual(buildView({ root, sup, env, now: NOW, commits: COMMITS }).lanes[0].ci, { fixes: 1, rounds: DEFAULTS.push.ci_fix_rounds }, 'the default rounds without a push config');
  const bare = laneProject();
  assert.deepEqual([buildView({ root: bare.root, sup: bare.sup, env: bare.env, now: NOW, commits: COMMITS }).lanes[0].plans], [null], 'no phase directory: no count');
  // review n3: phases that cannot be read (a file where the directory should be: ENOTDIR) give no count, never a broken view
  fs.writeFileSync(path.join(bare.root, '.planning', 'phases'), 'not a directory');
  assert.equal(plansOf(bare.root, '32'), null);
  assert.equal(buildView({ root: bare.root, sup: bare.sup, env: bare.env, now: NOW, commits: COMMITS }).lanes[0].plans, null);
  // review n8: a lane the supervisor holds until full mode is back (holdDowngradedLane marks it notified.downgraded)
  const heldSup = { ...sup, lane: { ...sup.lane, notified: { downgraded: true } } };
  assert.deepEqual([buildView({ root, sup: heldSup, env, now: NOW, commits: COMMITS }).lanes[0].held, buildView({ root, sup, env, now: NOW, commits: COMMITS }).lanes[0].held], ['fullMode', null]);
  const repo = tmpGitRepo();
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'feat: timed'], { cwd: repo });
  const [c] = recentCommits(repo);
  assert.equal(c.subject, 'feat: timed');
  assert.ok(Math.abs(Date.parse(c.at) - Date.now()) < 120000, c.at);
});

test('status --watch draws its footer in the config\'s language', async () => {
  const frames = [];
  await watch({ frame: () => ({ text: 'x', seconds: 5, lang: 'ru' }), write: (s) => frames.push(s), tty: false, now: () => new Date(2026, 0, 1, 8, 18, 3), rounds: 1 });
  assert.equal(frames[0], 'x\nобновлено 08:18:03 · каждые 5 с · Ctrl+C — выход\n');
  let n = 0;
  await watch({ frame: () => { if (n++) throw new Error('boom'); return { text: 'y', seconds: 1, lang: 'ru' }; }, write: (s) => frames.push(s), tty: false, now: () => new Date(2026, 0, 1, 8, 18, 3), sleep: async () => {}, rounds: 2 });
  assert.equal(frames.at(-1), '\nошибка: boom\nобновлено 08:18:03 · каждые 1 с · Ctrl+C — выход\n', 'an error keeps the language');
  await watch({ frame: () => ({ text: 'z', seconds: 3 }), write: (s) => frames.push(s), tty: false, now: () => new Date(2026, 0, 1, 8, 18, 3), rounds: 1 });
  assert.equal(frames.at(-1), 'z\nupdated 08:18:03 · every 3 s · Ctrl+C stops\n');
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

// Stage 4: three lanes in slots next to a control root; each slot is its own project for Claude Code.
function slotsProject() {
  const { root, home, env } = laneProject();
  const slot = (k) => {
    const p = path.join(path.dirname(root), `${path.basename(root)}.turbo`, `lane-${k}`);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  const slots = [slot(1), slot(2), slot(3)];
  const sup = { pid: 4242, updatedAt: at('10:59'), finished: false, halted: false, range: { from: '32', to: '36' }, next: { phase: '34', why: 'deps', waitsFor: ['32'] }, lanes: {
    'prep-35': { key: 'prep-35', job: 'prep', phase: '35', slot: 3, slotPath: slots[2], branch: 'turbo/prep-35', sessionId: null, launchedAt: at('10:56'), restarts: 0, notified: {}, mode: 'safe' },
    33: { key: '33', job: 'phase', phase: '33', slot: 2, slotPath: slots[1], branch: 'turbo/p33', sessionId: null, launchedAt: at('10:35'), restarts: 0, notified: {}, mode: 'safe' },
    32: { key: '32', job: 'phase', phase: '32', slot: 1, slotPath: slots[0], branch: 'turbo/p32', sessionId: SESSION.slice(0, 8), launchedAt: at('09:48'), restarts: 0, notified: {}, mode: 'full' },
  } };
  return { root, home, env, slots, sup };
}

test('lanes in slots (Stage 4): each lane reads its plans and helpers from its own slot and its records from the control root; prep lanes after the phases; the next phase from supervisor.json', () => {
  const { root, home, env, slots, sup } = slotsProject();
  const sdir = projectDirFor(home, slots[0]);
  writeSession(sdir, SESSION, [entry.user('run phase 32', at('09:48')), entry.launched('toolu_1', 'a2000000000000001', at('10:20'))]);
  setMtime(writeAgent(sdir, SESSION, 'a2000000000000001', agentEntries('a2000000000000001', '10:20', '10:58', 41000)), new Date(at('10:58')));
  const phaseDir = path.join(slots[0], '.planning', 'phases', '32-export');
  fs.mkdirSync(phaseDir, { recursive: true });
  for (const f of ['32-01-PLAN.md', '32-01-SUMMARY.md', '32-02-PLAN.md']) fs.writeFileSync(path.join(phaseDir, f), '# x\n');
  // the control root's own sessions and plans are not this lane's
  writeSession(projectDirFor(home, root), SESSION, [entry.launched('toolu_9', 'a2000000000000009', at('10:30'))]);
  const rootPhase = path.join(root, '.planning', 'phases', '32-export');
  fs.mkdirSync(rootPhase, { recursive: true });
  fs.writeFileSync(path.join(rootPhase, '32-01-PLAN.md'), '# x\n');
  completeStep(root, '32', 'freshness');
  completeStep(root, '35', 'freshness');
  writeLaneStatus(root, '33', 'needs-owner', { reason: 'a live check', at: at('10:50') });
  const v = buildView({ root, sup, running: true, env, now: NOW, commits: COMMITS });
  assert.deepEqual(v.lanes.map((l) => [l.key, l.job, l.phase, l.slot]), [['32', 'phase', '32', 1], ['33', 'phase', '33', 2], ['prep-35', 'prep', '35', 3]]);
  const [l32, l33, prep] = v.lanes;
  assert.deepEqual(l32.plans, { done: 1, total: 2 });
  assert.deepEqual(l32.agents.map((a) => a.agentId), ['a2000000000000001']);
  assert.ok(l32.transcript.startsWith(sdir), l32.transcript);
  assert.equal(l32.step, 'discuss', 'progress from the control root');
  assert.deepEqual([l33.status, l33.reason, l33.agents, l33.transcript], ['needs-owner', 'a live check', [], null]);
  assert.deepEqual([prep.step, prep.plans, prep.push], ['discuss', null, null], 'a prep lane steps through the progress of its phase; its plans are not written yet');
  assert.deepEqual(v.next, { phase: '34', why: 'deps', waitsFor: ['32'], gate: null });
  const quick = buildView({ root, sup, running: true, env, now: NOW, commits: COMMITS, agents: false });
  assert.deepEqual([quick.lanes[0].agents, quick.lanes[0].transcript, quick.lanes[0].plans], [[], null, { done: 1, total: 2 }], 'agents: false reads no transcript');
  assert.equal(buildView({ root, sup: { ...sup, finished: true }, env, now: NOW, commits: COMMITS, agents: false }).next, null);
});

test('an annotate lane has no phase, steps, plans or push and reads its own record; a v0.3 lane reads as before with slot 0; hand-edited entries never read "null" (Stage 4)', () => {
  const { root, env, slots, sup } = slotsProject();
  writeLaneStatus(root, 'annotate', 'needs-owner', { reason: 'which phases share files?', at: at('10:57') });
  const ann = { key: 'annotate', job: 'annotate', phase: null, slot: 3, slotPath: slots[2], sessionId: null, launchedAt: at('10:56'), restarts: 0, notified: {}, mode: 'safe' };
  const v = buildView({ root, sup: { ...sup, lanes: { annotate: ann, 32: sup.lanes[32], broken: null, list: [1] } }, env, now: NOW, commits: COMMITS, agents: false });
  assert.deepEqual(v.lanes.map((l) => l.key), ['32', 'annotate']);
  const a = v.lanes[1];
  assert.deepEqual([a.job, a.phase, a.step, a.plans, a.push, a.status, a.reason], ['annotate', null, null, null, null, 'needs-owner', 'which phases share files?']);
  const legacy = laneProject();
  const [l] = buildView({ root: legacy.root, sup: legacy.sup, env: legacy.env, now: NOW, commits: COMMITS }).lanes;
  assert.deepEqual([l.key, l.job, l.phase, l.slot], ['32', 'phase', '32', 0]);
  assert.equal(buildView({ root: legacy.root, sup: legacy.sup, env: legacy.env, now: NOW, commits: COMMITS }).next, null, 'checkout mode writes no next');
});

test('runLine is the pane\'s summary line while two or more lanes run, else nothing; waitReason says the next phase in the owner\'s language', async () => {
  const pane = await import('../mod/hooks/view-model.mjs');
  const { runLine, waitReason } = await import('../lib/view.mjs');
  const one = textView({ next: { phase: '33', why: 'slots', waitsFor: [], gate: null } });
  assert.equal(runLine(one), null);
  const two = { ...one, lanes: [{ ...one.lanes[0], key: '32', job: 'phase', slot: 1 }, { ...one.lanes[0], key: '33', job: 'phase', slot: 2, phase: '33' }], next: { phase: '34', why: 'deps', waitsFor: ['32'], gate: null } };
  assert.equal(runLine(two), '2 lanes · 1 question · next: phase 34 waits for phase 32');
  for (const lang of ['en', 'ru']) assert.equal(runLine({ ...two, ui: { lang } }), pane.runSummary({ ...two, ui: { lang } }));
  assert.equal(waitReason({ phase: '36', why: 'deps', waitsFor: ['34'] }, 'ru'), 'следующая: фаза 36 ждёт фазу 34');
  assert.equal(waitReason({ phase: '36', why: 'slots', waitsFor: [] }), 'next: phase 36 waits for a free lane');
  assert.equal(waitReason({ phase: '3\x1b[2J6', why: 'gates', waitsFor: ['3\x072'], gate: 'prod-deploy' }), 'next: phase 36 waits for phase 32 — both need the deploy', 'cleaned');
  assert.equal(waitReason(null), null);
  assert.equal(waitReason({ phase: '36', why: 'mystery' }), null);
});

// Stage 4: a view of three lanes in slots, as buildView returns it
function textLanes(over = {}, l33 = {}, l35 = {}) {
  const base = textView(over);
  return {
    ...base,
    lanes: [
      { ...base.lanes[0], key: '32', job: 'phase', slot: 1 },
      { ...base.lanes[0], key: '33', job: 'phase', slot: 2, phase: '33', step: 'fanout', launchedAt: at('10:35'), elapsedMs: 25 * 60000, plans: { done: 2, total: 4 }, agents: [{ type: 'gsd-code-reviewer', plan: null, task: null, state: 'running', action: { tool: 'Grep', detail: 'x' }, lastAt: at('10:58'), elapsedMs: 3 * 60000, tokens: 1 }], ...l33 },
      { ...base.lanes[0], key: 'prep-35', job: 'prep', slot: 3, phase: '35', step: 'discuss', launchedAt: at('10:56'), elapsedMs: 4 * 60000, plans: null, agents: [], ...l35 },
    ],
    next: { phase: '34', why: 'areas', waitsFor: ['32'], gate: null },
    ...(Object.hasOwn(over, 'next') ? { next: over.next } : {}),
    ...(Object.hasOwn(over, 'lanes') ? { lanes: over.lanes } : {}),
  };
}

test('with several lanes formatView is the pane in plain lines too: summary, blocks, collapsed and open lanes, the card\'s lane (review m3)', async () => {
  const pane = await import('../mod/hooks/view-model.mjs');
  assert.deepEqual(formatView(textLanes()).split('\n').slice(0, 3), ['Run — needs your answer (1)', '3 lanes · 1 question · next: phase 34 waits for phase 32 — they change the same files', 'Phase 32 · lane 1 — running plans · 5 of 9 plans done · 1h 12m']);
  const stopped = { running: false, pid: null, finished: false, halted: false };
  const views = [
    textLanes(),
    textLanes({ questions: [] }),
    textLanes({}, { status: 'needs-owner', reason: 'a live check' }),
    textLanes({}, { push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' }, ci: { fixes: 1, rounds: 2 } }),
    textLanes({}, { push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' }, ci: { fixes: 0, rounds: 0 } }),
    textLanes({}, { quiet: true }),
    textLanes({ supervisor: stopped }),
    textLanes({}, {}, { key: 'annotate', job: 'annotate', phase: null, step: null }),
    textLanes({ lanes: textLanes().lanes.slice(0, 2) }),
    textLanes({ next: { phase: '36', why: 'gates', waitsFor: ['33'], gate: 'owner-live' } }),
    textLanes({ next: null, questions: [] }, { status: 'done', step: null }),
    textView({}, { key: '32', job: 'phase', slot: 2 }),
  ];
  for (const lang of ['en', 'ru']) {
    for (const v of views) {
      // a question is a card with buttons in the pane and a list in the text: the lines are equal without questions
      const view = { ...v, questions: [], ui: { lang, refreshSeconds: 3, utcOffsetMinutes: -new Date(at('10:10')).getTimezoneOffset() } };
      assert.equal(formatView(view), pane.paneLines(pane.render(view)).join('\n'), `${lang}: ${JSON.stringify(v.lanes.map((l) => [l.key, l.status]))}`);
    }
  }
  assert.ok(formatView(textLanes()).split('\n').includes('  Deploy after green CI? (plan 32-09, task 3 · lane 1)'), 'the question says its lane');
  assert.ok(formatView(textLanes({ ui: { lang: 'ru' } })).split('\n').includes('  Deploy after green CI? (план 32-09, задача 3 · полоса 1)'));
  const E = '\x1b';
  assert.equal(formatView(textLanes(), { color: true }).split('\n')[0], `${E}[33mRun — needs your answer (1)${E}[0m`, 'the verdict in its colour on top');
});

test('the run line under every notification while two or more lanes run (Stage 4 D11)', async () => {
  const { runLineFor, withRunLine } = await import('../lib/view.mjs');
  assert.deepEqual(withRunLine({ title: 'Phase 33 done', body: 'Moving on.' }, '3 lanes · next: phase 34 waits for phase 32'), { title: 'Phase 33 done', body: 'Moving on.\n3 lanes · next: phase 34 waits for phase 32' });
  assert.deepEqual(withRunLine({ title: 't', body: '' }, 'x'), { title: 't', body: 'x' });
  assert.deepEqual(withRunLine({ title: 't', body: 'b' }, null), { title: 't', body: 'b' });
  const { root, env, sup } = slotsProject();
  writeJsonAtomic(path.join(runDirOf(root), 'supervisor.json'), sup);
  assert.equal(runLineFor(root, { lang: 'ru' }, { env, now: NOW }), '3 полосы · следующая: фаза 34 ждёт фазу 32');
  writeJsonAtomic(path.join(runDirOf(root), 'p32-questions.json'), [{ id: 'q1', phase: '32', question: 'Deploy?', options: [], state: 'open' }]);
  assert.equal(runLineFor(root, {}, { env, now: NOW }), '3 lanes · 1 question · next: phase 34 waits for phase 32');
  assert.equal(fs.existsSync(path.join(runDirOf(root), 'view-cache.json')), false, 'no transcript read, no cache written');
  const legacy = laneProject();
  writeJsonAtomic(path.join(runDirOf(legacy.root), 'supervisor.json'), legacy.sup);
  assert.equal(runLineFor(legacy.root, {}, { env: legacy.env, now: NOW }), null, 'one lane: nothing added');
  assert.equal(runLineFor(path.join(legacy.root, 'missing'), {}, { env: legacy.env, now: NOW }), null);
  fs.writeFileSync(path.join(runDirOf(legacy.root), 'supervisor.json'), '{ broken');
  assert.equal(runLineFor(legacy.root, null, { env: legacy.env, now: NOW }), null);
});

// Review fixes (L4 final review)
test('review I4, M4: a hand-edited slotPath that is not a path never throws; next only while the supervisor runs', () => {
  const { root, env, sup } = slotsProject();
  const odd = { ...sup, lanes: { ...sup.lanes, 33: { ...sup.lanes[33], slotPath: 5 }, 'prep-35': { ...sup.lanes['prep-35'], slotPath: true } } };
  const v = buildView({ root, sup: odd, running: true, env, now: NOW, commits: COMMITS });
  assert.deepEqual(v.lanes.map((l) => l.key), ['32', '33', 'prep-35']);
  assert.deepEqual(buildView({ root, sup, running: false, env, now: NOW, commits: COMMITS, agents: false }).next, null, 'a stopped supervisor schedules nothing');
});

test('review: lanes that stopped alone or finished their turn draw the same in the text as in the pane', async () => {
  const pane = await import('../mod/hooks/view-model.mjs');
  const views = [
    textLanes({ questions: [] }, { halted: { why: 'missing', at: at('10:50') } }),
    textLanes({ questions: [] }, { status: 'ready', step: null, quiet: true }),
    textLanes({ questions: [] }, {}, { status: 'prepped', step: null }),
    textLanes({ questions: [], lanes: textLanes().lanes.slice(0, 2) }, { halted: { why: 'missing', at: at('10:50') } }),
    textView({ questions: [] }, { key: 'prep-35', job: 'prep', slot: 1, phase: '35', step: 'discuss', plans: null }),
    textView({ questions: [] }, { halted: { why: 'missing', at: at('10:50') } }),
  ];
  for (const lang of ['en', 'ru']) {
    for (const v of views) {
      const view = { ...v, ui: { lang, refreshSeconds: 3, utcOffsetMinutes: -new Date(at('10:10')).getTimezoneOffset() } };
      assert.equal(formatView(view), pane.paneLines(pane.render(view)).join('\n'), `${lang}: ${JSON.stringify(v.lanes.map((l) => [l.key, l.status]))}`);
    }
  }
  const q = { id: 'm1', phase: 'annotate', question: 'Remove the relaxed dependencies?', options: [{ label: 'Remove all' }] };
  assert.ok(formatView(textLanes({ questions: [q] }, {}, { key: 'annotate', job: 'annotate', phase: null, step: null })).split('\n').includes('  Remove the relaxed dependencies? (lane markup)'));
});

test('review I5: the run line of a notification leaves out the lane that is leaving, and is not built with fewer than two lanes', async () => {
  const { runLineFor } = await import('../lib/view.mjs');
  const { root, env, sup } = slotsProject();
  writeJsonAtomic(path.join(runDirOf(root), 'supervisor.json'), sup);
  assert.equal(runLineFor(root, {}, { env, now: NOW, leaving: '33' }), '2 lanes · next: phase 34 waits for phase 32');
  writeJsonAtomic(path.join(runDirOf(root), 'supervisor.json'), { ...sup, lanes: { 32: sup.lanes[32], 33: sup.lanes[33] } });
  assert.equal(runLineFor(root, {}, { env, now: NOW, leaving: '33' }), null);
});

test('v0.4.0: away mode and the answers turbo took itself — formatView prints the pane\'s lines; buildView reads them from the run', async () => {
  const pane = await import('../mod/hooks/view-model.mjs');
  const auto = [{ phase: '32', id: '32-09-t2', question: 'Select the authentication provider', option: 'Clerk', at: at('10:30'), undo: 'turbo-run answer 32 32-09-t2 --undo' }];
  const views = [
    textView({ questions: [], away: { since: at('09:00') }, autoAnswered: auto }),
    textView({ questions: [], away: null, autoAnswered: auto }),
    textView({ questions: [], away: { since: at('09:00') }, autoAnswered: [] }),
  ];
  for (const lang of ['en', 'ru']) {
    for (const v of views) {
      const view = { ...v, ui: { lang, refreshSeconds: 3, utcOffsetMinutes: 0 } };
      assert.equal(formatView(view), pane.paneLines(pane.render(view)).join('\n'), lang);
    }
  }
  const lines = formatView(views[0]).split('\n');
  const i = lines.indexOf('Away mode — turbo takes the safe questions itself; when you are back: turbo-run back');
  assert.ok(i > 0, lines.join('\n'));
  assert.deepEqual(lines.slice(i + 1, i + 4), ['Accepted automatically while you were away (1):', '  Select the authentication provider → Clerk', '    undo: turbo-run answer 32 32-09-t2 --undo']);
  assert.ok(formatView({ ...views[1], ui: { lang: 'ru' } }).includes('Принято автоматически, пока вас не было (1):'));
  const root = tmpDir('vaway');
  const { writeAway } = await import('../lib/away-state.mjs');
  const { writeQuestions } = await import('../lib/questions.mjs');
  const { answerQuestion } = await import('../lib/answers.mjs');
  writeQuestions(root, '32', [{ id: '32-09-t2', phase: '32', plan: '32-09', task: '2', kind: 'decision', question: 'Pick one', options: [{ label: 'Clerk', signal: 'clerk', recommended: true }], allowOther: true, state: 'open', rev: 1 }]);
  answerQuestion({ root, phase: '32', id: '32-09-t2', option: 1, by: 'auto', now: new Date(at('10:30')), laneRunning: true });
  writeAway(root, { since: at('09:00'), ackAt: at('08:00'), snapshot: null });
  let v = buildView({ root, sup: null, commits: () => [], agents: false });
  assert.deepEqual(v.away, { since: at('09:00') });
  assert.deepEqual(v.autoAnswered.map((a) => [a.id, a.question, a.option, a.undo]), [['32-09-t2', 'Pick one', 'Clerk', 'turbo-run answer 32 32-09-t2 --undo']]);
  writeAway(root, { since: null, ackAt: at('11:00'), snapshot: null });
  v = buildView({ root, sup: null, commits: () => [], agents: false });
  assert.deepEqual([v.away, v.autoAnswered], [null, []], 'seen after the owner came back');
});
