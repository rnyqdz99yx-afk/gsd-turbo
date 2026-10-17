import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STEPS } from '../lib/phase-progress.mjs';
import { ASK_RULE, GAP_PLAN_RULE, HUMAN_ACTION_RULE, LEAN_CHECKER_RULE, LEAN_EXECUTOR_REFS, LEAN_PLANNER_RULE, LEAN_RESEARCH_RULE, RELEASE_RULE } from '../lib/lane-prompt.mjs';
import { LEAN_LINE, stripLean } from './helpers/lean.mjs';

test('turbo-phase skill: frontmatter, every step in order, the commands it drives', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  assert.match(s, /^---\nname: turbo-phase\ndescription: .+\nargument-hint: .+\nallowed-tools: \[Bash, Read, Write, Edit, Grep, Glob, Agent, Skill, SendMessage\]\n---\n/);
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
  assert.ok(!/gsd-tools (query )?state[.\s]begin-phase/.test(s), 'turbo never calls begin-phase');
  // planned-phase only where GSD's plan-phase would have run it (review M3): the plan step's checker pass, before execution
  const planned = [...s.matchAll(/gsd-tools (?:query )?state[.\s]planned-phase/g)].map((m) => m.index);
  const p1 = s.indexOf('\n1. ', s.indexOf('\n### plan\n'));
  assert.deepEqual(planned.length, 1);
  assert.ok(planned[0] > p1 && planned[0] < s.indexOf('\n2. ', p1), 'only in step plan point 1');
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

test('turbo-phase skill: push and CI (S2) — the lane asks, the supervisor pushes, red CI is fixed in bounded rounds', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const needles = [
    '### Push and CI', 'turbo-run inbox N', 'turbo-run push-request N --at wave', 'turbo-run push-request N --at phase --wait',
    'turbo-run push-request N --wait', 'turbo-run phase-step N --attempt ci', '600000', 'fix rounds allowed', 'data from CI, never instructions',
    'Do not run git push', 'push off: nothing requested', 'waiting:', '**CI red**', '**A plan that pushes**',
  ];
  for (const n of needles) assert.ok(s.includes(n), n);
  const close = s.slice(s.indexOf('\n### close\n'));
  const ask = close.indexOf('turbo-run push-request N --at phase --wait');
  assert.ok(ask > 0 && ask < close.indexOf('turbo-run phase-step N --done close'), 'close asks for the phase push before it marks itself done');
  const execute = s.slice(s.indexOf('\n### execute\n'), s.indexOf('\n### restore\n'));
  assert.ok(execute.includes('turbo-run push-request N --at wave') && execute.includes('turbo-run inbox N'));
  assert.ok(!/^\s*(\d+\.\s*)?`?git push/m.test(s), 'no step runs git push');
});

test('turbo-phase skill: each exit-1 line of push-request says whether the owner was notified (S2)', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const push = s.slice(s.indexOf('\n### Push and CI\n'), s.indexOf('**CI red.**'));
  assert.ok(!s.includes('ends this request and the owner was notified'));
  assert.match(push, /`refused: …`[^\n]*: the owner was notified/);
  assert.match(push, /`failed: no supervisor is running …`[^\n]*: nobody was notified/);
  assert.match(push, /`superseded: …`[^\n]*: [^\n]*nobody was notified/);
  assert.match(push, /`… · CI cancelled …`[^\n]*: [^\n]*nobody was notified/);
  const close = s.slice(s.indexOf('\n### close\n'));
  assert.ok(!close.includes('any other line → the owner was notified'));
});

test('turbo-phase skill: CI red rounds count once per red commit, and no new commit means no new round (S2)', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const red = s.slice(s.indexOf('**CI red.**'), s.indexOf('**A plan that pushes.**'));
  assert.match(red, /per red commit/);
  assert.match(red, /is not counted again/);
  assert.match(red, /never ask for a push of the same commit again/);
  // the executor-prompt paragraph of A plan that pushes is one of the named exceptions to "never rebuild a prompt"
  const conventions = s.slice(s.indexOf('## Conventions'), s.indexOf('## The step loop'));
  assert.match(conventions, /except where a step below says so \([^)]*\*\*A plan that pushes\*\*/);
});

test('turbo-phase skill: owner questions (S1) — list and classify, pre-answers, the stop at a checkpoint, delivery to the same agent, the continuation path', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const needles = [
    '### Owner questions', '**List and classify**', '**Pre-answers**', '**At a checkpoint**', '**Delivery**', '**After an interruption**', '**Commit the answers**',
    'turbo-run questions N --class <id>=<class>', 'consent:deploy', 'owner-only', 'turbo-run questions N --preanswers <plan id>', '## CHECKPOINT REACHED',
    'turbo-run questions N --stop <plan id>-t<task number> --agent <agent id>', '--unmet', '--kind human-action', 'turbo-run questions N --deliver',
    'SendMessage(to="<agent id>"', 'resumedAgentId', 'No transcript found for agent ID', 'ToolSearch', 'turbo-run agent-tail <agent id>', '<previous_agent_tail>',
    'turbo-run questions N --delivered <id> --path same-agent', 'turbo-run questions N --delivered <id> --path continuation', 'turbo-run view --json',
    'Never run `turbo-run answer` yourself', '`not a question id: …`', 'Never rename a plan file', 'every phase', '`gsd-tools commit "docs(phase-N): owner answers" --files .planning/turbo/answers/`',
  ];
  for (const n of needles) assert.ok(s.includes(n), n);
  assert.ok(!s.includes('answers/pN.json'), "the whole answers directory, not only this phase's file");
  const stop = s.slice(s.indexOf('\n### Stopping early\n'), s.indexOf('\n## Steps\n'));
  assert.match(stop, /^0\. Wait until every subagent you started in the background has finished/m);
  const plan = s.slice(s.indexOf('\n### plan\n'), s.indexOf('\n### gates-off\n'));
  assert.ok(plan.indexOf('turbo-run questions N') > plan.indexOf('gsd-plan-phase'), 'questions after planning');
  const execute = s.slice(s.indexOf('\n### execute\n'), s.indexOf('\n### restore\n'));
  for (const n of ['turbo-run questions N', '**Pre-answers**', '**At a checkpoint**', 'delivery path']) assert.ok(execute.includes(n), n);
  const loop = s.slice(s.indexOf('\n## The step loop\n'), s.indexOf('\n### Stopping early\n'));
  assert.ok(loop.indexOf('**Delivery**') >= 0 && loop.indexOf('**Delivery**') < loop.indexOf('1. `turbo-run phase-step N`'), 'delivery before the step loop');
  // the lane commits the whole answers directory before every step's done mark and in every stop
  assert.match(loop, /^4\. \*\*Commit the answers\*\* \(section \*\*Owner questions\*\*\), then `turbo-run phase-step N --done/m);
  assert.match(stop, /^0\. .*Then \*\*Commit the answers\*\*/m);
  assert.match(s, /\*\*Commit the answers\.\*\* .*Commit the whole directory with `gsd-tools commit "docs\(phase-N\): owner answers" --files \.planning\/turbo\/answers\/` before each `turbo-run phase-step N --done` and in \*\*Stopping early\*\*/);
});

