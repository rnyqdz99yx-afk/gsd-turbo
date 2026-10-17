import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROLES, fillTemplate, rolePrompt } from '../lib/roles.mjs';
import { slicePhase, compactPlan, writePlan, DEMO_INFO } from './helpers/slices.mjs';

const BLOCK = [
  '## OWNER QUESTION',
  'Question: <one line>',
  'Context: <up to 600 characters>',
  'Options:',
  '1. <label> — <description> (recommended)',
  '2. <label> — <description>',
].join('\n');
const PRE = 'x'.repeat(600);
const SLUG = 'telegram-notifications-and-owner-cards';
const BUILDER_FILES = ['lib/notify-telegram.mjs', 'lib/owner-cards.mjs', 'test/notify-telegram.test.mjs', 'test/owner-cards.test.mjs', 'docs/reference.md'];

const phaseDir = (root, slug = SLUG) => path.join(root, '.planning', 'phases', `05-${slug}`);

function builderCtx({ plan = {}, ...over } = {}) {
  const root = slicePhase({ slug: SLUG });
  const planPath = writePlan(root, '05-02', compactPlan({ id: '05-02', files: BUILDER_FILES, ...plan }), SLUG);
  return { root, phase: '5', planPath, contextPath: path.join(phaseDir(root), '05-CONTEXT.md'), lang: 'ru', preanswers: PRE, ...over };
}

const long = (head, n) => `${head} ${'y'.repeat(n)}`.slice(0, n);
const INFO6 = {
  ...DEMO_INFO,
  goal: 'Owner questions from headless sessions reach the owner and come back to the same session',
  requirements: Array.from({ length: 6 }, (_, i) => ({ id: `NOTIF-0${i + 1}`, text: long(`requirement ${i + 1}`, 100) })),
  successCriteria: Array.from({ length: 5 }, (_, i) => long(`criterion ${i + 1}`, 110)),
};
const NO_SIGNALS = { research: { yes: false, why: '' }, security: { yes: false, why: '' } };

function slicerCtx(over = {}) {
  const root = slicePhase({ slug: SLUG });
  const researchPath = path.join(phaseDir(root), '05-RESEARCH.md');
  fs.writeFileSync(researchPath, '# Research\n');
  return {
    root,
    phase: '5',
    contextPath: path.join(phaseDir(root), '05-CONTEXT.md'),
    researchPath,
    info: INFO6,
    signals: { research: { yes: true, why: 'external API: "Telegram Bot API" in the goal' }, security: { yes: false, why: '' } },
    lang: 'ru',
    preanswers: PRE,
    ...over,
  };
}

function fixerCtx(over = {}) {
  const root = slicePhase({ slug: SLUG });
  return {
    root,
    phase: '5',
    contextPath: path.join(phaseDir(root), '05-CONTEXT.md'),
    findingsPath: path.join(phaseDir(root), '05-REVIEW.md'),
    diffRange: '1a2b3c4d5e6f..9f8e7d6c5b4a',
    lang: 'ru',
    preanswers: PRE,
    ...over,
  };
}

// role -> a ctx builder; every role prompt carries the OWNER QUESTION block
const CASES = {
  builder: (over) => builderCtx(over),
  slicer: (over) => slicerCtx(over),
  fixer: (over) => fixerCtx(over),
};

test('ROLES names the three build-path roles', () => {
  assert.deepEqual([...ROLES], ['slicer', 'builder', 'fixer']);
  assert.ok(Object.isFrozen(ROLES));
});

test('builder prompt: its slice, its files, its SUMMARY, relative paths, within 6144 bytes', () => {
  const p = rolePrompt('builder', builderCtx());
  assert.ok(Buffer.byteLength(p) <= 6144, `${Buffer.byteLength(p)} bytes`);
  for (const s of [
    `.planning/phases/05-${SLUG}/05-02-PLAN.md`,
    `.planning/phases/05-${SLUG}/05-02-SUMMARY.md`,
    'You may create, change or delete only: lib/notify-telegram.mjs, lib/owner-cards.mjs, test/notify-telegram.test.mjs, test/owner-cards.test.mjs, docs/reference.md;',
    '`<type>(05-02): <what>`',
    `phase: 05-${SLUG}`,
    'plan: 02',
    '## Owner answers given ahead',
    PRE,
    'Write it for the owner in Russian',
  ]) assert.ok(p.includes(s), s);
  assert.ok(!p.includes('\\'), 'no backslash');
  assert.ok(!p.includes('{{'), 'no unfilled placeholder');
});

