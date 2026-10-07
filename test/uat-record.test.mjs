import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { HEAD, UAT } from './fixtures/uat-sample.mjs';
import { parseUat, applyUatResults, evidenceManifest, scanSecrets, recordUat } from '../lib/uat.mjs';
import { splitItem, itemText, uatPlan } from '../lib/uat-classify.mjs';

// a manifest entry as recordUat hands it to applyUatResults
const EV = [{ file: '.planning/turbo/run/evidence/p3/t.txt', sha256: 'cd'.repeat(32) }];
const RESULTS = [
  { test: 1, result: 'pass', class: 'A', checks: ['reload /settings', 'read the field'], harness: 'playwright-script', evidence: [{ file: '.planning/turbo/run/evidence/p3/t1.png', sha256: 'ab'.repeat(32) }] },
  { test: 2, result: 'owner', class: 'D' },
  { test: 3, result: 'pass', class: 'A', split: 'hermetic', expected: 'Page shows the code; the code is visible', harness: 'playwright-script', evidence: EV },
  { test: 3, result: 'deferred', class: 'C', split: 'live', expected: 'an SMS arrives on the phone.', reason: 'needs a physical phone' },
  { test: 4, result: 'issue', class: 'A', reported: 'the "Export" button does nothing', severity: 'major', harness: 'playwright-script' },
];
const HEAD2 = 'fedcba9876543210fedcba9876543210fedcba98';
const SIGN_UAT = UAT.replace('### 2. Owner signs the release\nexpected: the release is signed', '### 2. Owner signs the release and the page shows the badge\nexpected: the badge is visible');

// GSD's predicate (gsd-core bin/lib/uat-predicate.cjs parseUatResultItems, G12), reproduced without parseUat: a block runs
// from a "### N." heading to the next one; its first column-0 result line and first reason line decide.
const gsdView = (text) => {
  const blocks = [];
  for (const line of text.split('\n')) {
    const h = /^###\s*(\d+)\.\s*(.+)$/.exec(line);
    if (h) blocks.push({ n: Number(h[1]), lines: [] });
    else if (blocks.length) blocks.at(-1).lines.push(line);
  }
  return blocks.map(({ n, lines }) => {
    const res = lines.map((l) => /^result:[ \t]*\[?([\w-]+)\]?/i.exec(l)).find(Boolean);
    const why = lines.map((l) => /^reason:[ \t]*(.*)$/i.exec(l)).find(Boolean);
    return { n, result: res ? res[1].toLowerCase() : 'missing', reason: why ? why[1].trim() : '' };
  });
};
// one list entry: its "- " line and the indented lines after it
const entry = (text, opener) => {
  const i = text.indexOf(`\n${opener}\n`);
  return i < 0 ? null : text.slice(i + 1).split(/\n(?! {2})/)[0];
};

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
  assert.deepEqual(gsdView(out).map((x) => [x.n, x.result]), [[1, 'pass'], [2, 'pending'], [3, 'pass'], [4, 'issue'], [5, 'pass'], [6, 'skipped']]);
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
  const twice = applyUatResults(once, RESULTS.map((r) => (r.test === 4 ? { ...r, result: 'pass', reported: undefined, evidence: EV } : r)), { head: HEAD2, phase: '3' });
  const { tests } = parseUat(twice);
  assert.equal(tests.length, 6);
  const block1 = twice.split('### 1.')[1].split('###')[0];
  assert.equal(block1.match(/^result:/gm).length, 1);
  assert.equal(tests.find((x) => x.number === 4).result, 'pass');
  assert.equal(twice.match(/^- test: 6$/gm).length, 1, 'one deferred entry per test');
  assert.equal(twice.match(/^- gap_id: G-3-4$/gm).length, 1, 'one gap entry per test');
  // test 4 is no longer an issue: turbo's own gap entry is resolved, not left open
  const gap = entry(twice, '- gap_id: G-3-4');
  assert.ok(!/status: failed/.test(gap), gap);
  for (const l of ['  status: resolved', '  resolved_by: turbo-uat', `  resolved_at: ${HEAD2}`]) assert.ok(gap.split('\n').includes(l), l);
});

