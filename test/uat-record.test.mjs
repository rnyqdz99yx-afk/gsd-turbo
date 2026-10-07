import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { HEAD, UAT } from './fixtures/uat-sample.mjs';
import { parseUat, applyUatResults, evidenceManifest, scanSecrets, recordUat } from '../lib/uat.mjs';
import { splitItem, itemText } from '../lib/uat-classify.mjs';

const RESULTS = [
  { test: 1, result: 'pass', class: 'A', checks: ['reload /settings', 'read the field'], harness: 'playwright-mcp', evidence: [{ file: '.planning/turbo/run/evidence/p3/t1.png', sha256: 'ab'.repeat(32) }] },
  { test: 2, result: 'owner', class: 'D' },
  { test: 3, result: 'pass', class: 'A', split: 'hermetic', expected: 'Page shows the code; the code is visible', harness: 'playwright-mcp' },
  { test: 3, result: 'deferred', class: 'C', split: 'live', expected: 'an SMS arrives on the phone.', reason: 'needs a physical phone' },
  { test: 4, result: 'issue', class: 'A', reported: 'the "Export" button does nothing', severity: 'major', harness: 'playwright-mcp' },
];

// Mirrors bin/lib/uat-predicate.cjs (G12): per "### N." block the first column-0 result/reason line decides.
const gsdView = (text) => parseUat(text).tests.map((t) => ({ n: t.number, result: t.result, reason: t.fields.reason || '' }));

test('parseUat reads Step-A rows, ignores ## Current Test, joins block scalars', () => {
  const { tests } = parseUat(UAT);
  assert.deepEqual(tests.map((t) => [t.number, t.result]), [[1, 'pending'], [2, 'pending'], [3, 'pending'], [4, 'pending'], [5, 'pass']]);
  assert.equal(tests[3].expected, 'a CSV file downloads');
});

test('applyUatResults writes turbo records GSD can read', () => {
  const out = applyUatResults(UAT, RESULTS, { head: HEAD, phase: '3', now: new Date('2026-02-03T04:05:06Z') });
  const { tests } = parseUat(out);
  const t = Object.fromEntries(tests.map((x) => [x.number, x]));
  assert.equal(tests.length, 6);
  assert.deepEqual([t[1].result, t[1].fields.source, t[1].fields.class, t[1].fields.head], ['pass', 'turbo-uat', 'A', HEAD]);
  assert.equal(t[1].fields.checks, 'reload /settings; read the field');
  assert.ok(out.includes(`evidence:\n  - .planning/turbo/run/evidence/p3/t1.png sha256:${'ab'.repeat(32)}`));
  assert.deepEqual([t[2].result, t[2].fields.class], ['pending', 'D']);
  assert.equal(t[6].name, 'Page shows the code and an SMS arrives on the phone (live part, split from test 3)');
  assert.match(gsdView(out).find((x) => x.n === 6).reason, /^"Deferred follow-up: needs a physical phone"$/);
  assert.equal(t[4].result, 'issue');
  assert.ok(out.includes('reported: "the \\"Export\\" button does nothing"'));
  assert.ok(out.includes('- gap_id: G-3-4'));
  assert.ok(out.includes('## Deferred Follow-Ups\n\n- test: 6\n  idea: "needs a physical phone"\n  deferred_at: 2026-02-03'));
  assert.deepEqual(t[5].fields, parseUat(UAT).tests[4].fields, 'the owner-answered row is untouched');
  for (const [k, v] of Object.entries({ total: 6, passed: 3, issues: 1, pending: 1, skipped: 1, blocked: 0 })) assert.ok(out.includes(`\n${k}: ${v}\n`), `${k}: ${v}`);
  assert.ok(out.includes('updated: 2026-02-03T04:05:06.000Z'));
  assert.ok(out.includes('### 4. Export button downloads a CSV\nexpected: |\n  a CSV file downloads\nresult: issue'));
});

test('re-recording replaces turbo rows and the earlier live part instead of duplicating them', () => {
  const once = applyUatResults(UAT, RESULTS, { head: HEAD, phase: '3' });
  const twice = applyUatResults(once, RESULTS.map((r) => (r.test === 4 ? { ...r, result: 'pass', reported: undefined } : r)), { head: HEAD, phase: '3' });
  const { tests } = parseUat(twice);
  assert.equal(tests.length, 6);
  const block1 = twice.split('### 1.')[1].split('###')[0];
  assert.equal(block1.match(/^result:/gm).length, 1);
  assert.equal(tests.find((x) => x.number === 4).result, 'pass');
  assert.equal(twice.match(/^- test: 6$/gm).length, 1, 'one deferred entry per test');
  assert.equal(twice.match(/^- gap_id: G-3-4$/gm).length, 1, 'one gap entry per test');
});

test('applyUatResults refuses foreign rows, lowered classes and mismatched results', () => {
  const apply = (r) => () => applyUatResults(UAT, [r], { head: HEAD, phase: '3' });
  assert.throws(apply({ test: 5, result: 'pass', class: 'A' }), /already has a result/);
  assert.throws(apply({ test: 2, result: 'pass', class: 'A' }), /below the deterministic class D/);
  assert.throws(apply({ test: 4, result: 'deferred', class: 'A', reason: 'x' }), /cannot have class A/);
  assert.throws(apply({ test: 9, result: 'pass', class: 'A' }), /no test 9/);
  // a split result cannot bring its own text to lower the floor
  assert.throws(apply({ test: 2, result: 'pass', class: 'A', split: 'hermetic', expected: 'Page shows the value' }), /does not match the deterministic split/);
  assert.throws(apply({ test: 3, result: 'pass', class: 'A', split: 'hermetic', expected: 'Page shows the code' }), /does not match the deterministic split/);
  // two live parts of one test in one batch would append two rows
  assert.throws(() => applyUatResults(UAT, [RESULTS[3], RESULTS[3]], { head: HEAD, phase: '3' }), /two results/);
});

