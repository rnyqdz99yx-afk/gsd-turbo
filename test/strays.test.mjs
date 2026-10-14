import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { SCRATCH_RE, findStrays, strayWatch } from '../lib/strays.mjs';
import { tick } from '../lib/supervisor.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { msg } from '../lib/messages.mjs';

// lane temp directories live under turbo's own directory: a throwaway one for this file
process.env.CLAUDE_CONFIG_DIR = tmpDir('strays-home');

// Smoke F2, the supervisor's half: Bash writes pass the write guard, so the folders around the project are watched.

test('strayWatch: the folder above the project, and in slots mode the slots folder and the one above it; turbo\'s own entries never count', () => {
  const root = path.resolve('/w/desk/demo-app');
  const checkout = strayWatch(root, DEFAULTS);
  assert.deepEqual(checkout.map((w) => w.dir), [path.resolve('/w/desk')]);
  assert.equal(checkout[0].own('demo-app'), true);
  assert.equal(checkout[0].own('demo-app.turbo'), false, 'checkout mode: no slots of its own');
  const slots = strayWatch(root, DEFAULTS, { slots: true });
  assert.deepEqual(slots.map((w) => w.dir), [path.resolve('/w/desk'), path.resolve('/w/desk/demo-app.turbo')], 'the folder above the slots is the folder above the project: once');
  for (const n of ['demo-app', 'demo-app.turbo']) assert.equal(slots[0].own(n), true, n);
  for (const n of ['lane-1', 'lane-12', 'lane-2.removing-123-456']) assert.equal(slots[1].own(n), true, n);
  for (const n of ['exec-03-01', 'lane-0', 'notes.txt']) assert.equal(slots[1].own(n), false, n);
  // lanes.dir elsewhere: that folder and the one above it
  const moved = strayWatch(root, { ...DEFAULTS, lanes: { ...DEFAULTS.lanes, dir: '../../slots/demo' } }, { slots: true });
  assert.deepEqual(moved.map((w) => w.dir), [path.resolve('/w/desk'), path.resolve('/w/slots/demo'), path.resolve('/w/slots')]);
  assert.equal(moved[2].own('demo'), true);
});

test('SCRATCH_RE: what smoke F2 found (GSD executor folders, TDD captures as scripts, data or logs), not ordinary names', () => {
  for (const n of ['exec-02-01-tools', 'exec-03-01', 'exec-10-02.tmp', 'capture.mjs', 'capture-red.mjs', 'Capture-green.js', 'red-t1.json', 'mut-empty.json', 'mut-typeerror.json', 'red-run.log', 'capture.cjs', 'capture.ts', 'red-1.txt']) assert.ok(SCRATCH_RE.test(n), n);
  for (const n of ['demo-app', 'notes.txt', 'executive.pdf', 'Screenshot 2026-10-14.png', 'redesign.fig', 'Capture.PNG', 'capture 2026-10-14.jpg', 'red-dress.png', 'mut-notes.docx', 'exec-summary.docx', 'exec-3', 'scratch', 'tmp-x', 'red-t1.json.bak']) assert.ok(!SCRATCH_RE.test(n), n);
});

