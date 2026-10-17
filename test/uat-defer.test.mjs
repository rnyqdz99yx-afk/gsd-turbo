import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deferRows, ownerRuling, ownerRequest, parseUat } from '../lib/uat.mjs';
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
  'reason: нет тестового аккаунта; решение владельца 2026-01-02: «Отложить на фазу 9»', '',
  '### 9. Export of a large file', 'expected: the file downloads', 'result: skipped',
  'reason: no sample data — owner ruling 2026-01-03 DEFERRED → Phase 9', '',
  '### 10. Already deferred', 'expected: x', 'result: skipped', 'reason: "Deferred follow-up: later"', '',
  '### 11. Skipped for now', 'expected: y', 'result: skipped', 'reason: not now', '',
].join('\n');
const withRuled = () => UAT.replace('## Summary', `${RULED}\n## Summary`);
const rowOf = (text, n) => parseUat(text).tests.find((t) => t.number === n);
const firstReasonLine = (t) => String(t.fields.reason ?? '').trim();

test('ownerRuling: only a dated owner ruling that defers to a numbered phase in the same clause, with no stop word anywhere and no question', () => {
  for (const s of [
    // the two dated shapes of a live run, in generic words
    'no account for the second platform; owner ruling 2026-01-08 «Отложить вторую платформу на Phase 37» (tracker → L2).',
    'no paid tester — owner ruling 2026-01-07 DEFERRED → Phase 37 L2 (tracker). The log line was seen live.',
    'owner ruling 2026-01-02: defer to Phase 9', "the owner's ruling 2026-01-02: deferred to phase 12", 'owner ruling 2026-01-02 DEFERRED -> Phase 4',
    'решение владельца 2026-01-02: отложить на фазу 9', 'решение владельца от 2026-01-02: отложить проверку на фазу 9', 'по решению владельца 2026-01-02 отложить на Phase 3',
  ]) assert.ok(ownerRuling(s), s);
  for (const s of [
    // a ruling with no date, or no deferral to a numbered phase: the owner confirms these with one command
    'no tester accounts; owner ruling 2026-01-08: first fix start/stop on every platform, the tester steps afterwards.',
    'owner ruling: defer to Phase 9', 'ruled by the owner: deferred to phase 12', 'owner decided to defer it to phase 9', 'the owner deferred it',
    "the owner's ruling: later", 'Owner decided later', 'решение владельца 2026-01-02: потом', 'по решению владельца отложено на фазу 9', 'владелец решил отложить',
    'DEFERRED → Phase 9', 'deferred to phase 12', 'Отложить на фазу 9', 'отложено владельцем', 'owner ruling 2026-01-02: the tester steps afterwards',
    // round 1
    'the store review is still pending', 'not now', 'no test account', 'the owner signs the release', 'a deferred import runs later', 'phase 9 covers it',
    "the owner's decision: not in this phase", 'решение владельца: потом нельзя', 'owner ruling: must be tested in this phase',
    'awaiting owner decision', 'needs owner decision on pricing', 'blocked: owner decision required', 'owner decision pending', 'pending owner choice',
    'ждём решения владельца', 'нужно решение владельца', 'владелец не решил', 'владелец не отложил',
    'cannot be deferred to phase 9', 'not deferred to phase 9 — must test now', 'Отложенный импорт данных не работает', 'deferred until phase-gate passes',
    'owner ruling required', 'owner ruling pending', 'требуется решение владельца 2026-01-02',
    // round 2
    'no owner ruling yet', 'without an owner ruling', 'waiting for the owner ruling', 'wait for owner ruling', 'ask for an owner ruling',
    'owner ruling expected', 'owner ruling TBD', 'until the owner ruling arrives', "isn't deferred to phase 9", "won't be deferred to phase 9",
    "shouldn't be deferred to phase 9", 'never deferred to phase 9', 'no longer deferred to phase 9', 'was deferred to phase 9, now back in scope',
    'нельзя отложить на фазу 9', 'отложить на фазу 9 нельзя', 'the owner decided not to defer it', 'owner ruling 2026-01-08: проверить сейчас, не откладывать',
    'по решению владельца — не откладывать', 'решение владельца 2026-01-02: проверить сейчас', 'owner ruling overturned — test now',
    'owner ruling (x) superseded: test in this phase', 'previous owner ruling was revoked', 'Deferred to Phase 9? ask the owner', 'owner deferred? unclear',
    'owner ruling 2026-01-08: defer to Phase 9; no, test it now',
    // round 3
    'owner ruling pending: defer to phase 9', 'awaiting owner ruling to defer to phase 9', 'owner ruling required to defer to phase 9',
    'needs owner ruling to defer to phase 9', 'ждём решение владельца: отложить на фазу 9', 'нужно решение владельца, отложить на фазу 9',
    'the owner deferred the decision; test it', 'owner deferred the ruling to next week', 'the owner decided against deferring it to phase 9',
    'owner ruling rejected the deferral to phase 9', 'owner decided to test it rather than defer', 'owner ruling rescinded: defer to phase 9 cancelled',
    'решение владельца: отложить на фазу 9 отменено', 'владелец решил: отложить на фазу 9 — отменено', 'owner decided: defer to phase 9 only if the store is down',
    'unless the owner ruling says defer to phase 9', 'owner ruling (draft): defer to phase 9', 'owner ruling maybe: defer later', 'owner ruling: test again later today',
    'no — owner ruling: defer to phase 9', 'No. Owner ruling: defer to phase 9', 'owner ruling: test in this phase, defer the rest to phase 9',
    // the same with a date: the stop words still win
    'owner ruling 2026-01-02 pending: defer to phase 9', 'owner ruling 2026-01-02: defer to phase 9 cancelled', 'решение владельца 2026-01-02: отложить на фазу 9 отменено',
    'owner ruling 2026-01-02: defer to phase 9 only if the store is down', 'owner ruling 2026-01-02 (draft): defer to phase 9', 'no — owner ruling 2026-01-02: defer to phase 9',
    'owner ruling 2026-01-02: test in this phase, defer the rest to phase 9', 'owner ruling 2026-01-02 rejected: defer to phase 9', 'owner ruling 2026-01-02 — defer to phase 9',
    'needs a fix first; owner ruling 2026-01-02: defer to phase 9',
    // final batch: withdrawn, reversed, replaced, proposed or conditional rulings, two rulings, a "no way" precondition
    'owner ruling 2026-01-02: defer to phase 9 was withdrawn', 'owner ruling 2026-01-02: defer to phase 9 (reversed 2026-01-05)',
    'owner ruling 2026-01-02: defer to phase 9 — retracted', 'owner ruling 2026-01-02: defer to phase 9 replaced by owner ruling 2026-01-05 test in phase 8',
    'owner ruling 2026-01-02: defer to phase 9; owner ruling 2026-01-05: defer to phase 10',
    'proposed owner ruling 2026-01-02: defer to phase 9', 'owner ruling 2026-01-02 would defer to phase 9',
    'решение владельца 2026-01-02: отложить на фазу 9 — отозвано', 'предлагаемое решение владельца 2026-01-02: отложить на фазу 9',
    'решение владельца 2026-01-02: отложить на фазу 9 под вопросом', 'решение владельца 2026-01-02: отложить на фазу 9, пересмотреть позже',
    'решение владельца 2026-01-02: отложить на фазу 9 — отклонено', 'owner ruling 2026-01-02 deferred the decision to phase 9',
    'no way; owner ruling 2026-01-02: defer to phase 9', 'no deferral; owner ruling 2026-01-02: defer to phase 9',
    'no ruling; owner ruling 2026-01-02: defer to phase 9', 'no decision yet; owner ruling 2026-01-02: defer to phase 9',
  ]) assert.ok(!ownerRuling(s), s);
});