test('builder prompt carries the rules the spec fixes', () => {
  const p = rolePrompt('builder', builderCtx());
  for (const re of [
    /Behaviour is test first/,
    /never git add -A or git add \./,
    /Never run the whole test suite/,
    /nothing else under \.planning\//,
    /status: blocked/,
    /## Self-Check: PASSED/,
    /## Self-Check: FAILED/,
    /Commit the SUMMARY alone: `docs\(05-02\): complete <slice name> plan`/,
  ]) assert.match(p, re);
  assert.match(p, /Before you ask, commit the work that is done\./);
  const d = rolePrompt('builder', builderCtx({ plan: { files: ['src/new.js'], deleted: ['old.js'] } }));
  assert.ok(d.includes('You may create, change or delete only: src/new.js, old.js (delete);'), d);
});

test('slicer prompt: the phase, the plan files to write, within 8192 bytes', () => {
  const p = rolePrompt('slicer', slicerCtx());
  assert.ok(Buffer.byteLength(p) <= 8192, `${Buffer.byteLength(p)} bytes`);
  for (const s of [
    'Goal: Owner questions from',
    `1. ${INFO6.successCriteria[0]}`,
    `5. ${INFO6.successCriteria[4]}`,
    ...INFO6.requirements.map((r) => `- ${r.id}: ${r.text}`),
    `- .planning/phases/05-${SLUG}/05-RESEARCH.md: the research; every pitfall it names becomes a task or a spike in some slice.`,
    `Write .planning/phases/05-${SLUG}/05-NN-PLAN.md, NN two digits from 01 up:`,
    `phase: 05-${SLUG}`,
    '## Signals',
    'Research signal: external API: "Telegram Bot API" in the goal. Every assumption about an external system that the research or the code does not prove is a spike slice first.',
  ]) assert.ok(p.includes(s), s);
  for (const s of ['Security:', '## Open questions', '## Gap round', '{{', '\\']) assert.ok(!p.includes(s), s);
});

test('slicer prompt: open questions without research, the security signal, a gap round after the existing plans', () => {
  const info = { ...INFO6, needsResearchItems: ['Does the API rate-limit per chat?'] };
  const open = rolePrompt('slicer', slicerCtx({ info, researchPath: undefined }));
  assert.ok(open.includes('## Open questions\nThe discussion left these unchecked; each becomes a spike slice unless the code answers it:\n- Does the API rate-limit per chat?\n'), open);
  assert.ok(!open.includes('the research; every pitfall'));
  assert.ok(!rolePrompt('slicer', slicerCtx({ info })).includes('## Open questions'), 'research answers them');

  const sec = rolePrompt('slicer', slicerCtx({ signals: { research: { yes: false, why: '' }, security: { yes: true, why: 'it changes files under auth/' } } }));
  assert.ok(sec.includes('## Signals\nSecurity: it changes files under auth/. Keep auth, private data and data routing between users in slices of their own, each protection with a must_haves truth and a test.\n'), sec);
  assert.ok(!sec.includes('Research signal:'));
  assert.ok(!rolePrompt('slicer', slicerCtx({ signals: NO_SIGNALS })).includes('## Signals'));

  const ctx = slicerCtx({ findingsPath: undefined });
  for (const id of ['05-01', '05-02']) writePlan(ctx.root, id, compactPlan({ id }), SLUG);
  const gap = rolePrompt('slicer', { ...ctx, findingsPath: path.join(phaseDir(ctx.root), '05-VERIFICATION.md') });
  assert.ok(gap.includes(`## Gap round\n.planning/phases/05-${SLUG}/05-VERIFICATION.md is the verification report; its gaps are why you run again.`), gap);
  assert.ok(gap.includes('gap_closure: true, numbered from 03'));
  assert.ok(gap.includes(`Write .planning/phases/05-${SLUG}/05-NN-PLAN.md, NN two digits from 03 up:`));

  const none = rolePrompt('slicer', slicerCtx({ info: { ...INFO6, requirements: [], successCriteria: [], goal: '' } }));
  assert.ok(none.includes('Requirements (each id goes into the requirements of at least one slice):\n- none mapped to this phase\n'), none);
  assert.ok(none.includes('Success criteria:\n- none listed\n'));
  assert.ok(none.includes('Goal: (none in ROADMAP)\n'));
  assert.ok(rolePrompt('slicer', slicerCtx({ info: { ...INFO6, requirements: [{ id: 'X-01', text: '' }] } })).includes('\n- X-01\n'));
});

// L1's answers (lib/phase-signals.mjs): the discussion log's topics (each up to 300 characters), words, RESEARCH.md
const TOPICS = Array.from({ length: 4 }, (_, i) => long(`Does the API limit ${i + 1}?`, 300));
const L1_TOPICS = { yes: true, why: `the discussion log lists 4 research topics: ${TOPICS.join('; ')}` };
const L1_SECURITY = { yes: true, why: `auth: "login" in the goal ${'z'.repeat(400)}` };