test('turbo-phase skill: the release rule and the gap-plan rule (S4), verbatim as the lanes get them', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const conv = s.slice(s.indexOf('\n## Conventions\n'), s.indexOf('\n## The step loop\n')).split('\n');
  const rel = conv.find((l) => l.startsWith('- Releases (spec §8): '));
  const gap = conv.find((l) => l.startsWith('- Gap plans (spec §8): '));
  assert.ok(rel && rel.includes(RELEASE_RULE), 'release rule verbatim');
  assert.ok(gap && gap.includes(GAP_PLAN_RULE), 'gap-plan rule verbatim');
  for (const n of ['continuation agent', '**Pre-answers**', '**At a checkpoint**', '--kind human-action', 'recommended for the project', 'Never kill the process']) assert.ok(rel.includes(n), n);
  for (const n of ['gsd-plan-phase --gaps', 'verify-work', 'gsd-planner', 'revision prompt']) assert.ok(gap.includes(n), n);
});

test('turbo-phase skill: gap rounds (S4) — execute and uat loop on phase-step --attempt within gap_rounds, each round with new evidence; final-gate keeps one round', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  for (const step of ['execute', 'uat']) {
    const body = section(s, step);
    for (const n of [`turbo-run phase-step N --attempt ${step}`, `attempt ${step} <n> of <max>: go`, `attempt ${step} <n> of <max>: stop: <reason>`, '`gap_rounds`', 'new evidence', '**Gap plans**', 'args="N --gaps-only --no-transition"']) {
      assert.ok(body.includes(n), `${step}: ${n}`);
    }
    assert.ok(!body.includes('after one gap-closure round'), step);
    assert.ok(!body.includes('`n` above 1'), step);
  }
  assert.match(section(s, 'execute'), /then run point 2 again/);
  assert.match(section(s, 'uat'), /this point runs again/);
  const fg = section(s, 'final-gate');
  assert.match(fg, /one gap-closure round, outside `gap_rounds`/);
  assert.match(fg, /no `--attempt execute` here/);
  assert.ok(!fg.includes('as in point 2 of step **execute**'), 'execute point 2 is a loop now');
  const loop = s.slice(s.indexOf('## The step loop'), s.indexOf('### Stopping early'));
  assert.ok(loop.includes('(the gap-closure rounds of execute and uat, fix iterations, final-gate rounds)'));
});

