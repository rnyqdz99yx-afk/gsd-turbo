import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROLES, fillTemplate, rolePrompt } from '../lib/roles.mjs';
import { slicePhase, compactPlan, writePlan } from './helpers/slices.mjs';

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

// role -> a ctx builder; every role prompt carries the OWNER QUESTION block
const CASES = {
  builder: (over) => builderCtx(over),
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
  const d = rolePrompt('builder', builderCtx({ plan: { files: ['src/new.js'], deleted: ['old.js'] } }));
  assert.ok(d.includes('You may create, change or delete only: src/new.js, old.js (delete);'), d);
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
});

test('rolePrompt refuses what it cannot fill', () => {
  const ctx = builderCtx();
  assert.throws(() => rolePrompt('planner', ctx), /unknown role: planner/);
  assert.throws(() => rolePrompt('builder', { ...ctx, planPath: undefined }), /builder: planPath is required/);
  assert.throws(() => rolePrompt('builder', { ...ctx, contextPath: 'x.md' }), /contextPath must name a <phase>-CONTEXT\.md/);
});
