import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyItem, finalClass, splitItem, uatPlan, itemText, LIVE_PART_RE } from '../lib/uat-classify.mjs';

const cls = (t, autonomy = 'standard') => classifyItem(t, { autonomy }).class;

test('classifyItem: first match wins, strictest first, English and Russian', () => {
  const table = [
    ['Owner signs the release', 'D'],
    ['Подпись владельца на акте приёмки', 'D'],
    ['Владелец подписался под актом', 'D'],
    ['Владелец подписывается на последней странице акта', 'D'],
    ['Владелец подписался на странице акта', 'D'],
    ['Владелец подписывается на экране', 'D'],
    ['Владелец подпишет акт на странице', 'D'],
    ['Подпишите акт на странице', 'D'],
    // the reflexive verb cannot tell signing from subscribing; a false D costs the owner one checklist line
    ['Пользователь подписывается на канал и кнопка отображается', 'D'],
    ['Rotate the offline keys', 'D'],
    ['Login with the 2FA code from the owner phone', 'D'],
    ['A real payment of 10 USD goes through', 'D'],
    ['Оплата реальными деньгами проходит', 'D'],
    ['Реальный платёж проходит', 'D'],
    ['Withdraw 10 USD and the balance page updates', 'D'],
    ['Вывести средства и страница баланса обновляется', 'D'],
    ['После вывода средств страница баланса обновляется', 'D'],
    ['Owner approves the release on the page', 'D'],
    ['The owner must approve the release on the page', 'D'],
    ['Owner has approved the release and the page shows it', 'D'],
    ['Release approved by the product owner shows on the page', 'D'],
    ['Владелец одобряет релиз на странице', 'D'],
    ['Владелец должен одобрить релиз на странице', 'D'],
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
    ['Лог из прода показывает ошибку', 'C'],
    ['Страница на продовом сервере открывается', 'C'],
    ['Прод-сервер отдаёт страницу', 'C'],
    ['Production build serves the settings page', 'A'],
    ['Продукт отображается на странице', 'A'],
    ['Продовольственный раздел отображается на странице', 'A'],
    ['An SMS arrives with the code', 'C'],
    ['A code is sent to the phone and the page shows a field', 'C'],
    ['Уведомление приходит на телефон', 'C'],
    ['Письмо с кодом приходит на почту', 'C'],
    ['Ссылка приходит на электронную почту', 'C'],
    ['Код приходит на email', 'C'],
    ['Admin sees the moderation queue after login', 'B'],
    ['Войти под тестовой учётной записью', 'B'],
    ['Тестовая учётная запись видит очередь модерации', 'B'],
    ['Тестовая учётка видит страницу очереди', 'B'],
    ['User signs in and sees the dashboard', 'B'],
    ['User signs into the dashboard', 'B'],
    ['User logs in and the page shows the dashboard', 'B'],
    ['After logging in the page shows the dashboard', 'B'],
    ['Logs indicate the page loaded', 'A'],
    ['Page /settings shows the saved value', 'A'],
    ['GET /api/health returns 200', 'A'],
    ['Кнопка экспорта отображается', 'A'],
    // the subscription nouns are not signatures
    ['Подписка на канал отображается на странице', 'A'],
    ['Подписчик видит страницу', 'A'],
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

test('finalClass lets a proposal raise a C floor to D, and still never lowers D', () => {
  assert.equal(finalClass('C', 'D'), 'D');
  assert.equal(finalClass('D', 'C'), 'D');
  assert.equal(finalClass('C', 'C'), 'C');
  assert.equal(finalClass('C', undefined), 'C');
  assert.equal(finalClass('D', 'Z'), 'D');
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

test('splitItem never lowers the live part below the whole item\'s class', () => {
  const shape = (t, autonomy) => splitItem(t, { autonomy }).map((p) => [p.part ?? 'whole', p.class]);
  // the owner-decision match spans a clause separator, so no single clause carries the D
  for (const t of [
    'The owner reviews and approves the release on the page and an SMS arrives',
    'Owner then approves the release on the page and a push notification arrives',
    'Владелец затем одобряет релиз на странице и смс приходит',
  ]) assert.deepEqual(shape(t), [['whole', 'D']], t);
  assert.deepEqual(
    uatPlan([{ number: 1, name: 'Release approval', expected: 'The owner reviews and approves the release on the page and an SMS arrives', result: 'pending' }])
      .map((i) => [i.test, i.class, i.split ?? '']),
    [[1, 'D', '']],
  );
  assert.deepEqual(shape('Owner signs the release and the page shows the badge'), [['hermetic', 'A'], ['live', 'D']]);
  assert.deepEqual(shape('Deploy the hub and the page loads'), [['hermetic', 'A'], ['live', 'D']]);
  assert.deepEqual(shape('Deploy the hub and the page loads', 'max'), [['hermetic', 'A'], ['live', 'C']]);
});

test('splitItem: the live part keeps every live rule the whole item matched', () => {
  const shape = (t, autonomy) => splitItem(t, { autonomy }).map((p) => [p.part ?? 'whole', p.class]);
  // the owner-decision match spans a clause separator, and the live part reaches D only through another rule
  for (const t of [
    'The owner reviews and approves the release on the page and signs the contract',
    'The owner reviews and approves the release on the page and then deploys it',
    'Владелец затем одобряет релиз на странице и подписывает акт',
    'Release approved by admin and owner shows on the page and the hub is redeployed',
    // the same rule also matches inside a live clause on its own; the cross-clause match still keeps the item whole
    'The owner reviews and approves the release on the page and the owner\'s decision is final',
    'The owner\'s decision is final and the owner reviews and approves the release on the page',
  ]) assert.deepEqual(shape(t), [['whole', 'D']], t);
  assert.deepEqual(shape('The owner reviews and approves the release on the page and then deploys it', 'max'), [['whole', 'D']]);
  assert.deepEqual(
    uatPlan([{ number: 1, name: 'Release approval', expected: 'The owner reviews and approves the release on the page and signs the contract', result: 'pending' }])
      .map((i) => [i.test, i.class, i.split ?? '']),
    [[1, 'D', '']],
  );
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
