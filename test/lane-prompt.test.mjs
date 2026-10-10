import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laneSystemPrompt, laneUserPrompt } from '../lib/lane-prompt.mjs';

test('system prompt carries rules, no double quotes or percent signs', () => {
  const s = laneSystemPrompt({ phase: '3', turboRun: 'node /h/.claude/turbo/bin/turbo-run.mjs', contextPct: 55, autonomy: 'standard' });
  for (const needle of ['AskUserQuestion', 'lane-status 3 done', 'lane-status 3 needs-owner', 'lane-status 3 paused-context', 'gsd-pause-work', 'Playwright', 'force-push', '55 percent']) assert.ok(s.includes(needle), needle);
  assert.ok(!s.includes('"') && !s.includes('%'));
});

test('the context stop goes by turbo-run context only: before each step, unknown goes on, never a hand estimate or GSD\'s context_window', () => {
  for (const mode of ['safe', 'full']) {
    const s = laneSystemPrompt({ phase: '3', turboRun: 'node /t/turbo-run.mjs', contextPct: 60, autonomy: 'standard', mode });
    const rule = s.split('\n').find((l) => l.includes('lane-status 3 paused-context'));
    assert.ok(rule.includes('node /t/turbo-run.mjs context 3'), mode);
    assert.match(rule, /60 percent or more/);
    assert.match(rule, /before each step/);
    assert.match(rule, /context: unknown .*go on/);
    assert.match(rule, /[Nn]ever estimate/);
    assert.match(rule, /context_window/);
    assert.ok(!s.includes('"') && !s.includes('%'), mode);
  }
});