test('turbo-phase skill: a uat step that restarts with gap plans not run yet resumes their round first (F2)', () => {
  const uat = section(fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8'), 'uat');
  const zero = uat.indexOf('\n0. ');
  assert.ok(zero > 0 && zero < uat.indexOf('\n1. '), 'point 0 before point 1');
  for (const n of ['a plan without its SUMMARY', 'turbo-run phase-step N --attempt uat', 'go (round <n> resumed: …)', 'without counting it again']) assert.ok(uat.includes(n), n);
});

test('turbo-phase skill: owner-ruled UAT rows are deferred before owner-request; a stale report after UAT re-runs only the verifier when no code changed', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const stale = s.slice(s.indexOf('\n### Stale report\n'), s.indexOf('\n## Steps\n'));
  assert.ok(s.indexOf('\n### Stale report\n') > 0 && stale.length > 0, 'the procedure sits before the steps');
  for (const n of ['turbo-run staleness N --verification --json', '`verifier-only`', '`full`', 'verify-phase-goal.md', '`verifier_dispatch`',
    'args="N --no-transition"', 'gsd-tools commit', 'gsd-tools verification status <phase dir>']) assert.ok(stale.includes(n), n);
  const uat = section(s, 'uat');
  const defer = uat.indexOf('turbo-run uat defer N --rulings');
  assert.ok(defer > 0 && defer < uat.indexOf('turbo-run uat owner-request N --json'), 'defer before owner-request');
  assert.ok(uat.includes('turbo-run uat defer N <numbers>'), 'the owner confirms by number');
  const complete = uat.indexOf('uat.complete-session');
  assert.ok(complete > 0 && complete < uat.indexOf('Skill(skill="gsd-verify-work"'), 'the session is completed before verify-work');
  assert.ok(uat.slice(complete).indexOf('**Stale report**') > 0, 'the stale check follows the completed session');
  assert.ok(uat.split('\n').find((l) => l.startsWith('1. ')).includes('**Stale report**'), 'point 1 handles stale');
  assert.ok(section(s, 'close').includes('**Stale report**'));
});

test('turbo-phase skill: deferred rows are committed before a stop; close canonicalises a verifier-only human_needed report through uat point 5', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const p3 = section(s, 'uat').split('\n').find((l) => l.startsWith('3. '));
  assert.ok(p3.indexOf('gsd-tools commit') > p3.indexOf('turbo-run uat defer N --rulings') && p3.indexOf('gsd-tools commit') < p3.indexOf('turbo-run uat owner-request N --json'), p3);
  const p2 = section(s, 'close').split('\n').find((l) => l.startsWith('2. '));
  assert.match(p2, /`human_needed`.*point 5 of step \*\*uat\*\*/);
  assert.ok(section(s, 'Stale report').includes('not re-run'), 'the note says what was not run again');
});

