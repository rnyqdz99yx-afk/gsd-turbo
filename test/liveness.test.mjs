import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { DEFAULT_META, SESSION, entry, jsonl, projectDirFor, setMtime, writeAgent, writeJob, writeSession } from './helpers/transcripts.mjs';
import { COMMAND_TIMEOUT_MS, LONG_CALL_MS, OVERRUN_MS, callsInFlight, liveness, longCall } from '../lib/liveness.mjs';
import { laneAgents, sessionTree } from '../lib/transcripts.mjs';
import { createLaneProbe } from '../lib/wake.mjs';
import { buildView, formatView } from '../lib/view.mjs';
import { render, paneLines } from '../mod/hooks/view-model.mjs';

// Synthetic transcripts in Claude Code 2.1.29x's shapes: while a tool call runs, its tool_use is the last entry.
const at = (hhmm) => `2026-01-01T${hhmm}:00.000Z`;
const ms = (hhmm) => Date.parse(at(hhmm));
const MIN = 60000;
const bash = (ts, input, { id = 'toolu_bash', mid = null, sidechain = true } = {}) => entry.assistant({ ts: at(ts), tool: { name: 'Bash', input: { command: 'npm run build', ...input }, id }, sidechain, id: mid });
const result = (id, ts, sidechain = true) => ({ ...entry.toolResult(id, 'ok', at(ts)), isSidechain: sidechain });
const agentUser = (ts) => entry.agentUser('a0123456789abcdef', 'Execute the plan', at(ts));

test('callsInFlight: a command whose tool_use no tool_result answers is in flight, with its timeout or the default', () => {
  assert.deepEqual(callsInFlight([agentUser('10:00'), bash('10:01', { timeout: 300000 })]), [{ id: 'toolu_bash', tool: 'Bash', startMs: ms('10:01'), timeoutMs: 300000 }]);
  // Claude Code 2.1.29x runs a command without a timeout up to 10 minutes (not the 2 minutes older docs name)
  assert.equal(COMMAND_TIMEOUT_MS, 600000);
  assert.deepEqual(callsInFlight([agentUser('10:00'), bash('10:01', {})]).map((c) => c.timeoutMs), [600000]);
  assert.deepEqual(callsInFlight([agentUser('10:00'), entry.assistant({ ts: at('10:01'), tool: { name: 'PowerShell', input: { command: 'x', timeout: '90000' } }, sidechain: true })]).map((c) => c.timeoutMs), [90000]);
  // a timeout past what Claude Code allows still counts as an hour at most
  assert.deepEqual(callsInFlight([bash('10:01', { timeout: 1e12 })]).map((c) => c.timeoutMs), [3600000]);
});

test('callsInFlight: a background call, a finished call and an older call the conversation moved past are not in flight', () => {
  assert.deepEqual(callsInFlight([agentUser('10:00'), bash('10:01', { run_in_background: true })]), []);
  assert.deepEqual(callsInFlight([agentUser('10:00'), bash('10:01', { timeout: 600000 }), result('toolu_bash', '10:09')]), []);
  // a tool_use left without its result (a crash) and a newer assistant message after it: only the last message counts
  assert.deepEqual(callsInFlight([bash('10:01', {}, { id: 'toolu_old' }), entry.assistant({ ts: at('10:30'), text: 'Resuming', sidechain: true })]), []);
  assert.deepEqual(callsInFlight([]), []);
  assert.deepEqual(callsInFlight([agentUser('10:00')]), []);
});

test('callsInFlight: calls of one message written as entries of their own; the pending one starts at the newest result', () => {
  const entries = [
    agentUser('10:00'),
    entry.assistant({ ts: at('10:01'), tool: { name: 'Read', input: { file_path: 'a' }, id: 'toolu_read' }, sidechain: true, id: 'msg_1' }),
    bash('10:01', { timeout: 600000 }, { mid: 'msg_1' }),
    result('toolu_read', '10:02'),
  ];
  // calls of one message may run one after another: the earliest the pending one started is the newest write
  assert.deepEqual(callsInFlight(entries), [{ id: 'toolu_bash', tool: 'Bash', startMs: ms('10:02'), timeoutMs: 600000 }]);
  // a call of another tool has no deadline; an Agent call waits for a helper of its own
  assert.deepEqual(callsInFlight([entry.dispatch('toolu_ag', 'gsd-executor', 'Execute plan 02 of phase 34', 'go', at('10:05'))]).map((c) => [c.tool, c.timeoutMs]), [['Agent', null]]);
});