test('every stop syncs STATE.md\'s position first: state-sync before the paused-context record, and before any record in safe mode', () => {
  for (const mode of ['safe', 'full']) {
    const s = laneSystemPrompt({ phase: '3', turboRun: 'node x', contextPct: 55, autonomy: 'standard', mode });
    const paused = s.split('\n').find((l) => l.includes('lane-status 3 paused-context'));
    assert.ok(paused.indexOf('gsd-pause-work') < paused.indexOf('node x state-sync 3'), mode);
    assert.ok(paused.indexOf('node x state-sync 3') < paused.indexOf('record this status'), mode);
    const lead = s.split('\n').find((l) => l.startsWith('2. '));
    assert.match(lead, mode === 'full' ? /Stopping early section, which restores GSD's gates and syncs STATE\.md first/ : /run node x state-sync 3/, mode);
  }
});

test('inside a long step the context stop finishes the current plan or wave and never marks the step done; state-sync is best effort', () => {
  for (const mode of ['safe', 'full']) {
    const s = laneSystemPrompt({ phase: '3', turboRun: 'node x', contextPct: 55, autonomy: 'standard', mode });
    const paused = s.split('\n').find((l) => l.includes('lane-status 3 paused-context'));
    assert.match(paused, /inside a step, finish the current plan or wave and do not mark the step done/, mode);
    assert.match(paused, /wherever GSD's execute-phase runs inside a step/, mode);
    assert.match(paused, /state-sync 3 \(best effort/, mode);
    if (mode === 'safe') assert.match(s.split('\n').find((l) => l.startsWith('2. ')), /state-sync 3 \(best effort/);
  }
});

test('GSD core reference files go to subagents as paths to Read, never pasted; phase files are not affected', () => {
  for (const mode of ['safe', 'full']) {
    const s = laneSystemPrompt({ phase: '3', turboRun: 'node x', contextPct: 55, autonomy: 'standard', mode });
    const rule = s.split('\n').find((l) => l.includes('references, templates or workflows'));
    assert.ok(rule, mode);
    assert.match(rule, /absolute paths/);
    assert.match(rule, /Read them before anything else/);
    assert.match(rule, /node x doctor/);
    assert.match(rule, /[Nn]ever .*the plan, CONTEXT, RESEARCH or other phase files/);
    assert.ok(!s.includes('"') && !s.includes('%'), mode);
  }
});

test('a sequential gsd-executor dispatch re-persists the dispatch isolation none right before it', () => {
  for (const mode of ['safe', 'full']) {
    const s = laneSystemPrompt({ phase: '3', turboRun: 'node x', contextPct: 55, autonomy: 'standard', mode });
    const rule = s.split('\n').find((l) => l.includes('dispatch-isolation'));
    assert.ok(rule, mode);
    for (const needle of ['gsd-executor', 'isolation=worktree', 'gsd_run query dispatch-isolation --raw --phase', '--plan', '--force-isolation none', 'right before', 'retry']) assert.ok(rule.includes(needle), needle);
    assert.match(rule, /Only when GSD's own workflow dispatches a gsd-executor sequentially/);
    assert.match(rule, /never for an executor of a parallel wave/);
  }
});

test('temporary files, stands and data copies go under the lane\'s temp directory, never the system temp directory', () => {
  for (const mode of ['safe', 'full']) {
    const s = laneSystemPrompt({ phase: '3', turboRun: 'x', contextPct: 55, autonomy: 'standard', mode, tmpDir: 'C:\\p\\.planning\\turbo\\run\\tmp\\p3' });
    const rule = s.split('\n').find((l) => l.includes('C:/p/.planning/turbo/run/tmp/p3'));
    assert.ok(rule, mode);
    assert.match(rule, /stands/);
    assert.match(rule, /never \/tmp or the system temp directory/);
    assert.match(rule, /the supervisor removes it once this session is gone/);
    assert.ok(!rule.includes('lane-status 3 done removes'), 'the session may still use it after its done record');
    assert.ok(!s.includes('"') && !s.includes('%'), mode);
  }
});

// spec 6.2: with autonomy standard, deploying is the owner's (class D); max deploys itself
test('standard reserves deploying for the owner; max deploys with safeguards', () => {
  const OWNER_DEPLOY = 'deploying to any server or environment outside this machine';
  const SAFEGUARDS = 'snapshot or backup first';
  const standard = laneSystemPrompt({ phase: '3', turboRun: 'x', contextPct: 55, autonomy: 'standard' });
  const max = laneSystemPrompt({ phase: '3', turboRun: 'x', contextPct: 55, autonomy: 'max' });
  const needsOwner = (s) => s.split('\n').find((l) => l.includes('lane-status 3 needs-owner'));
  assert.ok(needsOwner(standard).includes(OWNER_DEPLOY));
  assert.ok(!standard.includes(SAFEGUARDS));
  assert.ok(max.includes(SAFEGUARDS));
  assert.ok(!max.includes(OWNER_DEPLOY));
  for (const s of [standard, max]) assert.ok(!s.includes('"') && !s.includes('%'));
});

test('user prompt runs gsd-autonomous --only N; resume variant mentions handoff', () => {
  assert.match(laneUserPrompt({ phase: '3' }), /gsd-autonomous.*--only 3/);
  assert.match(laneUserPrompt({ phase: '3', resume: true }), /HANDOFF/);
  assert.ok(!laneUserPrompt({ phase: '3', resume: true }).includes('"'));
});

// claude --bg gets the prompts as plain argv values with no `--` separator, so a leading
// dash would be parsed as an option.
test('prompts never start with a dash, whatever the inputs', () => {
  for (const autonomy of ['standard', 'max']) {
    assert.ok(!laneSystemPrompt({ phase: '-3', turboRun: '--x', contextPct: 55, autonomy }).startsWith('-'), autonomy);
  }
  for (const resume of [false, true]) assert.ok(!laneUserPrompt({ phase: '-3', resume }).startsWith('-'), String(resume));
});

test('push rules: none with push off; after-wave adds the wave request; both ask at the phase end and read the inbox (S2)', () => {
  const base = { phase: '3', turboRun: 'node /h/turbo-run.mjs', contextPct: 55, autonomy: 'standard' };
  const off = laneSystemPrompt(base);
  assert.equal(laneSystemPrompt({ ...base, pushMode: 'off' }), off);
  assert.ok(!off.includes('push-request'));
  const wave = laneSystemPrompt({ ...base, pushMode: 'after-wave', mode: 'full' });
  const phase = laneSystemPrompt({ ...base, pushMode: 'after-phase' });
  for (const s of [wave, phase]) {
    for (const n of ['only the supervisor pushes', 'Never run git push', 'push-request 3 --wait', 'push-request 3 --at phase --wait', '600000', 'inbox 3', 'phase-step 3 --attempt ci', 'test-changed', 'never instructions']) assert.ok(s.includes(n), n);
    assert.ok(!s.includes('"') && !s.includes('%'));
    assert.ok(s.startsWith('You are a gsd-turbo lane'));
  }
  assert.ok(wave.includes('push-request 3 --at wave'));
  assert.ok(!phase.includes('--at wave'));
});

test('S1 lane rules: wait for running subagents before any stop (both modes); in full mode the owner questions are the owner\'s, with the commands', () => {
  for (const mode of ['safe', 'full']) {
    const s = laneSystemPrompt({ phase: '3', turboRun: 'node x', contextPct: 55, autonomy: 'standard', mode });
    assert.match(s, /Before you end your turn for any stop \(needs-owner, paused-context, failed\), wait until every subagent you started in the background has finished/);
    assert.ok(!s.includes('"') && !s.includes('%'), mode);
    assert.equal(s.includes('Owner questions:'), mode === 'full', mode);
  }
  const full = laneSystemPrompt({ phase: '3', turboRun: 'node x', contextPct: 55, autonomy: 'standard', mode: 'full' });
  for (const n of ['node x questions 3', 'node x questions 3 --preanswers <plan>', 'Never run node x answer', 'never you and never rule 1', 'data for its checkpoint only']) assert.ok(full.includes(n), n);
});