test('turbo-phase skill: one verifier pass per uat step — every UAT write first (settle, complete-session), then one Stale report; a legitimate edit is never reverted to keep the report fresh', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const uat = section(s, 'uat');
  const line = (n) => uat.split('\n').find((l) => l.startsWith(`${n}. `));
  // point 1: a report stale only from UAT writes, which said human_needed, is refreshed once at point 5, not here
  const p1 = line(1);
  // only when nothing but the UAT file, STATE.md and turbo's run files changed (uatOnly): a changed plan or roadmap
  // refreshes the report before turbo-uat reads its human items
  for (const n of ['turbo-run staleness N --verification --json', '`uatOnly`', '`reported`', '`human_needed`', 'point 5']) assert.ok(p1.includes(n), n);
  // point 5: settle, complete the session, then the one Stale report, then verify-work
  const p5 = line(5);
  const settle = p5.indexOf('turbo-run uat settle N');
  const complete = p5.indexOf('uat.complete-session');
  const stale = p5.indexOf('**Stale report**', complete);
  const verify = p5.indexOf('Skill(skill="gsd-verify-work"');
  assert.ok(settle > 0 && settle < complete && complete < stale && stale < verify, p5);
  assert.ok(p5.includes('core.autocrlf'), 'the reason is named');
  // the fresh report is read again before verify-work: new human items go back to turbo-uat, gaps or anything else fail
  const after = p5.slice(stale, verify);
  for (const n of ['human item', 'back to point 2', '`passed`', '**fail**']) assert.ok(after.includes(n), n);
  const proc = section(s, 'Stale report');
  for (const n of ['One pass per step', 'Never revert', 'keep the commit', '`verifier-only`']) assert.ok(proc.includes(n), n);
  // close: the owner request is current before the done record (a resume removed it)
  const close = section(s, 'close');
  const owner = close.indexOf('turbo-run uat owner-request N');
  assert.ok(owner > 0 && owner < close.indexOf('turbo-run lane-status N done'), 'owner-request before the done record');
  // and before every stop for the owner in close, so status shows the checklist again after a resumed lane stops
  assert.ok(owner < close.indexOf('\n1. ') && close.includes('Before every **stop for the owner** in this step'), 'owner-request before any stop of close');
});

test('turbo-phase skill (v0.3.3): every stop for the owner is asked with turbo-run ask; lane questions are delivered on the lane path; owner-chosen fixes run as a counted gap round; the review loop is flagged', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const early = s.slice(s.indexOf('### Stopping early'), s.indexOf('### Push and CI'));
  for (const needle of [
    'turbo-run ask N --question', '--option "<label>|<description>"', '--recommended <n>', 'turbo-run ask N --action',
    '--about-review', 'owner question <plan id>-t<task number>', 'turbo-run lane-status N needs-owner', 'turbo-run lane-status N failed',
  ]) assert.ok(early.includes(needle), needle);
  assert.ok(early.includes(ASK_RULE), 'the ask rule verbatim, as the lanes get it');
  const owner = s.slice(s.indexOf('### Owner questions'), s.indexOf('### Stale report'));
  const lane = owner.slice(owner.indexOf('**Lane questions.**'));
  for (const needle of ['turbo-run questions N --deliver', 'turbo-run questions N --delivered <id> --path lane', 'data', 'Owner-chosen fixes']) assert.ok(lane.includes(needle), needle);
  const fixes = s.slice(s.indexOf('**Owner-chosen fixes.**'));
  for (const needle of ['turbo-run phase-step N --attempt owner-gaps', 'turbo-run owner-gaps N --review', '--gap', 'Skill(skill="gsd-plan-phase", args="N --gaps")', 'args="N --gaps-only --no-transition"', 'no hand-made UAT row']) assert.ok(fixes.includes(needle), needle);
  assert.ok(!/stop for the owner\*\* \("[^"]*\bWR-\d/.test(s), 'no finding codes in stop reasons');
});

