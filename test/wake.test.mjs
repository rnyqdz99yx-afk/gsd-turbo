import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { AGENT, AGENT2, DEFAULT_META, entry, projectDirFor, setMtime, writeAgent, writeJob, writeSession } from './helpers/transcripts.mjs';
import { sessionTreeMtimeMs } from '../lib/transcripts.mjs';
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
  assert.deepEqual(probe.activity(JOB, new Date(at('10:25')), 15 * 60000), { lastMs: Date.parse(at('10:20')), active: 1, calls: [] });
  assert.deepEqual(probe.activity(JOB, new Date(at('10:40')), 15 * 60000), { lastMs: Date.parse(at('10:20')), active: 0, calls: [] });
  assert.equal(probe.session('ffffffff'), null);
  assert.deepEqual(probe.activity('ffffffff', new Date(at('10:40')), 15 * 60000), { lastMs: null, active: 0, calls: [] });
  assert.deepEqual(activityOf({ lastAt: null, agents: [] }), { lastMs: null, active: 0 });
});

test('the lane probe tells whether the lane session itself answered after a time: its own assistant entries, not the prompt it was given or a synthetic error', () => {
  const base = tmpDir('replied');
  const root = path.join(base, 'app');
  fs.mkdirSync(root);
  const home = path.join(base, 'home');
  const dir = projectDirFor(home, root);
  writeJob(home, JOB, { sessionId: SID, cwd: root });
  const synthetic = { ...entry.assistant({ ts: at('10:30'), text: 'API Error' }), message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }] } };
  writeSession(dir, SID, [entry.assistant({ ts: at('10:00'), text: 'working' }), entry.user('This session was interrupted', at('10:20')), synthetic]);
  const probe = createLaneProbe(root, { CLAUDE_CONFIG_DIR: home });
  const woken = Date.parse(at('10:15'));
  assert.equal(probe.replied(JOB, woken), false);
  writeSession(dir, SID, [entry.assistant({ ts: at('10:00'), text: 'working' }), entry.user('This session was interrupted', at('10:20')), entry.assistant({ ts: at('10:21'), text: 'Resuming the subagents' })]);
  assert.equal(probe.replied(JOB, woken), true);
  assert.equal(probe.replied('ffffffff', woken), false);
});

test('v0.3.3: a wake for checkpoint answers and the lane\'s own question names both; a new full session takes the lane\'s own one itself', () => {
  const p = answerWakePrompt({ phase: '32', turboRun: 'node x', ids: ['32-09-t2'], lane: [{ id: 'ask-2', option: 1, label: 'Go -on' }] });
  assert.match(p, /^The owner answered the questions phase 32 stopped for: 32-09-t2\. Deliver them first: .* The owner answered the question you asked at your stop: ask-2 \(option 1, Go -on\)\. .*--delivered ask-2 --path lane\. Then go on with the turbo-phase skill for phase 32 /);
  assert.ok(plain(p));
  assert.equal(answerWakePrompt({ phase: '32', turboRun: 'node x', ids: ['32-09-t2'] }), answerWakePrompt({ phase: '32', turboRun: 'node x', ids: ['32-09-t2'], lane: [], mode: 'full' }), 'a checkpoint wake is unchanged');
  const u = laneUserPrompt({ phase: '2', mode: 'full', resume: true, turboRun: 'node x', laneAnswered: ['ask-1'] });
  assert.equal(u, "Resume phase 2. Run the turbo-phase skill with arguments: 2 --resume. Before its step loop, take the owner's answer to the question you asked: ask-1. Run node x questions 2 --deliver, do what the chosen option says, then run node x questions 2 --delivered ask-1 --path lane.");
  assert.ok(plain(u));
});