test('review I1: a prompt after a call left without its result (the wake) means it runs no more; only the message and its results set its start', () => {
  const left = [agentUser('09:55'), bash('10:00', { timeout: 600000 })];
  // the wake prompt the supervisor sent after the command overran: the call was left, nothing is in flight
  assert.deepEqual(callsInFlight([...left, entry.user('This session was interrupted: nothing was written for 13 minutes.', at('10:13'))]), []);
  // a meta entry, an attachment, a queued notification or a system line after it renew nothing
  const later = [
    { ...entry.user('caveat', at('10:05')), isMeta: true },
    { ...entry.attachedNote('b1x2y3z4w', 'completed', at('10:06')), isSidechain: true },
    entry.queued('b1x2y3z4w', 'completed', at('10:07')),
    { type: 'system', subtype: 'turn_duration', timestamp: at('10:08') },
  ];
  assert.deepEqual(callsInFlight([...left, ...later]).map((c) => c.startMs), [ms('10:00')]);
});

test('review I2: only the first call still pending of a message gets a deadline; a command waiting in line behind it has none', () => {
  const dispatch = { ...entry.dispatch('toolu_ag', 'gsd-executor', 'Execute plan 02 of phase 34', 'go', at('10:00')), message: { id: 'msg_2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ag', name: 'Agent', input: { prompt: 'go' } }] } };
  const queued = bash('10:00', { timeout: 120000 }, { mid: 'msg_2', sidechain: false });
  assert.deepEqual(callsInFlight([dispatch, queued]).map((c) => [c.tool, c.timeoutMs]), [['Agent', null], ['Bash', null]]);
  // so a helper that works on past the queued command's would-be deadline never makes the lane silent by it
  const calls = callsInFlight([dispatch, queued]);
  assert.equal(liveness({ lastMs: ms('10:03') + 50000, calls, nowMs: ms('10:04') + 30000, stallMs: 15 * MIN }).state, 'active');
  const two = [bash('10:00', { timeout: 600000 }, { id: 'toolu_1', mid: 'msg_3' }), bash('10:00', { timeout: 60000 }, { id: 'toolu_2', mid: 'msg_3' })];
  assert.deepEqual(callsInFlight(two).map((c) => [c.id, c.timeoutMs]), [['toolu_1', 600000], ['toolu_2', null]]);
});

test('review M7: the calls of a transcript are read through a window that grows past a long result to the message', () => {
  const base = tmpDir('window');
  const dir = path.join(base, 'p');
  fs.mkdirSync(dir, { recursive: true });
  const big = { ...entry.toolResult('toolu_read', 'r'.repeat(100 * 1024), at('10:02')), isSidechain: true };
  const file = writeSession(dir, SESSION, [
    agentUser('10:00'),
    entry.assistant({ ts: at('10:01'), tool: { name: 'Read', input: { file_path: 'a' }, id: 'toolu_read' }, sidechain: true, id: 'msg_1' }),
    bash('10:01', { timeout: 600000 }, { mid: 'msg_1' }),
    big,
  ]);
  const tree = sessionTree({ file, sessionId: SESSION });
  assert.deepEqual(tree.calls.map((c) => [c.tool, c.startMs, c.timeoutMs, c.file]), [['Bash', ms('10:02'), 600000, file]]);
});

