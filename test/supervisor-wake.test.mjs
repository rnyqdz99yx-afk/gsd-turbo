import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { tick } from '../lib/supervisor.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { writeLaneStatus } from '../lib/run-status.mjs';
import { laneSessionName } from '../lib/claude.mjs';
import { writeQuestions } from '../lib/questions.mjs';
import { answerQuestion } from '../lib/answers.mjs';

const WOKE = (id) => `backgrounded · ${id} · lane\nnote: woke session ${id} with its saved options (--name, --permission-mode, --settings, --append-system-prompt, --disallowedTools, --model)\n`;
const COPY = (id) => `note: session is already running in the background, so this started a copy as ${id}\nbackgrounded · ${id} · lane\n`;
const fresh = () => ({ lane: null, finished: false, halted: false });

// A full-mode supervisor for phase 2 with a fake claude that can stop, remove and resume sessions.
function harness() {
  const root = tmpDir('wake');
  fs.mkdirSync(path.join(root, '.planning'));
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const h = {
    root, phases: [{ number: '2', deps: [], complete: false, verification: null }], agents: [], launched: [], removed: [], stopped: [], resumed: [],
    notes: [], logs: [], resumeOut: [], activity: null,
    advance(min) { clock += min * 60000; },
    now: () => new Date(clock),
  };
  let n = 0;
  h.ctx = {
    root, mode: 'full', config: structuredClone(DEFAULTS), turboRun: 'node x',
    deps: {
      loadPhases: () => h.phases,
      claude: {
        launchBg: (opts, cwd) => { const id = `${++n}a2b3c4d`; h.launched.push({ id, cwd, ...opts }); h.agents.push({ id, name: opts.name, cwd, state: 'working' }); return id; },
        list: () => h.agents.map((a) => ({ ...a })),
        stop: (id) => {
          h.stopped.push(id);
          const a = h.agents.find((x) => x.id === id);
          if (!a) throw new Error(`claude stop failed: no session ${id}`);
          a.state = 'stopped';
        },
        rm: (id) => {
          h.removed.push(id);
          if (!h.agents.some((a) => a.id === id)) throw new Error(`claude rm failed: no session ${id}`);
          h.agents = h.agents.filter((a) => a.id !== id);
        },
        resume: (target, prompt, cwd) => {
          h.resumed.push({ target, prompt, cwd });
          const out = h.resumeOut.length ? h.resumeOut.shift() : null;
          if (out instanceof Error) throw out;
          const copy = out && /copy as (\w+)/.exec(out);
          if (copy) {
            h.agents.push({ id: copy[1], name: laneSessionName(root, '2'), cwd: root, state: 'working' });
            return out;
          }
          const lane = h.agents.find((a) => target.startsWith(a.id));
          if (lane) lane.state = 'working';
          return out ?? WOKE(lane?.id ?? target);
        },
      },
      lanes: { session: (jobId) => `${jobId}-2222-4333-8444-555555555555`, activity: () => h.activity },
      fingerprint: () => 'A',
      notify: async (key, vars) => { h.notes.push({ key, vars }); },
      now: () => new Date(clock),
      log: (line) => { h.logs.push(line); },
    },
  };
  return h;
}

// A question phase 2's lane stopped for (plan 02-01, task 2), waiting for the owner.
const STOP_Q = (over = {}) => ({
  id: '02-01-t2', phase: '2', plan: '02-01', task: '2', kind: 'decision', gate: 'blocking', header: '02-01 T2', question: 'Pick the store', context: '',
  options: [{ label: 'Files', description: '', recommended: true, signal: 'files', defer: false }, { label: 'SQLite', description: '', recommended: false, signal: 'sqlite', defer: false }],
  allowOther: true, condition: null, class: 'decision', topic: null, classified: false,
  agentId: 'a0123456789abcdef', stopped: true, state: 'open', answer: null, delivery: null, rev: 2, source: 'plan', ...over,
});
const owner = (h, id, option) => answerQuestion({ root: h.root, phase: '2', id, option, by: 'session', laneRunning: true });
const stopForOwner = (h) => {
  h.agents.find((a) => a.id === '1a2b3c4d').state = 'blocked';
  h.advance(1);
  writeLaneStatus(h.root, '2', 'needs-owner', { reason: 'owner question 02-01-t2', at: h.now().toISOString() });
};

// The lane stopped for the owner at a checkpoint: its needs-owner record, its session's turn ended.
async function stoppedLane(h) {
  let s = await tick(fresh(), h.ctx);
  writeQuestions(h.root, '2', [STOP_Q()]);
  stopForOwner(h);
  s = await tick(s, h.ctx);
  return s;
}