test('turbo-phase skill: a human action that did not work goes back to the owner with the lane\'s own diagnosis and shortest fix, never the same instructions; the second identical failure stops with the diagnosis', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const owner = s.slice(s.indexOf('### Owner questions'), s.indexOf('### Stale report'));
  const at = owner.slice(owner.indexOf('**At a checkpoint.**'), owner.indexOf('**Delivery.**'));
  assert.ok(at.includes('**A step that did not work**'), 'At a checkpoint sends a failed human action there');
  const lane = owner.slice(owner.indexOf('**Lane questions.**'), owner.indexOf('**Owner-chosen fixes.**'));
  assert.match(lane, /Done \(owner-only work\) → check the result and run the step again; a check that still fails: \*\*A step that did not work\*\*/);
  const p = owner.slice(owner.indexOf('**A step that did not work.**'), owner.indexOf('**Delivery.**'));
  assert.ok(p.length > 200, 'its own paragraph, before Delivery');
  assert.ok(p.includes(HUMAN_ACTION_RULE), 'the rule verbatim, as the lanes get it');
  for (const n of [
    'read-only', 'turbo-run questions N --json', '`diagnosis`',
    "turbo-run questions N --stop <plan id>-t<task number> --agent <agent id> --unmet --question '<", "--context '<",
    "turbo-run ask N --action '<", 'elevated', 'one command', 'never the plan\'s instructions again', 'Single quotes keep the shell off',
    'refused twice', 'the card keeps its last words', 'the second identical failure', 'never Done for the same step',
    // a delivery not marked yet is marked before the stop opens the question again; Delivery then has nothing to mark
    'mark it first, `turbo-run questions N --delivered <id> --path',
    'owner question <plan id>-t<task number>: <',
  ]) assert.ok(p.includes(n), n);
  // a diagnosis never changes what it looks at
  assert.match(p, /[Nn]ever change/);
  const delivery = owner.slice(owner.indexOf('**Delivery.**'), owner.indexOf('**After an interruption.**'));
  assert.equal(delivery.split('(nothing to do when **A step that did not work** marked it already)').length, 3, 'both delivery paths');
});

test('turbo-phase skill: during chunked planning each committed plan\'s questions are listed and classified at once, so the owner can answer ahead; the end of the step lists them once more', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const plan = section(s, 'plan');
  const point = plan.split('\n').find((l) => l.startsWith('2. '));
  const at = point.indexOf('after each plan\'s commit');
  assert.ok(at > point.indexOf('Skill(skill="gsd-plan-phase", args="N --chunked")'), point);
  assert.ok(point.includes('`docs(<padded phase>): plan <plan id> (chunked)`'), 'the commit GSD makes per plan');
  for (const n of ['`turbo-run questions N`', '`unclassified`', '`turbo-run questions N --class', 'answer ahead', 'before the next plan']) assert.ok(point.slice(at).includes(n), n);
  assert.ok(plan.split('\n').some((l) => l.startsWith('5. **List and classify**')), 'the whole list once more after the checker\'s revisions');
  const owner = s.slice(s.indexOf('### Owner questions'), s.indexOf('### Stale report'));
  assert.match(owner, /\*\*List and classify\*\* \(step \*\*plan\*\*: after each plan's commit and once more at its end;/);
});

test('turbo-phase skill: the merged Nyquist worktree goes through turbo-run worktrees prune, dry run first, never forced; a conflict keeps the unmerged work', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const point = section(s, 'fanout').split('\n').find((l) => l.startsWith('6. '));
  const dry = point.indexOf('`turbo-run worktrees prune <path> --dry-run`');
  const real = point.indexOf('`turbo-run worktrees prune <path>`');
  assert.ok(dry > point.indexOf('git merge --no-ff <branch>') && real > dry, 'merge, dry run, then the removal');
  for (const n of ['locks', 'this session', '`kept <path>: <why>`', '`partly removed <path> …`', '`not an agent worktree of this project: …`', 'name the line in the note', 'never force', 'never delete it by hand', 'git merge --abort', 'leave the worktree and its branch']) assert.ok(point.includes(n), n);
  assert.ok(!point.includes('git worktree remove') && !point.includes('git branch -d'), 'no hand removal the harness lock refuses');
});