test('liveness: busy while a command runs within its timeout, silent once it overran with nothing written, else the write rule', () => {
  const call = { tool: 'Bash', startMs: ms('10:00'), timeoutMs: 10 * MIN };
  const stall = 5 * MIN;
  // in flight 11 minutes, past stall_minutes but within its timeout and the margin: busy
  assert.deepEqual(liveness({ lastMs: ms('10:00'), calls: [call], nowMs: ms('10:11'), stallMs: stall }), { state: 'busy', call });
  assert.equal(OVERRUN_MS, 2 * MIN);
  assert.equal(liveness({ lastMs: ms('10:00'), calls: [call], nowMs: ms('10:12'), stallMs: stall }).state, 'busy', 'the margin is part of its time');
  // past its timeout and the margin, nothing written since: silent at once, named by the call
  assert.deepEqual(liveness({ lastMs: ms('10:00'), calls: [call], nowMs: ms('10:13'), stallMs: 60 * MIN }), { state: 'silent', call });
  // something in the tree wrote after its deadline (another helper): the write rule decides
  assert.equal(liveness({ lastMs: ms('10:12') + 30000, calls: [call], nowMs: ms('10:13'), stallMs: stall }).state, 'active');
  // a wake after its deadline restarts the count: no overrun twice for the same call
  assert.equal(liveness({ lastMs: ms('10:00'), calls: [call], nowMs: ms('10:13'), stallMs: stall, floorMs: ms('10:12') + 30000 }).state, 'active');
  // nothing in flight: silent after stall_minutes without a write, from the floor at the latest
  assert.equal(liveness({ lastMs: ms('10:00'), calls: [], nowMs: ms('10:05'), stallMs: stall }).state, 'silent');
  assert.equal(liveness({ lastMs: ms('10:00'), calls: [], nowMs: ms('10:04'), stallMs: stall }).state, 'active');
  assert.equal(liveness({ lastMs: ms('10:00'), calls: [], nowMs: ms('10:05'), stallMs: stall, floorMs: ms('10:02') }).state, 'active');
  // a call of another tool (no deadline) never makes a session busy
  assert.equal(liveness({ lastMs: ms('10:00'), calls: [{ tool: 'Agent', startMs: ms('10:00'), timeoutMs: null }], nowMs: ms('10:30'), stallMs: stall }).state, 'silent');
  // nothing read is no proof of silence
  assert.equal(liveness({ lastMs: null, calls: [], nowMs: ms('10:30'), stallMs: stall }).state, 'active');
  // the busy call named is the one running longest
  const later = { tool: 'Bash', startMs: ms('10:05'), timeoutMs: 10 * MIN };
  assert.equal(liveness({ lastMs: ms('10:05'), calls: [later, call], nowMs: ms('10:08'), stallMs: stall }).call, call);
});

test('longCall: a busy session names its command once it ran a minute', () => {
  const call = { tool: 'Bash', startMs: ms('10:00'), timeoutMs: 10 * MIN };
  assert.equal(LONG_CALL_MS, MIN);
  assert.deepEqual(longCall({ state: 'busy', call }, ms('10:06')), { since: at('10:00') });
  assert.equal(longCall({ state: 'busy', call }, ms('10:00') + 30000), null);
  assert.equal(longCall({ state: 'active', call: null }, ms('10:06')), null);
  assert.equal(longCall(null, ms('10:06')), null);
});

// A lane project whose session writes nothing: its turn ended at 10:00 while its helpers work in the background.
function laneProject() {
  const base = tmpDir('live');
  const root = path.join(base, 'app');
  fs.mkdirSync(path.join(root, '.planning', 'turbo', 'run'), { recursive: true });
  const home = path.join(base, 'home');
  const dir = projectDirFor(home, root);
  const lane = writeSession(dir, SESSION, [entry.user('run phase 34', at('09:50')), entry.launched('toolu_1', 'a3400000000000001', at('10:00'))]);
  setMtime(lane, new Date(at('10:00')));
  writeJob(home, SESSION.slice(0, 8), { sessionId: SESSION, cwd: root });
  const sup = { pid: 4242, updatedAt: at('10:20'), finished: false, halted: false, range: { from: '34', to: '34' }, lane: { phase: '34', sessionId: SESSION.slice(0, 8), launchedAt: at('09:50'), mode: 'full', restarts: 0 } };
  return { root, home, dir, lane, sup, env: { CLAUDE_CONFIG_DIR: home } };
}
const STALL = 15 * MIN;
const AID = 'a3400000000000001';
const META = { ...DEFAULT_META, description: 'Execute plan 02 of phase 34' };
const executor = (dir, entries, mtime) => setMtime(writeAgent(dir, SESSION, AID, entries, META), new Date(at(mtime)));

