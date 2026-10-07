import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpGitRepo } from './helpers/tmp.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { parseUat } from '../lib/uat.mjs';
import { UAT } from './fixtures/uat-sample.mjs';

function project(uat = UAT) {
  const root = tmpGitRepo();
  const dir = path.join(root, '.planning', 'phases', '03-demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '03-UAT.md'), uat);
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify({ lang: 'en', autonomy: 'standard', uat: { base_url: 'http://localhost:3000', forbidden_hosts: ['api.example.com'] } }));
  const notes = [];
  const lines = [];
  const run = (...a) => runPhaseCommand('uat', a, { root, out: (l) => lines.push(l), err: (l) => lines.push(l), deps: { notify: async (key, vars) => { notes.push({ key, vars }); } } });
  return { root, dir, run, lines, notes };
}

test('uat plan classifies pending items and checks the stand', async () => {
  const p = project();
  assert.equal(await p.run('plan', '3'), 0);
  const plan = JSON.parse(p.lines.at(-1));
  assert.equal(plan.stand.ok, true);
  assert.deepEqual(plan.items.map((i) => [i.test, i.class, i.split ?? '']), [[1, 'A', ''], [2, 'D', ''], [3, 'A', 'hermetic'], [3, 'C', 'live'], [4, 'A', '']]);
});

test('uat stand prepare/cleanup never prints the credentials', async () => {
  const p = project();
  assert.equal(await p.run('stand', '3', 'prepare'), 0);
  const s = JSON.parse(p.lines.at(-1));
  const { password } = JSON.parse(fs.readFileSync(s.credsFile, 'utf8'));
  assert.ok(!p.lines.join('\n').includes(password));
  assert.ok(fs.statSync(s.evidenceDir).isDirectory());
  assert.equal(await p.run('stand', '3', 'cleanup'), 0);
  assert.ok(!fs.existsSync(s.credsFile));
});

test('uat net-check fails on a request outside the allowlist', async () => {
  const p = project();
  const log = path.join(p.root, 'req.log');
  fs.writeFileSync(log, 'http://localhost:3000/\nhttp://127.0.0.1:3000/api\n');
  assert.equal(await p.run('net-check', '3', '--log', log), 0);
  fs.appendFileSync(log, 'https://api.example.com/v1?key=zzz\n');
  assert.equal(await p.run('net-check', '3', '--log', log), 1);
  assert.ok(p.lines.some((l) => /forbidden host: https:\/\/api\.example\.com$/.test(l)));
  assert.ok(!p.lines.join('\n').includes('zzz'), 'a violation never shows the path or query');
  // an empty log is reported as such; whether one was required is the turbo-uat procedure's call
  fs.writeFileSync(log, '\n  \n');
  assert.equal(await p.run('net-check', '3', '--log', log), 0);
  assert.equal(p.lines.at(-1), 'no requests logged');
});

test('uat stand prepare and net-check refuse a stand config that standCheck refuses', async () => {
  const p = project();
  fs.writeFileSync(path.join(p.root, '.planning', 'turbo', 'config.json'), JSON.stringify({ lang: 'en', uat: { base_url: 'http://localhost:3000', forbidden_hosts: 'api.example.com' } }));
  const log = path.join(p.root, 'req.log');
  fs.writeFileSync(log, 'https://api.example.com/v1\n');
  assert.equal(await p.run('stand', '3', 'prepare'), 1);
  assert.ok(!fs.existsSync(path.join(p.root, '.planning', 'turbo', 'run', 'uat-p3')), 'a refused stand is never prepared');
  assert.equal(await p.run('net-check', '3', '--log', log), 1);
  assert.equal(p.lines.filter((l) => /forbidden_hosts must be a list of host names/.test(l)).length, 2);
  assert.equal(await p.run('plan', '3'), 1);
  assert.equal(await p.run('stand', '3', 'cleanup'), 0, 'cleanup always runs');
});

