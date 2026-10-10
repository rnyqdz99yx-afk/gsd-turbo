import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { AGENT, AGENT2, FORK, SESSION, entry, jsonl, projectDirFor, setMtime, usage, writeAgent, writeSession } from './helpers/transcripts.mjs';
import { TAIL_MAX, actionOf, agentIndex, contextTokens, findAgentTranscript, headEntry, planOf, projectDirs, projectKey, sessionTranscripts, tailEntries } from '../lib/transcripts.mjs';

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
