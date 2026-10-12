import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_RULING_RE, deferRows, ownerRequest, parseUat } from '../lib/uat.mjs';
import { UAT } from './fixtures/uat-sample.mjs';

// GSD's own deferral matcher (uat-predicate.cjs DEFERRED_REASON_RE), copied: the rewritten rows must satisfy it
const GSD_DEFERRED = /^["']?deferred follow-up\b/i;
const NOW = new Date('2026-02-03T04:05:06Z');

// Rows the owner already handled: three carry an owner ruling (English, Russian, "DEFERRED → Phase N"), two do not,
// one is already a GSD deferral.
const RULED = [
  '### 6. Payment with a real card', 'expected: the charge goes through', 'result: skipped',
  'reason: no test card; owner ruling 2026-01-02: defer to Phase 9', '',
  '### 7. Store listing shows the app', 'expected: listed', 'result: blocked', 'blocked_by: third-party',
  'reason: the store review is still pending', '',
  '### 8. Partner sign-in', 'expected: signed in', 'result: skipped',
  'reason: нет тестового аккаунта; владелец: «Отложить на фазу 9»', '',
  '### 9. Export of a large file', 'expected: the file downloads', 'result: skipped',
  'reason: no sample data — DEFERRED → Phase 9', '',
  '### 10. Already deferred', 'expected: x', 'result: skipped', 'reason: "Deferred follow-up: later"', '',
  '### 11. Skipped for now', 'expected: y', 'result: skipped', 'reason: not now', '',
].join('\n');
const withRuled = () => UAT.replace('## Summary', `${RULED}\n## Summary`);
const rowOf = (text, n) => parseUat(text).tests.find((t) => t.number === n);
const firstReasonLine = (t) => String(t.fields.reason ?? '').trim();

test('OWNER_RULING_RE: an owner ruling or a deferral to a phase, in English and Russian; a plain reason is no ruling', () => {
  for (const s of [
    'owner ruling 2026-01-02: later', "the owner's decision: not in this phase", 'owner decided to skip it', 'ruled by the owner',
    'DEFERRED → Phase 9', 'deferred to phase 12', 'deferred -> Phase 3 (tracker)',
    'Отложить на фазу 9', 'отложено владельцем', 'по решению владельца', 'решение владельца: потом',
  ]) assert.ok(OWNER_RULING_RE.test(s), s);
  for (const s of ['the store review is still pending', 'not now', 'no test account', 'the owner signs the release', 'a deferred import runs later', 'phase 9 covers it']) {
    assert.ok(!OWNER_RULING_RE.test(s), s);
  }
});

test('deferRows --rulings: owner-ruled skipped rows become GSD deferrals with the reason unchanged; the others stay', () => {
  const before = withRuled();
  const { text, deferred, already } = deferRows(before, { rulings: true, now: NOW });
  assert.deepEqual([deferred, already], [[6, 8, 9], []]);
  for (const n of [6, 8, 9]) {
    const t = rowOf(text, n);
    assert.equal(t.result, 'skipped', String(n));
    assert.ok(GSD_DEFERRED.test(firstReasonLine(t)), `${n}: ${t.fields.reason}`);
  }
  assert.equal(rowOf(text, 6).fields.reason, '"Deferred follow-up: no test card; owner ruling 2026-01-02: defer to Phase 9"');
  assert.equal(rowOf(text, 8).fields.reason, '"Deferred follow-up: нет тестового аккаунта; владелец: «Отложить на фазу 9»"');
  // the heading and the expected line are kept; no second result or reason line is left behind
  const block = text.split('\n').slice(rowOf(text, 6).start, rowOf(text, 6).end);
  assert.deepEqual(block.filter((l) => /^(result|reason|expected):/.test(l)).map((l) => l.split(':')[0]), ['expected', 'result', 'reason']);
  // rows without a ruling, the earlier deferral and every other row are as they were
  for (const n of [1, 2, 3, 4, 5, 7, 10, 11]) assert.deepEqual(rowOf(text, n).fields, rowOf(before, n).fields, String(n));
  // the durable record: one Deferred Follow-Ups entry per row, and the summary counts follow the rows
  const section = text.slice(text.indexOf('## Deferred Follow-Ups'));
  for (const n of [6, 8, 9]) assert.match(section, new RegExp(`^- test: ${n}\\n {2}idea: ".+"\\n {2}deferred_at: 2026-02-03\\n {2}source: turbo-uat$`, 'm'));
  assert.match(section, /idea: "Payment with a real card — no test card; owner ruling 2026-01-02: defer to Phase 9"/);
  assert.match(text, /^skipped: 5$/m);
  assert.match(text, /^blocked: 1$/m);
  assert.match(text, /^updated: 2026-02-03T04:05:06\.000Z$/m);
});

test('deferRows is idempotent and never writes next to an entry turbo did not write', () => {
  const once = deferRows(withRuled(), { rulings: true, now: NOW }).text;
  const twice = deferRows(once, { rulings: true, now: NOW });
  assert.deepEqual([twice.deferred, twice.text], [[], once]);
  const foreign = `${withRuled()}\n## Deferred Follow-Ups\n\n- test: 6\n  idea: "the owner's own note"\n  deferred_at: 2026-01-02\n`;
  const r = deferRows(foreign, { rulings: true, now: NOW });
  assert.deepEqual(r.deferred, [6, 8, 9]);
  assert.equal(r.text.match(/^- test: 6$/gm).length, 1);
  assert.match(r.text, /idea: "the owner's own note"/);
});

test('deferRows by number: the owner confirms skipped or blocked rows; anything else is refused and nothing changes', () => {
  const before = withRuled();
  const r = deferRows(before, { tests: [7, 11, 10], now: NOW });
  assert.deepEqual([r.deferred, r.already], [[7, 11], [10]]);
  assert.equal(rowOf(r.text, 7).result, 'skipped');
  assert.equal(rowOf(r.text, 7).fields.reason, '"Deferred follow-up: the store review is still pending"');
  assert.equal(rowOf(r.text, 7).fields.blocked_by, undefined, 'a deferral is no longer blocked by anyone');
  // a row with no reason gets the owner's confirmation as its reason
  const bare = UAT.replace('## Summary', '### 6. Blocked without a word\nresult: blocked\n\n## Summary');
  assert.equal(rowOf(deferRows(bare, { tests: [6], now: NOW }).text, 6).fields.reason, '"Deferred follow-up: confirmed by the owner"');
  for (const n of [1, 5, 99]) assert.throws(() => deferRows(before, { tests: [n], now: NOW }), /only a skipped or blocked row|no test/, String(n));
  const issue = before.replace('### 5. Already answered by the owner\nexpected: x\nresult: pass', '### 5. Already answered by the owner\nexpected: x\nresult: issue');
  assert.throws(() => deferRows(issue, { tests: [5], now: NOW }), /only a skipped or blocked row/);
});

test('ownerRequest: skipped or blocked rows ask for a confirmation, never for a new test, in both languages', () => {
  const { tests } = parseUat(deferRows(withRuled(), { rulings: true, now: NOW }).text.replace(/result: \[pending\]/g, 'result: pass'));
  const ru = ownerRequest({ phase: '3', tests, lang: 'ru', file: 'f' });
  assert.deepEqual([ru.needsOwner, ru.counts.signoff, ru.confirm], [true, 2, [7, 11]]);
  assert.match(ru.reason, /^ничего не надо тестировать — подтвердите, что пункты остаются отложенными: 7, 11/);
  assert.match(ru.text, /Ничего не надо тестировать заново/);
  assert.match(ru.text, /^- 7\. Store listing shows the app — the store review is still pending$/m);
  assert.match(ru.text, /turbo-run uat defer 3 7,11/);
  assert.doesNotMatch(ru.text, /подпись/, 'nothing here needs a signature');
  const en = ownerRequest({ phase: '3', tests, lang: 'en', file: 'f' });
  assert.match(en.reason, /^nothing to test again — confirm that items 7, 11 stay deferred/);
  assert.match(en.text, /turbo-run uat defer 3 7,11/);
  assert.doesNotMatch(en.text, /signature/);
  // a pending row still asks for the owner's check or signature, next to the confirmation
  const mixed = ownerRequest({ phase: '3', tests: parseUat(withRuled()).tests, lang: 'en', file: 'f' });
  assert.deepEqual(mixed.confirm, [6, 7, 8, 9, 11]);
  assert.match(mixed.reason, /item\(s\) need your sign-off; see f; nothing to test again — confirm that items 6, 7, 8, 9, 11 stay deferred/);
});
