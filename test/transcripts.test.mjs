import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { AGENT, AGENT2, FORK, SESSION, entry, jsonl, notification, projectDirFor, setMtime, usage, writeAgent, writeJob, writeSession } from './helpers/transcripts.mjs';
import { TAIL_MAX, actionOf, agentIndex, agentSnapshot, agentState, contextTokens, cwdInside, findAgentTranscript, findTranscript, harnessNotificationText, headEntry, jobState, laneAgents, laneTranscript, launchedAgentId, normalCwd, parseNotifications, planOf, projectDirs, projectKey, scanLaneTranscript, sessionTranscripts, tailEntries } from '../lib/transcripts.mjs';

const T0 = '2026-01-01T10:00:00.000Z';

// A project root and a Claude home with the project's transcript directory.
function setup() {
  const base = tmpDir('tr');
  const root = path.join(base, 'my project.v2');
  fs.mkdirSync(root);
  const home = path.join(base, 'home');
  return { root, home, dir: projectDirFor(home, root) };
}

test('projectKey turns every character but ASCII letters and digits into a dash', () => {
  assert.equal(projectKey('D:\\work\\my project.v2'), 'D--work-my-project-v2');
  assert.equal(projectKey('/home/dev/app_x'), '-home-dev-app-x');
  assert.equal(projectKey('/srv/проект'), '-srv-------');
});

test('projectDirs finds the project directory, and only an existing one', () => {
  const { root, home, dir } = setup();
  assert.deepEqual(projectDirs(home, root), [dir]);
  assert.deepEqual(projectDirs(path.join(home, 'missing'), root), []);
});

test('a key longer than 200 characters matches the directories named with its first 200 and a hash suffix', () => {
  const base = tmpDir('trl');
  const root = path.join(base, 'x'.repeat(230));
  fs.mkdirSync(root);
  const home = path.join(base, 'home');
  const long = projectKey(root);
  const hashed = path.join(home, 'projects', `${long.slice(0, 200)}-1a2b3c`);
  fs.mkdirSync(hashed, { recursive: true });
  fs.mkdirSync(path.join(home, 'projects', `${long.slice(0, 199)}`), { recursive: true });
  assert.deepEqual(projectDirs(home, root), [hashed]);
});

test('sessionTranscripts matches the full id or the prefix claude --bg printed, newest first', () => {
  const { dir } = setup();
  const a = writeSession(dir, SESSION, [entry.user('go', T0)]);
  const other = writeSession(dir, FORK, [entry.user('go', T0)]);
  setMtime(a, new Date('2026-01-01T10:00:00Z'));
  setMtime(other, new Date('2026-01-01T11:00:00Z'));
  assert.deepEqual(sessionTranscripts([dir], SESSION).map((t) => t.sessionId), [SESSION]);
  assert.deepEqual(sessionTranscripts([dir], SESSION.slice(0, 8)).map((t) => t.file), [a]);
  assert.equal(sessionTranscripts([dir], '').length, 0);
  assert.equal(sessionTranscripts([dir], '../x').length, 0);
});

test('a forked session moved the subagent: it is found by id in any session directory, newest file first', () => {
  const { dir } = setup();
  const old = writeAgent(dir, SESSION, AGENT, [entry.agentUser(AGENT, 'task', T0)]);
  const moved = writeAgent(dir, FORK, AGENT, [entry.agentUser(AGENT, 'task', T0)], { agentType: 'gsd-executor', description: 'moved' });
  writeAgent(dir, SESSION, AGENT2, [entry.agentUser(AGENT2, 'task', T0)]);
  setMtime(old, new Date('2026-01-01T10:00:00Z'));
  setMtime(moved, new Date('2026-01-01T12:00:00Z'));
  fs.mkdirSync(path.join(dir, 'memory'));
  const index = agentIndex([dir]);
  assert.deepEqual([...index.keys()].sort(), [AGENT, AGENT2].sort());
  const found = findAgentTranscript([dir], AGENT, index);
  assert.equal(found.file, moved);
  assert.equal(found.sessionId, FORK);
  assert.equal(found.meta.description, 'moved');
  assert.equal(findAgentTranscript([dir], 'a-missing'), null);
  assert.equal(findAgentTranscript([dir], '../../etc'), null);
});