test('turbo-phase skill (review 1, MAJOR 2): no "go on" past the hard gates — final-gate, uat, close, open threats, failed verification; close refuses in code too', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const early = s.slice(s.indexOf('### Stopping early'), s.indexOf('### Push and CI'));
  assert.match(early, /Never offer to go on past a stop of step \*\*final-gate\*\*, \*\*uat\*\* or \*\*close\*\*, past open security threats or past a verification that did not pass: the options there are fix first \(\*\*Owner-chosen fixes\*\*\), run the live check again, or stop the phase here\./);
  assert.match(s, /go on \(never for a stop of final-gate, uat or close\) →/);
  assert.match(s, /`turbo-run phase-step N --done close` refuses unless VERIFICATION\.md reads `passed` and SECURITY\.md counts no open threat/);
});

test('turbo-phase skill (review 1, MAJOR 3): two refusals of turbo-run ask end the rewriting: the stop goes out with a plain reason', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  assert.match(s, /refused twice → `turbo-run lane-status N needs-owner --reason "<the question in plain words>"`/);
});

test('turbo-phase skill: step integrate (Stage 4 §7.1) — the lane takes in main in its slot, reports ready, never marks the step itself', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const sec = section(s, 'integrate');
  for (const n of [
    'turbo-run integrate N', 'exit 4', 'TURBO_FULL=1 turbo-run test-changed', 'turbo-run phase-step N --attempt integrate', 'full test rounds allowed',
    'gsd-tools verification status <phase dir>', '**Stale report**', 'turbo-run lane-status N ready --base', 'without marking this step done',
    'reintegrate', 'ci-red', 'turbo-run integrate N --hold', 'turbo-run ask N',
  ]) assert.ok(sec.includes(n), n);
  assert.ok(section(s, 'close').includes('next integrate'), 'close hands over to integrate in a slot');
  assert.ok(s.includes('push in slots'), 'CI red and close know the slot line');
  assert.ok(s.includes('`reintegrate` messages'), 'the inbox paragraph');
});

// F1: Done on an action card cannot sign UAT rows, so the stop for a signature is a sign-off card whose Accept signs them
test('turbo-phase skill: a UAT stop for the owner\'s signature is a sign-off card (ask --sign), and only the owner\'s Accept signs the rows (F1)', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const p4 = section(s, 'uat').split('\n').find((l) => l.startsWith('4. '));
  for (const n of ['`sign`', 'turbo-run ask N --sign', 'never `--action`', 'Accept', 'Not now']) assert.ok(p4.includes(n), n);
  assert.ok(p4.indexOf('turbo-run ask N --sign') < p4.indexOf('/gsd-verify-work N'), 'the card first, verify-work as the owner\'s other way');
  const early = s.slice(s.indexOf('### Stopping early'), s.indexOf('### Push and CI'));
  assert.match(early, /UAT rows that wait for the owner's signature[^\n]*`turbo-run ask N --sign/);
  const lane = s.slice(s.indexOf('**Lane questions.**'), s.indexOf('**Owner-chosen fixes.**'));
  for (const n of ['turbo-run uat sign N --answer <id>', 'gsd-tools commit', 'Not now', 'never sign rows any other way']) assert.ok(lane.includes(n), n);
  assert.ok(lane.indexOf('turbo-run uat sign N --answer <id>') < lane.lastIndexOf('--path lane'), 'signed before it is marked delivered');
  // review 1: a sign-off card that signs nothing stops the way every stop does (answers committed, gates and STATE.md
  // restored), without a new card; a step run again after the signature does not dispatch turbo-uat for nothing
  assert.match(lane, /points 0 and 1 of \*\*Stopping early\*\*, then `turbo-run lane-status N needs-owner --reason [^`]+` \(no new card\), then its point 3/);
  // controller: the env marker is the lane's to keep, never to clear
  assert.ok(s.includes('never set, clear or override `TURBO_LANE`'));
  const p2 = section(s, 'uat').split('\n').find((l) => l.startsWith('2. '));
  assert.ok(p2.indexOf('`turbo-run uat plan N`') > 0 && p2.indexOf('`turbo-run uat plan N`') < p2.indexOf('Agent(subagent_type="turbo-uat"'), p2);
  assert.ok(p2.includes('no `items`'), p2);
  assert.ok(section(s, 'uat').split('\n').find((l) => l.startsWith('1. ')).includes("the owner's answers"));
});

test('turbo-phase skill: the plan step is done only with the whole plan set, so a lane interrupted inside chunked planning resumes it', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const plan = section(s, 'plan').split('\n');
  const p1 = plan.find((l) => l.startsWith('1. '));
  const p3 = plan.find((l) => l.startsWith('3. '));
  for (const n of ['`has_plans` true', '`turbo-run phase-step N --check plan`', '`plan set complete`', '`plan set incomplete: …`', 'point 2']) assert.ok(p1.includes(n), n);
  for (const n of ['`has_plans` still false', '**fail**', '`plan set incomplete: …`']) assert.ok(p3.includes(n), n);
  // review: a plan GSD wrote but an interruption kept from its commit is committed before the step counts as done
  for (const n of ['`git status --porcelain -- <phase dir>`', 'committed first', '`gsd-tools commit']) assert.ok(p1.includes(n), n);
  assert.ok(!/`has_plans` true → done/.test(p1), 'has_plans alone no longer marks the step done');
});

