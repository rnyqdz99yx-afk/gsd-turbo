import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { tick } from '../lib/supervisor.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { writeLaneStatus } from '../lib/run-status.mjs';
import { laneSessionName } from '../lib/claude.mjs';
import { markDelivered, stopQuestion, writeQuestions } from '../lib/questions.mjs';
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
    notes: [], logs: [], resumeOut: [], activity: null, replies: [], failStop: false, failRm: false,
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
          if (h.failStop) throw new Error('claude stop failed: timed out');
          const a = h.agents.find((x) => x.id === id);
          if (!a) throw new Error(`claude stop failed: no session ${id}`);
          a.state = 'stopped';
        },
        rm: (id) => {
          h.removed.push(id);
          if (h.failRm) throw new Error('claude rm failed: timed out');
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
      // replies: the times of the lane session's own assistant entries (the model answered after a wake)
      lanes: { session: (jobId) => `${jobId}-2222-4333-8444-555555555555`, activity: () => h.activity, replied: (jobId, sinceMs) => h.replies.some((ms) => ms > sinceMs) },
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
  assert.equal(s.lane.woken.count, 2);
  assert.match(s.lane.woken.key, /^02-01-t2:2:\S+,02-02-t1:2:\S+$/);
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

test('a lane that writes nothing for stall_minutes is woken with the interruption prompt; twice at most, then the owner is told once (spec §5.5.6)', async () => {
  const h = harness();
  let s = await tick(fresh(), h.ctx);
  h.activity = { lastMs: h.now().getTime(), active: 0 };
  h.advance(14);
  s = await tick(s, h.ctx);
  assert.equal(h.resumed.length, 0);
  h.advance(2);
  s = await tick(s, h.ctx);
  assert.equal(h.resumed.length, 1);
  assert.match(h.resumed[0].prompt, /^This session was interrupted: nothing was written for 16 minutes\. Run node x view --json/);
  assert.deepEqual(s.lane.stall, { count: 1, at: h.now().toISOString() });
  h.advance(10);
  s = await tick(s, h.ctx);
  assert.equal(h.resumed.length, 1, 'stall_minutes after the wake first');
  h.advance(6);
  s = await tick(s, h.ctx);
  assert.equal(h.resumed.length, 2);
  h.advance(16);
  s = await tick(s, h.ctx);
  h.advance(16);
  s = await tick(s, h.ctx);
  assert.equal(h.resumed.length, 2);
  assert.deepEqual(h.notes.filter((x) => x.key === 'laneStalled').map((x) => [x.vars.phase, x.vars.wakes, x.vars.id]), [['2', 2, '1a2b3c4d']]);
  h.activity = { lastMs: h.now().getTime(), active: 0 };
  h.replies.push(h.now().getTime());
  s = await tick(s, h.ctx);
  assert.equal(s.lane.stall, null, 'it answered and wrote again: a new spell');
});

test('a lane whose turn ended while its subagents work is waiting for them, not blocked: no laneBlocked while they run', async () => {
  const h = harness();
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'blocked';
  h.activity = { lastMs: h.now().getTime(), active: 2 };
  for (let i = 0; i < 4; i++) {
    h.advance(5);
    h.activity.lastMs = h.now().getTime();
    s = await tick(s, h.ctx);
  }
  assert.ok(!h.notes.some((x) => x.key === 'laneBlocked'));
  h.activity.active = 0;
  for (let i = 0; i < 3; i++) {
    h.advance(5);
    h.activity.lastMs = h.now().getTime();
    s = await tick(s, h.ctx);
  }
  assert.ok(h.notes.some((x) => x.key === 'laneBlocked'));
  assert.equal(h.resumed.length, 0);
});

test('no lane transcript found is no proof of a stall: never woken; nor is a full lane under a safe-mode supervisor (Review Focus 5)', async () => {
  const h = harness();
  let s = await tick(fresh(), h.ctx);
  h.activity = { lastMs: null, active: 0 };
  for (let i = 0; i < 4; i++) {
    h.advance(30);
    s = await tick(s, h.ctx);
  }
  assert.equal(h.resumed.length, 0);
  h.activity = { lastMs: Date.parse('2026-01-01T00:00:00Z'), active: 0 };
  h.ctx.mode = 'safe';
  h.advance(30);
  s = await tick(s, h.ctx);
  assert.equal(h.resumed.length, 0);
});

test('the wake prompt the woken session only records is no progress: a session that answers nothing after it is woken twice, then the owner is told (D13)', async () => {
  const h = harness();
  let s = await tick(fresh(), h.ctx);
  h.activity = { lastMs: h.now().getTime(), active: 0 };
  // a resumed session writes the wake prompt into its transcript at once, then hangs
  const resume = h.ctx.deps.claude.resume;
  h.ctx.deps.claude.resume = (...a) => {
    const out = resume(...a);
    h.activity = { lastMs: h.now().getTime() + 2000, active: 0 };
    return out;
  };
  for (let i = 0; i < 8; i++) {
    h.advance(16);
    s = await tick(s, h.ctx);
  }
  assert.equal(h.resumed.length, 2);
  assert.equal(h.notes.filter((x) => x.key === 'laneStalled').length, 1);
  assert.equal(s.lane.stall.count, 2);
});

test('a new answer to a checkpoint that stopped again wakes the lane again: the bound counts wakes for the same answers, not the same ids (D13)', async () => {
  const h = harness();
  let s = await stoppedLane(h);
  for (let round = 1; round <= 3; round++) {
    if (round > 1) {
      // the agent returned the same checkpoint again: the lane stops for the owner once more
      stopQuestion(h.root, '2', '02-01-t2', { agentId: 'a0123456789abcdef', now: h.now() });
      stopForOwner(h);
      s = await tick(s, h.ctx);
    }
    owner(h, '02-01-t2', round === 2 ? 2 : 1);
    h.advance(1);
    const before = h.resumed.length;
    s = await tick(s, h.ctx);
    assert.equal(h.resumed.length, before + 1, `round ${round}: woken`);
    markDelivered(h.root, '2', '02-01-t2', 'same-agent', { now: h.now() });
  }
});

// The lane's own session resists claude stop and claude rm; resuming a session that still runs starts a copy (F4).
function resistingSession(h) {
  Object.assign(h, { failStop: true, failRm: true, copies: [] });
  h.ctx.deps.claude.resume = (target, prompt) => {
    h.resumed.push({ target, prompt });
    const id = `c0ffee${String(h.copies.length + 1).padStart(2, '0')}`;
    h.copies.push(id);
    h.agents.push({ id, name: laneSessionName(h.root, '2'), cwd: h.root, state: 'working' });
    return `note: session is already running in the background, so this started a copy as ${id}\nbackgrounded · ${id} · lane\n`;
  };
}

test('answers that cannot reach a session claude cannot stop or remove: no resume (it would start copies), no second session, two tries, then the owner is told once', async () => {
  const h = harness();
  let s = await stoppedLane(h);
  owner(h, '02-01-t2', 1);
  resistingSession(h);
  const before = h.notes.length;
  for (let i = 0; i < 30; i++) {
    h.advance(1);
    s = await tick(s, h.ctx);
  }
  assert.deepEqual([h.resumed.length, h.copies.length, h.launched.length], [0, 0, 1]);
  assert.equal(s.lane.woken.count, 2);
  const told = h.notes.slice(before).filter((x) => x.key === 'laneNeedsOwner');
  assert.equal(told.length, 1);
  assert.match(told[0].vars.reason, /^the answers to 02-01-t2 did not reach session 1a2b3c4d \(claude stop failed: timed out\)$/);
  assert.equal(s.halted, false);
  assert.equal(s.failingSince, undefined);
});

test('a silent session claude cannot stop or remove: no resume, no second session, two tries, then laneStalled once', async () => {
  const h = harness();
  let s = await tick(fresh(), h.ctx);
  h.activity = { lastMs: h.now().getTime(), active: 0 };
  resistingSession(h);
  for (let i = 0; i < 6; i++) {
    h.advance(16);
    s = await tick(s, h.ctx);
  }
  assert.deepEqual([h.resumed.length, h.copies.length, h.launched.length], [0, 0, 1]);
  assert.equal(s.lane.stall.count, 2);
  assert.equal(h.notes.filter((x) => x.key === 'laneStalled').length, 1);
});

test('a relaunch that fails after a failed wake fails the tick but keeps the count of tries: the bound still holds', async () => {
  const h = harness();
  let s = await stoppedLane(h);
  owner(h, '02-01-t2', 1);
  let launches = 0;
  h.ctx.deps.claude.launchBg = () => { launches += 1; throw new Error('claude --bg failed: boom'); };
  h.ctx.deps.claude.resume = (target, prompt) => { h.resumed.push({ target, prompt }); return 'Resumed.\n'; };
  for (let i = 0; i < 10; i++) {
    h.advance(1);
    s = await tick(s, h.ctx);
  }
  assert.equal(launches, 2);
  assert.equal(h.resumed.length, 4);
  assert.equal(s.lane.woken.count, 2);
  assert.equal(h.notes.filter((x) => x.key === 'laneNeedsOwner' && /did not reach/.test(x.vars.reason)).length, 1);
});

test('a failed wake of a full lane on a phase GSD completed, under a safe-mode supervisor, waits for full mode instead of a safe relaunch', async () => {
  const h = harness();
  let s = await stoppedLane(h);
  h.ctx.mode = 'safe';
  h.phases[0].complete = true;
  owner(h, '02-01-t2', 1);
  h.resumeOut.push('Resumed.\n', 'Resumed.\n');
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(h.resumed.length, 2);
  assert.equal(h.launched.length, 1, 'no gsd-autonomous relaunch');
  assert.equal(s.lane.sessionId, '1a2b3c4d');
  assert.deepEqual(h.notes.filter((x) => x.key === 'laneDowngraded').map((x) => x.vars.phase), ['2']);
});

test('a blocked lane under a safe-mode supervisor is the owner\'s, never stall-woken: laneBlocked goes out as before (deviation from D14)', async () => {
  const h = harness();
  h.ctx.mode = 'safe';
  let s = await tick(fresh(), h.ctx);
  // gsd-autonomous ended its turn with a question in its text: it waits for the owner
  h.agents[0].state = 'blocked';
  h.activity = { lastMs: h.now().getTime(), active: 0 };
  for (let i = 0; i < 4; i++) {
    h.advance(5);
    s = await tick(s, h.ctx);
  }
  assert.equal(h.resumed.length, 0);
  assert.deepEqual(h.notes.map((x) => x.key), ['laneBlocked']);
});

test('a session claude agents lists as ended whose rm fails stays the lane\'s: no new session starts beside it', async () => {
  const h = harness();
  let s = await stoppedLane(h);
  owner(h, '02-01-t2', 1);
  // claude stop works and the list says stopped, yet claude rm cannot remove the session
  h.failRm = true;
  h.ctx.deps.claude.resume = (target, prompt) => { h.resumed.push({ target, prompt }); return 'Resumed.\n'; };
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 1, 'no second session');
  assert.equal(s.lane.sessionId, '1a2b3c4d');
  assert.equal(s.lane.woken.count, 1);
  assert.ok(h.logs.some((l) => /session 1a2b3c4d was not removed/.test(l)), h.logs.join('\n'));
});

