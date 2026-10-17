import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Stage 5 §8 (plan B, task 8): the turbo-phase skill's plan drafts text.
const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
const section = (name, level = '###') => {
  const at = s.indexOf(`\n${level} ${name}\n`);
  assert.ok(at >= 0, name);
  const end = s.slice(at + 1).search(/\n#{2,3} /);
  return end < 0 ? s.slice(at) : s.slice(at, at + 1 + end);
};
const inOrder = (text, needles) => {
  let at = -1;
  for (const n of needles) {
    const i = text.indexOf(n, at + 1);
    assert.ok(i > at, `in order: ${n}`);
    at = i;
  }
};

test('Conventions name the draft paragraph and the reconcile prompt among the prompts turbo builds by hand', () => {
  const rule = s.split('\n').find((l) => l.includes('Never rebuild by hand a prompt'));
  assert.ok(rule.includes('the draft paragraph and the reconcile prompt of **Plan drafts**'));
});

test('step plan runs Plan drafts after GSD\'s outline and before its first Wave; its questions after every plan\'s commit stay', () => {
  const plan = section('plan');
  const p2 = plan.split('\n').find((l) => l.startsWith('2. '));
  assert.ok(p2.includes("When GSD's outline is complete (its chunked planning's §8.5.1) and before its first Wave is dispatched, run section **Plan drafts**"));
  assert.ok(p2.includes("every plan's commit is still followed by the questions below"));
  assert.ok(p2.includes('turbo-run questions N'));
});

test('section Plan drafts: the commands in order, one message per wave, GSD\'s path on any failure, GSD\'s checker unchanged, the wait before stopping', () => {
  const d = section('Plan drafts');
  inOrder(d, [
    'turbo-run plan-drafts N --plan', 'commit first: <ids>', 'drafts off: <why>', 'turbo-run plan-drafts N --drafting <id>', 'ONE message',
    "GSD's dispatch of its first Wave", 'run_in_background=true', 'commits nothing', 'Drafts are dispatched this once', 'gsd_stall_watch',
    'turbo-run plan-drafts N --drafted <id>', 'turbo-run plan-drafts N --replan <id>', 'turbo-run plan-drafts N --reconcile <id>', 'use: gsd',
    "GSD's own single-plan Agent call", 'ONE message', 'in the foreground', 'turbo-run plan-drafts N --reconciled <id> --verdict passed',
    'turbo-run plan-drafts N --promote <id>', 'marker_received', 'docs(<padded phase>): plan <id> (chunked)', '**List and classify**',
    '--verdict failed', "GSD's own single-plan Agent call", 'step 9', 'plan checker and its revision loop, unchanged', 'point 3',
    '**Stopping early**', 'wait for every draft and reconcile agent',
    'came from a draft without a passed reconcile', '--replan <id>', 'drop a plan that skipped its reconcile', 'point 2 of step **plan** again',
  ]);
  assert.ok(d.includes('never for `--gaps`, `--reviews`, a freshness revision'));
  assert.ok(!/draft later/.test(d), 'no rolling re-dispatch');
  // review C2, I1: every wave after drafts on (a resumed session's first runnable wave too), draft returns handled before
  // GSD's resume check, serial dispatch
  inOrder(d, ['**Every Wave GSD dispatches after `drafts on`**', 'its first runnable Wave too', "Before GSD's §8.5.2 point 2 (its resume check)",
    'keeps that entry in the runnable set', "At GSD's §8.5.2 point 4", '`CHUNKED_PARALLEL` false', "GSD's first serial call of the Wave"]);
  assert.ok(d.includes('a `## REVISION COMPLETE` that leaves no issue unaddressed'));
  assert.ok(d.includes('is no plan of GSD\'s outline'));
});

test('the reconcile prompt: GSD\'s revision contract, the draft-reconcile blocker, Steps 2-5 (2.5) only, no commit, the three returns', () => {
  const d = section('Plan drafts');
  const prompt = d.slice(d.indexOf('<revision_context>'), d.indexOf('</instructions>'));
  inOrder(prompt, [
    '<revision_context>', '**Mode:** revision (gsd-turbo draft reconcile)', '<required_reading>', '<draft>', '<each before: path>', '<outline>', '<context>',
    'plan: "<id>"', 'dimension: "draft-reconcile"', 'severity: "blocker"', 'required_property: "every file, symbol, interface, command and decision',
    'description: "<the assumptions lines>"', '<instructions>', 'planner-revision.md', 'Steps 2 to 5 (with 2.5) only; not Steps 1, 6 or 7', 'Read only the files listed above',
    'Never run git or gsd-tools commit', 'Edit nothing but <draft>', 'do not edit ROADMAP.md or STATE.md', 'Return only one of the markers below',
    '## RECONCILE PASSED', '## RECONCILE FAILED', '## REVISION_CONFLICT',
  ]);
  assert.ok(d.includes('followed by the **Temporary files** paragraph'));
});