test('uat record + owner-request: D items make the phase wait, C-only sends one checklist notification', async () => {
  const p = project();
  const results = path.join(p.root, 'results.json');
  fs.writeFileSync(results, JSON.stringify([
    { test: 1, result: 'pass', class: 'A', harness: 'http' },
    { test: 2, result: 'owner', class: 'D' },
    { test: 3, result: 'deferred', class: 'C', reason: 'needs a physical phone' },
    { test: 4, result: 'pass', class: 'A', harness: 'http' },
  ]));
  assert.equal(await p.run('record', '3', '--results', results), 0);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.root, encoding: 'utf8' }).trim();
  assert.equal(parseUat(fs.readFileSync(path.join(p.dir, '03-UAT.md'), 'utf8')).tests[0].fields.head, head);
  assert.equal(await p.run('owner-request', '3', '--json'), 0);
  const r = JSON.parse(p.lines.at(-1));
  assert.deepEqual([r.needsOwner, r.counts.signoff, r.counts.checklist], [true, 1, 1]);
  assert.ok(fs.existsSync(path.join(p.root, r.file)));
  assert.equal(p.notes.length, 0, 'D items: the lane reports needs-owner, the supervisor notifies');

  // every open row makes the phase wait, whoever wrote it: test 2 stays GSD's pending row here
  const q = project();
  fs.writeFileSync(path.join(q.root, 'r.json'), JSON.stringify([{ test: 3, result: 'deferred', class: 'C', reason: 'phone' }]));
  assert.equal(await q.run('record', '3', '--results', path.join(q.root, 'r.json')), 0);
  assert.equal(await q.run('owner-request', '3', '--json'), 0);
  assert.equal(JSON.parse(q.lines.at(-1)).needsOwner, true);
  assert.equal(q.notes.length, 0);

  // the owner already answered test 2 through verify-work; only the C item is left
  const c = project();
  const uatFile = path.join(c.dir, '03-UAT.md');
  const before = fs.readFileSync(uatFile, 'utf8');
  const answered = before.replace('### 2. Owner signs the release\nexpected: the release is signed\nresult: [pending]', '### 2. Owner signs the release\nexpected: the release is signed\nresult: pass');
  assert.notEqual(answered, before);
  fs.writeFileSync(uatFile, answered);
  fs.writeFileSync(path.join(c.root, 'r.json'), JSON.stringify([
    { test: 1, result: 'pass', class: 'A', harness: 'http' },
    { test: 3, result: 'deferred', class: 'C', reason: 'phone' },
    { test: 4, result: 'pass', class: 'A', harness: 'http' },
  ]));
  assert.equal(await c.run('record', '3', '--results', path.join(c.root, 'r.json')), 0);
  assert.equal(await c.run('owner-request', '3', '--json'), 0);
  const cr = JSON.parse(c.lines.at(-1));
  assert.deepEqual([cr.needsOwner, cr.counts.signoff, cr.counts.checklist], [false, 0, 1]);
  assert.ok(fs.existsSync(path.join(c.root, cr.file)));
  assert.deepEqual(c.notes.map((n) => n.key), ['ownerChecklist']);
  assert.deepEqual(c.notes[0].vars, { phase: '3', n: 1, file: '.planning/turbo/run/p3-owner.md' });

  // the lane's uat step runs owner-request more than once: the same checklist is never sent twice
  const sidecar = path.join(c.root, '.planning', 'turbo', 'run', 'p3-owner.notified');
  assert.ok(fs.existsSync(sidecar));
  assert.equal(await c.run('owner-request', '3', '--json'), 0);
  assert.equal(c.notes.length, 1);
  // a new C item changes the checklist: the owner hears about it once more
  fs.writeFileSync(path.join(c.root, 'r4.json'), JSON.stringify([{ test: 4, result: 'deferred', class: 'C', reason: 'a real browser download' }]));
  assert.equal(await c.run('record', '3', '--results', path.join(c.root, 'r4.json')), 0);
  assert.equal(await c.run('owner-request', '3', '--json'), 0);
  assert.deepEqual(c.notes.map((n) => n.vars.n), [1, 2]);
  assert.equal(await c.run('owner-request', '3', '--json'), 0);
  assert.equal(c.notes.length, 2);
  // the owner closes both checks through verify-work: the stale request and its sidecar go away
  const open = fs.readFileSync(uatFile, 'utf8');
  const closed = open.replaceAll('result: skipped', 'result: pass');
  assert.notEqual(closed, open);
  fs.writeFileSync(uatFile, closed);
  assert.equal(await c.run('owner-request', '3', '--json'), 0);
  const done = JSON.parse(c.lines.at(-1));
  assert.deepEqual([done.file, done.needsOwner, done.counts.checklist, done.counts.signoff], [null, false, 0, 0]);
  assert.ok(!fs.existsSync(path.join(c.root, '.planning', 'turbo', 'run', 'p3-owner.md')));
  assert.ok(!fs.existsSync(sidecar));
  assert.equal(c.notes.length, 2);
});