test('the owner answered every question the lane stopped for: claude stop, then claude --bg --resume of its session without flags (spec §5.5.1)', async () => {
  const h = harness();
  let s = await stoppedLane(h);
  assert.deepEqual(h.resumed, [], 'nothing answered yet');
  assert.equal(h.notes.at(-1).key, 'laneNeedsOwner');
  owner(h, '02-01-t2', 1);
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(h.stopped, ['1a2b3c4d']);
  assert.equal(h.resumed.length, 1);
  assert.equal(h.resumed[0].target, '1a2b3c4d-2222-4333-8444-555555555555');
  assert.equal(h.resumed[0].cwd, h.root);
  assert.match(h.resumed[0].prompt, /^The owner answered the questions phase 2 stopped for: 02-01-t2\. /);
  assert.match(h.resumed[0].prompt, /node x questions 2 --deliver/);
  assert.ok(!/\bfiles\b/.test(h.resumed[0].prompt), 'no answer text in the argv');
  assert.equal(h.launched.length, 1, 'no new session');
  assert.equal(s.lane.sessionId, '1a2b3c4d');
  assert.equal(s.lane.launchedAt, h.now().toISOString(), 'the needs-owner record no longer counts');
  assert.ok(h.logs.includes('wake phase 2: woke session 1a2b3c4d'));
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(h.resumed.length, 1, 'the woken session works: no second wake');
});

test('an open stop keeps the lane waiting; the same answers wake it twice at most, then the owner is told again', async () => {
  const h = harness();
  let s = await stoppedLane(h);
  writeQuestions(h.root, '2', [STOP_Q(), STOP_Q({ id: '02-02-t1', plan: '02-02', task: '1' })]);
  owner(h, '02-01-t2', 1);
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(h.resumed.length, 0, '02-02-t1 is still open');
  owner(h, '02-02-t1', 2);
  h.advance(1);
  s = await tick(s, h.ctx);
  stopForOwner(h);
  s = await tick(s, h.ctx);
  stopForOwner(h);
  const before = h.notes.length;
  s = await tick(s, h.ctx);
  assert.equal(h.resumed.length, 2);
  assert.deepEqual([s.lane.woken.key, s.lane.woken.count], ['02-01-t2,02-02-t1', 2]);
  assert.deepEqual(h.notes.slice(before).map((x) => x.key), ['laneNeedsOwner']);
});

test('a copy is stopped and removed and the wake tried once more; a second copy starts a new session that delivers by the continuation path (spec §5.5.1 step 4)', async () => {
  const h = harness();
  let s = await stoppedLane(h);
  owner(h, '02-01-t2', 1);
  h.resumeOut.push(COPY('c0ffee01'), COPY('c0ffee02'));
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(h.resumed.length, 2);
  assert.deepEqual(h.stopped, ['1a2b3c4d', 'c0ffee01', '1a2b3c4d', 'c0ffee02']);
  assert.deepEqual(h.removed, ['c0ffee01', 'c0ffee02', '1a2b3c4d']);
  assert.equal(h.launched.length, 2);
  assert.equal(s.lane.sessionId, '2a2b3c4d');
  assert.equal(h.launched[1].prompt, "Resume phase 2. Run the turbo-phase skill with arguments: 2 --resume. Before its step loop, deliver the owner's answers to 02-01-t2: run node x questions 2 --deliver and follow the skill's section Owner questions, Delivery. This is a new session: SendMessage cannot reach those agents, so take the continuation path for each.");
  assert.deepEqual(h.agents.map((a) => a.id), ['2a2b3c4d'], 'no copy left');
});

test('output that is neither a wake nor a copy, or an error, never counts as a wake: one more try, then a new session (Review Focus 2)', async () => {
  const h = harness();
  let s = await stoppedLane(h);
  owner(h, '02-01-t2', 1);
  h.resumeOut.push('Resumed.\n', new Error('claude --resume failed: exit status 1'));
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(h.resumed.length, 2);
  assert.ok(h.logs.includes('wake phase 2 attempt 1: claude reported neither a wake nor a copy'));
  assert.ok(h.logs.includes('wake phase 2 attempt 2: claude --resume failed: exit status 1'));
  assert.equal(s.lane.sessionId, '2a2b3c4d');
});

test('any relaunch of the lane (here after paused-context) carries the owner\'s undelivered answers', async () => {
  const h = harness();
  let s = await tick(fresh(), h.ctx);
  writeQuestions(h.root, '2', [STOP_Q()]);
  owner(h, '02-01-t2', 1);
  h.agents[0].state = 'done';
  h.advance(1);
  writeLaneStatus(h.root, '2', 'paused-context', { reason: 'before uat', at: h.now().toISOString() });
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 2);
  assert.match(h.launched[1].prompt, /deliver the owner's answers to 02-01-t2: run node x questions 2 --deliver/);
  assert.equal(h.resumed.length, 0);
});
