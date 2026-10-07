import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyItem, finalClass, splitItem, uatPlan } from '../lib/uat-classify.mjs';

const cls = (t, autonomy = 'standard') => classifyItem(t, { autonomy }).class;

test('classifyItem: first match wins, strictest first, English and Russian', () => {
  const table = [
    ['Owner signs the release', 'D'],
    ['Подпись владельца на акте приёмки', 'D'],
    ['Rotate the offline keys', 'D'],
    ['Login with the 2FA code from the owner phone', 'D'],
    ['A real payment of 10 USD goes through', 'D'],
    ['Оплата реальными деньгами проходит', 'D'],
    ['Message appears on the partner platform via a third-party API', 'C'],
    ['Notification arrives on a physical device', 'C'],
    ['Works in the production environment', 'C'],
    ['Production build serves the settings page', 'A'],
    ['An SMS arrives with the code', 'C'],
    ['Admin sees the moderation queue after login', 'B'],
    ['Войти под тестовой учётной записью', 'B'],
    ['User signs in and sees the dashboard', 'B'],
    ['Page /settings shows the saved value', 'A'],
    ['GET /api/health returns 200', 'A'],
    ['Кнопка экспорта отображается', 'A'],
    ['Everything feels fast', null],
  ];
  for (const [text, want] of table) assert.equal(cls(text), want, text);
});

test('deploy is owner-only under standard and a production write (C) under max', () => {
  assert.equal(cls('Deploy to the server and check health'), 'D');
  assert.equal(cls('Deploy to the server and check health', 'max'), 'C');
});

test('finalClass never lowers the deterministic class', () => {
  assert.equal(finalClass('D', 'A'), 'D');
  assert.equal(finalClass('C', 'B'), 'C');
  assert.equal(finalClass('A', 'B'), 'B');
  assert.equal(finalClass('B', 'A'), 'B');
  assert.equal(finalClass(null, 'A'), 'A');
  assert.equal(finalClass(null, 'Z'), 'C');
  assert.equal(finalClass(null, undefined), 'C');
});

test('splitItem: hermetic and live halves become two items', () => {
  const parts = splitItem('Settings page shows the saved value and an SMS arrives on the phone');
  assert.deepEqual(parts.map((p) => [p.part, p.class]), [['hermetic', 'A'], ['live', 'C']]);
  assert.match(parts[1].text, /SMS/);
  assert.equal(splitItem('An SMS arrives on the phone').length, 1);
  assert.equal(splitItem('Page shows the value').length, 1);
});

test('uatPlan covers pending tests only and splits mixed ones', () => {
  const tests = [
    { number: 1, name: 'Page shows the value', expected: 'value visible', result: 'pending' },
    { number: 2, name: 'Already passed', expected: 'x', result: 'pass' },
    { number: 3, name: 'Page shows the code and an SMS arrives on the phone', expected: '', result: 'pending' },
  ];
  const items = uatPlan(tests);
  assert.deepEqual(items.map((i) => [i.test, i.class, i.split ?? '']), [[1, 'A', ''], [3, 'A', 'hermetic'], [3, 'C', 'live']]);
});
