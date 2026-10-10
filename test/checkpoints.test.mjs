import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_PLAN, DECISION_PLAN, VERIFY_PLAN } from './helpers/plans.mjs';
import { CHECKPOINT_KINDS, parseCheckpoints, quotedSignal } from '../lib/checkpoints.mjs';

// three backticks, built so this file holds no fence of its own
const FENCE = '`'.repeat(3);

test('a decision checkpoint: its position among the tasks, the gate, the plan\'s auto_select and its options', () => {
  const list = parseCheckpoints(DECISION_PLAN);
  assert.equal(list.length, 1);
  const [cp] = list;
  assert.deepEqual([cp.task, cp.kind, cp.gate, cp.autoSelect], [2, 'decision', 'blocking', 'clerk']);
  assert.equal(cp.decision, 'Select the authentication provider');
  assert.equal(cp.context, 'The app needs sign-in. Two options with different trade-offs.');
  assert.deepEqual(cp.options, [
    { id: 'supabase', name: 'Supabase Auth', pros: 'Built into the database we use', cons: 'Less customizable UI' },
    { id: 'clerk', name: 'Clerk', pros: 'Pre-built UI & good docs', cons: 'Paid after 10k users' },
  ]);
  assert.equal(cp.resumeSignal, 'Select: supabase or clerk');
  assert.deepEqual([cp.whatBuilt, cp.howToVerify, cp.action], ['', '', '']);
});

test('human-verify and human-action checkpoints keep their own fields; gate blocking-human is kept', () => {
  const [v] = parseCheckpoints(VERIFY_PLAN);
  assert.deepEqual([v.task, v.kind, v.gate, v.autoSelect, v.options], [3, 'human-verify', 'blocking', null, []]);
  assert.equal(v.whatBuilt, 'Dashboard layout - dev server running at http://localhost:3000');
  assert.equal(v.howToVerify, 'Visit http://localhost:3000/dashboard and check: 1. Sidebar left 2. No horizontal scroll');
  assert.equal(v.resumeSignal, 'Type "approved" or describe layout issues');
  const [a] = parseCheckpoints(ACTION_PLAN);
  assert.deepEqual([a.task, a.kind, a.gate], [2, 'human-action', 'blocking-human']);
  assert.equal(a.action, 'Complete the email verification for the mail service account');
  assert.equal(a.instructions, 'I created the account and asked for the verification mail. Click the link in it.');
  assert.equal(a.verification, 'The mail API key works: the test send succeeds');
  assert.equal(a.resumeSignal, 'Type "done" when verified');
});

test('auto tasks, other checkpoint types and examples inside code fences are no questions; CRLF plans parse the same', () => {
  assert.deepEqual(CHECKPOINT_KINDS, ['decision', 'human-verify', 'human-action']);
  // an example task quoted inside task 1's action would otherwise end task 1 at its </task>
  const fenced = ACTION_PLAN.replace('<action>Send the welcome mail</action>',
    `<action>Send the welcome mail like this:\n${FENCE}xml\n<task type="checkpoint:decision"><decision>not real</decision></task>\n${FENCE}\n</action>`);
  assert.deepEqual(parseCheckpoints(fenced).map((c) => [c.task, c.kind]), [[2, 'human-action']]);
  assert.deepEqual(parseCheckpoints('<tasks>\n<task type="checkpoint:tdd-review" gate="advisory"><what-checked>x</what-checked></task>\n</tasks>'), []);
  assert.deepEqual(parseCheckpoints(VERIFY_PLAN.replace(/\n/g, '\r\n')), parseCheckpoints(VERIFY_PLAN));
  assert.deepEqual(parseCheckpoints('no tasks here'), []);
});

test('quotedSignal reads the word a resume signal asks for, else the fallback', () => {
  assert.equal(quotedSignal('Type "approved" or describe issues', 'x'), 'approved');
  assert.equal(quotedSignal('Type “done” when verified', 'x'), 'done');
  assert.equal(quotedSignal('Select: a or b', 'approved'), 'approved');
  assert.equal(quotedSignal(undefined, 'done'), 'done');
});

test('attributes in single quotes count as well', () => {
  const single = DECISION_PLAN.replace('<task type="checkpoint:decision" gate="blocking" auto_select="clerk">', "<task type='checkpoint:decision' gate='blocking-human' auto_select='clerk'>");
  assert.deepEqual(parseCheckpoints(single).map((c) => [c.task, c.kind, c.gate, c.autoSelect]), [[2, 'decision', 'blocking-human', 'clerk']]);
  assert.equal(parseCheckpoints(single.replace('<option id="clerk">', "<option id='clerk'>"))[0].options[1].id, 'clerk');
});

test('a fence closes only with a bare fence of its own character, at least as long: a line with an info string inside it is content (CommonMark)', () => {
  const info = VERIFY_PLAN.replace('<action>Sidebar, header and content area.</action>', `<action>Sidebar:\n${FENCE}\n${FENCE}js\nx\n${FENCE}\n</action>`);
  assert.deepEqual(parseCheckpoints(info).map((c) => [c.task, c.kind]), [[3, 'human-verify']]);
  const long = VERIFY_PLAN.replace('<action>Sidebar, header and content area.</action>', `<action>Example:\n${FENCE}\`\n${FENCE}\n~~~\n<task type="checkpoint:decision"><decision>not real</decision></task>\n${FENCE}\`\n</action>`);
  assert.deepEqual(parseCheckpoints(long).map((c) => [c.task, c.kind]), [[3, 'human-verify']]);
  // the plan's closing tag on the fence's closing line still closes it
  const tilde = DECISION_PLAN.replace('<action>Create the sessions table.</action>', '<action>Create:\n~~~sql\ncreate table s();\n~~~</action>');
  assert.deepEqual(parseCheckpoints(tilde).map((c) => [c.task, c.kind]), [[2, 'decision']]);
});