test('uat record refuses evidence without the stand credentials, and a repository without a commit', async () => {
  const p = project();
  const uatFile = path.join(p.dir, '03-UAT.md');
  const ev = path.join(p.root, '.planning', 'turbo', 'run', 'evidence', 'p3');
  fs.mkdirSync(ev, { recursive: true });
  fs.writeFileSync(path.join(ev, 'note.txt'), 'the value persisted\n');
  const results = path.join(p.root, 'results.json');
  fs.writeFileSync(results, JSON.stringify([{ test: 1, result: 'pass', class: 'A', harness: 'http', evidence: ['.planning/turbo/run/evidence/p3/note.txt'] }]));
  const before = fs.readFileSync(uatFile, 'utf8');
  // never prepared (or already cleaned up): the known-credential scan would run blind
  assert.equal(await p.run('record', '3', '--results', results), 1);
  assert.match(p.lines.at(-1), /record before stand cleanup/);
  assert.equal(fs.readFileSync(uatFile, 'utf8'), before);
  assert.equal(await p.run('stand', '3', 'prepare'), 0);
  assert.equal(await p.run('record', '3', '--results', results), 0);
  assert.equal(parseUat(fs.readFileSync(uatFile, 'utf8')).tests[0].result, 'pass');

  const q = project();
  execFileSync('git', ['update-ref', '-d', 'HEAD'], { cwd: q.root });
  fs.writeFileSync(path.join(q.root, 'r.json'), JSON.stringify([{ test: 1, result: 'pass', class: 'A', harness: 'http' }]));
  assert.equal(await q.run('record', '3', '--results', path.join(q.root, 'r.json')), 1);
  assert.equal(q.lines.at(-1), 'turbo-run uat: record needs a commit');
});

test('turbo-run status lists owner requests in every view', () => {
  const p = project();
  const run = path.join(p.root, '.planning', 'turbo', 'run');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'p3-owner.md'), 'x');
  fs.writeFileSync(path.join(run, 'p3-owner.notified'), '{}');
  const status = (...a) => execFileSync(process.execPath, [path.resolve('bin/turbo-run.mjs'), 'status', '--project', p.root, ...a], { encoding: 'utf8' });
  const want = ['.planning/turbo/run/p3-owner.md'];
  // never started: a phase run by hand still shows its request
  assert.match(status(), /never started\)\nowner request: \.planning\/turbo\/run\/p3-owner\.md\n$/);
  assert.deepEqual(JSON.parse(status('--json')).ownerRequests, want);
  fs.writeFileSync(path.join(run, 'supervisor.json'), JSON.stringify({ lane: null, finished: false, halted: false, pid: null }));
  const out = status();
  assert.match(out, /owner request: \.planning\/turbo\/run\/p3-owner\.md/);
  assert.equal(out.match(/owner request:/g).length, 1, 'the notification sidecar is not an owner request');
  assert.deepEqual(JSON.parse(status('--json')).ownerRequests, want);
});
