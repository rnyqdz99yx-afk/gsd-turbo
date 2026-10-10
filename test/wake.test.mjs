import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { AGENT, entry, projectDirFor, setMtime, writeAgent, writeJob, writeSession } from './helpers/transcripts.mjs';
import { activityOf, answerWakePrompt, createLaneProbe, stallWakePrompt } from '../lib/wake.mjs';
import { laneUserPrompt } from '../lib/lane-prompt.mjs';

// a claude argv value: no double quotes, no percent signs, never an option
const plain = (s) => !s.includes('"') && !s.includes('%') && !s.startsWith('-');

test('the answer wake prompt names the questions and the delivery command, never an answer (Review Focus 4)', () => {
  const p = answerWakePrompt({ phase: '32', turboRun: 'node /t/turbo-run.mjs', ids: ['32-09-t2', '32-10-t3'] });
  assert.equal(p, 'The owner answered the questions phase 32 stopped for: 32-09-t2, 32-10-t3. Deliver them first: run node /t/turbo-run.mjs questions 32 --deliver and follow the turbo-phase skill, section Owner questions, Delivery: SendMessage each answer to the agent it names and wait for its result. Then go on with the turbo-phase skill for phase 32 from where you stopped; its step loop resumes by itself (arguments: 32 --resume).');
  assert.ok(plain(p));
});

test('the stall wake prompt: the unfinished subagents first, then the lane\'s own work, in full and in safe mode', () => {
  const full = stallWakePrompt({ phase: '32', turboRun: 'node x', mode: 'full', minutes: 16 });
  assert.match(full, /^This session was interrupted: nothing was written for 16 minutes\. Run node x view --json and follow the turbo-phase skill, section Owner questions, After an interruption: /);
  assert.match(full, /\(arguments: 32 --resume\)\.$/);
  const safe = stallWakePrompt({ phase: '32', turboRun: 'node x', mode: 'safe', minutes: 20 });
  assert.match(safe, /SendMessage with the current state of the disk and git \(git status --short, git log --oneline -5\)/);
  assert.match(safe, /Then: Resume phase 32\. First run node x gates restore 32 .*--only 32\. The state on disk/);
  assert.ok(plain(full) && plain(safe));
});

test('laneUserPrompt carries the owner\'s undelivered answers into a new full-mode session; unchanged without them and in safe mode', () => {
  assert.equal(laneUserPrompt({ phase: '2', mode: 'full', resume: true, turboRun: 'node x' }), 'Resume phase 2. Run the turbo-phase skill with arguments: 2 --resume');
  const p = laneUserPrompt({ phase: '2', mode: 'full', resume: true, turboRun: 'node x', answered: ['02-01-t2'] });
  assert.equal(p, "Resume phase 2. Run the turbo-phase skill with arguments: 2 --resume. Before its step loop, deliver the owner's answers to 02-01-t2: run node x questions 2 --deliver and follow the skill's section Owner questions, Delivery. This is a new session: SendMessage cannot reach those agents, so take the continuation path for each.");
  assert.ok(plain(p));
  assert.equal(laneUserPrompt({ phase: '2', resume: true, turboRun: 'node x', answered: ['02-01-t2'] }), laneUserPrompt({ phase: '2', resume: true, turboRun: 'node x' }));
});

const JOB = '1a2b3c4d';
const SID = `${JOB}-2222-4333-8444-555555555555`;
const at = (hhmm) => `2026-01-01T${hhmm}:00.000Z`;

test('the lane probe: the session id from the job state, the newest write of the lane and its subagents, and the subagents still running', () => {
  const base = tmpDir('probe');
  const root = path.join(base, 'app');
  fs.mkdirSync(root);
  const home = path.join(base, 'home');
  const dir = projectDirFor(home, root);
  writeJob(home, JOB, { sessionId: SID, cwd: root });
  setMtime(writeSession(dir, SID, [entry.user('go', at('10:00'))]), new Date(at('10:00')));
  setMtime(writeAgent(dir, SID, AGENT, [entry.agentUser(AGENT, 'task', at('10:01')), entry.assistant({ ts: at('10:20'), text: 'working', sidechain: true })]), new Date(at('10:20')));
  const probe = createLaneProbe(root, { CLAUDE_CONFIG_DIR: home });
  assert.equal(probe.session(JOB), SID);
  assert.deepEqual(probe.activity(JOB, new Date(at('10:25')), 15 * 60000), { lastMs: Date.parse(at('10:20')), active: 1 });
  assert.deepEqual(probe.activity(JOB, new Date(at('10:40')), 15 * 60000), { lastMs: Date.parse(at('10:20')), active: 0 });
  assert.equal(probe.session('ffffffff'), null);
  assert.deepEqual(probe.activity('ffffffff', new Date(at('10:40')), 15 * 60000), { lastMs: null, active: 0 });
  assert.deepEqual(activityOf({ lastAt: null, agents: [] }), { lastMs: null, active: 0 });
});