test('deferRows keeps a reason that spans lines whole, in the row and in the follow-up entry, and never doubles the prefix', () => {
  const rows = [
    '### 6. Multi-line quoted', 'result: skipped', 'reason: "no test card; owner ruling 2026-01-02:', '  defer to Phase 9 with the rest"', '',
    '### 7. Multi-line plain', 'result: skipped', 'reason: owner ruling 2026-01-02: the first part', '  and the rest deferred to Phase 9', '',
    '### 8. Blocked, already worded as a deferral', 'result: blocked', 'reason: "Deferred follow-up: later"', '',
    '### 9. Block reason', 'result: blocked', 'reason: |', '  waiting for the store', '  review', '',
  ].join('\n');
  const before = UAT.replace('## Summary', `${rows}\n## Summary`);
  const r = deferRows(before, { rulings: true, now: NOW });
  assert.deepEqual(r.deferred, [6, 7]);
  assert.equal(rowOf(r.text, 6).fields.reason, '"Deferred follow-up: no test card; owner ruling 2026-01-02: defer to Phase 9 with the rest"');
  assert.equal(rowOf(r.text, 7).fields.reason, '"Deferred follow-up: owner ruling 2026-01-02: the first part and the rest deferred to Phase 9"');
  assert.ok(!/^ {2}(defer to Phase 9|and the rest deferred to Phase 9)/m.test(r.text), 'no continuation line is left behind');
  assert.match(r.text, /idea: "Multi-line plain — owner ruling 2026-01-02: the first part and the rest deferred to Phase 9"/);
  const b = deferRows(before, { tests: [8], now: NOW });
  assert.equal(rowOf(b.text, 8).fields.reason, '"Deferred follow-up: later"');
  // the owner request shows a block reason's text, never its indicator
  const req = ownerRequest({ phase: '3', tests: parseUat(before).tests, lang: 'en', file: 'f' });
  assert.match(req.text, /^- 9\. Block reason — waiting for the store review$/m);
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
  assert.equal(rowOf(text, 8).fields.reason, '"Deferred follow-up: нет тестового аккаунта; решение владельца 2026-01-02: «Отложить на фазу 9»"');
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

test('ownerRequest: skipped or blocked rows were not tested: the owner confirms the deferral or tests them with verify-work, in both languages', () => {
  const { tests } = parseUat(deferRows(withRuled(), { rulings: true, now: NOW }).text.replace(/result: \[pending\]/g, 'result: pass'));
  const ru = ownerRequest({ phase: '3', tests, lang: 'ru', file: 'f' });
  assert.deepEqual([ru.needsOwner, ru.counts.signoff, ru.confirm], [true, 2, [7, 11]]);
  assert.equal(ru.reason, 'пункты 7, 11 не проверялись; если они остаются на потом — подтверди: turbo-run uat defer 3 7,11; или проверь их через /gsd-verify-work 3');
  assert.match(ru.text, /^Эти пункты не проверялись/m);
  assert.match(ru.text, /сохрани файл UAT в git \(commit\)/);
  assert.doesNotMatch(ru.text, /подтвердите|закоммит/, 'one form of address, plain words');
  assert.match(ru.text, /^- 7\. Store listing shows the app — the store review is still pending$/m);
  assert.match(ru.text, /turbo-run uat defer 3 7,11/);
  assert.doesNotMatch(ru.text, /подпись/, 'nothing here needs a signature');
  const en = ownerRequest({ phase: '3', tests, lang: 'en', file: 'f' });
  assert.equal(en.reason, 'items 7, 11 were not tested; if they stay for later, confirm: turbo-run uat defer 3 7,11; or test them with /gsd-verify-work 3');
  assert.match(en.text, /save the UAT file in git \(commit\)/);
  assert.match(en.text, /turbo-run uat defer 3 7,11/);
  assert.doesNotMatch(en.text, /signature/);
  // a pending row still asks for the owner's check or signature, next to the confirmation
  const mixed = ownerRequest({ phase: '3', tests: parseUat(withRuled()).tests, lang: 'en', file: 'f' });
  assert.deepEqual(mixed.confirm, [6, 7, 8, 9, 11]);
  assert.match(mixed.reason, /item\(s\) need your sign-off; see f; items 6, 7, 8, 9, 11 were not tested/);
});

test('retestRows: issue rows go back to pending for the re-test after a gap round, the issue kept in one retest line (B5 A/B)', async () => {
  const { retestRows } = await import('../lib/uat.mjs');
  const ISSUES = [
    '### 12. Retry of a failed GIF', 'expected: the retry downloads again', 'result: issue', 'reported: "the retry reuses the dead URL"', 'severity: minor',
    'source: turbo-uat', 'class: A', 'head: 0123456', '',
    '### 13. Passed already', 'expected: z', 'result: pass', 'source: turbo-uat', 'class: A', '',
  ].join('\n');
  const before = UAT.replace('## Summary', `${ISSUES}\n## Summary`);
  const r = retestRows(before, { round: 2, now: NOW });
  assert.deepEqual(r.retest, [12]);
  const t = rowOf(r.text, 12);
  assert.equal(t.result, 'pending');
  assert.equal(t.fields.reported, undefined);
  assert.equal(t.fields.severity, undefined);
  assert.equal(String(t.fields.retest).replace(/^"|"$/g, ''), 'gap round 2: was an issue: the retry reuses the dead URL');
  assert.equal(rowOf(r.text, 13).result, 'pass');
  assert.equal(t.expected, 'the retry downloads again');
  // nothing to re-test: the text as it was
  assert.deepEqual(retestRows(r.text, { round: 3, now: NOW }), { text: r.text, retest: [] });
});