test('slicer prompt: signals in L1\'s words are not repeated, and stay short', () => {
  const info = { ...INFO6, needsResearchItems: TOPICS };
  const open = rolePrompt('slicer', slicerCtx({ info, researchPath: undefined, signals: { research: L1_TOPICS, security: { yes: false, why: '' } } }));
  assert.ok(open.includes(`- ${TOPICS[0].slice(0, 159)}…\n`), 'the topics are open questions, in short');
  const logged = slicerCtx({ info: { ...info, needsResearchItems: [...TOPICS, 'a', 'b', 'c'] }, researchPath: undefined });
  fs.writeFileSync(path.join(phaseDir(logged.root), '05-DISCUSSION-LOG.md'), '# log\n');
  const all = rolePrompt('slicer', logged);
  assert.ok(all.includes(`The discussion left these unchecked (in full in .planning/phases/05-${SLUG}/05-DISCUSSION-LOG.md); each becomes`), all);
  assert.ok(all.includes('\n- a\n- and 2 more\n'), 'at most five topics');
  assert.ok(!open.includes('Research signal:'), 'the topics are not repeated as a signal');
  assert.ok(!open.includes('## Signals'));
  const researched = rolePrompt('slicer', slicerCtx({ info, signals: { research: L1_TOPICS, security: { yes: false, why: '' } } }));
  assert.ok(!researched.includes('## Open questions') && !researched.includes('Research signal:'), 'RESEARCH.md answers the topics');
  const exists = rolePrompt('slicer', slicerCtx({ signals: { research: { yes: true, why: 'RESEARCH.md already exists' }, security: { yes: false, why: '' } } }));
  assert.ok(!exists.includes('## Signals'), 'RESEARCH.md is already in the Read list');
  const sec = rolePrompt('slicer', slicerCtx({ signals: { research: { yes: false, why: '' }, security: L1_SECURITY } }));
  const line = sec.split('\n').find((l) => l.startsWith('Security: '));
  assert.ok(line.startsWith('Security: auth: "login" in the goal z') && line.includes('…. Keep auth, private data'), line);
  assert.ok(line.length < 200 + 'Security: '.length + 160, `${line.length} characters`);
});

test('slicer prompt: the worst case stays within 8192 bytes', () => {
  const ctx = slicerCtx({
    info: { ...INFO6, needsResearchItems: TOPICS },
    researchPath: undefined,
    signals: { research: { yes: true, why: `external API: "${'Q'.repeat(300)} API" in the goal` }, security: L1_SECURITY },
  });
  for (const id of ['05-01', '05-02']) writePlan(ctx.root, id, compactPlan({ id }), SLUG);
  const p = rolePrompt('slicer', { ...ctx, info: { ...ctx.info, needsResearchItems: [] }, findingsPath: path.join(phaseDir(ctx.root), '05-VERIFICATION.md') });
  const q = rolePrompt('slicer', { ...ctx, findingsPath: path.join(phaseDir(ctx.root), '05-VERIFICATION.md') });
  for (const x of [p, q]) {
    assert.ok(x.includes('## Gap round') && x.includes('Security: ') && x.includes('## Owner answers given ahead'));
    assert.ok(Buffer.byteLength(x) <= 8192, `${Buffer.byteLength(x)} bytes`);
  }
  assert.ok(p.includes('Research signal: ') && q.includes('## Open questions'));
});