test('the probe\'s last write covers nested subagents: any transcript under the session\'s subagents tree (journal: a busy lane was woken twice; Review Focus 5)', () => {
  const base = tmpDir('tree');
  const root = path.join(base, 'app');
  fs.mkdirSync(root);
  const home = path.join(base, 'home');
  const dir = projectDirFor(home, root);
  writeJob(home, JOB, { sessionId: SID, cwd: root });
  setMtime(writeSession(dir, SID, [entry.user('go', at('10:00'))]), new Date(at('10:00')));
  setMtime(writeAgent(dir, SID, AGENT, [entry.agentUser(AGENT, 'task', at('10:01'))]), new Date(at('10:01')));
  // a level-2 agent: the lane's agent list leaves it out (it reports to its parent)
  const nested = writeAgent(dir, SID, AGENT2, [entry.agentUser(AGENT2, 'sub', at('10:02'))], { ...DEFAULT_META, spawnDepth: 2, parentAgentId: AGENT });
  setMtime(nested, new Date(at('10:30')));
  // and one a level deeper; meta files and other files are no transcript writes
  const deeper = path.join(dir, SID, 'subagents', 'nested', 'agent-a1111111111111111.jsonl');
  fs.mkdirSync(path.dirname(deeper), { recursive: true });
  fs.writeFileSync(deeper, '{}\n');
  setMtime(deeper, new Date(at('10:35')));
  for (const meta of fs.readdirSync(path.join(dir, SID, 'subagents')).filter((n) => n.endsWith('.meta.json'))) setMtime(path.join(dir, SID, 'subagents', meta), new Date(at('10:01')));
  fs.writeFileSync(path.join(dir, SID, 'subagents', 'notes.txt'), 'x'); // written now: not a transcript
  const probe = createLaneProbe(root, { CLAUDE_CONFIG_DIR: home });
  assert.equal(probe.activity(JOB, new Date(at('10:40')), 15 * 60000).lastMs, Date.parse(at('10:35')));
  assert.equal(sessionTreeMtimeMs({ file: path.join(dir, `${SID}.jsonl`), sessionId: SID }), Date.parse(at('10:35')));
  assert.equal(sessionTreeMtimeMs({ file: path.join(dir, 'missing.jsonl'), sessionId: 'missing' }), null);
});

test('the probe reads a lane that runs in another directory (its slot) when given that directory (Stage 4 L1)', () => {
  const base = tmpDir('probe-slot');
  const root = path.join(base, 'app');
  const slot = path.join(base, 'app.turbo', 'lane-1');
  fs.mkdirSync(root);
  fs.mkdirSync(slot, { recursive: true });
  const home = path.join(base, 'home');
  const dir = projectDirFor(home, slot);
  writeJob(home, JOB, { sessionId: SID, cwd: slot });
  setMtime(writeSession(dir, SID, [entry.user('go', at('10:00')), entry.assistant({ ts: at('10:05'), text: 'ok' })]), new Date(at('10:05')));
  const probe = createLaneProbe(root, { CLAUDE_CONFIG_DIR: home });
  assert.equal(probe.session(JOB, slot), SID);
  assert.equal(probe.activity(JOB, new Date(at('10:10')), 15 * 60000, slot).lastMs, Date.parse(at('10:05')));
  assert.equal(probe.replied(JOB, Date.parse(at('10:01')), slot), true);
});

test('review I4: each lane keeps its own transcript cache across the other lanes\' reads', () => {
  const base = tmpDir('probe-cache');
  const root = path.join(base, 'app');
  fs.mkdirSync(root);
  const home = path.join(base, 'home');
  const slots = ['lane-1', 'lane-2'].map((n) => path.join(base, 'app.turbo', n));
  const jobs = ['1a2b3c4d', '5e6f7a8b'];
  slots.forEach((slot, i) => {
    fs.mkdirSync(slot, { recursive: true });
    const sid = `${jobs[i]}-2222-4333-8444-555555555555`;
    writeJob(home, jobs[i], { sessionId: sid, cwd: slot });
    writeSession(projectDirFor(home, slot), sid, [entry.user('go', at('10:00'))]);
  });
  const seen = [];
  const probe = createLaneProbe(root, { CLAUDE_CONFIG_DIR: home }, {
    agentsOf: (opts) => {
      seen.push({ main: opts.main.sessionId, cache: opts.cache });
      opts.used[opts.main.sessionId] = { mark: opts.main.sessionId };
      return { lastAt: at('10:00'), agents: [] };
    },
  });
  const now = new Date(at('10:05'));
  probe.activity(jobs[0], now, 60000, slots[0]);
  probe.activity(jobs[1], now, 60000, slots[1]);
  probe.activity(jobs[0], now, 60000, slots[0]);
  assert.deepEqual(seen[2].cache, { [seen[0].main]: { mark: seen[0].main } }, 'lane 1 finds its own cache after lane 2 read');
});