test('a helper polls a build with a 10-minute command and the session wrote nothing for 17 minutes — busy, never "maybe stuck"', () => {
  const { root, dir, sup, env } = laneProject();
  executor(dir, [agentUser('10:00'), bash('10:12', { timeout: 600000 })], '10:12');
  const now = new Date(at('10:17'));
  const v = buildView({ root, sup, running: true, config: { stall_minutes: 15 }, env, now, commits: () => [] });
  const [lane] = v.lanes;
  assert.deepEqual([lane.quiet, lane.busy, lane.lastAt], [false, { since: at('10:12') }, at('10:12')]);
  assert.deepEqual(lane.agents.map((a) => [a.state, a.busy]), [['running', { since: at('10:12') }]]);
  const text = formatView(v);
  assert.match(text, /^Phase 34 — [^\n]* · all fine$/m);
  assert.match(text, /^ {2}a long command is running · 5m$/m);
  assert.match(text, /^ {2}Executor · plan 34-02 · a long command is running · 5m$/m);
  assert.doesNotMatch(text, /silent|stuck/);
  const ru = formatView({ ...v, ui: { ...v.ui, lang: 'ru' } });
  assert.match(ru, /^ {2}идёт долгая команда · 5 мин$/m);
  assert.match(ru, /^ {2}Исполнитель · план 34-02 · идёт долгая команда · 5 мин$/m);
  assert.doesNotMatch(ru, /тишина|молчит|завис/);
  // the pane says the same, in no warning colour
  assert.deepEqual(paneLines(render(v)).slice(0, 4), text.split('\n').slice(0, 4));
  // the supervisor's probe sees the command in flight: liveness says busy
  const live = createLaneProbe(root, env).activity(SESSION.slice(0, 8), now, STALL, root);
  assert.equal(liveness({ lastMs: live.lastMs, calls: live.calls, nowMs: now.getTime(), stallMs: 5 * MIN }).state, 'busy');
});

test('a helper whose command came back, or went to the background, and that wrote nothing since is quiet; so is one whose command overran', () => {
  for (const [name, entries] of [
    ['finished', [agentUser('09:55'), bash('09:58', { timeout: 600000 }), result('toolu_bash', '10:00')]],
    ['background', [agentUser('09:55'), bash('10:00', { run_in_background: true })]],
    ['overran', [agentUser('09:55'), bash('10:00', { timeout: 120000 })]],
  ]) {
    const { root, dir, sup, env } = laneProject();
    executor(dir, entries, '10:00');
    // 6 minutes on: the overran command's deadline (2 + 2 minutes) passed; the others wrote nothing for stall_minutes 5
    const v = buildView({ root, sup, running: true, config: { stall_minutes: 5 }, env, now: new Date(at('10:06')), commits: () => [] });
    assert.deepEqual([v.lanes[0].quiet, v.lanes[0].busy, v.lanes[0].agents[0].state], [true, null, 'quiet'], name);
    assert.match(formatView(v), /^Phase 34 — [^\n]* · silent for 6m — turbo is waking the session$/m, name);
  }
});

test('a nested helper in flight keeps the whole lane busy, and its parent that waits for it running', () => {
  const { root, dir, lane, sup, env } = laneProject();
  // the lane session's foreground Agent call waits; its executor waits for a nested helper of its own
  fs.appendFileSync(lane, jsonl([entry.dispatch('toolu_fg', 'gsd-executor', 'Execute plan 02 of phase 34', 'go', at('10:00'))]));
  setMtime(lane, new Date(at('10:00')));
  executor(dir, [agentUser('10:00'), { ...entry.dispatch('toolu_nested', 'general-purpose', 'Build the package', 'build', at('10:01')), isSidechain: true }], '10:01');
  const nested = 'a3400000000000002';
  setMtime(writeAgent(dir, SESSION, nested, [entry.agentUser(nested, 'build', at('10:01')), bash('10:02', { timeout: 600000 })], { agentType: 'general-purpose', description: 'Build the package', spawnDepth: 2, parentAgentId: AID }), new Date(at('10:02')));
  const now = new Date(at('10:10'));
  const r = laneAgents({ dirs: [dir], main: { file: lane, sessionId: SESSION }, root, now, stallMs: 5 * MIN });
  assert.deepEqual(r.tree.calls.map((c) => c.tool).sort(), ['Agent', 'Agent', 'Bash'], 'the Agent calls of the lane and of the executor, the nested Bash');
  assert.deepEqual(r.agents.map((a) => [a.agentId, a.state]), [[AID, 'running']], 'the nested helper is its parent\'s; the parent waits for it');
  const v = buildView({ root, sup, running: true, config: { stall_minutes: 5 }, env, now, commits: () => [] });
  assert.deepEqual([v.lanes[0].quiet, v.lanes[0].busy], [false, { since: at('10:02') }]);
  // the nested command overran: the parent and the lane are silent
  const late = new Date(at('10:15'));
  const quiet = buildView({ root, sup, running: true, config: { stall_minutes: 5 }, env, now: late, commits: () => [] });
  assert.deepEqual([quiet.lanes[0].quiet, quiet.lanes[0].busy, quiet.lanes[0].agents[0].state], [true, null, 'quiet']);
});