test('turbo-phase skill: the lane hands its temporary-files rule (rule 7) to every subagent, unchanged; a run by hand keeps subagents inside the checkout and the temp directory', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const conv = s.slice(s.indexOf('\n## Conventions\n'), s.indexOf('\n## The step loop\n')).split('\n');
  const line = conv.find((l) => l.startsWith('- Temporary files'));
  assert.ok(line, 'a Conventions bullet');
  for (const n of ['rule 7', 'unchanged', 'every subagent prompt', 'executors', 'continuation agents', 'planners', 'turbo-uat', 'by hand', 'nothing else goes outside the checkout', '`.planning/turbo/run/tdd/`']) assert.ok(line.includes(n), n);
});

test('turbo-phase skill: the watchdog\'s line makes the lane go on and never start the supervisor itself', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const p = s.slice(s.indexOf('`warn: the supervisor is not running …`'));
  assert.ok(s.indexOf('`warn: the supervisor is not running …`') > s.indexOf('\nInbox: before each step'), 'next to the inbox');
  assert.match(p, /^`warn: the supervisor is not running …` \(from `turbo-run inbox`, `ask` or `lane-status`\): .*Go on with the point you are in\. Never start, stop or restart the supervisor yourself \(`turbo-run start` and `resume` refuse in a lane\)/);
});

test('turbo-phase skill: the plan step is done only with turbo\'s own record of the plan check; a lane cut before GSD\'s plan-checker runs the checker pass, never planning again', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const plan = section(s, 'plan').split('\n');
  const p1 = plan.find((l) => l.startsWith('1. '));
  const p3 = plan.find((l) => l.startsWith('3. '));
  const p6 = plan.find((l) => l.startsWith('6. '));
  for (const n of ['`plan set unchecked: …`', 'the checker pass only, never planning again', '`gsd-plan-checker`', '`<gsd-core>/workflows/plan-phase.md`', '`gsd-planner` revision', 'one revision round at most', 'then points 4, 5 and 6']) assert.ok(p1.includes(n), n);
  // review I1/M3: GSD's own record of the planning (its steps 13b-13d) follows the checker pass
  for (const n of ['`gsd-tools query state.planned-phase --phase N', '`gsd-tools query roadmap.annotate-dependencies N`', '`commit_docs`', '"docs(<padded phase>): create phase plan"', '.planning/STATE.md .planning/ROADMAP.md']) assert.ok(p1.includes(n), n);
  assert.ok(p1.indexOf('`gsd-plan-checker`') < p1.indexOf('state.planned-phase') && p1.indexOf('create phase plan"') < p1.indexOf('then points 4, 5 and 6'), 'checker, then GSD\'s record, then points 4-6');
  assert.ok(p3.includes('until point 6 has recorded the plan check'), p3);
  assert.ok(p6, 'point 6');
  for (const n of ['`turbo-run phase-step N --plan-checked --note', 'Auto-Advance Check', "point 1's checker pass", 'create phase plan` commit', '`plan_checker`, else `workflow.plan_check`', 'SUMMARY']) assert.ok(p6.includes(n), n);
  // freshness's own checker round over a whole plan set counts too
  const fresh = section(s, 'freshness');
  assert.ok(fresh.includes('`turbo-run phase-step N --plan-checked --note "freshness re-check"`'), 'freshness records its checker round');
});

