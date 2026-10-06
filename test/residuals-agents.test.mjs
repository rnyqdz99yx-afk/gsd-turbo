import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { parseAgents } from '../lib/claude.mjs';
import { tick } from '../lib/supervisor.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { msg } from '../lib/messages.mjs';

test('parseAgents takes a state only from a string field', () => {
  const a = parseAgents(JSON.stringify([
    { id: 'o1', state: { phase: 'x' }, status: 'busy' },
    { id: 'n1', state: 7, status: 'working' },
    { id: 'e1', state: '', status: 'done' },
    { id: 's1', state: 'blocked', status: 'busy' },
  ]));
  assert.deepEqual(a.map((x) => [x.id, x.state]), [['o1', 'busy'], ['n1', 'working'], ['e1', 'done'], ['s1', 'blocked']]);
});

function harness({ phases, launch } = {}) {
  const root = tmpDir('res');
  fs.mkdirSync(path.join(root, '.planning'));
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const h = { root, phases, agents: [], launched: [], notes: [], fp: 'A', advance(min) { clock += min * 60000; } };
  let n = 0;
  h.ctx = {
    root, config: structuredClone(DEFAULTS), turboRun: 'node x',
    deps: {
      loadPhases: () => h.phases,
      claude: {
        launchBg: (o) => {
          const id = `s${++n}`;
          h.launched.push({ id, ...o });
          if (launch) return launch(id, o);
          h.agents.push({ id, name: o.name, cwd: root, state: 'working' });
          return id;
        },
        list: () => h.agents,
        stop() {},
        rm: (id) => { h.agents = h.agents.filter((a) => a.id !== id); },
      },
      fingerprint: () => h.fp,
      notify: async (key, vars) => { h.notes.push({ key, vars }); },
      now: () => new Date(clock),
      log() {},
    },
  };
  return h;
}
const P = (number, deps = [], complete = false) => ({ number, deps, complete, verification: null });
const fresh = () => ({ lane: null, finished: false, halted: false });

test('a launch whose lane record cannot be written counts toward the launch-failure cap', async () => {
  const h = harness({ phases: [P('2')], launch: (id) => id }); // the session never shows up in the list
  fs.mkdirSync(path.join(h.root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(h.root, '.planning', 'turbo', 'run'), 'not a directory'); // writeLaneStatus fails
  let s = fresh();
  for (let i = 0; i < 12 && !s.halted; i++) s = await tick(s, h.ctx);
  assert.equal(s.halted, true);
  assert.equal(h.launched.length, 10);
  assert.equal(h.notes.at(-1).key, 'launchHalted');
  assert.match(h.notes.at(-1).vars.error, /session s\d+ started, then/);
});

test('an untrusted workspace stops the run at the first launch with a clear notification', async () => {
  const h = harness({ phases: [P('2')], launch: () => { throw new Error('claude --bg failed: Workspace not trusted. Run `claude` in /w/app once and accept the trust prompt'); } });
  const s = await tick(fresh(), h.ctx);
  assert.equal(s.halted, true);
  assert.equal(h.launched.length, 1);
  assert.deepEqual(h.notes.map((x) => [x.key, x.vars.dir]), [['workspaceUntrusted', h.root]]);
  for (const lang of ['en', 'ru']) assert.match(msg(lang, 'workspaceUntrusted', { phase: '2', dir: '/w/app' }).body, /\/w\/app.*resume 2/);
});