test('findStrays: entries born at or after the lanes started, unless known or turbo\'s; birth time, else change time; unreadable folders and entries skipped', () => {
  const since = Date.parse('2026-10-14T08:00:00Z');
  const files = {
    '/d/demo-app': since - 1e9, '/d/old.txt': since - 1, '/d/exec-03-01': since + 5, '/d/Screenshot.png': since + 9, '/d/red-t1.json': 0,
    '/d/gone': null,
  };
  const ctime = { '/d/red-t1.json': since + 1 }; // a file system that keeps no birth time
  const fsApi = {
    readdirSync: (dir) => {
      if (dir !== path.resolve('/d')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return Object.keys(files).map((p) => p.slice(3));
    },
    lstatSync: (p) => {
      const k = `/d/${path.basename(p)}`;
      if (files[k] === null) throw new Error('ENOENT');
      return { birthtimeMs: files[k], ctimeMs: ctime[k] ?? files[k] };
    },
  };
  const watch = [{ dir: path.resolve('/d'), own: (n) => n === 'demo-app' }, { dir: path.resolve('/nope'), own: () => false }];
  const { found, kept } = findStrays({ watch, sinceMs: since, fsApi });
  assert.deepEqual(found.map((f) => [f.name, f.scratch]), [['Screenshot.png', false], ['exec-03-01', true], ['red-t1.json', true]]);
  assert.equal(found[1].path, path.join(path.resolve('/d'), 'exec-03-01'));
  assert.deepEqual(kept, []);
  // seen: reported once; an entry gone (or outside the watched folders) is forgotten; an unreadable folder keeps its own
  const d = (n) => path.join(path.resolve('/d'), n);
  const seen = [...found.map((f) => f.path), d('deleted-since'), path.join(path.resolve('/nope'), 'x'), path.join(path.resolve('/elsewhere'), 'y')];
  assert.deepEqual(findStrays({ watch, sinceMs: since, fsApi, seen }), { found: [], kept: [d('Screenshot.png'), d('exec-03-01'), d('red-t1.json'), path.join(path.resolve('/nope'), 'x')] });
});

test('findStrays on a real folder: what a lane wrote above the slots after its start', () => {
  const desk = tmpDir('desk');
  fs.mkdirSync(path.join(desk, 'demo-app'));
  fs.mkdirSync(path.join(desk, 'demo-app.turbo', 'lane-1'), { recursive: true });
  const since = Date.now() - 1000;
  fs.mkdirSync(path.join(desk, 'exec-02-01-tools'));
  fs.writeFileSync(path.join(desk, 'exec-02-01-tools', 'capture-red.mjs'), '');
  fs.writeFileSync(path.join(desk, 'demo-app.turbo', 'mut-empty.json'), '{}');
  const { found } = findStrays({ watch: strayWatch(path.join(desk, 'demo-app'), DEFAULTS, { slots: true }), sinceMs: since });
  assert.deepEqual(found.map((f) => [path.relative(desk, f.path), f.scratch]), [['exec-02-01-tools', true], [path.join('demo-app.turbo', 'mut-empty.json'), true]]);
  assert.deepEqual(findStrays({ watch: strayWatch(path.join(desk, 'demo-app'), DEFAULTS, { slots: true }), sinceMs: Date.now() + 60000 }).found, [], 'nothing born after a later start');
});

function harness(found) {
  const root = tmpDir('strays-sup');
  fs.mkdirSync(path.join(root, '.planning'));
  const h = { root, launched: [], notes: [], logs: [], calls: [], found };
  let n = 0;
  h.agents = [];
  h.ctx = {
    root, config: structuredClone(DEFAULTS), turboRun: 'node x',
    deps: {
      loadPhases: () => [{ number: '2', deps: [], complete: false, verification: null }],
      claude: {
        launchBg: (opts, cwd) => { const id = `s${++n}`; h.launched.push({ id, cwd, ...opts }); h.agents.push({ id, name: opts.name, cwd, state: 'working' }); return id; },
        list: () => h.agents,
        stop: () => {},
        rm: () => {},
      },
      fingerprint: () => 'A',
      notify: async (key, vars) => { h.notes.push({ key, vars }); },
      now: () => new Date('2026-10-14T08:00:00Z'),
      log: (line) => { h.logs.push(line); },
      strays: (q) => { h.calls.push(q); return { found: h.found.filter((f) => !q.seen.includes(f.path)), kept: q.seen.filter((p) => h.found.some((f) => f.path === p)) }; },
    },
  };
  return h;
}

test('the supervisor reports what appeared next to the project while lanes run: each once, in the log, scratch names also to the owner; never moved', async () => {
  const f = (name, scratch) => ({ dir: '/w/desk', name, path: `/w/desk/${name}`, scratch });
  const h = harness([f('exec-02-01-tools', true), f('Screenshot.png', false)]);
  let s = await tick({ lane: null, finished: false, halted: false }, h.ctx);
  assert.equal(h.launched.length, 1);
  assert.equal(h.launched[0].guard, true, 'the lane launches with its write guard');
  assert.deepEqual(h.calls, [{ sinceMs: Date.parse('2026-10-14T08:00:00.000Z'), seen: [] }], 'counted from the lane\'s start');
  assert.deepEqual(s.strays, { since: '2026-10-14T08:00:00.000Z', seen: ['/w/desk/exec-02-01-tools', '/w/desk/Screenshot.png'] });
  assert.ok(h.logs.includes("next to the project: /w/desk/exec-02-01-tools appeared while lanes run, named like a lane's scratch file; left as it is"), h.logs.join('\n'));
  assert.ok(h.logs.includes("next to the project: 1 other new entry since the lanes started (not turbo's; left as they are)"), h.logs.join('\n'));
  assert.ok(!h.logs.some((l) => l.includes('Screenshot')), "the owner's own file names stay out of the log");
  assert.deepEqual(h.notes.filter((x) => x.key === 'strayFiles'), [{ key: 'strayFiles', vars: { files: '/w/desk/exec-02-01-tools' } }], 'only the scratch name goes to the owner');
  // the next tick: nothing new, nothing said again
  h.found.push(...Array.from({ length: 7 }, (_, i) => f(`capture-${i}.mjs`, true)));
  s = await tick(s, h.ctx);
  const notes = h.notes.filter((x) => x.key === 'strayFiles');
  assert.equal(notes.length, 2);
  assert.equal(notes[1].vars.files, `${[0, 1, 2, 3, 4].map((i) => `/w/desk/capture-${i}.mjs`).join(', ')} (+2)`);
  await tick(s, h.ctx);
  assert.equal(h.notes.filter((x) => x.key === 'strayFiles').length, 2);
  // an entry gone is forgotten
  h.found.splice(h.found.findIndex((x) => x.name === 'Screenshot.png'), 1);
  s = await tick(s, h.ctx);
  assert.ok(!s.strays.seen.includes('/w/desk/Screenshot.png'));
  // no lane: the record goes
  const idle = await tick({ ...s, lane: null }, { ...h.ctx, deps: { ...h.ctx.deps, loadPhases: () => [{ number: '2', deps: [], complete: true, verification: 'passed' }] } });
  assert.equal(idle.strays, undefined);
});

test('a failing sweep never fails the tick; lanes.write_guard false launches without the guard', async () => {
  const h = harness([]);
  h.ctx.deps.strays = () => { throw new Error('EACCES: the Desktop'); };
  h.ctx.config.lanes = { ...h.ctx.config.lanes, write_guard: false };
  const s = await tick({ lane: null, finished: false, halted: false }, h.ctx);
  assert.equal(s.lane.phase, '2');
  assert.equal(h.launched[0].guard, false);
  assert.ok(h.logs.includes('strays: EACCES: the Desktop'), h.logs.join('\n'));
});

test('the owner\'s notice in both languages', () => {
  const en = msg('en', 'strayFiles', { files: 'C:\\Users\\dev\\Desktop\\exec-03-01' });
  assert.equal(en.title, 'Files appeared next to the project');
  assert.ok(en.body.startsWith('C:\\Users\\dev\\Desktop\\exec-03-01. They look like temporary files of a running phase'), en.body);
  assert.match(en.body, /turbo leaves them as they are/);
  const ru = msg('ru', 'strayFiles', { files: '/w/exec-03-01' });
  assert.equal(ru.title, 'Рядом с проектом появились файлы');
  assert.match(ru.body, /^\/w\/exec-03-01\. Похоже, это временные файлы работающей фазы/);
});

test('past 500 entries still there, the sweep counts from now and forgets them: nothing is reported twice', async () => {
  const f = (i) => ({ dir: '/w/desk', name: `n${i}`, path: `/w/desk/n${i}`, scratch: false });
  const h = harness([]);
  let s = await tick({ lane: null, finished: false, halted: false }, h.ctx);
  assert.deepEqual(s.strays, { since: '2026-10-14T08:00:00.000Z', seen: [] });
  h.found.push(...Array.from({ length: 501 }, (_, i) => f(i)));
  h.ctx.deps.now = () => new Date('2026-10-14T09:00:00Z');
  s = await tick(s, h.ctx);
  assert.ok(h.logs.includes("next to the project: 501 other new entries since the lanes started (not turbo's; left as they are)"));
  assert.deepEqual(s.strays, { since: '2026-10-14T09:00:00.000Z', seen: [] }, 'what is there was born before the new start: never found again');
  s = await tick(s, h.ctx);
  assert.equal(h.calls.at(-1).sinceMs, Date.parse('2026-10-14T09:00:00.000Z'));
});