test('a re-record rewrites turbo\'s own Gaps and Deferred Follow-Ups entries and leaves GSD\'s alone', () => {
  const opts = { head: HEAD, phase: '3' };
  // an unclassified item: the agent may record it as C once and as D later, never lower (C1)
  const uat = UAT.replace('## Summary', '### 6. Nightly job finishes\nexpected: it completes\nresult: [pending]\n\n## Summary');
  const issue = { test: 4, result: 'issue', class: 'A', reported: 'nothing happens', severity: 'major' };
  const defer = { test: 6, result: 'deferred', class: 'C', reason: 'needs a full night' };
  const once = applyUatResults(uat, [issue, defer], opts);
  assert.ok(entry(once, '- test: 6').includes('idea: "needs a full night"'));
  // a deferral again rewrites turbo's one entry
  const again = applyUatResults(once, [{ ...defer, reason: 'needs two nights' }], opts);
  assert.equal(again.match(/^- test: 6$/gm).length, 1);
  assert.ok(entry(again, '- test: 6').includes('idea: "needs two nights"'));
  const twice = applyUatResults(again, [{ test: 4, result: 'pass', class: 'A', evidence: EV }, { test: 6, result: 'owner', class: 'D' }], { head: HEAD2, phase: '3' });
  assert.ok(entry(twice, '- gap_id: G-3-4').includes('\n  status: resolved\n'));
  assert.equal(entry(twice, '- test: 6'), null, 'a test that is no longer deferred has no deferred entry');
  assert.deepEqual(gsdView(twice).filter((x) => [4, 6].includes(x.n)).map((x) => x.result), ['pass', 'pending']);
  // an issue again replaces turbo's resolved entry; the D row never goes back to a deferral
  const thrice = applyUatResults(twice, [{ ...issue, reported: 'still nothing', severity: 'minor' }], opts);
  const gap = entry(thrice, '- gap_id: G-3-4');
  assert.equal(thrice.match(/^- gap_id: G-3-4$/gm).length, 1);
  for (const l of ['  status: failed', '  reason: "turbo-uat reported: still nothing"', '  severity: minor']) assert.ok(gap.split('\n').includes(l), l);
  assert.ok(!/resolved_(by|at)/.test(gap), gap);
  assert.throws(() => applyUatResults(twice, [defer], opts), /class C is below the class D turbo-uat recorded for this test/);
  // a gap GSD wrote for the same id: an issue would hide behind it, so turbo refuses; a pass leaves it as it is
  const foreign = uat.replace('## Gaps\n', '## Gaps\n\n- gap_id: G-3-4\n  truth: "x"\n  status: failed\n  reason: "User reported: y"\n  test: 4\n');
  assert.throws(() => applyUatResults(foreign, [issue], opts), /G-3-4 .*did not write/);
  assert.equal(entry(applyUatResults(foreign, [{ test: 4, result: 'pass', class: 'A', evidence: EV }], opts), '- gap_id: G-3-4'), entry(foreign, '- gap_id: G-3-4'));
});

test('a hermetic result alone appends the live half as a pending row', () => {
  const opts = { head: HEAD, phase: '3' };
  const sms = applyUatResults(UAT, [RESULTS[2]], opts);
  const row = parseUat(sms).tests.find((x) => x.number === 6);
  assert.deepEqual([row.name, row.expected, row.result, row.fields.class, row.fields.source, row.fields.head],
    ['Page shows the code and an SMS arrives on the phone (live part, split from test 3)', 'an SMS arrives on the phone.', 'pending', 'C', 'turbo-uat', HEAD]);
  assert.equal(gsdView(sms).find((x) => x.n === 6).result, 'pending');
  for (const [k, v] of Object.entries({ total: 6, passed: 2, pending: 4 })) assert.ok(sms.includes(`\n${k}: ${v}\n`), `${k}: ${v}`);
  const [h] = splitItem('Owner signs the release and the page shows the badge. the badge is visible');
  const sign = applyUatResults(SIGN_UAT, [{ test: 2, result: 'pass', class: 'A', split: 'hermetic', expected: h.text, evidence: EV }], opts);
  const signRow = parseUat(sign).tests.find((x) => x.number === 6);
  assert.deepEqual([signRow.name, signRow.expected, signRow.result, signRow.fields.class],
    ['Owner signs the release and the page shows the badge (live part, split from test 2)', 'Owner signs the release', 'pending', 'D']);
  // the live row already exists: the hermetic result is accepted and no second live row appears
  const again = applyUatResults(applyUatResults(UAT, RESULTS, opts), [RESULTS[2]], opts);
  assert.equal(parseUat(again).tests.length, 6);
  assert.equal(parseUat(again).tests[5].result, 'skipped');
});