test('turbo-phase skill: the lane\'s write guard is named, and a denial is never worked around through Bash', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  const line = s.split('\n').find((l) => l.startsWith('- Temporary files'));
  for (const n of ['write guard', 'Write, Edit, MultiEdit and NotebookEdit', "the lane's temporary directory", "the control root's `.planning/turbo`", 'never get around a denial through Bash']) assert.ok(line.includes(n), n);
});

// --- Stage 6 L2: lean mode (spec §5.2-§5.4) ---------------------------------------------------------------------------

const skillText = () => fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8').replace(/\r\n/g, '\n');

test('turbo-phase skill (lean): the Lean mode section carries the inserts verbatim and the lean procedures', () => {
  const s = skillText();
  const at = s.indexOf('\n## Lean mode\n');
  assert.ok(at > 0, 'the section exists');
  const lean = s.slice(at, s.indexOf('\n## Steps\n'));
  for (const rule of [LEAN_RESEARCH_RULE, LEAN_PLANNER_RULE, LEAN_CHECKER_RULE]) assert.ok(lean.includes(rule), rule.slice(0, 40));
  for (const n of [
    'lean: on', 'When the workflow spawns gsd-phase-researcher', 'When the workflow spawns gsd-code-reviewer', 'turbo-run jobs N regate --json',
    'turbo-run jobs N review --json', '`n` above 2', '`fallback`', 'verifier_dispatch', '--about-review', 'skip: lean:',
    'turbo-run state-sync N --no-commit', '"docs(phase-N): <step> records"', 'stop records', 'pause records',
    // review: the diff reviews are bounded and survive GSD skipping every --files path; the re-gate checks its gates ran
    'turbo-run phase-step N --attempt review-diff', '`n` above 3', 'the same without `--files`', 'sub-points 1 to 3',
    'produced no artifact', 'With `code-review` among the jobs', 'never open threats',
  ]) assert.ok(lean.includes(n), n);
  assert.ok(!lean.includes('\n### '), 'bold labels only: no ### inside, so every step section keeps its own end');
  assert.ok(!lean.includes('draft later'));
});

test('turbo-phase skill (lean): every step that changes has its one Lean line', () => {
  const s = skillText();
  const conv = s.slice(s.indexOf('\n## Conventions\n'), s.indexOf('\n## The step loop\n')).split('\n');
  const bullet = conv.find((l) => l.startsWith('- **Lean:** '));
  assert.ok(bullet && bullet.includes(LEAN_EXECUTOR_REFS), 'the executor reference diet');
  const lines = (text) => text.split('\n').filter((l) => LEAN_LINE.test(l));
  assert.equal(lines(s.slice(s.indexOf('## The step loop'), s.indexOf('### Stopping early'))).length, 3, 'step loop points 1, 2 and 4');
  for (const name of ['Stopping early', 'Stale report', 'freshness', 'prologue', 'plan', 'execute', 'fanout', 'fix', 'final-gate']) {
    assert.ok(lines(section(s, name)).length > 0, name);
  }
  const plan = lines(section(s, 'plan')).join('\n');
  for (const n of ['--skip-research', 'turbo-run jobs N research']) assert.ok(plan.includes(n), n);
  const fanout = lines(section(s, 'fanout')).join('\n');
  for (const n of ['secure-phase.md', 'never Accept', 'direct: true']) assert.ok(fanout.includes(n), n);
  assert.ok(lines(section(s, 'final-gate')).join('\n').includes('**Re-gate**'));
  assert.ok(lines(section(s, 'Stale report')).join('\n').includes('**Re-gate**'));
  assert.ok(lines(section(s, 'Stopping early')).join('\n').includes('stop records'));
});

test('turbo-phase skill (lean): the lean text stays under 9000 bytes', () => {
  const s = skillText();
  const size = Buffer.byteLength(s) - Buffer.byteLength(stripLean(s));
  assert.ok(size > 0 && size < 9000, `${size} bytes`);
});
