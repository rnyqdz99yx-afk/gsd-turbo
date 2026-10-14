import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_PLAN, DECISION_PLAN, ORCHESTRATED_PLAN, OWNER_ACTION_PLAN, OWNER_CONTEXT_PLAN, OWNER_DECISION_PLAN, OWNER_VERIFY_PLAN, SITTING_PLAN, VERIFY_PLAN } from './helpers/plans.mjs';
import { CHECKPOINT_KINDS, parseCheckpoints, quotedSignal, sittingCheckpoint } from '../lib/checkpoints.mjs';

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

test('the plan tag on a fence\'s closing line stays: the field the fence ends keeps its text and its command, and never runs into the next one', () => {
  const a = ACTION_PLAN.replace('<action>Complete the email verification for the mail service account</action>', `<action>Complete the email verification:\n${FENCE}bash\nmail-cli verify\n${FENCE}</action>`);
  assert.equal(parseCheckpoints(a)[0].action, 'Complete the email verification: `mail-cli verify`');
  const v = VERIFY_PLAN.replace('<how-to-verify>', `<how-to-verify>\n${FENCE}bash\ncurl localhost:3000\n${FENCE}</how-to-verify>\n<x>`);
  assert.equal(parseCheckpoints(v)[0].howToVerify, '`curl localhost:3000`');
});

test('a command in a fenced block of a field stays in the question, as inline code (spec §5.1: the owner runs or checks it); CRLF plans read the same', () => {
  const action = ACTION_PLAN.replace(/<instructions>[\s\S]*?<\/instructions>/, `<instructions>\n    Log in to the mail CLI in your terminal:\n    ${FENCE}bash\n    mail-cli login --account welcome\n    ${FENCE}\n    Then click the link in the verification mail.\n  </instructions>`);
  assert.equal(parseCheckpoints(action)[0].instructions, 'Log in to the mail CLI in your terminal: `mail-cli login --account welcome` Then click the link in the verification mail.');
  const verify = VERIFY_PLAN.replace(/<how-to-verify>[\s\S]*?<\/how-to-verify>/, `<how-to-verify>\n    1. Start it:\n    ${FENCE}bash\n    npm install\n    npm run dev -- --port 3000\n    ${FENCE}\n    2. Visit http://localhost:3000/dashboard: sidebar left, no horizontal scroll.\n  </how-to-verify>`);
  const [v] = parseCheckpoints(verify);
  assert.equal(v.howToVerify, '1. Start it: `npm install; npm run dev -- --port 3000` 2. Visit http://localhost:3000/dashboard: sidebar left, no horizontal scroll.');
  assert.deepEqual(parseCheckpoints(verify.replace(/\n/g, '\r\n')), parseCheckpoints(verify));
  assert.deepEqual(parseCheckpoints(action.replace(/\n/g, '\r\n')), parseCheckpoints(action));
});

test('a line that starts with inline code in three backticks is no fence: a backtick fence\'s info string never holds a backtick', () => {
  const plan = VERIFY_PLAN.replace('Sidebar, header and content area.', `Sidebar, header and content area.\n${FENCE}npm run build${FENCE} must pass.`);
  assert.deepEqual(parseCheckpoints(plan).map((c) => [c.task, c.kind]), [[3, 'human-verify']]);
});

test('a tag named in inline code is no element: the field is the real one, never a cut across the action (owner cards)', () => {
  const [v] = parseCheckpoints(OWNER_VERIFY_PLAN);
  assert.match(v.whatBuilt, /^\*\*Что получилось:\*\* проверил пакет библиотеки картинок/);
  assert.ok(!v.whatBuilt.includes('</action>') && !v.whatBuilt.includes('summary to the owner'));
  assert.match(v.action, /Present the `<what-built>` summary to the owner/, 'the action keeps its inline code');
  const [a] = parseCheckpoints(OWNER_ACTION_PLAN);
  assert.match(a.instructions, /^\*\*Что получилось:\*\* пробная сборка готова/);
  assert.ok(!a.instructions.includes('</action>'));
  assert.equal(parseCheckpoints('<tasks>\n<task type="checkpoint:human-verify">\n<action>Show `<what-built>` then ``<how-to-verify>``.</action>\n</task>\n</tasks>')[0].whatBuilt, '');
  // an unpaired backtick before a field's end tag hides no tag (review 1)
  const [u] = parseCheckpoints('<tasks>\n<task type="checkpoint:human-verify"><what-built>Готово, ключ `K</what-built><how-to-verify>Открой `страницу` галереи</how-to-verify></task>\n</tasks>');
  assert.deepEqual([u.whatBuilt, u.howToVerify], ['Готово, ключ `K', 'Открой `страницу` галереи']);
});

test('the task name (never an option\'s name) and the fields\' raw lines for the owner cards; CRLF reads the same', () => {
  const [d] = parseCheckpoints(OWNER_DECISION_PLAN);
  assert.equal(d.name, 'Task 2: Владелец выбирает, где хранить превью картинок');
  assert.equal(parseCheckpoints(DECISION_PLAN)[0].name, '', 'a checkpoint without <name>: none, not the first option\'s');
  const [c] = parseCheckpoints(OWNER_CONTEXT_PLAN);
  assert.match(c.raw.context, /^\s*Executor preparation, before presenting; no file changes:\n\s+- Run verify 1/);
  assert.deepEqual(parseCheckpoints(OWNER_CONTEXT_PLAN.replace(/\n/g, '\r\n')), parseCheckpoints(OWNER_CONTEXT_PLAN));
});

test('a live sitting: a human-action with <instructions> and a go/stop resume signal, or one that names the sitting or the orchestrator (journal 2026-10-14)', () => {
  const [sit] = parseCheckpoints(SITTING_PLAN);
  assert.deepEqual([sit.task, sit.kind, sittingCheckpoint(sit)], [2, 'human-action', true]);
  const [orch] = parseCheckpoints(ORCHESTRATED_PLAN);
  assert.equal(sittingCheckpoint(orch), true, 'the action names the orchestrator and the sitting');
  // the owner's own steps are no sitting
  for (const plan of [ACTION_PLAN, OWNER_ACTION_PLAN, DECISION_PLAN, VERIFY_PLAN, OWNER_VERIFY_PLAN, OWNER_DECISION_PLAN, OWNER_CONTEXT_PLAN]) {
    for (const cp of parseCheckpoints(plan)) assert.equal(sittingCheckpoint(cp), false, `${cp.kind} ${cp.name || cp.action}`);
  }
  assert.equal(sittingCheckpoint({ ...sit, instructions: '' }), false, 'no <instructions>: a plain action');
  assert.equal(sittingCheckpoint({ ...sit, resumeSignal: 'Type "go" when it is plugged in' }), false, 'go alone is a plain go-ahead');
  assert.equal(sittingCheckpoint({ ...sit, resumeSignal: 'Ответь «старт» или «стоп»' }), true, 'in Russian');
  assert.equal(sittingCheckpoint({ ...sit, resumeSignal: 'Type "gopher" or "stopwatch"' }), false, 'whole words only');
  assert.equal(sittingCheckpoint({ ...sit, kind: 'decision' }), false, 'a decision is no sitting');
  assert.equal(sittingCheckpoint({ ...parseCheckpoints(ACTION_PLAN)[0], action: 'Оркестратор проводит проверку вместе с владельцем' }), true);
  assert.equal(sittingCheckpoint(null), false);
});