test('applyUatResults refuses foreign rows, lowered classes and mismatched results', () => {
  const apply = (r) => () => applyUatResults(UAT, [r], { head: HEAD, phase: '3' });
  assert.throws(apply({ test: 5, result: 'pass', class: 'A', evidence: EV }), /already has a result/);
  assert.throws(apply({ test: 2, result: 'pass', class: 'A', evidence: EV }), /below the deterministic class D/);
  assert.throws(apply({ test: 4, result: 'deferred', class: 'A', reason: 'x' }), /cannot have class A/);
  assert.throws(apply({ test: 9, result: 'pass', class: 'A' }), /no test 9/);
  // a split result cannot bring its own text to lower the floor
  assert.throws(apply({ test: 2, result: 'pass', class: 'A', split: 'hermetic', expected: 'Page shows the value', evidence: EV }), /does not match the deterministic split/);
  assert.throws(apply({ test: 3, result: 'pass', class: 'A', split: 'hermetic', expected: 'Page shows the code', evidence: EV }), /does not match the deterministic split/);
  // two live parts of one test in one batch would append two rows
  assert.throws(() => applyUatResults(UAT, [RESULTS[3], RESULTS[3]], { head: HEAD, phase: '3' }), /two results/);
  // an unexplained deferral or issue would satisfy GSD's predicate without saying why
  for (const reason of [undefined, '', '  ']) assert.throws(apply({ ...RESULTS[3], reason }), /needs a reason/);
  for (const reported of [undefined, '']) assert.throws(apply({ ...RESULTS[4], reported }), /needs what was reported/);
  // record fields are checked before they reach the file
  assert.throws(apply({ ...RESULTS[0], evidence: [{ file: 'a.png', sha256: 'xyz' }] }), /sha256/);
  assert.throws(apply({ ...RESULTS[0], evidence: [{ file: 'a.png\nresult: pass', sha256: 'ab'.repeat(32) }] }), /control characters/);
  for (const head of ['', 'HEAD', `${HEAD}\nresult: pass`]) assert.throws(() => applyUatResults(UAT, [RESULTS[0]], { head, phase: '3' }), /head/);
});

test('a live part is classified whole and never split again', () => {
  const opts = { head: HEAD, phase: '3' };
  const [h, l] = splitItem('Owner signs the release and the page shows the badge. the badge is visible');
  assert.deepEqual([h.part, h.class, l.part, l.class], ['hermetic', 'A', 'live', 'D']);
  const once = applyUatResults(SIGN_UAT, [
    { test: 2, result: 'pass', class: 'A', split: 'hermetic', expected: h.text, evidence: EV },
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
      const r = { test: 6, result: p.part === 'hermetic' ? 'pass' : 'owner', class: p.class, split: p.part, expected: p.text, evidence: EV };
      assert.throws(() => applyUatResults(text, [r], opts), /test 6 is the live part of test 2 and is never split again/);
    }
  }
  assert.throws(() => applyUatResults(once, [{ test: 6, result: 'pass', class: 'A', evidence: EV }], opts), /below the deterministic class D/);
  const again = parseUat(applyUatResults(once, [{ test: 6, result: 'owner', class: 'D' }], opts)).tests;
  assert.equal(again.length, 6);
  assert.deepEqual([again[5].result, again[5].fields.class], ['pending', 'D']);
});