test('a live part is classified whole and never split again', () => {
  const opts = { head: HEAD, phase: '3' };
  const uat = UAT.replace('### 2. Owner signs the release\nexpected: the release is signed', '### 2. Owner signs the release and the page shows the badge\nexpected: the badge is visible');
  const [h, l] = splitItem('Owner signs the release and the page shows the badge. the badge is visible');
  assert.deepEqual([h.part, h.class, l.part, l.class], ['hermetic', 'A', 'live', 'D']);
  const once = applyUatResults(uat, [
    { test: 2, result: 'pass', class: 'A', split: 'hermetic', expected: h.text },
    { test: 2, result: 'owner', class: 'D', split: 'live', expected: l.text },
  ], opts);
  const row = parseUat(once).tests.find((x) => x.number === 6);
  assert.deepEqual([row.name, row.expected, row.result, row.fields.class],
    ['Owner signs the release and the page shows the badge (live part, split from test 2)', 'Owner signs the release', 'pending', 'D']);
  // the live part's own text still splits, so only the live-part guard keeps a hermetic pass off the pending D row
  const parts = splitItem(itemText(row));
  assert.deepEqual(parts.map((p) => [p.part, p.class]), [['hermetic', 'A'], ['live', 'D']]);
  // trailing blanks on the heading: parseUat trims the name, so the end-anchored marker still matches
  for (const text of [once, once.replace(row.name, `${row.name}  `)]) {
    for (const p of parts) {
      const r = { test: 6, result: p.part === 'hermetic' ? 'pass' : 'owner', class: p.class, split: p.part, expected: p.text };
      assert.throws(() => applyUatResults(text, [r], opts), /test 6 is the live part of test 2 and is never split again/);
    }
  }
  assert.throws(() => applyUatResults(once, [{ test: 6, result: 'pass', class: 'A' }], opts), /below the deterministic class D/);
  const again = parseUat(applyUatResults(once, [{ test: 6, result: 'owner', class: 'D' }], opts)).tests;
  assert.equal(again.length, 6);
  assert.deepEqual([again[5].result, again[5].fields.class], ['pending', 'D']);
});

test('evidenceManifest hashes files inside the project only', () => {
  const root = tmpDir('ev');
  fs.mkdirSync(path.join(root, 'e'));
  fs.writeFileSync(path.join(root, 'e', 'a.txt'), 'abc');
  assert.deepEqual(evidenceManifest(root, ['e/a.txt']), [{ file: 'e/a.txt', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', bytes: 3 }]);
  assert.throws(() => evidenceManifest(root, ['../x']), /outside the project/);
});

test('scanSecrets reports rule and line only, never the value', () => {
  const secret = 'Zx9-one-time-Pass';
  const text = ['ok line', `token=${'a'.repeat(30)}`, `typed ${secret} into the form`, '-----BEGIN RSA PRIVATE KEY-----',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('\n');
  const f = scanSecrets(text, { known: [secret] });
  assert.deepEqual(f.map((x) => [x.line, x.rule]), [[2, 'credential assignment'], [3, 'one-time credential'], [4, 'private key'], [5, 'jwt']]);
  assert.ok(!JSON.stringify(f).includes(secret));
});

test('recordUat writes a clean record and refuses one that would leak the one-time password', () => {
  const root = tmpDir('uat');
  const dir = path.join(root, '.planning', 'phases', '03-demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '03-UAT.md'), UAT);
  const ev = path.join(root, '.planning', 'turbo', 'run', 'evidence', 'p3');
  fs.mkdirSync(ev, { recursive: true });
  fs.writeFileSync(path.join(ev, 't1.png'), Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(path.join(ev, 'requests-t1.log'), 'POST http://localhost:3000/login body=Zx9-one-time-Pass\n');
  const bad = [{ test: 1, result: 'pass', class: 'A', evidence: ['.planning/turbo/run/evidence/p3/requests-t1.log'] }];
  assert.throws(() => recordUat({ root, phaseDir: dir, phase: '3', head: HEAD, known: ['Zx9-one-time-Pass'], results: bad }),
    (e) => /secret-scan refused/.test(e.message) && /requests-t1\.log:1 one-time credential/.test(e.message) && !e.message.includes('Zx9'));
  assert.equal(fs.readFileSync(path.join(dir, '03-UAT.md'), 'utf8'), UAT);
  const good = [{ test: 1, result: 'pass', class: 'A', harness: 'playwright-mcp', evidence: ['.planning/turbo/run/evidence/p3/t1.png'] }];
  const r = recordUat({ root, phaseDir: dir, phase: '3', head: HEAD, known: ['Zx9-one-time-Pass'], results: good });
  assert.equal(r.counts.passed, 2);
  assert.match(fs.readFileSync(path.join(dir, '03-UAT.md'), 'utf8'), /t1\.png sha256:[0-9a-f]{64}/);
});
