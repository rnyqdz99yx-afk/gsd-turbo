import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { isLoopbackUrl, standCheck, netViolations, prepareStand, readStandSecrets, cleanupStand, standDir } from '../lib/uat-stand.mjs';
import { applyUatResults, parseUat, ownerRequest, ownerRequestFiles } from '../lib/uat.mjs';
import { msg } from '../lib/messages.mjs';
import { UAT, HEAD } from './fixtures/uat-sample.mjs';

test('loopback URLs only', () => {
  for (const u of ['http://localhost:3000/x', 'http://127.0.0.1:8080', 'http://[::1]:5173/', 'ws://app.localhost:1/s']) assert.ok(isLoopbackUrl(u), u);
  for (const u of ['https://example.com', 'http://10.0.0.5', 'http://localhost.example.com', 'file:///etc/passwd', 'nonsense']) assert.ok(!isLoopbackUrl(u), u);
});

test('standCheck refuses a non-loopback base_url and marks an empty one as inferred', () => {
  assert.equal(standCheck({ base_url: 'https://prod.example.com' }).ok, false);
  const ok = standCheck({ base_url: 'http://localhost:3000', boot: 'npm run dev', forbidden_hosts: ['api.example.com'] });
  assert.deepEqual([ok.ok, ok.inferred, ok.baseUrl, ok.forbiddenHosts], [true, false, 'http://localhost:3000', ['api.example.com']]);
  assert.equal(standCheck({}).inferred, true);
});

test('netViolations flags forbidden and non-loopback hosts and never echoes query strings', () => {
  const bad = netViolations(['http://localhost:3000/a?token=s3cret', 'data:image/png;base64,xx', 'https://cdn.example.com/x.js?k=v', 'https://sub.api.example.com/p', ''], { forbiddenHosts: ['api.example.com'] });
  assert.deepEqual(bad, [{ url: 'https://cdn.example.com/x.js', why: 'not loopback' }, { url: 'https://sub.api.example.com/p', why: 'forbidden host' }]);
  assert.ok(!JSON.stringify(bad).includes('s3cret'));
});

test('prepareStand makes a fresh data dir and one-time creds; only the password counts as a secret', () => {
  const root = tmpDir('stand');
  fs.mkdirSync(path.join(root, '.planning'));
  const s = prepareStand(root, '3', { random: (n) => Buffer.alloc(n, 7) });
  assert.ok(fs.statSync(s.dataDir).isDirectory());
  const creds = JSON.parse(fs.readFileSync(s.credsFile, 'utf8'));
  assert.match(creds.username, /^turbo-uat-[0-9a-f]{6}$/);
  assert.deepEqual(readStandSecrets(root, '3'), [creds.password]);
  cleanupStand(root, '3');
  assert.ok(!fs.existsSync(standDir(root, '3')));
  assert.deepEqual(readStandSecrets(root, '3'), []);
});

test('the stand and evidence directories refuse a phase id with a path separator', () => {
  const root = tmpDir('stand-id');
  for (const bad of ['../x', '3/..', '..\\x', '']) {
    assert.throws(() => prepareStand(root, bad), /invalid phase id/, bad);
    assert.throws(() => cleanupStand(root, bad), /invalid phase id/, bad);
  }
});

test('ownerRequest: one message in the configured language; D items make the phase wait', () => {
  const recorded = applyUatResults(UAT, [
    { test: 1, result: 'pass', class: 'A' },
    { test: 2, result: 'owner', class: 'D' },
    { test: 3, result: 'deferred', class: 'C', reason: 'needs a physical phone' },
    { test: 4, result: 'issue', class: 'A', reported: 'nothing happens' },
  ], { head: HEAD, phase: '3' });
  const { tests } = parseUat(recorded);
  const ru = ownerRequest({ phase: '3', tests, lang: 'ru', file: '.planning/turbo/run/p3-owner.md' });
  assert.deepEqual(ru.counts, { passed: 1, failed: 1, checklist: 1, signoff: 1 });
  assert.equal(ru.needsOwner, true);
  assert.match(ru.text, /Фаза 3/);
  assert.match(ru.text, /- \[ \] 3\. Page shows the code/);
  assert.match(ru.text, /\/gsd-verify-work 3/);
  assert.match(ru.reason, /p3-owner\.md/);
  const en = ownerRequest({ phase: '3', tests: tests.filter((t) => t.number !== 2), lang: 'en', file: 'f' });
  assert.deepEqual([en.needsOwner, en.reason], [false, '']);
  assert.match(en.text, /checklist/i);
});

test('ownerRequest: a live half the recorder left pending makes the phase wait', () => {
  const { tests: src } = parseUat(UAT);
  const recorded = applyUatResults(UAT, [
    { test: 3, split: 'hermetic', expected: 'Page shows the code; the code is visible', result: 'pass', class: 'A' },
  ], { head: HEAD, phase: '3' });
  const { tests } = parseUat(recorded);
  const live = tests.find((t) => t.number === src.length + 1);
  assert.deepEqual([live.result, live.fields.class], ['pending', 'C']);
  const r = ownerRequest({ phase: '3', tests, lang: 'en', file: 'f' });
  assert.deepEqual([r.needsOwner, r.counts], [true, { passed: 1, failed: 0, checklist: 0, signoff: 1 }]);
  assert.match(r.text, /\(live part, split from test 3\)/);
});

test('ownerRequestFiles lists run/p*-owner.md; ownerChecklist exists in both languages', () => {
  const root = tmpDir('or');
  const run = path.join(root, '.planning', 'turbo', 'run');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'p3-owner.md'), 'x');
  fs.writeFileSync(path.join(run, 'p3.json'), '{}');
  assert.deepEqual(ownerRequestFiles(root), ['.planning/turbo/run/p3-owner.md']);
  assert.match(msg('en', 'ownerChecklist', { phase: '3', n: 1, file: 'f' }).title, /checklist/);
  assert.match(msg('ru', 'ownerChecklist', { phase: '3', n: 1, file: 'f' }).title, /чек-лист/);
});