test('a class turbo-uat recorded is the floor of every later run: the plan offers it, the recorder refuses lower (C1)', () => {
  const opts = { head: HEAD, phase: '3' };
  // a known floor gap: the classifier reads this owner-only item as A, and the agent raises it to D
  const uat = UAT.replace('### 1. Settings page shows the saved value\nexpected: the value persists after reload', '### 1. Owner confirms the pricing page copy\nexpected: the copy is final');
  assert.notEqual(uat, UAT);
  assert.deepEqual(uatPlan(parseUat(uat).tests).filter((i) => i.test === 1).map((i) => i.class), ['A']);
  const once = applyUatResults(uat, [{ test: 1, result: 'owner', class: 'D' }], opts);
  const row = parseUat(once).tests.find((x) => x.number === 1);
  assert.deepEqual([row.result, row.fields.source, row.fields.class], ['pending', 'turbo-uat', 'D']);
  // run 2 (a uat-step repeat, a resumed session, an owner resume without signing)
  const plan = uatPlan(parseUat(once).tests).filter((i) => i.test === 1);
  assert.deepEqual(plan.map((i) => [i.class, i.rule]), [['D', 'class D recorded by turbo-uat']]);
  for (const r of [{ result: 'pass', class: 'A', evidence: EV }, { result: 'issue', class: 'B', reported: 'x' }, { result: 'deferred', class: 'C', reason: 'x' }]) {
    assert.throws(() => applyUatResults(once, [{ test: 1, ...r }], opts), new RegExp(`class ${r.class} is below the class D turbo-uat recorded for this test`));
  }
  const again = parseUat(applyUatResults(once, [{ test: 1, result: 'owner', class: 'D' }], opts)).tests[0];
  assert.deepEqual([again.result, again.fields.class], ['pending', 'D']);
  // a recorded class on a row turbo did not write is not turbo's: the deterministic floor alone applies
  const foreign = uat.replace('expected: the copy is final\nresult: [pending]', 'expected: the copy is final\nresult: [pending]\nclass: D');
  assert.deepEqual(uatPlan(parseUat(foreign).tests).filter((i) => i.test === 1).map((i) => i.class), ['A']);
  // the live row of a split test carries its own recorded class to its live part
  const live = applyUatResults(UAT, [{ ...RESULTS[2], evidence: EV }, { ...RESULTS[3], result: 'owner', class: 'D', reason: undefined }], opts);
  const liveRow = parseUat(live).tests.find((x) => x.number === 6);
  assert.deepEqual([liveRow.result, liveRow.fields.class], ['pending', 'D']);
  assert.throws(() => applyUatResults(live, [RESULTS[3]], opts), /class C is below the class D turbo-uat recorded for this test/);
});

test('a pass needs evidence, and a harness is one of playwright-script, http, socket (M7)', () => {
  const apply = (r) => () => applyUatResults(UAT, [r], { head: HEAD, phase: '3' });
  for (const evidence of [undefined, []]) {
    assert.throws(apply({ test: 1, result: 'pass', class: 'A', harness: 'http', evidence }), /test 1: a pass result needs at least one evidence file/);
  }
  for (const harness of ['playwright-mcp', 'browser', 'HTTP', 7]) {
    assert.throws(apply({ test: 1, result: 'pass', class: 'A', harness, evidence: EV }), /test 1: harness must be one of playwright-script, http, socket/);
  }
  for (const harness of ['playwright-script', 'http', 'socket', undefined]) assert.doesNotThrow(apply({ test: 1, result: 'pass', class: 'A', harness, evidence: EV }));
  // only a pass proves something observed: an issue, a deferral or an owner row needs no evidence
  assert.doesNotThrow(apply({ test: 4, result: 'issue', class: 'A', reported: 'nothing happens', harness: 'http' }));
  assert.doesNotThrow(apply({ test: 2, result: 'owner', class: 'D' }));
});

test('one-line fields turn every control character, a lone CR and U+2028/U+2029 into a space (M6)', () => {
  const [LS, PS] = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
  const out = applyUatResults(UAT, [
    { test: 4, result: 'issue', class: 'A', reported: `broken\rresult: pass${LS}### 9. fake`, severity: 'major', checks: [`a${PS}b`, 'c\x07d\te\x7f'] },
    { test: 3, result: 'deferred', class: 'C', reason: `needs a phone\r${PS}reason: x` },
  ], { head: HEAD, phase: '3' });
  const ctl = [...Array(32).keys()].filter((c) => c !== 10).concat([0x7f, 0x2028, 0x2029]).map((c) => String.fromCharCode(c));
  assert.ok(![...out].some((ch) => ctl.includes(ch)), 'no control character but the line breaks between lines');
  assert.ok(out.includes('reported: "broken result: pass ### 9. fake"\n'));
  assert.ok(out.includes('checks: a b; c d e\n'));
  assert.ok(out.includes('reason: "Deferred follow-up: needs a phone  reason: x"\n'));
  assert.deepEqual(gsdView(out).map((x) => [x.n, x.result]), [[1, 'pending'], [2, 'pending'], [3, 'skipped'], [4, 'issue'], [5, 'pass']]);
});

