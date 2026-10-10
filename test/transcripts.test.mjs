import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { AGENT, AGENT2, FORK, SESSION, entry, projectDirFor, setMtime, writeAgent, writeSession } from './helpers/transcripts.mjs';
import { agentIndex, findAgentTranscript, projectDirs, projectKey, sessionTranscripts } from '../lib/transcripts.mjs';

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
