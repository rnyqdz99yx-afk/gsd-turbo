import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEAD, UAT } from './fixtures/uat-sample.mjs';
import { applyUatResults, ownerRequest, parseUat, signRows } from '../lib/uat.mjs';

// F1: the owner's Accept on a sign-off card (turbo-run ask N --sign) signs the card's rows: GSD's pass, the owner as
// the source, and the answer that signed it.
const ANSWER = { id: 'ask-2', by: 'telegram', at: '2026-02-03T04:00:00.000Z' };
const NOW = new Date('2026-02-03T04:05:06Z');
// turbo-uat recorded test 2 as owner-only (D), test 3 as a deferred live check, test 4 as an issue; test 1 stays
// GSD's pending row; test 5 the owner already passed
const RECORDED = applyUatResults(UAT, [
  { test: 2, result: 'owner', class: 'D' },
  { test: 3, result: 'deferred', class: 'C', reason: 'needs a physical phone' },
  { test: 4, result: 'issue', class: 'A', reported: 'nothing downloads', severity: 'major' },
], { head: HEAD, phase: '3' });
const WITH_SKIP = RECORDED.replace('## Summary', '### 6. Skipped for now\nexpected: y\nresult: skipped\nreason: not now\n\n## Summary');
const row = (text, n) => parseUat(text).tests.find((t) => t.number === n);

test('ownerRequest lists the rows the owner signs apart from the skipped or blocked ones they confirm', () => {
  const r = ownerRequest({ phase: '3', tests: parseUat(WITH_SKIP).tests, lang: 'en', file: 'f' });
  assert.deepEqual([r.needsOwner, r.sign, r.confirm, r.counts.signoff], [true, [1, 2], [6], 3]);
  // the request names the card first, verify-work as the other way
  assert.match(r.text, /^Accept them on the question card of the phase \(it then goes on by itself\), or close them with \/gsd-verify-work 3/m);
  assert.match(ownerRequest({ phase: '3', tests: parseUat(WITH_SKIP).tests, lang: 'ru', file: 'f' }).text, /^Прими их на карточке вопроса фазы/m);
});

test('signRows signs the card\'s rows as passed by the owner, with the answer on each row; GSD reads them as pass', () => {
  const r = signRows(RECORDED, { tests: [2, 1], answer: ANSWER, now: NOW });
  assert.deepEqual([r.signed, r.already], [[1, 2], []]);
  const t2 = row(r.text, 2);
  assert.deepEqual([t2.result, t2.fields.source, t2.fields.signed], ['pass', 'owner', 'owner answer ask-2 (telegram, 2026-02-03T04:00:00.000Z)']);
  // turbo-uat's record fields go, its class stays (what was signed: an owner item, or one nobody checked): the row is
  // the owner's now
  assert.equal(t2.fields.class, 'D');
  assert.ok(!Object.hasOwn(t2.fields, 'head'));
  assert.ok(!Object.hasOwn(row(r.text, 1).fields, 'class'), 'a row without a class gets none');
  assert.equal(t2.expected, 'the release is signed');
  assert.ok(r.text.includes('### 2. Owner signs the release\nexpected: the release is signed\nresult: pass\nsource: owner\nclass: D\nsigned: owner answer ask-2'));
  assert.equal(row(r.text, 1).result, 'pass');
  // the other rows are untouched; the summary is counted again
  for (const n of [3, 4, 5]) assert.deepEqual(row(r.text, n).fields, row(RECORDED, n).fields, `test ${n}`);
  for (const [k, v] of Object.entries({ total: 5, passed: 3, issues: 1, pending: 0, skipped: 1 })) assert.ok(r.text.includes(`\n${k}: ${v}\n`), `${k}: ${v}`);
  assert.ok(r.text.includes('updated: 2026-02-03T04:05:06.000Z'));
  assert.equal(ownerRequest({ phase: '3', tests: parseUat(r.text).tests }).needsOwner, false);
  // a row the owner signed is never turbo-uat's to record again
  assert.throws(() => applyUatResults(r.text, [{ test: 2, result: 'owner', class: 'D' }], { head: HEAD, phase: '3' }), /already has a result that turbo-uat did not write/);
});

test('signRows: a row closed meanwhile is left alone; a skipped or blocked row or an unknown test is refused and nothing changes', () => {
  const once = signRows(RECORDED, { tests: [2], answer: ANSWER, now: NOW }).text;
  const again = signRows(once, { tests: [2, 4, 3, 5], answer: ANSWER, now: NOW });
  assert.deepEqual([again.signed, again.already, again.text], [[], [2, 3, 4, 5], once]);
  assert.throws(() => signRows(WITH_SKIP, { tests: [2, 6], answer: ANSWER, now: NOW }), /test 6: a skipped or blocked row is not signed: the owner confirms it with turbo-run uat defer/);
  assert.throws(() => signRows(RECORDED, { tests: [9], answer: ANSWER, now: NOW }), /no test 9 in the UAT file/);
  // review 1: a row whose text is not what the owner was shown is never signed
  const seen = { 1: 'Settings page shows the saved value. the value persists after reload', 2: 'Owner signs the release. the release is signed' };
  assert.deepEqual(signRows(RECORDED, { tests: [1, 2], seen, answer: ANSWER, now: NOW }).signed, [1, 2]);
  assert.throws(() => signRows(RECORDED, { tests: [1, 2], seen: { ...seen, 2: 'Owner signs the contract. the contract is signed' }, answer: ANSWER, now: NOW }), /test 2 changed since the owner was asked/);
  assert.throws(() => signRows(RECORDED, { tests: [2], seen: {}, answer: ANSWER, now: NOW }), /test 2 changed since the owner was asked/);
  // keeps the file's line endings
  const crlf = signRows(RECORDED.replace(/\n/g, '\r\n'), { tests: [2], answer: ANSWER, now: NOW }).text;
  assert.ok(crlf.includes('result: pass\r\nsource: owner\r\n'));
  assert.ok(!/[^\r]\n/.test(crlf));
});
