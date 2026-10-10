import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STEPS } from '../lib/phase-progress.mjs';

test('turbo-phase skill: frontmatter, every step in order, the commands it drives', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  assert.match(s, /^---\nname: turbo-phase\ndescription: .+\nargument-hint: .+\nallowed-tools: \[Bash, Read, Write, Edit, Grep, Glob, Agent, Skill\]\n---\n/);
  let at = -1;
  for (const step of STEPS) {
    const i = s.indexOf(`\n### ${step}\n`);
    assert.ok(i > at, `step ${step} in order`);
    at = i;
  }
  const needles = [
    'node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs"',
    'turbo-run phase-step N', 'turbo-run phase-step N --done', 'turbo-run lane-status N paused-context', 'turbo-run lane-status N needs-owner',
    'turbo-run lane-status N done', 'gsd-pause-work', 'turbo-run staleness N --json', 'turbo-run staleness N --record-all',
    'turbo-run gates off N', 'turbo-run gates restore N', 'turbo-run gates docs-off N', 'turbo-run gates docs-restore N', 'turbo-run gates chunked',
    'turbo-run jobs N prologue --json', 'turbo-run jobs N fanout --json', 'turbo-run jobs N outcome --json', 'TURBO_FULL=1 turbo-run test-changed',
    'isolation="worktree"', 'subagent_type="turbo-uat"', 'turbo-run uat owner-request N --json',
    'args="N --no-transition"', 'args="N --gaps-only --no-transition"', 'args="N --chunked"', '--research-phase N', 'discuss-phase-assumptions.md',
    'auto_advance', 'args="N --fix"', 'Verify all open threats', 'gsd-verify-work', 'planner-revision.md', 'ONE message', 'gsd-tools commit',
    'gsd-tools phase uat-passed N --uat-only',
    // bounded rounds count across sessions (I1)
    'turbo-run phase-step N --attempt execute', 'turbo-run phase-step N --attempt fix', 'turbo-run phase-step N --attempt final-gate',
    'turbo-run phase-step N --attempt uat', 'budget used up across sessions',
    // a stand turbo-uat left running is found by its pid file only (I5)
    '.planning/turbo/run/uat-pN/stand.pid', 'taskkill', 'Never kill processes by name',
    // the lane kills only a live stand.pid process: Windows reuses PIDs, and POSIX pid 0 or 1 would hit far more
    'a positive integer above 1', 'process.kill(pid, 0)', 'process.kill(pid,0)',
  ];
  for (const n of needles) assert.ok(s.includes(n), n);
  assert.ok(!/gsd-turbo-/.test(s));
});

const section = (s, name) => {
  const at = s.indexOf(`\n### ${name}\n`);
  const end = s.indexOf('\n### ', at + 1);
  return s.slice(at, end < 0 ? undefined : end);
};

test('turbo-phase skill: the context check of the step loop is turbo-run context, never a hand estimate', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const loop = s.slice(s.indexOf('## The step loop'), s.indexOf('### Stopping early'));
  const point = loop.split('\n').find((l) => l.startsWith('2. '));
  assert.ok(point.includes('`turbo-run context N`'), point);
  assert.match(point, /context: unknown/);
  assert.match(point, /[Nn]ever estimate/);
  assert.match(point, /context_window/);
});

test('turbo-phase skill: STATE.md\'s position is synced after every stop and after execute', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const early = s.slice(s.indexOf('### Stopping early'), s.indexOf('## Steps'));
  assert.ok(early.indexOf('turbo-run state-sync N') > 0 && early.indexOf('turbo-run state-sync N') < early.indexOf('turbo-run lane-status N needs-owner'), 'Stopping early syncs before the lane status');
  const loop = s.slice(s.indexOf('## The step loop'), s.indexOf('### Stopping early'));
  const point = loop.split('\n').find((l) => l.startsWith('2. '));
  assert.ok(point.indexOf('gsd-pause-work') < point.indexOf('turbo-run state-sync N') && point.indexOf('turbo-run state-sync N') < point.indexOf('paused-context'), point);
  assert.ok(section(s, 'execute').includes('turbo-run state-sync N'), 'execute ends with a sync');
  assert.ok(!/gsd-tools (query )?state[.\s](begin-phase|planned-phase)/.test(s), 'turbo never calls begin-phase or planned-phase');
});

test('turbo-phase skill: inside execute the context stop finishes the plan or wave and leaves the step undone; state-sync is best effort', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const loop = s.slice(s.indexOf('## The step loop'), s.indexOf('### Stopping early'));
  const point = loop.split('\n').find((l) => l.startsWith('2. '));
  assert.match(point, /`turbo-run state-sync N` \(best effort/);
  assert.match(point, /[Ww]herever GSD's execute-phase runs inside a step \(execute, the re-runs in final-gate and the uat gap round\).*before each wave or plan.*finish the current plan or wave.*without marking the step done/);
});

test('turbo-phase skill: passing GSD core reference files as paths is a listed exception to never rebuilding GSD prompts', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const rule = s.split('\n').find((l) => l.includes('Never rebuild by hand a prompt'));
  for (const needle of ['`references/`', '`templates/`', '`workflows/`', 'absolute paths', 'Read them before anything else', 'never for the plan, CONTEXT, RESEARCH or other phase files']) assert.ok(rule.includes(needle), needle);
});

// A stop inside execute restores the gates (Stopping early) while gates-off stays done: the resumed
// execute must turn them off again, or GSD runs its gates serially and the fan-out runs them again.
test('turbo-phase skill: step execute begins with gates off, handled like step gates-off', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const exec = section(s, 'execute');
  const off = exec.indexOf('turbo-run gates off N');
  assert.ok(off > 0, 'execute runs gates off');
  assert.ok(off < exec.indexOf('Skill(skill="gsd-execute-phase"'), 'before GSD executes');
  assert.match(exec, /refuses.*gates-off/s, 'the refusal is handled as in step gates-off');
  // the deliberate gates-on re-runs of execute-phase stay as they are
  for (const step of ['final-gate', 'uat', 'close']) assert.ok(!section(s, step).includes('turbo-run gates off N'), step);
});