test('tailEntries parses at most the last 256 KB and drops the line the window starts inside', () => {
  const { dir } = setup();
  const file = path.join(dir, 'big.jsonl');
  const filler = entry.user('x'.repeat(1000), T0);
  const lines = [entry.user('first', T0)];
  for (let i = 0; i < 400; i++) lines.push(filler);
  lines.push(entry.user('last', '2026-01-01T10:05:00.000Z'));
  fs.writeFileSync(file, jsonl(lines) + '{"broken": ');
  const { entries, read } = tailEntries(file);
  assert.equal(read, TAIL_MAX);
  assert.ok(fs.statSync(file).size > TAIL_MAX);
  assert.equal(entries.at(-1).message.content, 'last');
  assert.ok(entries.every((e) => e.message.content !== 'first'));
  assert.ok(entries.length < 400);
});

test('a tail window that starts inside a multibyte character still parses every whole line after it (Review Focus 2)', () => {
  const { dir } = setup();
  const file = path.join(dir, 'utf8.jsonl');
  for (const pad of ['', 'x']) {
    fs.writeFileSync(file, jsonl([entry.user(`${pad}${'я'.repeat(200000)}`, T0), entry.user('готово ✓', T0), entry.user('ещё строка', T0)]));
    assert.deepEqual(tailEntries(file).entries.map((e) => e.message.content), ['готово ✓', 'ещё строка'], `pad "${pad}"`);
  }
});

test('headEntry reads the first entry; null when the first line does not end within the window', () => {
  const { dir } = setup();
  const file = path.join(dir, 'h.jsonl');
  fs.writeFileSync(file, jsonl([entry.user('first', T0), entry.user('second', '2026-01-01T10:01:00.000Z')]));
  assert.equal(headEntry(file).timestamp, T0);
  fs.writeFileSync(file, jsonl([entry.user('y'.repeat(2000), T0)]));
  assert.equal(headEntry(file, { max: 1024 }), null);
  assert.equal(headEntry(file).timestamp, T0);
});

test('contextTokens adds input, cache creation and cache read; nothing counted is null', () => {
  assert.equal(contextTokens(usage(2, 245, 165000)), 165247);
  assert.equal(contextTokens({ output_tokens: 500 }), null);
  assert.equal(contextTokens(undefined), null);
});

test('actionOf: a path inside the root is relative, a command keeps its start, secrets are masked, 80 characters at most', () => {
  const root = tmpDir('act');
  assert.deepEqual(actionOf({ name: 'Edit', input: { file_path: path.join(root, 'lib', 'x.mjs'), old_string: 'a' } }, root), { tool: 'Edit', detail: 'lib/x.mjs' });
  assert.deepEqual(actionOf({ name: 'Read', input: { file_path: path.join(root, '..', 'elsewhere', 'y.md') } }, root).detail, path.join(root, '..', 'elsewhere', 'y.md').replace(/\\/g, '/'));
  const long = actionOf({ name: 'Bash', input: { command: `node --test   test/a.test.mjs\n${'z'.repeat(200)}`, description: 'run tests' } }, root);
  assert.equal(long.detail.length, 80);
  assert.ok(long.detail.startsWith('node --test test/a.test.mjs z'));
  assert.ok(long.detail.endsWith('…'));
  const deep = actionOf({ name: 'Write', input: { file_path: path.join(root, ...Array(30).fill('dir'), 'end.mjs') } }, root);
  assert.equal(deep.detail.length, 80);
  assert.ok(deep.detail.startsWith('…') && deep.detail.endsWith('dir/end.mjs'));
  const secret = `ghp_${'a'.repeat(36)}`;
  assert.equal(actionOf({ name: 'Bash', input: { command: `curl -H "Authorization: token ${secret}" x` } }, root).detail.includes(secret), false);
  assert.deepEqual(actionOf({ name: 'Skill', input: { skill: 'gsd-execute-phase' } }), { tool: 'Skill', detail: 'gsd-execute-phase' });
  assert.deepEqual(actionOf({ name: 'TodoWrite', input: { todos: [] } }), { tool: 'TodoWrite', detail: '' });
});