test('review M3, M5d, M6: the call a finished helper left runs no more; a helper at work outside the tree keeps the lane from silence; a stopped lane is never busy', () => {
  {
    const { root, dir, lane, sup, env } = laneProject();
    fs.appendFileSync(lane, jsonl([entry.note(AID, 'stopped', at('10:05'))]));
    setMtime(lane, new Date(at('10:05')));
    executor(dir, [agentUser('10:00'), bash('10:01', { timeout: 3600000 })], '10:01');
    const v = buildView({ root, sup, running: true, config: { stall_minutes: 5 }, env, now: new Date(at('10:20')), commits: () => [] });
    assert.deepEqual([v.lanes[0].quiet, v.lanes[0].busy, v.lanes[0].agents[0].state], [true, null, 'stopped']);
  }
  {
    const { root, dir, lane, sup, env } = laneProject();
    // the executor works in the transcript of another session (a fork moved it): not in this session's tree
    const other = '22222222-3333-4444-8555-666666666666';
    setMtime(writeAgent(dir, other, AID, [agentUser('10:00'), entry.assistant({ ts: at('10:19'), text: 'working', sidechain: true })], META), new Date(at('10:19')));
    assert.ok(fs.existsSync(lane));
    const v = buildView({ root, sup, running: true, config: { stall_minutes: 5 }, env, now: new Date(at('10:20')), commits: () => [] });
    assert.deepEqual([v.lanes[0].agents[0].state, v.lanes[0].quiet], ['running', false]);
  }
  {
    const { root, dir, sup, env } = laneProject();
    executor(dir, [agentUser('10:00'), bash('10:12', { timeout: 600000 })], '10:12');
    fs.writeFileSync(path.join(root, '.planning', 'turbo', 'run', 'p34.json'), JSON.stringify({ phase: '34', status: 'failed', reason: '', sessionId: '', at: at('10:13') }));
    const v = buildView({ root, sup, running: true, config: { stall_minutes: 15 }, env, now: new Date(at('10:17')), commits: () => [] });
    assert.deepEqual([v.lanes[0].status, v.lanes[0].busy], ['failed', null]);
  }
});

test('a silent lane in words says what turbo did: it wakes the session, woke or restarted it before, or gave up and needs the owner', () => {
  const { root, dir, sup, env } = laneProject();
  executor(dir, [agentUser('09:55'), bash('09:58', {}), result('toolu_bash', '10:00')], '10:00');
  const view = (stall, lang = 'en') => formatView(buildView({ root, sup: { ...sup, lane: { ...sup.lane, ...(stall ? { stall: stall.stall, notified: stall.notified ?? {} } : {}) } }, running: true, config: { stall_minutes: 15, lang }, env, now: new Date(at('10:20')), commits: () => [] }));
  assert.match(view(null), /· silent for 20m — turbo is waking the session$/m);
  // the supervisor woke it at 10:01: the silence counts from the wake, as the supervisor counts it
  assert.match(view({ stall: { count: 1, at: at('10:01') } }), /· silent for 20m — woke the session, waking it again$/m);
  assert.match(view({ stall: { count: 1, at: at('10:01'), relaunched: true } }, 'ru'), /· тишина 20 мин — перезапустил сессию, будит ещё раз$/m);
  assert.match(view({ stall: { count: 1, at: at('10:01'), missed: true } }, 'ru'), /· тишина 20 мин — не смог разбудить сессию, будит ещё раз$/m);
  // the wakes are used up: the supervisor tells the owner at its next check and wakes no more (review M5c)
  assert.match(view({ stall: { count: 2, at: at('10:01') } }), /· silent for 20m — waking the session did not help: needs you$/m);
  const told = view({ stall: { count: 2, at: at('10:01') }, notified: { stalled: true } }, 'ru');
  assert.match(told, /· тишина 20 мин — разбудить сессию не вышло: нужны вы$/m);
  assert.match(told, /^ {2}Нужны вы: фаза молчит и после пробуждений — посмотреть: claude attach 11111111$/m);
  assert.doesNotMatch(told, /возможно/);
  // a wake too recent: the lane is not silent yet (its helper is, and says only that)
  const recent = view({ stall: { count: 1, at: at('10:10') } });
  assert.doesNotMatch(recent, /the session/);
  assert.match(recent, /^ {2}⚠️ Executor silent for 20m · plan 34-02$/m);
});