test('slicer prompt carries the slicing rules the spec fixes', () => {
  const p = rolePrompt('slicer', slicerCtx());
  for (const re of [
    /at most 5 tasks, its plan at most 8 KB/,
    /spike: true, wave 1, no depends_on/,
    /Cite the decisions a slice implements \(D-NN/,
    /never the whole test suite/,
    /do not commit/,
    /no globs, no directories, nothing GSD or turbo keeps \(the top of \.planning\/, its turbo\/, this phase's directory\)/,
  ]) assert.match(p, re);
  assert.match(p, /Before you ask, write the plan files that are done; do not commit them\./);
  assert.ok(!p.includes('commit the work that is done'), 'the slicer is never told to commit');
  const bare = rolePrompt('slicer', slicerCtx({ researchPath: undefined }));
  assert.ok(bare.includes('code insights.\n- The code the phase touches'), 'no gap in the Read list without research');
});

test('fixer prompt: review findings, the diff in question, within 6144 bytes', () => {
  const p = rolePrompt('fixer', fixerCtx());
  assert.ok(Buffer.byteLength(p) <= 6144, `${Buffer.byteLength(p)} bytes`);
  for (const s of [
    `.planning/phases/05-${SLUG}/05-REVIEW.md is a GSD code review. Fix every Critical (CR-, BL-) and Warning (WR-) finding in it; leave Info (IN-) findings alone.`,
    'The changes in question: git diff 1a2b3c4d5e6f..9f8e7d6c5b4a. Leave code outside them alone unless a fix needs it.',
    '`fix(05): <finding id> <what>`',
    `Read .planning/phases/05-${SLUG}/05-CONTEXT.md only for the decisions a fix touches.`,
    'Before you ask, commit the work that is done.',
  ]) assert.ok(p.includes(s), s);
  for (const s of ['{{', '\\']) assert.ok(!p.includes(s), s);
});

test('fixer prompt: a security audit, failing tests, named findings', () => {
  const sec = rolePrompt('fixer', fixerCtx({ findingsPath: '.planning/phases/05-x/05-SECURITY.md' }));
  assert.ok(sec.includes('.planning/phases/05-x/05-SECURITY.md is a GSD security audit. Fix every threat in its Threat Register whose Status is open, Severity critical or high, and Disposition mitigate.'), sec);
  const tests = rolePrompt('fixer', fixerCtx({ findingsPath: '.planning/turbo/run/build-tests-05.log' }));
  assert.ok(tests.includes('.planning/turbo/run/build-tests-05.log is the output of tests that failed after a merge. Make them pass by fixing the code; change a test only when it is plainly wrong about the behaviour the decisions or the plan set, and say so in your last message.'), tests);
  const named = rolePrompt('fixer', fixerCtx({ findingIds: ['CR-03', 'WR-01'], diffRange: undefined }));
  assert.ok(named.includes(`.planning/phases/05-${SLUG}/05-REVIEW.md is a GSD code review. Fix exactly these: CR-03, WR-01; leave everything else in it alone.`), named);
  assert.ok(!named.includes('git diff'));
  assert.ok(!named.includes('Fix every Critical'));
});

test('fixer prompt never closes a critical or high finding by documentation', () => {
  const p = rolePrompt('fixer', fixerCtx());
  for (const re of [
    /never by editing the report, a comment or a document, or by calling it accepted/,
    /No refactors, renames, reformatting, cleanups or new features/,
    /Change nothing under \.planning\//,
  ]) assert.match(p, re);
  assert.throws(() => rolePrompt('fixer', fixerCtx({ findingsPath: undefined })), /fixer: findingsPath is required/);
});

test('every role prompt carries the OWNER QUESTION block exactly', () => {
  for (const [role, ctx] of Object.entries(CASES)) {
    const p = rolePrompt(role, ctx());
    assert.ok(p.includes(BLOCK), role);
    const bare = rolePrompt(role, ctx({ preanswers: undefined }));
    assert.ok(bare.includes(BLOCK), role);
    assert.ok(!bare.includes('## Owner answers given ahead'), role);
    assert.ok(!bare.includes('\n\n\n'), role);
  }
});

test('fillTemplate: CRLF, missing values, blank runs', () => {
  assert.equal(fillTemplate('a\r\n{{x}}\r\n\r\n\r\nb', { x: '1' }), 'a\n1\n\nb\n');
  assert.throws(() => fillTemplate('{{nope}}', {}), /no value for \{\{nope\}\}/);
  assert.equal(fillTemplate('{{a}}', { a: '$& {{b}}' }), '$& {{b}}\n', 'values are inserted as they are, never re-read');
  assert.equal(fillTemplate('- a\r\n{{x}}\r\n- b\n', { x: '' }), '- a\n- b\n', 'an empty item leaves no gap in a list');
  assert.equal(fillTemplate('a\n{{x}}\nb', { x: 'one\r\n\r\n\r\ntwo\r' }), 'a\none\n\ntwo\n\nb\n', 'values lose their CRs too');
});

test('rolePrompt refuses what it cannot fill', () => {
  const ctx = builderCtx();
  assert.throws(() => rolePrompt('planner', ctx), /unknown role: planner/);
  assert.throws(() => rolePrompt('builder', { ...ctx, planPath: undefined }), /builder: planPath is required/);
  assert.throws(() => rolePrompt('builder', { ...ctx, contextPath: 'x.md' }), /contextPath must name a <phase>-CONTEXT\.md/);
  assert.throws(() => rolePrompt('slicer', { ...ctx, contextPath: '05-CONTEXT.md' }), /slicer: contextPath must be in the phase directory inside the project/);
  assert.throws(() => rolePrompt('fixer', { ...ctx, findingsPath: 'r-REVIEW.md', contextPath: path.join(ctx.root, '..', '05-CONTEXT.md') }), /fixer: contextPath must be in the phase directory/);
});