test('planOf reads the plan and task GSD dispatch descriptions name', () => {
  assert.deepEqual(planOf('Execute plan 07 of phase 32'), { plan: '32-07', task: null });
  assert.deepEqual(planOf('Execute plan 3 of phase 4.1'), { plan: '4.1-3', task: null });
  assert.deepEqual(planOf('Continue plan 32-07 from Task 2'), { plan: '32-07', task: '2' });
  assert.deepEqual(planOf('Verify phase 32 goal achievement'), { plan: null, task: null });
  assert.deepEqual(planOf(undefined), { plan: null, task: null });
});

test('normalCwd turns a Git Bash path into a Windows one on win32 only; cwdInside accepts the root and directories below it', () => {
  assert.equal(normalCwd('/c/work/app', 'win32'), 'C:/work/app');
  assert.equal(normalCwd('/d', 'win32'), 'D:/');
  assert.equal(normalCwd('D:\\work\\app', 'win32'), 'D:/work/app');
  assert.equal(normalCwd('/cache/x', 'win32'), '/cache/x');
  assert.equal(normalCwd('/c/work/app', 'linux'), '/c/work/app');
  const { root } = setup();
  // the spelling Git Bash gives the root on Windows; elsewhere the root as is
  const shell = process.platform === 'win32' ? root.replace(/^([A-Za-z]):\\/, (m, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : root;
  assert.ok(cwdInside(root, root));
  assert.ok(cwdInside(`${shell}/lib/sub`, root));
  assert.equal(cwdInside(`${root}-other`, root), false);
  assert.equal(cwdInside(path.dirname(root), root), false);
  assert.equal(cwdInside(null, root), false);
});

const JOB = '1a2b3c4d';
const STALE = `${JOB}-2222-4333-8444-555555555555`;
const CURRENT = '99999999-8888-4777-8666-555555555555';

test('a lane resumed onto another transcript: the job state wins over the stale file its job id prefixes', () => {
  const { root, home, dir } = setup();
  const stale = writeSession(dir, STALE, [entry.user('first run', T0)]);
  const current = writeSession(dir, CURRENT, [entry.user('resumed', T0)]);
  setMtime(stale, new Date('2026-01-01T12:00:00Z')); // newer than the current one: a prefix lookup alone would pick it
  setMtime(current, new Date('2026-01-01T11:00:00Z'));
  writeJob(home, JOB, { sessionId: STALE, resumeSessionId: CURRENT, linkScanPath: current });
  assert.deepEqual(laneTranscript({ home, root, jobId: JOB }), { file: current, sessionId: CURRENT, via: 'job-link' });
  writeJob(home, JOB, { sessionId: STALE, resumeSessionId: CURRENT, linkScanPath: path.join(dir, 'gone.jsonl') });
  assert.deepEqual(laneTranscript({ home, root, jobId: JOB }), { file: current, sessionId: CURRENT, via: 'job-session' });
  // a linkScanPath outside <claude-home>/projects/ is never read
  const outside = path.join(path.dirname(home), 'elsewhere.jsonl');
  fs.writeFileSync(outside, '');
  writeJob(home, JOB, { sessionId: STALE, resumeSessionId: CURRENT, linkScanPath: outside });
  assert.deepEqual(laneTranscript({ home, root, jobId: JOB }), { file: current, sessionId: CURRENT, via: 'job-session' });
  fs.rmSync(path.join(home, 'jobs'), { recursive: true });
  assert.deepEqual(laneTranscript({ home, root, jobId: JOB }), { file: stale, sessionId: STALE, via: 'job-prefix' });
  assert.equal(laneTranscript({ home, root, jobId: '../x' }), null);
  assert.equal(jobState(home, JOB), null);
});

test('a root spelled differently from the path the lane started in: the lane transcript is still found (Review Focus 1)', () => {
  const base = tmpDir('trj');
  const real = path.join(base, 'real');
  const link = path.join(base, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, 'junction'); // a junction on Windows (no admin needed); the type is ignored elsewhere
  const home = path.join(base, 'home');
  const dir = projectDirFor(home, link); // Claude Code names the directory after the path the session started in
  const file = writeSession(dir, STALE, [entry.user('go', T0)]);
  assert.deepEqual(projectDirs(home, real), []);
  assert.deepEqual(laneTranscript({ home, root: real, jobId: JOB }), { file, sessionId: STALE, via: 'job-prefix' });
  assert.equal(laneTranscript({ home, root: real, jobId: 'feedbeef' }), null);
  assert.deepEqual(projectDirs(home, link), [dir]);
  if (process.platform === 'win32') assert.equal(projectDirs(home, link.toLowerCase()).length, 1);
});

test('findTranscript: the calling session (CLAUDE_CODE_SESSION_ID), its job (CLAUDE_JOB_DIR), the lane, then the newest transcript whose cwd is in the root', () => {
  const { root, home, dir } = setup();
  const otherRoot = path.join(path.dirname(root), 'other project');
  const other = projectDirFor(home, otherRoot);
  // Git Bash spells the root /c/… on Windows, and Bash may have moved into a subfolder
  const shell = process.platform === 'win32' ? root.replace(/^([A-Za-z]):\\/, (m, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : root;
  const mine = writeSession(dir, CURRENT, [{ ...entry.user('hi', T0), cwd: `${shell}/lib` }]);
  const laneFile = writeSession(dir, STALE, [entry.user('lane', T0)]);
  const foreign = writeSession(other, FORK, [{ ...entry.user('hi', T0), cwd: otherRoot }]);
  setMtime(mine, new Date('2026-01-01T10:00:00Z'));
  setMtime(laneFile, new Date('2026-01-01T09:00:00Z'));
  setMtime(foreign, new Date('2026-01-01T11:00:00Z'));
  // an id needs no cwd check: here it names the other project's transcript, and it comes before a recorded lane
  assert.deepEqual(findTranscript({ home, root, env: { CLAUDE_CODE_SESSION_ID: FORK }, lane: JOB }), { file: foreign, sessionId: FORK, via: 'session' });
  // a session id is exact: a mere prefix of a transcript's name names no session
  assert.deepEqual(findTranscript({ home, root, env: { CLAUDE_CODE_SESSION_ID: '99999999' }, lane: JOB }), { file: laneFile, sessionId: STALE, via: 'lane' });
  const jobDir = writeJob(home, 'feedbeef', { sessionId: 'feedbeef-0000-4000-8000-000000000000', resumeSessionId: CURRENT, linkScanPath: mine });
  assert.deepEqual(findTranscript({ home, root, env: { CLAUDE_JOB_DIR: jobDir }, lane: JOB }), { file: mine, sessionId: CURRENT, via: 'job' });
  assert.deepEqual(findTranscript({ home, root, env: {} }), { file: mine, sessionId: CURRENT, via: 'newest' });
  assert.equal(findTranscript({ home, root: path.join(path.dirname(root), 'third'), env: {} }), null);
});

test('the newest-transcript fallback reads past a last line longer than the tail window', () => {
  const { root, home, dir } = setup();
  const file = writeSession(dir, CURRENT, [{ ...entry.user('hi', T0), cwd: root }, { ...entry.user('z'.repeat(600 * 1024), T0), cwd: undefined }]);
  assert.deepEqual(findTranscript({ home, root, env: {} }), { file, sessionId: CURRENT, via: 'newest' });
});

test('parseNotifications keeps final statuses (killed reads as stopped) and skips progress events', () => {
  const text = [notification(AGENT, 'completed'), notification(AGENT2, 'killed'), notification('b1x2y3z4w', 'failed'),
    '<task-notification>\n<task-id>b9q8r7s6t</task-id>\n<summary>shell printed a line</summary>\n<event>output</event>\n</task-notification>'].join('\n');
  assert.deepEqual(parseNotifications(text), [
    { taskId: AGENT, status: 'completed' }, { taskId: AGENT2, status: 'stopped' }, { taskId: 'b1x2y3z4w', status: 'failed' },
  ]);
});

test('only entries the harness wrote carry a notification: never a quote in a dispatch prompt, a tool result or assistant text', () => {
  assert.ok(harnessNotificationText(entry.note(AGENT, 'completed', T0)));
  assert.ok(harnessNotificationText(entry.attachedNote(AGENT, 'completed', T0)));
  const quote = notification(AGENT, 'completed');
  assert.equal(harnessNotificationText(entry.dispatch('toolu_q', 'gsd-executor', 'Execute plan 07 of phase 32', `wait for ${quote}`, T0)), null);
  assert.equal(harnessNotificationText(entry.toolResult('toolu_g', `log.jsonl:12: ${quote}`, T0)), null);
  assert.equal(harnessNotificationText(entry.assistant({ ts: T0, text: quote })), null);
  assert.equal(harnessNotificationText(entry.user(`the owner pasted: ${quote}`, T0)), null);
  assert.equal(harnessNotificationText(entry.queued(AGENT, 'completed', T0)), null);
  assert.equal(harnessNotificationText({ ...entry.note(AGENT, 'completed', T0), isSidechain: true }), null);
  assert.equal(launchedAgentId(entry.launched('toolu_l', AGENT, T0)), AGENT);
  assert.equal(launchedAgentId(entry.toolResult('toolu_g', AGENT, T0)), null);
});

test('scanLaneTranscript indexes notifications and launched agents, the newest notification per agent winning', () => {
  const { dir } = setup();
  const quote = notification(AGENT2, 'completed');
  const file = writeSession(dir, SESSION, [
    entry.user('run phase 32', T0),
    entry.dispatch('toolu_1', 'gsd-executor', 'Execute plan 07 of phase 32', 'do it', T0),
    entry.launched('toolu_1', AGENT, T0),
    entry.dispatch('toolu_2', 'gsd-executor', 'Execute plan 08 of phase 32', `report ${quote} when done`, T0),
    entry.launched('toolu_2', AGENT2, T0),
    entry.attachedNote(AGENT, 'stopped', '2026-01-01T10:10:00.000Z'),
    entry.note(AGENT, 'completed', '2026-01-01T10:20:00.000Z'),
  ]);
  const s = scanLaneTranscript(file);
  assert.deepEqual(s.launched, [AGENT, AGENT2]);
  assert.deepEqual(s.notes, { [AGENT]: { status: 'completed', at: '2026-01-01T10:20:00.000Z' } });
  assert.equal(s.scanned, fs.statSync(file).size);
});

test('scanLaneTranscript reads a transcript larger than one chunk whose chunk boundary splits a multibyte character (Review Focus 2)', () => {
  const { dir } = setup();
  for (const pad of ['', 'x']) {
    const file = writeSession(dir, SESSION, [
      entry.user(`${pad}${'я'.repeat(600000)}`, T0),
      entry.launched('toolu_1', AGENT, T0),
      entry.note(AGENT, 'completed', '2026-01-01T10:40:00.000Z'),
    ]);
    const s = scanLaneTranscript(file);
    assert.ok(fs.statSync(file).size > 1024 * 1024);
    assert.equal(s.scanned, fs.statSync(file).size, `pad "${pad}"`);
    assert.deepEqual(s.launched, [AGENT]);
    assert.deepEqual(s.notes[AGENT], { status: 'completed', at: '2026-01-01T10:40:00.000Z' });
  }
});

test('scanLaneTranscript reads only what was appended, keeps a line without its newline for later, and rereads a file that shrank', () => {
  const { dir } = setup();
  const file = writeSession(dir, SESSION, [entry.user('x'.repeat(5000), T0), entry.launched('toolu_1', AGENT, T0)]);
  const first = scanLaneTranscript(file);
  assert.equal(first.read, fs.statSync(file).size);
  assert.equal(scanLaneTranscript(file, first).read, 0);
  const half = JSON.stringify(entry.note(AGENT, 'completed', '2026-01-01T10:30:00.000Z'));
  fs.appendFileSync(file, half.slice(0, 40));
  const partial = scanLaneTranscript(file, first);
  assert.equal(partial.read, 40);
  assert.equal(partial.scanned, first.scanned);
  assert.deepEqual(partial.notes, {});
  fs.appendFileSync(file, `${half.slice(40)}\n`);
  const done = scanLaneTranscript(file, partial);
  assert.equal(done.read, half.length + 1);
  assert.deepEqual(done.notes[AGENT], { status: 'completed', at: '2026-01-01T10:30:00.000Z' });
  writeSession(dir, SESSION, [entry.launched('toolu_9', AGENT2, T0)]);
  assert.deepEqual(scanLaneTranscript(file, done).launched, [AGENT2]);
  assert.deepEqual(scanLaneTranscript(file, { scanned: 'bad' }).launched, [AGENT2]);
});

const NOW = new Date('2026-01-01T11:00:00.000Z');
const STALL = 15 * 60000;
const at = (hhmm) => `2026-01-01T${hhmm}:00.000Z`;
// A subagent transcript: its prompt at `from`, then one tool call at `to` with the given usage.
const agentEntries = (id, from, to, tool = { name: 'Bash', input: { command: 'node --test test/a.test.mjs' } }) => [
  entry.agentUser(id, 'Execute the plan', at(from)),
  entry.assistant({ ts: at(to), tool, usage: usage(1, 1000, 40000), sidechain: true }),
];

test('agentState: a notification the agent did not outlive decides; else running within the stall window, else quiet', () => {
  const base = { lastAt: at('10:20'), writtenMs: Date.parse(at('10:20')), nowMs: NOW.getTime(), stallMs: STALL };
  assert.equal(agentState({ ...base, note: { status: 'completed', at: at('10:20') } }), 'completed');
  assert.equal(agentState({ ...base, note: { status: 'stopped', at: at('10:20') } }), 'stopped');
  assert.equal(agentState({ ...base, note: { status: 'failed', at: at('10:20') } }), 'failed');
  assert.equal(agentState({ ...base, note: null }), 'quiet');
  assert.equal(agentState({ ...base, note: null, writtenMs: Date.parse(at('10:50')) }), 'running');
  // resumed with SendMessage after a stop: it wrote again after the notification
  assert.equal(agentState({ ...base, note: { status: 'stopped', at: at('10:10') }, writtenMs: Date.parse(at('10:58')) }), 'running');
});

test('agentSnapshot reads first and last time, the last tool call and the last context; an unchanged file returns the cached snapshot', () => {
  const root = tmpDir('snap');
  const { dir } = setup();
  const file = writeAgent(dir, SESSION, AGENT, agentEntries(AGENT, '10:00', '10:40', { name: 'Edit', input: { file_path: path.join(root, 'lib', 'x.mjs') } }));
  const s = agentSnapshot(file, root);
  assert.equal(s.firstAt, at('10:00'));
  assert.equal(s.lastAt, at('10:40'));
  assert.deepEqual(s.action, { tool: 'Edit', detail: 'lib/x.mjs' });
  assert.equal(s.tokens, 41001);
  assert.equal(agentSnapshot(file, root, s), s);
  fs.appendFileSync(file, jsonl([entry.assistant({ ts: at('10:45'), text: 'done', sidechain: true })]));
  const grown = agentSnapshot(file, root, s);
  assert.notEqual(grown, s);
  assert.equal(grown.lastAt, at('10:45'));
  assert.deepEqual(grown.action, { tool: 'Edit', detail: 'lib/x.mjs' });
  assert.equal(agentSnapshot(file, root, { size: 'x' }).firstAt, at('10:00'));
});

test('laneAgents: states from the lane transcript, nested agents left out, active ones first', () => {
  const root = tmpDir('lane');
  const { dir } = setup();
  const ids = { done: 'a1000000000000001', run: 'a1000000000000002', quiet: 'a1000000000000003', killed: 'a1000000000000004', failed: 'a1000000000000005', resumed: 'a1000000000000006', nested: 'a1000000000000007' };
  const laneFile = writeSession(dir, SESSION, [
    entry.user('run phase 32', at('09:59')),
    ...Object.values(ids).filter((id) => id !== ids.nested).map((id, i) => entry.launched(`toolu_${i}`, id, at('10:00'))),
    entry.note(ids.done, 'completed', at('10:30')),
    entry.attachedNote(ids.killed, 'killed', at('10:31')),
    entry.note(ids.failed, 'failed', at('10:32')),
    entry.note(ids.resumed, 'stopped', at('10:20')),
  ]);
  const write = (id, from, to, mtime, meta) => setMtime(writeAgent(dir, SESSION, id, agentEntries(id, from, to), meta), new Date(at(mtime)));
  write(ids.done, '10:00', '10:30', '10:30');
  write(ids.run, '10:00', '10:50', '10:50');
  write(ids.quiet, '10:00', '10:30', '10:30');
  write(ids.killed, '10:00', '10:31', '10:31');
  write(ids.failed, '10:00', '10:32', '10:32');
  write(ids.resumed, '10:00', '10:55', '10:55');
  write(ids.nested, '10:00', '10:58', '10:58', { agentType: 'gsd-code-reviewer', spawnDepth: 2 });
  const used = {};
  const r = laneAgents({ dirs: [dir], main: { file: laneFile, sessionId: SESSION }, root, now: NOW, stallMs: STALL, used });
  const byId = Object.fromEntries(r.agents.map((a) => [a.agentId, a]));
  assert.deepEqual([r.transcript, r.sessionId], [laneFile, SESSION]);
  assert.equal(byId[ids.done].state, 'completed');
  assert.equal(byId[ids.run].state, 'running');
  assert.equal(byId[ids.quiet].state, 'quiet');
  assert.equal(byId[ids.killed].state, 'stopped');
  assert.equal(byId[ids.failed].state, 'failed');
  assert.equal(byId[ids.resumed].state, 'running');
  assert.equal(byId[ids.nested], undefined);
  assert.deepEqual(r.agents.slice(0, 3).map((a) => a.state).sort(), ['quiet', 'running', 'running']);
  const done = byId[ids.done];
  assert.equal(done.elapsedMs, 30 * 60000);
  assert.equal(byId[ids.run].elapsedMs, 60 * 60000);
  assert.deepEqual([done.type, done.plan, done.task, done.model, done.tokens], ['gsd-executor', '32-07', null, 'opus', 41001]);
  assert.deepEqual(done.action, { tool: 'Bash', detail: 'node --test test/a.test.mjs' });
  assert.ok(used[r.transcript] && used[done.transcript]);
});

test('background shell tasks and progress events in the lane transcript are never agents and never change one (Review Focus 4)', () => {
  const { root, dir } = setup();
  const event = { ...entry.attachedNote('b9q8r7s6t', 'completed', at('10:41')) };
  event.attachment = { ...event.attachment, prompt: '<task-notification>\n<task-id>b9q8r7s6t</task-id>\n<summary>printed a line</summary>\n<event>output</event>\n</task-notification>' };
  const laneFile = writeSession(dir, SESSION, [
    entry.launched('toolu_1', AGENT, at('10:00')),
    entry.note('b1x2y3z4w', 'completed', at('10:40')),
    event,
    { ...entry.toolResult('toolu_b', 'Command running in background with ID: b1x2y3z4w', at('10:39')), toolUseResult: { backgroundTaskId: 'b1x2y3z4w' } },
  ]);
  setMtime(writeAgent(dir, SESSION, AGENT, agentEntries(AGENT, '10:00', '10:55')), new Date(at('10:55')));
  const r = laneAgents({ dirs: [dir], main: { file: laneFile, sessionId: SESSION }, root, now: NOW, stallMs: STALL });
  assert.deepEqual(r.agents.map((a) => [a.agentId, a.state]), [[AGENT, 'running']]);
});

test('laneAgents after a fork: the current session finds agents launched before the fork in the old session directory', () => {
  const { root, dir } = setup();
  const laneFile = writeSession(dir, FORK, [entry.launched('toolu_1', AGENT, at('10:00')), entry.launched('toolu_2', AGENT2, at('10:01'))]);
  writeAgent(dir, SESSION, AGENT, agentEntries(AGENT, '10:00', '10:58'));
  writeAgent(dir, FORK, AGENT2, agentEntries(AGENT2, '10:01', '10:59'));
  const r = laneAgents({ dirs: [dir], main: { file: laneFile, sessionId: FORK }, root, now: NOW, stallMs: STALL });
  assert.deepEqual(r.agents.map((a) => [a.agentId, a.sessionId]).sort(), [[AGENT, SESSION], [AGENT2, FORK]].sort());
  assert.deepEqual(laneAgents({ dirs: [dir], main: null, root, now: NOW, stallMs: STALL }), { transcript: null, sessionId: null, lastAt: null, agents: [] });
});

test('a Claude home spelled through a link still accepts the linkScanPath its job state names under projects/', () => {
  const base = tmpDir('trh');
  const realHome = path.join(base, 'real-home');
  fs.mkdirSync(realHome);
  const home = path.join(base, 'home-link');
  fs.symlinkSync(realHome, home, 'junction'); // CLAUDE_CONFIG_DIR given through a link; the job state names the real path
  const root = path.join(base, 'app');
  fs.mkdirSync(root);
  const current = writeSession(projectDirFor(realHome, root), CURRENT, [entry.user('resumed', T0)]);
  writeJob(realHome, JOB, { sessionId: STALE, resumeSessionId: CURRENT, linkScanPath: current });
  assert.deepEqual(laneTranscript({ home, root, jobId: JOB }), { file: current, sessionId: CURRENT, via: 'job-link' });
  // and the other way round: the home as is, the linkScanPath through the link
  const viaLink = path.join(home, path.relative(realHome, current));
  writeJob(realHome, JOB, { sessionId: STALE, resumeSessionId: CURRENT, linkScanPath: viaLink });
  assert.deepEqual(laneTranscript({ home: realHome, root, jobId: JOB }), { file: viaLink, sessionId: CURRENT, via: 'job-link' });
  // a path outside projects/ stays refused whatever its spelling
  const outside = path.join(home, 'elsewhere.jsonl');
  fs.writeFileSync(outside, '');
  writeJob(realHome, JOB, { sessionId: STALE, resumeSessionId: CURRENT, linkScanPath: outside });
  assert.equal(laneTranscript({ home: realHome, root, jobId: JOB }).via, 'job-session');
});