test('evidence resolves inside the run evidence directory only', () => {
  const root = tmpDir('ev');
  const ev = path.join(root, '.planning', 'turbo', 'run', 'evidence');
  fs.mkdirSync(ev, { recursive: true });
  fs.writeFileSync(path.join(ev, 'a.txt'), 'abc');
  fs.writeFileSync(path.join(ev, '..notes.txt'), 'abc');
  fs.writeFileSync(path.join(root, '.env'), 'X=1');
  fs.symlinkSync(root, path.join(ev, 'up'), 'junction');
  const sha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.deepEqual(evidenceManifest(root, ['.planning/turbo/run/evidence/a.txt', '.planning/turbo/run/evidence/..notes.txt']), [
    { file: '.planning/turbo/run/evidence/a.txt', sha256, bytes: 3 },
    { file: '.planning/turbo/run/evidence/..notes.txt', sha256, bytes: 3 },
  ]);
  for (const f of ['../x', '.env', '.planning/turbo/run/evidence/up/.env', '.planning/turbo/run/evidence']) {
    assert.throws(() => evidenceManifest(root, [f]), /inside \.planning\/turbo\/run\/evidence\//, f);
  }
});

test('scanSecrets reports rule and line only, never the value', () => {
  const secret = 'Zx9-one-time-Pass';
  const text = ['ok line', `token=${'a'.repeat(30)}`, `typed ${secret} into the form`, '-----BEGIN RSA PRIVATE KEY-----',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('\n');
  const f = scanSecrets(text, { known: [secret] });
  assert.deepEqual(f.map((x) => [x.line, x.rule]), [[2, 'credential assignment'], [3, 'one-time credential'], [4, 'private key'], [5, 'jwt']]);
  assert.ok(!JSON.stringify(f).includes(secret));
  // the encoded forms a request log or a JSON body carries
  const odd = 'p@ss "w0rd"/x';
  const forms = [`q=${encodeURIComponent(odd)}`, `{"v":${JSON.stringify(odd)}}`, `auth ${Buffer.from(odd).toString('base64').replace(/=+$/, '')}`];
  assert.deepEqual(scanSecrets(['ok', ...forms].join('\n'), { known: [odd] }).map((x) => [x.line, x.rule]),
    [[2, 'one-time credential'], [3, 'one-time credential'], [4, 'one-time credential']]);
  // a value too short to scan for fails closed and is not named
  assert.throws(() => scanSecrets('ok', { known: ['12345'] }), (e) => /shorter than 6/.test(e.message) && !e.message.includes('12345'));
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
  fs.writeFileSync(path.join(ev, 'requests.jsonl'), '{"body":"Zx9-one-time-Pass"}\n');
  fs.writeFileSync(path.join(ev, 'har'), 'body=Zx9-one-time-Pass\n');
  const known = ['Zx9-one-time-Pass'];
  const record = (results) => () => recordUat({ root, phaseDir: dir, phase: '3', head: HEAD, known, results });
  const bad = [{ test: 1, result: 'pass', class: 'A', evidence: ['.planning/turbo/run/evidence/p3/requests-t1.log'] }];
  assert.throws(record(bad), (e) => /secret-scan refused/.test(e.message) && /requests-t1\.log:1 one-time credential/.test(e.message) && !e.message.includes('Zx9'));
  // every evidence file but known binary types is scanned, whatever its extension
  for (const f of ['requests.jsonl', 'har']) {
    assert.throws(record([{ test: 1, result: 'pass', class: 'A', evidence: [`.planning/turbo/run/evidence/p3/${f}`] }]), new RegExp(`p3/${f}:1 one-time credential`));
  }
  // a leak into the record itself names the line of the new text, which is not on disk
  const leaky = [{ test: 1, result: 'pass', class: 'A', checks: ['typed Zx9-one-time-Pass into the form'], evidence: ['.planning/turbo/run/evidence/p3/t1.png'] }];
  assert.throws(record(leaky), (e) => /03-UAT\.md new record line \d+ one-time credential/.test(e.message) && !e.message.includes('Zx9'));
  assert.equal(fs.readFileSync(path.join(dir, '03-UAT.md'), 'utf8'), UAT);
  const good = [{ test: 1, result: 'pass', class: 'A', harness: 'playwright-script', evidence: ['.planning/turbo/run/evidence/p3/t1.png'] }];
  const r = record(good)();
  assert.equal(r.counts.passed, 2);
  assert.match(fs.readFileSync(path.join(dir, '03-UAT.md'), 'utf8'), /t1\.png sha256:[0-9a-f]{64}/);
  assert.deepEqual(fs.readdirSync(dir), ['03-UAT.md'], 'the atomic write leaves no temp file');
});
