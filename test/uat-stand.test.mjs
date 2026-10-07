import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { isLoopbackUrl, standCheck, netViolations, prepareStand, readStandSecrets, cleanupStand, standDir, evidenceDir } from '../lib/uat-stand.mjs';
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

test('refusals never echo URL credentials, paths or query strings', () => {
  const r = standCheck({ base_url: 'https://user:secretpw@prod.example.com/p?token=abc123' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /https:\/\/prod\.example\.com$/);
  for (const s of ['secretpw', 'user:', '@', 'token', 'abc123', '?']) assert.ok(!r.reason.includes(s), s);
  assert.ok(!standCheck({ base_url: 'http://u:secretpw@exa mple.com' }).reason.includes('secretpw'));
  const bad = netViolations(['http://u:secretpw@cdn.example.com/a', 'u:secretpw@cdn.example.com/b', 'http://u:secretpw@exa mple.com/c']);
  assert.deepEqual(bad.map((b) => b.why), ['not loopback', 'scheme not allowed', 'unparsable']);
  assert.ok(!JSON.stringify(bad).includes('secretpw'), JSON.stringify(bad));
});

test('standCheck refuses credentials in a loopback base_url without echoing them', () => {
  const r = standCheck({ base_url: 'http://admin:pw123456@localhost:3000/x' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /must not carry credentials.*: http:\/\/localhost:3000$/);
  assert.ok(!r.reason.includes('pw123456') && !r.reason.includes('admin'), r.reason);
});

test('forbidden_hosts: a list of hosts, normalized; anything else is refused', () => {
  const ok = standCheck({ base_url: 'http://localhost:3000', forbidden_hosts: ['admin.localhost:9000', 'https://API.example.com/x', 'u:pw@cdn.example.com'] });
  assert.deepEqual([ok.ok, ok.forbiddenHosts], [true, ['admin.localhost', 'api.example.com', 'cdn.example.com']]);
  for (const forbidden_hosts of ['api.example.com', { a: 1 }, 7]) {
    const r = standCheck({ forbidden_hosts });
    assert.deepEqual([r.ok, r.reason], [false, 'uat.forbidden_hosts must be a list of host names'], JSON.stringify(forbidden_hosts));
  }
  const bad = standCheck({ forbidden_hosts: ['ok.example.com', ' ', 'file:///x'] });
  assert.deepEqual([bad.ok, bad.reason], [false, 'uat.forbidden_hosts entry 2 is not a host name']);
  assert.equal(standCheck({ base_url: 'http://admin.localhost:3000', forbidden_hosts: ['admin.localhost'] }).ok, false);
  // a forbidden host can be a loopback one
  assert.deepEqual(netViolations(['http://admin.localhost:3000/x', 'http://localhost:3000/', 'http://a.admin.localhost/'], { forbiddenHosts: ['admin.localhost:9000'] }),
    [{ url: 'http://admin.localhost:3000', why: 'forbidden host' }, { url: 'http://a.admin.localhost', why: 'forbidden host' }]);
  assert.throws(() => netViolations([], { forbiddenHosts: 'admin.localhost' }), /must be a list/);
});

test('netViolations shows hosts only and flags every scheme the stand does not serve', () => {
  const bad = netViolations([
    'https://api.example.org/bot123456:AAFakeTokenValue/send?chat_id=1',
    'admin:hunter2@evil.example.com/x',
    'ftp://localhost/x',
    'gopher://localhost/x',
    'file:///etc/passwd',
    'ws://localhost:1/s',
    'https://localhost:3000/ok',
  ]);
  assert.deepEqual(bad, [
    { url: 'https://api.example.org', why: 'not loopback' },
    { url: '(opaque URL)', why: 'scheme not allowed' },
    { url: 'ftp://localhost', why: 'scheme not allowed' },
    { url: '(opaque URL)', why: 'scheme not allowed' },
    { url: 'file://', why: 'scheme not allowed' },
  ]);
  for (const s of ['AAFake', 'bot123456', 'chat_id', 'admin', 'hunter2', 'passwd']) assert.ok(!JSON.stringify(bad).includes(s), s);
});

test('netViolations flags forbidden and non-loopback hosts and never echoes query strings', () => {
  const bad = netViolations(['http://localhost:3000/a?token=s3cret', 'data:image/png;base64,xx', 'https://cdn.example.com/x.js?k=v', 'https://sub.api.example.com/p', ''], { forbiddenHosts: ['api.example.com'] });
  assert.deepEqual(bad, [{ url: 'https://cdn.example.com', why: 'not loopback' }, { url: 'https://sub.api.example.com', why: 'forbidden host' }]);
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

test('creds.json is readable by its owner only', { skip: process.platform === 'win32' && 'POSIX file modes' }, () => {
  const root = tmpDir('stand-mode');
  const s = prepareStand(root, '3');
  assert.equal(fs.statSync(s.credsFile).mode & 0o777, 0o600);
  cleanupStand(root, '3');
});

test('the stand and evidence directories refuse a phase id with a path separator', () => {
  const root = tmpDir('stand-id');
  for (const bad of ['../x', '3/..', '..\\x', '']) {
    assert.throws(() => prepareStand(root, bad), /invalid phase id/, bad);
    assert.throws(() => cleanupStand(root, bad), /invalid phase id/, bad);
    assert.throws(() => evidenceDir(root, bad), /invalid phase id/, bad);
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
  // the live half plus GSD's own pending rows 1, 2 and 4, which turbo did not record
  assert.deepEqual([r.needsOwner, r.counts], [true, { passed: 1, failed: 0, checklist: 0, signoff: 4 }]);
  assert.match(r.text, /\(live part, split from test 3\)/);
});

test('ownerRequest: rows turbo never recorded make the phase wait', () => {
  const { tests } = parseUat(applyUatResults(UAT, [{ test: 1, result: 'pass', class: 'A' }], { head: HEAD, phase: '3' }));
  const r = ownerRequest({ phase: '3', tests, lang: 'en', file: 'f' });
  assert.deepEqual([r.needsOwner, r.counts], [true, { passed: 1, failed: 0, checklist: 0, signoff: 3 }]);
  assert.match(r.text, /^- 2\. Owner signs the release — the release is signed$/m);
  assert.doesNotMatch(r.text, /Nothing is left for you/);
});

test('ownerRequest: only pass, an issue or a deferred skip leaves a row closed (GSD predicate)', () => {
  const extra = [
    '### 6. No result line', 'expected: y', '',
    '### 7. Blocked one', 'result: blocked', '',
    '### 8. Skipped without a deferral', 'result: skipped', 'reason: not now', '',
    '### 9. Deferred by the owner', 'result: skipped', 'reason: "Deferred follow-up: later"', '',
    '### 10. Reported by the owner', 'result: issue', '',
  ].join('\n');
  const { tests } = parseUat(UAT.replace('## Summary', `${extra}\n## Summary`));
  const r = ownerRequest({ phase: '3', tests, lang: 'en', file: 'f' });
  assert.deepEqual([r.needsOwner, r.counts], [true, { passed: 0, failed: 0, checklist: 0, signoff: 7 }]);
  for (const n of [1, 2, 3, 4, 6, 7, 8]) assert.match(r.text, new RegExp(`^- ${n}\\. `, 'm'), String(n));
  for (const n of [5, 9, 10]) assert.doesNotMatch(r.text, new RegExp(`^- ${n}\\. `, 'm'), String(n));
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