test('the lane stops while the Telegram long poll waits: the wake counts from after the poll, so its old needs-owner record no longer counts (S1b review F1)', async () => {
  const h = harness();
  Object.assign(h.ctx.config, { notify: { desktop: false, telegram: true }, answer: { telegram: true } });
  // a bot token's shape, built at run time; the chat id is made up
  h.ctx.deps.env = { TURBO_TELEGRAM_TOKEN: `${'123456789'}:${'A'.repeat(35)}`, TURBO_TELEGRAM_CHAT: '4242' };
  let id = 100;
  let during = null;
  h.ctx.deps.telegram = async (method) => {
    if (method === 'sendMessage') return { message_id: ++id };
    if (method !== 'getUpdates') return true;
    during?.();
    during = null;
    h.advance(0.5);
    return [];
  };
  let s = await tick(fresh(), h.ctx);
  writeQuestions(h.root, '2', [STOP_Q({ stopped: false, agentId: null, rev: 1 })]);
  h.advance(1);
  // within the poll: the lane stops at the checkpoint (needs-owner) and the owner answers at once
  during = () => {
    h.advance(0.25);
    writeQuestions(h.root, '2', [STOP_Q()]);
    h.agents.find((a) => a.id === '1a2b3c4d').state = 'blocked';
    writeLaneStatus(h.root, '2', 'needs-owner', { reason: 'owner question 02-01-t2', at: h.now().toISOString() });
    owner(h, '02-01-t2', 1);
  };
  s = await tick(s, h.ctx);
  assert.equal(h.resumed.length, 1, 'woken for the answer');
  assert.equal(s.lane.launchedAt, h.now().toISOString(), 'the time after the poll, later than the lane\'s record');
  // the woken session delivers the answer and ends without a record of its own: a relaunch, not the old stop again
  markDelivered(h.root, '2', '02-01-t2', 'same-agent', { now: h.now() });
  h.agents.find((a) => a.id === '1a2b3c4d').state = 'idle';
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 2, 'relaunched');
  assert.deepEqual(h.notes.filter((x) => x.key === 'laneNeedsOwner'), []);
});
