import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyItem, finalClass, splitItem, uatPlan, itemText, LIVE_PART_RE } from '../lib/uat-classify.mjs';

const cls = (t, autonomy = 'standard') => classifyItem(t, { autonomy }).class;

test('classifyItem: first match wins, strictest first, English and Russian', () => {
  const table = [
    ['Owner signs the release', 'D'],
    ['Подпись владельца на акте приёмки', 'D'],
    ['Владелец подписался под актом', 'D'],
    ['Rotate the offline keys', 'D'],
    ['Login with the 2FA code from the owner phone', 'D'],
    ['A real payment of 10 USD goes through', 'D'],
    ['Оплата реальными деньгами проходит', 'D'],
    ['Реальный платёж проходит', 'D'],
    ['Withdraw 10 USD and the balance page updates', 'D'],
    ['Owner approves the release on the page', 'D'],
    ['Владелец одобряет релиз на странице', 'D'],
    ['Задеплоить на сервер и проверить, что страница открывается', 'D'],
    ['После деплоя страница открывается', 'D'],
    ['Деплоить на сервер', 'D'],
    ['Redeploy the hub and the page loads', 'D'],
    ['Message appears on the partner platform via a third-party API', 'C'],
    ['Notification arrives on a physical device', 'C'],
    ['Works in the production environment', 'C'],
    ['Отправить на прод и страница открывается', 'C'],
    ['Страница открывается на продакшене', 'C'],
    ['Данные с прода видны на странице', 'C'],
    ['Работает в продакшене', 'C'],
    ['Production build serves the settings page', 'A'],
    ['An SMS arrives with the code', 'C'],
    ['Уведомление приходит на телефон', 'C'],
    ['Письмо с кодом приходит на почту', 'C'],
    ['Admin sees the moderation queue after login', 'B'],
    ['Войти под тестовой учётной записью', 'B'],
    ['Тестовая учётная запись видит очередь модерации', 'B'],
    ['Тестовая учётка видит страницу очереди', 'B'],
    ['User signs in and sees the dashboard', 'B'],
    ['User signs into the dashboard', 'B'],
    ['User logs in and the page shows the dashboard', 'B'],
    ['After logging in the page shows the dashboard', 'B'],
    ['Page /settings shows the saved value', 'A'],
    ['GET /api/health returns 200', 'A'],
    ['Кнопка экспорта отображается', 'A'],
    // subscribing is not a signature: the noun forms and the reflexive verb with "на" stay out of D
    ['Подписка на канал отображается на странице', 'A'],
    ['Пользователь подписывается на канал и кнопка отображается', 'A'],
    // "она почти" must not read as "на почту"
    ['Она почти сразу показывает страницу', 'A'],
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

test('splitItem: a clause that matches no rule goes to the live half', () => {
  const parts = splitItem('Page shows the code and the courier delivers the parcel and an SMS arrives');
  assert.deepEqual(parts.map((p) => [p.part, p.class, p.text]), [
    ['hermetic', 'A', 'Page shows the code'],
    ['live', 'C', 'the courier delivers the parcel; an SMS arrives'],
  ]);
});

test('splitItem: owner-only and live word forms split off their observable clause', () => {
  const shape = (t) => splitItem(t).map((p) => [p.part, p.class, p.text]);
  assert.deepEqual(shape('Задеплоить на сервер и проверить, что страница открывается'), [
    ['hermetic', 'A', 'проверить, что страница открывается'],
    ['live', 'D', 'Задеплоить на сервер'],
  ]);
  assert.deepEqual(shape('Withdraw 10 USD and the balance page updates'), [
    ['hermetic', 'A', 'the balance page updates'],
    ['live', 'D', 'Withdraw 10 USD'],
  ]);
  assert.deepEqual(shape('Отправить на прод и страница открывается'), [
    ['hermetic', 'A', 'страница открывается'],
    ['live', 'C', 'Отправить на прод'],
  ]);
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

test('itemText joins name and expected the way uatPlan reads a test', () => {
  assert.equal(itemText({ name: 'Page shows the value', expected: 'value visible' }), 'Page shows the value. value visible');
  assert.equal(itemText({ name: 'Page shows the value', expected: '' }), 'Page shows the value');
});

test('split items carry the deterministic part text as expected and that part\'s class (F3)', () => {
  const t = { number: 3, name: 'Owner signs the release and the page shows the badge', expected: '', result: 'pending' };
  const items = uatPlan([t]);
  const parts = splitItem(itemText(t));
  assert.deepEqual(items.map((i) => [i.split, i.class]), [['hermetic', 'A'], ['live', 'D']]);
  for (const [n, i] of items.entries()) {
    assert.equal(i.expected, parts[n].text);
    assert.equal(classifyItem(i.expected).class, i.class);
  }
});

test('uatPlan classifies a live part appended by the recorder whole and never splits it again', () => {
  const name = 'Owner signs the release and the page shows the badge';
  const liveName = `${name} (live part, split from test 3)`;
  assert.equal(LIVE_PART_RE.exec(liveName)?.[1], '3');
  const items = uatPlan([
    { number: 3, name, expected: '', result: 'pass' },
    { number: 6, name: liveName, expected: 'Owner signs the release', result: 'pending' },
  ]);
  assert.deepEqual(items.map((i) => [i.test, i.class, i.split ?? '', i.expected]), [[6, 'D', '', 'Owner signs the release']]);
});

test('autonomy max: a deploy-plus-page item splits into a hermetic half and a live C half', () => {
  const t = { number: 4, name: 'Deploy to the server and the page shows the new version', expected: '', result: 'pending' };
  assert.deepEqual(uatPlan([t], { autonomy: 'max' }).map((i) => [i.split, i.class]), [['hermetic', 'A'], ['live', 'C']]);
  assert.deepEqual(splitItem(itemText(t), { autonomy: 'max' }).map((p) => p.text), ['the page shows the new version', 'Deploy to the server']);
  assert.deepEqual(uatPlan([t]).map((i) => [i.split, i.class]), [['hermetic', 'A'], ['live', 'D']]);
});
