# gsd-turbo Stage 3 S4 — live sittings (`attend`), release rules, `gap_rounds` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner run the tail of a phase that needs them in their own Claude Code session (`/turbo-autonomous attend N`, `turbo-run attend N [--done]`) and hand it back to its lane; give lanes and that session one release rule (never overwrite a running executable, never kill a process that holds a file) and one gap-plan rule (re-run only the failed items' checks); and replace the hard single gap-closure round of `/turbo-phase`'s `execute` and `uat` steps with `gap_rounds` rounds that each must bring new evidence.

**Architecture:** `lib/attend.mjs` owns the attend mark (`run/p<N>-attend.json`; its existence is the mark), the plans left (`openPlans`) and the release of the checkpoints a stopped lane waited at (`releaseStops`, through S1a's `withPhaseLock`). `turbo-run attend N` (in `bin/turbo-run.mjs`, next to `resume` and `stop`, which it reuses) stops the daemon and the lane session, writes the mark and releases the stops; `attend N --done` is `resume N --start`, and `resume` clears the mark. The supervisor's `step` holds every lane while any mark exists. `lib/gap-rounds.mjs` reads the evidence of a round (the verification report's failing must-haves and score, or the UAT rows that do not pass) and decides each round of `turbo-run phase-step N --attempt execute|uat` against `gap_rounds` and the previous round's evidence. The release and gap-plan rules are two constants in `lib/lane-prompt.mjs`, given to every lane and copied verbatim into both skills. The owner's flow lives in `skills/turbo-autonomous/SKILL.md`; the lane's gap rounds in `skills/turbo-phase/SKILL.md`.

**Tech Stack:** Node ≥ 20 (ESM `.mjs`, `node:test`, zero npm dependencies), git, Claude Code background sessions (2.1.29x), GSD 1.16.

**Spec:** `docs/specs/2026-10-10-stage-3-design.md` — §8 (S4: `/turbo-autonomous attend N`, the release rules, `gap_rounds`, the gap-plan rule) is the scope, with `gap_rounds` of §10 and S4's tests of §11; §5.5 and §9 for how a lane session is stopped and woken (`claude stop <job id>` keeps the conversation; a flagless `claude --bg --resume <sessionId>` wakes the same session).

**Base:** `main` at `7e00aa8` (gsd-turbo 0.2.2) with these plans executed and merged first, in this order: S0 `docs/plans/2026-10-10-stage-3-s0-transcripts.md`, S2 `docs/plans/2026-10-10-stage-3-s2-push-ci.md`, S1a `docs/plans/2026-10-11-stage-3-s1-owner-channel.md`, S1b `docs/plans/2026-10-11-stage-3-s1b-telegram.md`, S3 `docs/plans/2026-10-11-stage-3-s3-live-view.md`. Existing code is referenced by function name and anchor text, never by line number. If an anchor moved, apply the same change next to the named code.

What this plan consumes from the earlier plans, by exact name (it re-implements none of them):
- S1a `lib/questions.mjs`: `withPhaseLock`, `readQuestions`, `writeQuestions`, `refreshQuestions`, `stopQuestion`, `deliveryState`; `lib/answers.mjs`: `answerQuestion`, `preAnswerText`. The question fields `stopped`, `agentId`, `state`, `kind`, `rev`.
- S1a CLI: `turbo-run questions N`, `turbo-run questions N --preanswers <plan>`, `turbo-run questions --open --json`, `turbo-run answer N <id> … --by session --rev <rev>`; `TURBO_LANE` in every lane session's env (lanes never answer); the supervisor's `wakeForAnswers` and `checkStall` (held, not edited); `laneSystemPrompt`'s two unnumbered S1 rules.
- S1a skills: `skills/turbo-phase/SKILL.md` section `### Owner questions` with **Pre-answers** and **At a checkpoint**; `skills/turbo-autonomous/SKILL.md` sections `## If the arguments are \`answer\`` and `## Answer the open questions` (the last section).
- S1a tests: `test/helpers/plans.mjs` (`DECISION_PLAN`, `VERIFY_PLAN`, `ACTION_PLAN`, `writePhase`); `test/supervisor-wake.test.mjs` (`harness`, `fresh`, `STOP_Q`, `owner`, `stopForOwner`); the `allowed-tools` pin in `test/skill.test.mjs`.
- S2: `ATTEMPTS` / `countAttempt` in `lib/phase-progress.mjs` (`ci` counts like a step); `pushRule` as the last element of `laneSystemPrompt`'s array; the `### Push and CI` section and the Conventions bullet `- Never \`git push\`, … (section **Push and CI**).` of `skills/turbo-phase/SKILL.md`; `deps.supervisorAlive` for phase commands.
- S0: `DEFAULTS.stall_minutes`; `openQuestions` (through S1a). S1b: nothing directly (its Telegram poll runs inside the daemon, which `attend` stops). S3: the `--watch` branch at the top of `case 'status'` (left as it is).

## Decisions this plan makes where the spec is open

- **D1 The mark.** `.planning/turbo/run/p<N>-attend.json` `{ phase, at, sessionId }`. Its existence is the mark: an empty or unparseable file still holds the lanes, so a damaged mark never lets a lane start next to the owner. Not in `supervisor.json` (only a running daemon writes that) and not in the lane record (the lane writes that).
- **D2 Attend stops the daemon.** `turbo-run attend N` stops the daemon (`stopDaemon`) before it writes the mark, then every lane session of this checkout (`stopLanes`, which runs `claude stop`: the conversation is kept). No tick can run alongside (an S1a wake's `claude --bg --resume` can take up to 120 s). During the sitting no supervisor runs: no Telegram poll, no CI watch; `--done` starts it again.
- **D3 Every lane is held.** The spec says "this lane"; while any phase is attended the owner's session is a writer in the checkout, so a supervisor started meanwhile (another terminal, `start --only M`) starts, relaunches, wakes and notifies no lane at all, logged once per set of marks.
- **D4 Preconditions.** Phase N must be the supervisor's lane (`supervisor.json` `lane.phase`) and have plans without a SUMMARY. Without a lane, a phase GSD completes during the sitting would be skipped by the scheduler (complete phases never start) and never get turbo's gates and UAT. Refusals change nothing. A lane that is still working is stopped too (spec: attend stops the session); the skill then checks the tree and the worktrees before anything runs.
- **D5 Hand-back.** `turbo-run attend N --done` is exactly `turbo-run resume N --start`; `resume N` clears the mark too (an owner's resume hands the phase back), so a sitting that ended without `--done` is recovered by either.
- **D6 Stops are released.** At attend, the phase's questions with `stopped: true` become questions asked ahead (`stopped: false`, `agentId: null`): their agents belonged to the stopped session, which the owner's session never reaches. An answer given at the stop reaches the attended executor as a pre-answer (`preAnswerText`), and the lane session after `--done` gets no stale delivery sentence.
- **D7 Questions in the sitting.** Phase N's open questions except `human-action` ones (spec: physical actions are done when the run reaches them), through S1a's **Answer the open questions** with that filter.
- **D8 Sequential in the main checkout.** Every executor is dispatched without `isolation="worktree"`; right before each dispatch and each retry the session runs `gsd-tools query dispatch-isolation --raw --phase <phase> --plan <plan id> --force-isolation none` (the form of lane rule 6). GSD's gates go off first (`turbo-run gates off N`), as in a lane; the lane runs restore and the fan-out after the hand-back. No gap closure in the sitting: the lane's `execute` step closes gaps within `gap_rounds`.
- **D9** `turbo-run attend` (both forms) refuses inside a lane (`TURBO_LANE`), like S1a's `answer`.
- **D10 Evidence of a round.** `execute`: the verification report's frontmatter `score` and, for each `gaps` entry, its `status` and `truth`. `uat`: every UAT row whose result is not `pass`, with its result. Free text (`reason`, `missing`, `artifacts`, `reported`) never counts: a verifier writes it anew on every run. "Failed differently" is a different status or result.
- **D11 Round rule.** Round 1 always runs (within the budget). Round n > 1 runs only when the evidence differs from what round n − 1 recorded (`run/p<N>-gap-rounds.json`). Evidence that cannot be read at round n > 1 stops; a missing earlier record proves nothing and the round runs (the budget still bounds it).
- **D12 `gap_rounds` values.** A whole number of 0 or more, or a digit string (the file is edited by hand); anything else is the default 1. `0` means no gap round: the first gaps stop for the owner.
- **D13** `final-gate` keeps its single gap round outside `gap_rounds` (the spec names only `execute` and `uat`); its text now names that round itself instead of pointing at `execute`'s, which became a loop.
- **D14 Release rule.** One constant `RELEASE_RULE` (`lib/lane-prompt.mjs`) in every lane's system prompt (both modes), appended to every executor and continuation agent prompt, and copied verbatim into both skills (tests keep them identical). The spec's `<release>/<время>/` is written as "a new directory named after the UTC time under the release directory (for example release/2026-10-11T12-00-00Z/)": no angle brackets that a Markdown viewer would hide, no colons that Windows paths refuse. A locked file: the executor returns a `checkpoint:human-action`; the lane records it through S1a's **At a checkpoint** (`--kind human-action`) and stops `owner-only` with a reason that ends with the programmatic-quit recommendation.
- **D15 Gap-plan rule.** One constant `GAP_PLAN_RULE`, appended to the gsd-planner prompt (and its revisions) whenever GSD plans gap closure (`plan-phase --gaps`, or verify-work planning its fixes), in both modes.
- **D16** `turbo-run status` names each attended phase (text and `--json`).
- **D17 Where the code lives.** `attend` is a supervisor-control command like `start`, `stop` and `resume`, so it lives in `bin/turbo-run.mjs` (it stops the daemon and starts it), with its logic in `lib/attend.mjs`; the gap rounds live in `lib/gap-rounds.mjs`, wired into `phase-step` in `lib/cli-phase.mjs`.

## Global Constraints

- Node ≥ 20, ESM `.mjs` only, **zero runtime npm dependencies**; tests use `node:test` and `node:assert/strict`.
- Windows and Linux (CI: Linux / Node 22; dev: Windows / Node 24): paths with `path.join` / `path.resolve`; child processes only through `execFileSync`, `spawnSync` or `spawn` with an argument array, `windowsHide: true` and a timeout, never a shell.
- Public repository: no personal names, private project names, hosts, paths, emails or real transcript content in code, tests, fixtures or commits.
- Spec values, verbatim:
  - `/turbo-autonomous attend N`; `turbo-run attend N` marks the lane `attended` and stops its session (`claude stop`, the conversation is kept); while the mark stands the supervisor does not relaunch it;
  - the skill shows the remaining plans (without SUMMARY) and all their questions and asks for the answers up front, in one batch;
  - GSD `execute-phase N` in the main checkout, sequentially: before each dispatch `gsd-tools dispatch-isolation --force-isolation none`; conditional pre-answers go into the executors' prompts; physical actions are done by the owner when the run reaches them;
  - `turbo-run attend N --done` clears the mark and does `resume N --start`; the lane continues `/turbo-phase` (verifier, gates, UAT, close);
  - release rules (lane rule and `attend`): a running executable is never overwritten, a build is copied to a new path (`<release>/<time>/`); a file locked by a process → the process is not killed, the session stops (`owner-only`) with an exact instruction; a programmatic quit of the app (IPC, or `--quit` of a second instance) is the project's job, written into the stop reason as a recommendation;
  - config key `"gap_rounds": 1` (default 1); it replaces the hard single gap-closure round of the `execute` and `uat` steps; each round must bring new evidence, a round without a new result stops;
  - a gap plan re-runs only the checks of the failed items, never the whole live run (lane rule for `gsd-plan-phase --gaps`).
- Lane prompts (`--append-system-prompt` and the user prompt) contain no `"` and no `%` and never start with `-`. Owner text never goes into any `claude` argv.
- Read-only toward Claude Code: nothing under `<claude-home>` is written, moved or deleted.
- State files are written with `writeJsonAtomic` (`lib/fsx.mjs`); a phase's questions change only inside S1a's `withPhaseLock`.
- The supervisor decides deterministically; no LLM in its loop. While any phase is attended it starts, relaunches and wakes no lane.
- Tests never touch the network, a real `claude` or the developer's Claude home. A test that spawns `bin/turbo-run.mjs` for `attend` passes `TURBO_LANE: ''` in the child's env.
- TDD. While implementing a task, run only the test files that task names (`node --test <files>`), never the full suite (`npm test`): the controller runs it once at merge. One commit per task, conventional style, the repository's configured identity. Never push, merge, tag or install; never `--no-verify`.

## Review Focus

1. **A damaged or forgotten attend mark** (an empty or unparseable `p<N>-attend.json`, or the owner's session crashed mid-sitting). Expected: it still holds every lane, never a lane next to the owner; `turbo-run status` names it and how to hand the phase back. Pinned in Task 4 (`a broken mark holds too`, `attendedPhases` lists a broken mark) and Task 5 (the status line).
2. **The owner answers, during the sitting, the question the stopped lane waits at** (session, pane or Telegram). Expected: the stopped session is not woken; the answer reaches the attended executor as a pre-answer; the next lane session gets no stale delivery. Pinned in Task 4 (`releaseStops` with `preAnswerText` and `deliveryState`; no answer wake while attended).
3. **The verifier rewords its gaps** (another `reason`, CRLF line endings, quotes around truths) while the same must-haves stay failed. Expected: no new evidence → the round stops. Pinned in Task 1.
4. **`gap_rounds` hand-edited** to `"3"`, `0`, `-1`, `2.5` or `null`. Expected: 3, 0 (the first gaps stop), else the default 1; never NaN, never unbounded. Pinned in Task 1.
5. **A supervisor started while a phase is attended** (`/turbo-autonomous` in another terminal, `start --only M`). Expected: no lane of any phase starts until the mark is gone. Pinned in Task 4 (`no lane starts while any phase is attended`).

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/gap-rounds.mjs` | create | `GAP_STEPS`, `gapRounds`, `verificationGaps`, `uatProblems`, `gapEvidence`, `gapRound` |
| `lib/attend.mjs` | create | `attendFile`, `writeAttend`, `clearAttend`, `attendedPhases`, `openPlans`, `releaseStops` |
| `lib/config.mjs` | modify | `DEFAULTS.gap_rounds = 1` |
| `lib/cli-phase.mjs` | modify | `phase-step N --attempt execute` and `--attempt uat` decide a gap round |
| `lib/lane-prompt.mjs` | modify | `RELEASE_RULE`, `GAP_PLAN_RULE`; two lane rules before S2's push rule |
| `lib/supervisor.mjs` | modify | `step` holds every lane while a phase is attended |
| `bin/turbo-run.mjs` | modify | `USAGE`; `resumePhase` (out of `case 'resume'`, clears the mark); `attend`; `case 'attend'`; `status` names attended phases |
| `skills/turbo-phase/SKILL.md` | modify | Conventions: **Releases**, **Gap plans**; the step loop's point 3; `execute` point 2, `final-gate` point 1, `uat` point 6 |
| `skills/turbo-autonomous/SKILL.md` | modify | frontmatter; new section for the arguments `attend <phase>` |
| `README.md` | modify | Use; Inside a phase; rounds; Automated UAT; Config `gap_rounds`; Safety **Releases**; section Live sittings |
| `test/gap-rounds.test.mjs`, `test/attend.test.mjs` | create | tests |
| `test/lane-prompt.test.mjs`, `test/skill-turbo-phase.test.mjs`, `test/supervisor-wake.test.mjs`, `test/cli.test.mjs`, `test/skill.test.mjs` | modify | imports, one pin, appended tests |

Files other Stage 3 plans also change (merge-conflict risk; every S4 edit is anchored on a name or a quoted line): `lib/supervisor.mjs` (S1a, S2), `lib/lane-prompt.mjs` (S1a, S2), `lib/cli-phase.mjs` (S1a, S2), `lib/config.mjs` `DEFAULTS` (S0, S1b, S2, S3), `bin/turbo-run.mjs` (S0, S1a, S2, S3), both skills (S1a, S2), `README.md` (all), `test/supervisor-wake.test.mjs` and `test/skill.test.mjs` (S1a).

## Contracts

- **Mark** `.planning/turbo/run/p<N>-attend.json`: `{ "phase": "4", "at": "<ISO time of the first attend>", "sessionId": "<lane job id>" | null }`; the file's existence is the mark.
- **`turbo-run attend <N>`**: refusals exit 1 on stderr and change nothing (`phase N is not the supervisor's lane …`, `phase N has no plan without a summary: nothing to attend …`, `no single phase directory …`, `refused: attend is the owner's: a lane never runs it`). Otherwise, after `stopDaemon`'s and `stopLanes`'s own lines: `phase <N>: attended in this session; no lane starts, relaunches or wakes until turbo-run attend <N> --done`, `open plans: <ids>`, and `released stops: <ids> (asked ahead again)` when any. Exit 0, or 1 when a lane session did not stop (the mark stays).
- **`turbo-run attend <N> --done`**: exactly `turbo-run resume <N> --start`. `turbo-run resume <N>` removes the mark too.
- **`turbo-run status`**: `attended: phase <N> since <at> in the owner's session (hand it back: turbo-run attend <N> --done)`; `--json` gains `attended: [{ phase, at }]`.
- **`turbo-run phase-step <N> --attempt execute|uat`** (exit 0 either way): `attempt <step> <n> of <max>: go`, or `attempt <step> <n> of <max>: stop: <reason>` with the reason `the gap_rounds budget of <max> is used up across sessions`, `no new evidence: round <n-1> left the same <k> failing item(s) in <file>` or `no result to compare: <why>`. Every other `--attempt <step>` prints `attempt <step> <n>` as before.
- **`run/p<N>-gap-rounds.json`**: `{ "execute": { n, hash, failing, file, at }, "uat": { … } }`.
- **`RELEASE_RULE`, `GAP_PLAN_RULE`**: exported strings of `lib/lane-prompt.mjs`, without `"` or `%`.

---

### Task 1: `gap_rounds` — the evidence of a round and `phase-step --attempt execute|uat`

**Files:**
- Create: `lib/gap-rounds.mjs`
- Modify: `lib/config.mjs` (`DEFAULTS`)
- Modify: `lib/cli-phase.mjs` (imports; `function phaseStep`, its `--attempt` branch)
- Test: `test/gap-rounds.test.mjs` (create)

**Interfaces:**
- Consumes: `countAttempt(root, phase, step, { now })` (`lib/phase-progress.mjs`, S2's `ATTEMPTS` accepts `execute` and `uat`); `findPhaseDir`, `phaseArtifacts` (`lib/phase-files.mjs`); `parseUat` (`lib/uat.mjs`); `runDir`; `readJson`, `writeJsonAtomic`; `DEFAULTS`, `loadConfig` (`lib/config.mjs`).
- Produces (in `lib/gap-rounds.mjs`):
  - `GAP_STEPS = ['execute', 'uat']`;
  - `gapRounds(config) → number` (whole number ≥ 0);
  - `verificationGaps(text) → { score: string, gaps: Array<{ status, truth }> } | null`;
  - `uatProblems(text) → string[]` (`"<n>. <name>: <result>"`, sorted);
  - `gapEvidence(root, phase, step) → { file, failing, items } | { file, items: null, why }`;
  - `gapRound(root, phase, step, { config, now }) → { step, n, max, go, reason, file, failing }`.
- CLI: `turbo-run phase-step N --attempt execute|uat` prints `attempt <step> <n> of <max>: go` or `…: stop: <reason>`.

- [ ] **Step 1: Write the failing tests**

Create `test/gap-rounds.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { UAT } from './fixtures/uat-sample.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { clearAttempts, readProgress } from '../lib/phase-progress.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { GAP_STEPS, gapEvidence, gapRound, gapRounds, uatProblems, verificationGaps } from '../lib/gap-rounds.mjs';

// The gaps of a GSD verification report (agents/gsd-verifier.md, Step 10): nested artifacts and missing lists, quoted
// and plain values, and a deferred list after them.
const LOGIN = ['  - truth: "Login: the form signs in"', '    status: failed', '    reason: "Route returns 500"', '    artifacts:', '      - path: "src/a.ts"', '        issue: "stub"', '    missing:', '      - "real handler"'];
const LOGOUT = ['  - truth: Logout clears the session', '    status: partial', "    reason: 'cookie remains'"];
const report = (gaps, { score = '3/5 must-haves verified' } = {}) => [
  '---', 'phase: 03-demo', 'status: gaps_found', `score: ${score}`, 'covered_files:', '  - src/a.ts',
  ...(gaps.length ? ['gaps:', ...gaps] : []),
  'deferred:', '  - truth: "Addressed in a later phase"', '    addressed_in: "Phase 5"',
  '---', '', '# Phase 3: Demo Verification Report', '', '- truth: not frontmatter', '',
].join('\n');

function project({ config } = {}) {
  const root = tmpDir('gap');
  const dir = path.join(root, '.planning', 'phases', '03-demo');
  fs.mkdirSync(dir, { recursive: true });
  if (config) {
    fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
    fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify(config));
  }
  return {
    root, dir,
    verification: (text) => fs.writeFileSync(path.join(dir, '03-VERIFICATION.md'), text),
    uat: (text) => fs.writeFileSync(path.join(dir, '03-UAT.md'), text),
  };
}
const round = (root, step, rounds) => gapRound(root, '3', step, { config: { ...DEFAULTS, ...(rounds === undefined ? {} : { gap_rounds: rounds }) } });

test('gap_rounds: 1 by default; a whole number of 0 or more, a digit string too; anything else is the default (Review Focus 4)', () => {
  assert.equal(DEFAULTS.gap_rounds, 1);
  assert.deepEqual(GAP_STEPS, ['execute', 'uat']);
  const cases = [[3, 3], ['3', 3], [' 2 ', 2], [0, 0], ['0', 0], [undefined, 1], [null, 1], [-1, 1], [2.5, 1], ['x', 1], ['', 1], [true, 1], ['-2', 1]];
  for (const [v, want] of cases) assert.equal(gapRounds({ gap_rounds: v }), want, JSON.stringify(v));
  assert.equal(gapRounds(undefined), 1);
});

test('verificationGaps: the score and each gap\'s status and truth; reasons, nested lists, deferred items and the body never count; CRLF reads the same', () => {
  const want = { score: '3/5 must-haves verified', gaps: [{ status: 'failed', truth: 'Login: the form signs in' }, { status: 'partial', truth: 'Logout clears the session' }] };
  assert.deepEqual(verificationGaps(report([...LOGIN, ...LOGOUT])), want);
  assert.deepEqual(verificationGaps(report([...LOGIN, ...LOGOUT]).replace(/\n/g, '\r\n')), want);
  assert.deepEqual(verificationGaps(report([])), { score: '3/5 must-haves verified', gaps: [] });
  assert.deepEqual(verificationGaps(report(['  - truth: Only a truth'])).gaps, [{ status: 'failed', truth: 'Only a truth' }]);
  assert.equal(verificationGaps('# no frontmatter\n'), null);
  assert.equal(verificationGaps('---\nstatus: gaps_found\n'), null, 'a frontmatter that never closes');
});

test('uatProblems: every UAT row that does not pass, with its result', () => {
  assert.deepEqual(uatProblems(UAT), [
    '1. Settings page shows the saved value: pending', '2. Owner signs the release: pending',
    '3. Page shows the code and an SMS arrives on the phone: pending', '4. Export button downloads a CSV: pending',
  ]);
  assert.deepEqual(uatProblems(UAT.replace(/result: \[pending\]/g, 'result: pass')), []);
});

test('execute gap rounds: the first always runs; rewording the same gaps is no new evidence (Review Focus 3)', () => {
  const p = project();
  p.verification(report([...LOGIN, ...LOGOUT]));
  let r = round(p.root, 'execute', 3);
  assert.deepEqual([r.n, r.max, r.go, r.failing, r.file], [1, 3, true, 2, '03-VERIFICATION.md']);
  // the verifier ran again: other words, CRLF, the same must-haves failed the same way
  p.verification(report([...LOGIN.map((l) => l.replace('Route returns 500', 'The route still answers 500')), ...LOGOUT]).replace(/\n/g, '\r\n'));
  r = round(p.root, 'execute', 3);
  assert.deepEqual([r.n, r.go, r.reason], [2, false, 'no new evidence: round 1 left the same 2 failing item(s) in 03-VERIFICATION.md']);
  assert.equal(readProgress(p.root, '3').attempts.execute, 2, 'counted like every attempt');
});

test('execute gap rounds: a closed gap or a moved score is new evidence; the budget still ends the rounds; the owner\'s resume starts afresh', () => {
  const p = project();
  p.verification(report([...LOGIN, ...LOGOUT]));
  assert.equal(round(p.root, 'execute', 3).go, true);
  p.verification(report(LOGIN, { score: '4/5 must-haves verified' }));
  assert.equal(round(p.root, 'execute', 3).go, true);
  let r = round(p.root, 'execute', 3);
  assert.deepEqual([r.n, r.go, r.reason], [3, false, 'no new evidence: round 2 left the same 1 failing item(s) in 03-VERIFICATION.md']);

  const q = project();
  q.verification(report([...LOGIN, ...LOGOUT]));
  assert.equal(round(q.root, 'execute').go, true, 'default budget 1');
  q.verification(report(LOGIN));
  r = round(q.root, 'execute');
  assert.deepEqual([r.n, r.max, r.go, r.reason], [2, 1, false, 'the gap_rounds budget of 1 is used up across sessions']);
  clearAttempts(q.root, '3');
  r = round(q.root, 'execute');
  assert.deepEqual([r.n, r.go], [1, true], 'the owner\'s resume: a fresh budget');

  const z = project();
  z.verification(report(LOGIN));
  r = round(z.root, 'execute', 0);
  assert.deepEqual([r.n, r.max, r.go, r.reason], [1, 0, false, 'the gap_rounds budget of 0 is used up across sessions']);
});

test('uat gap rounds compare the UAT rows that do not pass; without a result to read, a later round stops', () => {
  const p = project();
  p.uat(UAT);
  assert.equal(gapEvidence(p.root, '3', 'uat').failing, 4);
  assert.equal(round(p.root, 'uat', 3).go, true);
  p.uat(UAT.replace('result: pass', 'result: issue'));
  assert.equal(round(p.root, 'uat', 3).go, true, 'a row failed differently');
  let r = round(p.root, 'uat', 3);
  assert.deepEqual([r.go, r.reason], [false, 'no new evidence: round 2 left the same 5 failing item(s) in 03-UAT.md']);

  const q = project();
  q.verification(report(LOGIN));
  assert.equal(round(q.root, 'execute', 3).go, true);
  fs.rmSync(path.join(q.dir, '03-VERIFICATION.md'));
  r = round(q.root, 'execute', 3);
  assert.deepEqual([r.go, r.reason], [false, 'no result to compare: no VERIFICATION.md for phase 3']);
});

test('turbo-run phase-step N --attempt execute|uat prints the round and its verdict; other attempts print as before', async () => {
  const p = project({ config: { gap_rounds: '2' } });
  p.verification(report(LOGIN));
  const lines = [];
  const run = (...a) => runPhaseCommand('phase-step', a, { root: p.root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) });
  assert.equal(await run('3', '--attempt', 'execute'), 0);
  assert.equal(lines.at(-1), 'attempt execute 1 of 2: go');
  assert.equal(await run('3', '--attempt', 'execute'), 0);
  assert.equal(lines.at(-1), 'attempt execute 2 of 2: stop: no new evidence: round 1 left the same 1 failing item(s) in 03-VERIFICATION.md');
  assert.equal(await run('3', '--attempt', 'uat'), 0);
  assert.equal(lines.at(-1), 'attempt uat 1 of 2: go');
  assert.equal(await run('3', '--attempt', 'fix'), 0);
  assert.equal(lines.at(-1), 'attempt fix 1');
  assert.ok(fs.existsSync(path.join(p.root, '.planning', 'turbo', 'run', 'p3-gap-rounds.json')));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/gap-rounds.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/gap-rounds.mjs`.

- [ ] **Step 3: Implement**

`lib/config.mjs` — in `DEFAULTS`, add right after the line `  max_restarts_without_progress: 3,`:

```js
  // spec §8 (S4): gap-closure rounds a phase may run after verification (execute) and after UAT (uat), each
  gap_rounds: 1,
```

Create `lib/gap-rounds.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { DEFAULTS } from './config.mjs';
import { countAttempt } from './phase-progress.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { parseUat } from './uat.mjs';

// spec §8 (S4): the gap-closure rounds of /turbo-phase's execute step (after verification) and uat step (after UAT).
// At most gap_rounds of each per phase, counted across sessions with phase-step --attempt; a round after the first
// runs only when the previous one brought new evidence, else the phase stops for the owner.
export const GAP_STEPS = Object.freeze(['execute', 'uat']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const indentOf = (line) => line.length - line.trimStart().length;
const roundsFile = (root, phase) => path.join(runDir(root), `p${phase}-gap-rounds.json`);
const digest = (items) => createHash('sha256').update(JSON.stringify(items)).digest('hex');

function unquote(v) {
  const s = String(v).trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

// gap_rounds from the turbo config: a whole number of 0 or more (a digit string counts: the file is edited by hand);
// anything else is the default. 0 means no gap-closure round: the first gaps stop for the owner.
export function gapRounds(config) {
  const v = config?.gap_rounds;
  if (Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v);
  return DEFAULTS.gap_rounds;
}

// The failing items of a GSD verification report (its frontmatter, agents/gsd-verifier.md Step 10): the score, and
// each entry of gaps as its status and truth. The free text around them (reason, missing, artifacts) is written anew
// by every verifier run, so it never counts. null without a closed frontmatter.
export function verificationGaps(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  let score = '';
  const gaps = [];
  let inGaps = false;
  let dash = -1;
  let cur = null;
  const take = (s) => {
    const m = /^(truth|status):\s*(.*)$/.exec(s);
    if (m && cur) cur[m[1]] = flat(unquote(m[2]));
  };
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (top) {
      inGaps = top[1] === 'gaps';
      if (top[1] === 'score') score = flat(unquote(top[2]));
      continue;
    }
    if (!inGaps) continue;
    // an entry of gaps starts at the first dash's column; deeper dashes are its nested lists
    const item = /^(\s*)-\s+(.*)$/.exec(line);
    if (item && (dash < 0 || item[1].length === dash)) {
      dash = item[1].length;
      cur = { status: '', truth: '' };
      gaps.push(cur);
      take(item[2]);
    } else if (cur && indentOf(line) === dash + 2) {
      take(line.trim());
    }
  }
  return { score, gaps: gaps.map((g) => ({ status: g.status || 'failed', truth: g.truth })) };
}

// The UAT rows that do not pass, with their result (turbo-uat rewrites the free text on every run).
export const uatProblems = (text) => parseUat(text).tests.filter((t) => t.result !== 'pass').map((t) => `${t.number}. ${flat(t.name)}: ${t.result}`).sort();

// What a round of the step is judged by: the phase's verification report (execute) or UAT file (uat).
export function gapEvidence(root, phase, step) {
  const dir = findPhaseDir(root, phase);
  const kind = step === 'execute' ? 'VERIFICATION.md' : 'UAT file';
  const name = dir ? phaseArtifacts(dir)[step === 'execute' ? 'verification' : 'uat'] : null;
  if (!name) return { file: null, items: null, why: `no ${kind} for phase ${phase}` };
  let text;
  try {
    text = fs.readFileSync(path.join(dir, name), 'utf8');
  } catch (err) {
    return { file: name, items: null, why: `${name} cannot be read (${err.code || err.message})` };
  }
  if (step === 'uat') {
    const items = uatProblems(text);
    return { file: name, failing: items.length, items };
  }
  const v = verificationGaps(text);
  if (!v) return { file: name, items: null, why: `${name} has no frontmatter` };
  return { file: name, failing: v.gaps.length, items: [`score: ${v.score}`, ...v.gaps.map((g) => `${g.status}: ${g.truth}`)].sort() };
}

// turbo-run phase-step N --attempt execute|uat: counts the round across sessions, then decides it. Round 1 runs within
// the budget; a later round runs only when the evidence differs from what the round before it recorded. Evidence
// that cannot be read at a later round stops; a missing earlier record proves nothing and the round runs.
export function gapRound(root, phase, step, { config = {}, now = new Date() } = {}) {
  if (!GAP_STEPS.includes(step)) throw new Error(`not a gap step: ${step}`);
  const n = countAttempt(root, phase, step, { now });
  const max = gapRounds(config);
  const ev = gapEvidence(root, phase, step);
  const hash = ev.items ? digest(ev.items) : null;
  const saved = readJson(roundsFile(root, phase), {});
  const all = isObj(saved) ? saved : {};
  const prev = isObj(all[step]) ? all[step] : null;
  let reason = '';
  if (n > max) reason = `the gap_rounds budget of ${max} is used up across sessions`;
  else if (n > 1 && !hash) reason = `no result to compare: ${ev.why}`;
  else if (n > 1 && prev?.n === n - 1 && prev.hash === hash) reason = `no new evidence: round ${n - 1} left the same ${ev.failing} failing item(s) in ${ev.file}`;
  writeJsonAtomic(roundsFile(root, phase), { ...all, [step]: { n, hash, failing: ev.failing ?? null, file: ev.file, at: now.toISOString() } });
  return { step, n, max, go: !reason, reason, file: ev.file, failing: ev.failing ?? null };
}
```

`lib/cli-phase.mjs`:
1. Add to the imports: `import { GAP_STEPS, gapRound } from './gap-rounds.mjs';`
2. In `function phaseStep`, inside `if (flags.has('--attempt')) {`, replace the line `    out(\`attempt ${step} ${countAttempt(root, phase, step)}\`);` with:

```js
    // spec §8 (S4): execute's and uat's gap-closure rounds: at most gap_rounds, each with new evidence
    if (GAP_STEPS.includes(step)) {
      const r = gapRound(root, phase, step, { config: loadConfig(root) });
      out(`attempt ${step} ${r.n} of ${r.max}: ${r.go ? 'go' : `stop: ${r.reason}`}`);
      return 0;
    }
    out(`attempt ${step} ${countAttempt(root, phase, step)}`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/gap-rounds.test.mjs test/phase-progress.test.mjs test/config.test.mjs`
Expected: PASS (7 new tests; `phase-progress.test.mjs` and `config.test.mjs` unchanged and green: `loadConfig` without a file still equals `DEFAULTS`, and `--attempt fix` still prints `attempt fix <n>`).

- [ ] **Step 5: Commit**

```bash
git add lib/gap-rounds.mjs lib/config.mjs lib/cli-phase.mjs test/gap-rounds.test.mjs
git commit -q -m "feat: gap_rounds bounds the gap-closure rounds of execute and uat; a later round runs only after new evidence"
```

---

### Task 2: Lane rules — releases and gap plans

**Files:**
- Modify: `lib/lane-prompt.mjs` (two exported constants above `export function laneSystemPrompt`; two elements of its array)
- Modify: `skills/turbo-phase/SKILL.md` (`## Conventions`)
- Modify: `README.md` (`## Safety`)
- Test: `test/lane-prompt.test.mjs` (import, then append), `test/skill-turbo-phase.test.mjs` (import, then append)

**Interfaces:**
- Consumes: `laneSystemPrompt({ phase, turboRun, contextPct, autonomy, mode, tmpDir, pushMode })` with S1a's two unnumbered rules and S2's `...pushRule({ phase, turboRun, pushMode })` as its last element; S1a's skill parts **Pre-answers** and **At a checkpoint**.
- Produces: `RELEASE_RULE` and `GAP_PLAN_RULE` (exported strings of `lib/lane-prompt.mjs`); the lane rules `Releases: …` and `Gap plans: …` in both modes, right before S2's push rule; the Conventions bullets `- Releases (spec §8): …` and `- Gap plans (spec §8): …` of `skills/turbo-phase/SKILL.md` (Tasks 3 and 6 point at them).

- [ ] **Step 1: Write the failing tests**

In `test/lane-prompt.test.mjs`, replace `import { laneSystemPrompt, laneUserPrompt } from '../lib/lane-prompt.mjs';` with:

```js
import { GAP_PLAN_RULE, RELEASE_RULE, laneSystemPrompt, laneUserPrompt } from '../lib/lane-prompt.mjs';
```

Append:

```js
test('S4 lane rules: releases and gap plans in both modes, before the push rule; no double quotes or percent signs', () => {
  for (const mode of ['safe', 'full']) {
    const s = laneSystemPrompt({ phase: '3', turboRun: 'node x', contextPct: 55, autonomy: 'standard', mode, pushMode: 'after-phase' });
    const lines = s.split('\n');
    const rel = lines.findIndex((l) => l.startsWith('Releases: '));
    const gap = lines.findIndex((l) => l.startsWith('Gap plans: '));
    const push = lines.findIndex((l) => l.startsWith('Push and CI'));
    assert.ok(rel > 0 && gap > rel && push > gap, `${mode}: ${rel} ${gap} ${push}`);
    assert.ok(lines[rel].includes(RELEASE_RULE) && lines[gap].includes(GAP_PLAN_RULE), mode);
    for (const n of ['every gsd-executor and continuation agent', 'owner-only stop', 'never kill the process', 'recommended for the project: a programmatic quit', 'IPC', '--quit']) assert.ok(lines[rel].includes(n), n);
    for (const n of ['--gaps', 'verify-work', 'gsd-planner', 'revision prompt']) assert.ok(lines[gap].includes(n), n);
    assert.ok(!s.includes('"') && !s.includes('%') && !s.startsWith('-'), mode);
  }
  for (const n of ['UTC time under the release directory', 'leave the running copy alone', 'never kill or stop that process', 'checkpoint:human-action', 'the exact step for the owner']) assert.ok(RELEASE_RULE.includes(n), n);
  for (const n of ['only the checks of the items that failed', 'never re-runs the whole live run']) assert.ok(GAP_PLAN_RULE.includes(n), n);
  for (const r of [RELEASE_RULE, GAP_PLAN_RULE]) assert.ok(!/["%<>]/.test(r), r);
});
```

In `test/skill-turbo-phase.test.mjs`, add right after `import { STEPS } from '../lib/phase-progress.mjs';`:

```js
import { GAP_PLAN_RULE, RELEASE_RULE } from '../lib/lane-prompt.mjs';
```

Append:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/lane-prompt.test.mjs test/skill-turbo-phase.test.mjs`
Expected: FAIL — both files with `The requested module '../lib/lane-prompt.mjs' does not provide an export named 'GAP_PLAN_RULE'`.

- [ ] **Step 3: Write the rules, the skill bullets and the README bullet**

`lib/lane-prompt.mjs` — right above `export function laneSystemPrompt`, add:

```js
// spec §8 (S4): the release rule. Executors and continuation agents get it appended to their prompts (in a lane and in
// the owner's attend sitting); a lane follows it itself. A plain argv value: no double quotes, no percent signs, no
// angle brackets (a Markdown viewer hides them in the skills, which copy it verbatim), never a leading dash.
export const RELEASE_RULE = `Never overwrite an executable, or any other file, that a running process holds open: build or copy each release into a new directory named after the UTC time under the release directory (for example release/2026-10-11T12-00-00Z/) and leave the running copy alone. When a file you must replace stays locked by a running process, never kill or stop that process: stop at that point and return a checkpoint:human-action that names the file, the process holding it (its name and PID when known) and the exact step for the owner (for example: quit the app, then answer done). A way to make the app quit on request (an IPC call, or --quit sent to a second instance) is the project's own work: name it in that checkpoint as a recommendation, and never build it unasked.`;

// spec §8 (S4): a gap plan checks the failed items only; the phase's whole live run is not repeated for a gap.
export const GAP_PLAN_RULE = 'A gap plan re-runs only the checks of the items that failed (the failed must-haves of the verification report, or the UAT tests with issues) and the tests of the files it changes. It never re-runs the whole live run of the phase: no full UAT pass, no end-to-end or live pass over every item.';
```

In `laneSystemPrompt`, in the array that is joined with `'\n'`, right before S2's element `...pushRule({ phase, turboRun, pushMode }),` (and after S1a's two unnumbered rules), insert:

```js
    // spec §8 (S4): releases never overwrite a running executable or kill a process; gap plans check the failed items only
    `Releases: ${RELEASE_RULE} Add that rule, unchanged, to the prompt of every gsd-executor and continuation agent you dispatch, and follow it yourself. A file locked by a running process is an owner-only stop: never kill the process; the stop reason names the file, the process and the owner's exact step, and ends with: recommended for the project: a programmatic quit (an IPC call, or --quit sent to a second instance).`,
    `Gap plans: whenever GSD plans gap closure (plan-phase with --gaps, or verify-work planning the fixes for its issues), add this paragraph, unchanged, at the end of the gsd-planner prompt and of each revision prompt: ${GAP_PLAN_RULE}`,
```

`skills/turbo-phase/SKILL.md` — in `## Conventions`, right after the bullet that starts `- Never \`git push\`, never force, never \`--no-verify\`.` (S2 extended it), add these two bullets (each on one line, the rule texts exactly as the constants above):

```markdown
- Releases (spec §8): Never overwrite an executable, or any other file, that a running process holds open: build or copy each release into a new directory named after the UTC time under the release directory (for example release/2026-10-11T12-00-00Z/) and leave the running copy alone. When a file you must replace stays locked by a running process, never kill or stop that process: stop at that point and return a checkpoint:human-action that names the file, the process holding it (its name and PID when known) and the exact step for the owner (for example: quit the app, then answer done). A way to make the app quit on request (an IPC call, or --quit sent to a second instance) is the project's own work: name it in that checkpoint as a recommendation, and never build it unasked. Add that rule, unchanged, at the end of every gsd-executor and continuation agent prompt (after the plan's **Pre-answers**, section **Owner questions**), and follow it yourself. Never kill the process. When an agent returns that checkpoint, run **At a checkpoint** with `--kind human-action` and the owner's exact step as `--question`, and **stop for the owner** with the reason `owner question <id>: <file> locked by <process>: <the owner's step>; recommended for the project: a programmatic quit (an IPC call, or --quit sent to a second instance)`.
- Gap plans (spec §8): whenever GSD plans gap closure (`gsd-plan-phase --gaps`, or verify-work planning the fixes of its issues), add this, unchanged, at the end of the gsd-planner prompt and of each revision prompt: A gap plan re-runs only the checks of the items that failed (the failed must-haves of the verification report, or the UAT tests with issues) and the tests of the files it changes. It never re-runs the whole live run of the phase: no full UAT pass, no end-to-end or live pass over every item.
```

`README.md` — in `## Safety`, right after the bullet that starts `- **Git and data.**`, add:

```markdown
- **Releases.** Sessions never overwrite a running executable: a build goes into a new directory named after the UTC time under the release directory (`release/2026-10-11T12-00-00Z/`, for example). A file that a running process holds is never freed by killing the process: the session stops for you with the file, the process and the exact step (for example, quit the app). Making the app quit on request (an IPC call, or `--quit` sent to a second instance) is the project's own work; the stop reason recommends it. The same rule goes into every executor prompt, also in your own `attend` sitting (see [Live sittings](#live-sittings)).
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/lane-prompt.test.mjs test/skill-turbo-phase.test.mjs test/lane-mode.test.mjs`
Expected: PASS (2 new tests; every existing test unchanged and green: the system prompt still has no `"` or `%`, the full-mode prompt still has no `deploy yourself`, `Defer only owner-only items` or `Do everything else in the phase first`).

- [ ] **Step 5: Commit**

```bash
git add lib/lane-prompt.mjs skills/turbo-phase/SKILL.md README.md test/lane-prompt.test.mjs test/skill-turbo-phase.test.mjs
git commit -q -m "feat: lanes keep releases next to running executables and never kill a process; gap plans check the failed items only"
```

---

### Task 3: `/turbo-phase` — gap rounds in `execute` and `uat`

**Files:**
- Modify: `skills/turbo-phase/SKILL.md` (`## The step loop` point 3; `### execute` point 2; `### final-gate` point 1; `### uat` point 6)
- Modify: `README.md` (`### Inside a phase`, the rounds paragraph, `## Automated UAT`, `## Config`)
- Test: `test/skill-turbo-phase.test.mjs` (append)

**Interfaces:**
- Consumes: Task 1's `turbo-run phase-step N --attempt execute|uat` lines (`attempt <step> <n> of <max>: go` / `…: stop: <reason>`); Task 2's Conventions bullet **Gap plans**.
- Produces: the `execute` and `uat` steps loop over gap rounds within `gap_rounds`; `final-gate` keeps one round of its own.

- [ ] **Step 1: Write the failing test**

Append to `test/skill-turbo-phase.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/skill-turbo-phase.test.mjs`
Expected: FAIL — the new test (`execute: attempt execute <n> of <max>: go`).

- [ ] **Step 3: Rewrite the steps and the README**

`skills/turbo-phase/SKILL.md`:

1. In `## The step loop`, point 3, replace `(gap closure, fix iterations, final-gate rounds, the UAT repeat)` with `(the gap-closure rounds of execute and uat, fix iterations, final-gate rounds)`.

2. In `### execute`, point 2, replace the whole bullet that starts `   - \`gaps_found\`: first \`turbo-run phase-step N --attempt execute\`.` (it ends `("verification gaps remain after one gap-closure round").`) with:

```markdown
   - `gaps_found`: gap-closure rounds (G13), at most `gap_rounds` of them (`.planning/turbo/config.json`, default 1), each of which must bring new evidence. Each round starts with `turbo-run phase-step N --attempt execute`. It prints `attempt execute <n> of <max>: go`, or `attempt execute <n> of <max>: stop: <reason>` when the budget is used up across sessions or the previous round left the verification report's failing must-haves and score as they were → **stop for the owner** ("verification gaps remain: <reason>"). On `go`: `Skill(skill="gsd-plan-phase", args="N --gaps")` (Conventions, **Gap plans**; when it reaches its Auto-Advance Check, do not launch execute-phase; G5), then `Skill(skill="gsd-execute-phase", args="N --gaps-only --no-transition")`, then run point 2 again.
```

3. In `### final-gate`, point 1, replace the bullet `   - \`gaps_found\`: as in point 2 of step **execute**, without its \`--attempt execute\` (this pass is counted already).` with:

```markdown
   - `gaps_found`: one gap-closure round, outside `gap_rounds` (the `--attempt final-gate` above counts this pass; no `--attempt execute` here): `Skill(skill="gsd-plan-phase", args="N --gaps")` (Conventions, **Gap plans**; at its Auto-Advance Check do not launch execute-phase; G5), then `Skill(skill="gsd-execute-phase", args="N --gaps-only --no-transition")`, then check again; still `gaps_found` → **stop for the owner** ("verification gaps remain after the final-gate gap-closure round").
```

4. In `### uat`, replace the whole point that starts `6. If verify-work found issues (turbo-uat \`issue\` rows), it plans their gap closure.` (it ends `("UAT issues remain after one gap-closure round").`) with:

```markdown
6. If verify-work found issues (turbo-uat `issue` rows), it plans their gap closure (Conventions, **Gap plans**). Then `turbo-run phase-step N --attempt uat`. It prints `attempt uat <n> of <max>: go`, or `attempt uat <n> of <max>: stop: <reason>` when `gap_rounds` (default 1) is used up across sessions or the previous round brought no new evidence (the UAT rows that do not pass are as they were) → **stop for the owner** ("UAT issues remain: <reason>"). On `go`: `Skill(skill="gsd-execute-phase", args="N --gaps-only --no-transition")`, then `TURBO_FULL=1 turbo-run test-changed` (red → **fail** ("full test suite red after UAT gap closure")), then repeat points 1–5; when verify-work finds issues again, this point runs again.
```

`README.md`:

1. In `### Inside a phase (`/turbo-phase`)`, point 6, replace `and one gap-closure round when the verifier finds gaps;` with `and up to \`gap_rounds\` gap-closure rounds (default 1) when the verifier finds gaps;`.
2. Replace `(for example verification gaps left after one gap-closure round,` with `(for example verification gaps left after the gap-closure rounds,`.
3. Replace the paragraph that starts `The bounded rounds (one gap-closure round in \`execute\`` with:

```markdown
The bounded rounds (up to `gap_rounds` gap-closure rounds in `execute` and in `uat`, default 1 each; 3 code-review fix iterations; 2 red rounds in `final-gate`) are counted across sessions: a session that restarts a step after a context pause or a crash goes on from the earlier count, and the phase stops for you when a budget is used up. Your `/turbo-autonomous resume <N>` starts a fresh budget. A gap-closure round after the first runs only when the previous one brought new evidence: the verification report's failing must-haves and score (`execute`), or the UAT rows that do not pass (`uat`), changed; other words for the same failures do not count. A round that left them as they were stops the phase for you, whatever budget is left. A gap plan re-runs only the checks of the failed items, never the phase's whole live run.
```

4. In `## Automated UAT (`turbo-uat`)`, replace `turns issues into a gap closure, which the phase runs once.` with `turns issues into a gap closure, which the phase runs up to \`gap_rounds\` times (default 1).`
5. In `## Config`, right after the `max_restarts_without_progress` row, add:

```markdown
| `gap_rounds` | `1` | Gap-closure rounds a phase may run after verification and, separately, after UAT, counted across sessions (0 or more; 0 stops at the first gaps). A round after the first runs only when the previous one changed the result. |
```

Check the README: `grep -n "gap_rounds" README.md` lists exactly four lines: point 6 of Inside a phase, the rounds paragraph, the Automated UAT sentence and the Config row.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/skill-turbo-phase.test.mjs`
Expected: PASS (every test in the file, including the first one's needles `turbo-run phase-step N --attempt execute`, `--attempt uat` and `budget used up across sessions`, which the fix and final-gate steps still carry).

- [ ] **Step 5: Commit**

```bash
git add skills/turbo-phase/SKILL.md README.md test/skill-turbo-phase.test.mjs
git commit -q -m "feat: turbo-phase closes gaps in up to gap_rounds rounds in execute and uat, each with new evidence"
```

---

### Task 4: The attend mark, released stops, and a supervisor that holds every lane

**Files:**
- Create: `lib/attend.mjs`
- Modify: `lib/supervisor.mjs` (imports; the start of `async function step`)
- Test: `test/attend.test.mjs` (create), `test/supervisor-wake.test.mjs` (imports, then append)

**Interfaces:**
- Consumes: S1a `withPhaseLock`, `readQuestions`, `writeQuestions` (`lib/questions.mjs`); in tests S1a's `refreshQuestions`, `stopQuestion`, `deliveryState`, `answerQuestion`, `preAnswerText`, `writeQuestions` and the `test/supervisor-wake.test.mjs` helpers `harness`, `fresh`, `STOP_Q`, `owner`, `stopForOwner`; `comparePhase` (`lib/scheduler.mjs`); `findPhaseDir`, `phaseArtifacts`.
- Produces (in `lib/attend.mjs`):
  - `attendFile(root, phase) → string` (`.planning/turbo/run/p<N>-attend.json`);
  - `writeAttend(root, phase, { sessionId = null, now } = {}) → { phase, at, sessionId }` (keeps an earlier mark's `at` and `sessionId`);
  - `clearAttend(root, phase) → boolean`;
  - `attendedPhases(root) → Array<{ phase, at | null }>` (phase order);
  - `openPlans(root, phase) → string[] | null` (plan ids without a SUMMARY; null without a single phase directory);
  - `releaseStops(root, phase) → string[]` (the ids it turned from stops into questions asked ahead).
- Supervisor: while `attendedPhases(root)` is not empty, `step` returns at once (no `loadPhases`, no `claude` call, no launch, relaunch, wake or notification); the state key `attendWait` holds the logged set.

- [ ] **Step 1: Write the failing tests**

Create `test/attend.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { ACTION_PLAN, DECISION_PLAN, VERIFY_PLAN, writePhase } from './helpers/plans.mjs';
import { deliveryState, refreshQuestions, stopQuestion } from '../lib/questions.mjs';
import { answerQuestion, preAnswerText } from '../lib/answers.mjs';
import { attendFile, attendedPhases, clearAttend, openPlans, releaseStops, writeAttend } from '../lib/attend.mjs';

const AG = 'a0123456789abcdef';

test('the attend mark: written once with its first time, listed in phase order, a broken one still listed, cleared once (Review Focus 1)', () => {
  const root = tmpDir('att');
  assert.deepEqual(attendedPhases(root), []);
  assert.deepEqual(writeAttend(root, '10', { sessionId: '1a2b3c4d', now: new Date('2026-01-01T10:00:00Z') }), { phase: '10', at: '2026-01-01T10:00:00.000Z', sessionId: '1a2b3c4d' });
  assert.deepEqual(writeAttend(root, '10', { now: new Date('2026-01-01T11:00:00Z') }), { phase: '10', at: '2026-01-01T10:00:00.000Z', sessionId: '1a2b3c4d' }, 'a second attend keeps the first mark');
  writeAttend(root, '4', { now: new Date('2026-01-01T12:00:00Z') });
  fs.writeFileSync(attendFile(root, '7'), ''); // broken
  fs.writeFileSync(`${attendFile(root, '9')}.tmp-123`, '{}'); // a half-written temp file is no mark
  assert.deepEqual(attendedPhases(root), [{ phase: '4', at: '2026-01-01T12:00:00.000Z' }, { phase: '7', at: null }, { phase: '10', at: '2026-01-01T10:00:00.000Z' }]);
  assert.equal(path.basename(attendFile(root, '4')), 'p4-attend.json');
  assert.equal(clearAttend(root, '4'), true);
  assert.equal(clearAttend(root, '4'), false);
  assert.deepEqual(attendedPhases(root).map((a) => a.phase), ['7', '10']);
});

test('openPlans: the plans without a SUMMARY; null without a single phase directory', () => {
  const root = tmpDir('att');
  const dir = writePhase(root, '04-four', { '04-01-PLAN.md': 'x', '04-01-SUMMARY.md': 'x', '04-02-PLAN.md': 'x', '04-03-PLAN.md': 'x' });
  assert.deepEqual(openPlans(root, '4'), ['04-02', '04-03']);
  assert.equal(openPlans(root, '5'), null);
  for (const f of ['04-02-SUMMARY.md', '04-03-SUMMARY.md']) fs.writeFileSync(path.join(dir, f), 'x');
  assert.deepEqual(openPlans(root, '4'), []);
});

test('releaseStops: the checkpoints a stopped lane waits at are asked ahead again; an answer given at the stop reaches the attended executor as a pre-answer (Review Focus 2)', () => {
  const root = tmpDir('att');
  writePhase(root, '32-auth', { '32-09-PLAN.md': DECISION_PLAN, '32-10-PLAN.md': VERIFY_PLAN, '32-11-PLAN.md': ACTION_PLAN });
  refreshQuestions(root, '32');
  stopQuestion(root, '32', '32-10-t3', { agentId: AG });
  answerQuestion({ root, phase: '32', id: '32-10-t3', option: 1, by: 'session', laneRunning: true });
  stopQuestion(root, '32', '32-11-t2', { agentId: AG });
  assert.deepEqual(deliveryState(root, '32').ready.map((q) => q.id), ['32-10-t3'], 'without the release the next lane session would deliver it');
  assert.equal(preAnswerText(root, '32', '32-10'), '', 'a stop is delivered, never pre-answered');

  assert.deepEqual(releaseStops(root, '32'), ['32-10-t3', '32-11-t2']);
  assert.deepEqual(deliveryState(root, '32'), { waiting: [], ready: [] });
  const list = refreshQuestions(root, '32');
  const v = list.find((q) => q.id === '32-10-t3');
  assert.deepEqual([v.stopped, v.agentId, v.state], [false, null, 'answered']);
  assert.match(preAnswerText(root, '32', '32-10'), /At checkpoint task 3 \(checkpoint:human-verify\) the owner's answer is: approved\./);
  const a = list.find((q) => q.id === '32-11-t2');
  assert.deepEqual([a.stopped, a.state, a.options.map((o) => o.defer)], [false, 'open', [true]], 'a physical action is asked ahead as a preference again');
  assert.deepEqual(releaseStops(root, '32'), []);
  assert.deepEqual(releaseStops(tmpDir('att-none'), '3'), []);
});
```

In `test/supervisor-wake.test.mjs`, add to the import block:

```js
import { attendFile, clearAttend, writeAttend } from '../lib/attend.mjs';
```

Append to `test/supervisor-wake.test.mjs`:

```js
test('while a phase is attended the supervisor wakes, stall-wakes, relaunches and notifies nothing; the mark gone, the forced relaunch goes on (S4)', async () => {
  const h = harness();
  let s = await tick(fresh(), h.ctx); // lane 1a2b3c4d works
  writeAttend(h.root, '2', { sessionId: '1a2b3c4d', now: h.now() });
  h.activity = { lastMs: h.now().getTime(), active: 0 };
  h.advance(20); // silent longer than stall_minutes: a stall wake without the mark
  s = await tick(s, h.ctx);
  writeQuestions(h.root, '2', [STOP_Q()]);
  stopForOwner(h);
  owner(h, '02-01-t2', 1); // the owner answers the question the lane stopped at: an answer wake without the mark
  h.advance(1);
  s = await tick(s, h.ctx);
  s.lane.forceRelaunch = true; // what resume N leaves for a daemon
  h.advance(30);
  s = await tick(s, h.ctx);
  assert.deepEqual([h.resumed.length, h.stopped.length, h.removed.length, h.launched.length], [0, 0, 0, 1]);
  assert.equal(h.logs.filter((l) => l.startsWith("attended in the owner's session: phase 2;")).length, 1, h.logs.join('\n'));
  assert.ok(!h.notes.some((n) => ['laneBlocked', 'laneStalled', 'laneNeedsOwner'].includes(n.key)), JSON.stringify(h.notes));
  assert.equal(s.attendWait, '2');
  clearAttend(h.root, '2');
  s = await tick(s, h.ctx);
  assert.deepEqual([h.removed, h.launched.length], [['1a2b3c4d'], 2]);
  assert.equal(s.attendWait, undefined);
});

test('no lane starts while any phase is attended; a broken mark holds too (Review Focus 1, 5)', async () => {
  const h = harness();
  fs.mkdirSync(path.dirname(attendFile(h.root, '7')), { recursive: true });
  fs.writeFileSync(attendFile(h.root, '7'), ''); // another phase, and a broken mark
  let s = await tick(fresh(), h.ctx);
  s = await tick(s, h.ctx);
  assert.deepEqual([h.launched.length, s.lane, s.attendWait], [0, null, '7']);
  assert.equal(h.logs.filter((l) => l.startsWith("attended in the owner's session: phase 7;")).length, 1);
  clearAttend(h.root, '7');
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/attend.test.mjs test/supervisor-wake.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/attend.mjs` (both files).

- [ ] **Step 3: Implement**

Create `lib/attend.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { comparePhase } from './scheduler.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { readQuestions, withPhaseLock, writeQuestions } from './questions.mjs';

// spec §8 (S4): run/p<N>-attend.json marks a phase the owner runs in their own session (turbo-run attend N). The
// file's existence is the mark: an empty or broken one still holds every lane, so a damaged mark never lets a lane
// start next to the owner. Its content ({ phase, at, sessionId }) only informs.
const MARK_RE = /^p(.+)-attend\.json$/;
export const attendFile = (root, phase) => path.join(runDir(root), `p${phase}-attend.json`);

// Writes the mark; an earlier mark of the phase keeps its time and its session.
export function writeAttend(root, phase, { sessionId = null, now = new Date() } = {}) {
  const prev = readJson(attendFile(root, phase), null);
  const rec = {
    phase: String(phase),
    at: typeof prev?.at === 'string' ? prev.at : now.toISOString(),
    sessionId: typeof prev?.sessionId === 'string' && prev.sessionId ? prev.sessionId : sessionId,
  };
  writeJsonAtomic(attendFile(root, phase), rec);
  return rec;
}

// Removes the mark; true when there was one.
export function clearAttend(root, phase) {
  const file = attendFile(root, phase);
  const had = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return had;
}

// Every attended phase in GSD's phase order: [{ phase, at }], at null when the mark cannot be read.
export function attendedPhases(root) {
  let names;
  try {
    names = fs.readdirSync(runDir(root));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.map((n) => MARK_RE.exec(n)?.[1]).filter(Boolean).sort(comparePhase).map((phase) => {
    const rec = readJson(attendFile(root, phase), null);
    return { phase, at: typeof rec?.at === 'string' ? rec.at : null };
  });
}

// The phase's plans without a SUMMARY, by id: what the owner's session executes. null without a single phase directory.
export function openPlans(root, phase) {
  const dir = findPhaseDir(root, phase);
  return dir ? phaseArtifacts(dir).plans.filter((p) => !p.hasSummary).map((p) => p.id) : null;
}

// spec §8 with §5.5: the checkpoints a stopped lane waits at become questions asked ahead again. Their agents belong
// to the lane session attend stopped, which the owner's session never reaches. An answer given at the stop stays and
// reaches the executor the owner's session dispatches as a pre-answer (turbo-run questions N --preanswers); an open
// one is asked ahead, its options rebuilt from the plan at the next refresh. Returns the ids it released.
export function releaseStops(root, phase) {
  return withPhaseLock(root, phase, () => {
    const list = readQuestions(root, phase);
    const ids = list.filter((q) => q.stopped).map((q) => q.id);
    if (ids.length) writeQuestions(root, phase, list.map((q) => (q.stopped ? { ...q, stopped: false, agentId: null } : q)));
    return ids;
  });
}
```

`lib/supervisor.mjs`:
1. Add to the imports: `import { attendedPhases } from './attend.mjs';`
2. In `async function step(s, ctx, now)`, right after its line `  const at = now.toISOString();`, insert:

```js
  // spec §8 (S4): while the owner attends a phase in their own session (turbo-run attend N), that session is the only
  // writer in this checkout: no lane of that phase or any other starts, relaunches, wakes or is notified until
  // turbo-run attend N --done or resume N clears the mark. Logged once per set of marks.
  const attended = attendedPhases(root).map((a) => a.phase).join(', ');
  if (attended) {
    if (s.attendWait !== attended) deps.log(`attended in the owner's session: phase ${attended}; no lane starts, relaunches or wakes until turbo-run attend <phase> --done`);
    s.attendWait = attended;
    return;
  }
  delete s.attendWait;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/attend.test.mjs test/supervisor-wake.test.mjs test/supervisor.test.mjs`
Expected: PASS (3 new tests in `test/attend.test.mjs`, 2 new in `test/supervisor-wake.test.mjs`; every existing supervisor test unchanged: their projects have no `run/` directory or no mark).

- [ ] **Step 5: Commit**

```bash
git add lib/attend.mjs lib/supervisor.mjs test/attend.test.mjs test/supervisor-wake.test.mjs
git commit -q -m "feat: an attend mark holds every lane; the stops of an attended phase are asked ahead again"
```

---

### Task 5: `turbo-run attend N [--done]`; `resume` clears the mark; `status` names it

**Files:**
- Modify: `bin/turbo-run.mjs` (imports; `USAGE`; new `async function resumePhase` built from `case 'resume'`; new `function attend`; `case 'resume'`; new `case 'attend'`; `case 'status'`)
- Test: `test/cli.test.mjs` (append)

**Interfaces:**
- Consumes: Task 4's `attendedPhases`, `clearAttend`, `openPlans`, `releaseStops`, `writeAttend`; in `bin/turbo-run.mjs` `stopDaemon(root, sup)`, `stopLanes(root, before)`, `start(root)`, `keptRange`, `supAlive`, `pollOf`, `clearAttempts`, `supPath`, `die`, `out`; in `test/cli.test.mjs` its `fakeProject`, `sleeper`, `exited`, `runAsync`, `run`, `writeSup`, `readSup`, `readJsonFile`, `runDirOf`, `waitFor`, `logOf`, `plainProject`, `ago`, `laneSessionName`.
- Produces: the CLI of the Contracts section: `turbo-run attend <N>`, `turbo-run attend <N> --done` (= `resume <N> --start`), `resume <N>` removing the mark, `status` lines and `--json` `attended`.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.mjs`:

```js
// spec §8 (S4): phase 4 with plan 04-01 done and 04-02 open, a live supervisor whose lane is lanePhase, and a
// question the lane stopped at
function attendProject(t, { lanePhase = '4' } = {}) {
  const p = fakeProject({ phases: [{ number: '4', name: 'four', phase_complete: false }] });
  const dir = path.join(p.root, '.planning', 'phases', '04-four');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['04-01-PLAN.md', '04-01-SUMMARY.md', '04-02-PLAN.md']) fs.writeFileSync(path.join(dir, f), '# plan\n');
  const child = sleeper(t);
  writeSup(p.root, { pid: child.pid, updatedAt: ago(0), lane: { phase: lanePhase, sessionId: 'abc123' } });
  p.setClaude({ agents: [{ id: 'abc123', name: laneSessionName(p.root, lanePhase), cwd: p.root, state: 'blocked' }] });
  fs.writeFileSync(path.join(runDirOf(p.root), 'p4-questions.json'), JSON.stringify([
    { id: '04-02-t1', phase: '4', plan: '04-02', task: '1', kind: 'human-action', options: [], stopped: true, agentId: 'a0123456789abcdef', state: 'open', rev: 2 },
  ]));
  return { p, child, env: { ...p.env, TURBO_LANE: '' } };
}

test('attend N stops the supervisor and the lane session, marks the phase, releases its stops and names the open plans; status names the mark (S4)', async (t) => {
  const { p, child, env } = attendProject(t);
  const r = await runAsync(['attend', '4'], p.root, env);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(await exited(child), 'the supervisor is stopped');
  assert.equal(readSup(p.root).pid, null);
  assert.deepEqual(p.claudeCalls().filter((a) => a[0] === 'stop' || a[0] === 'rm'), [['stop', 'abc123']], 'claude stop keeps the conversation; nothing is removed');
  assert.match(r.stdout, /^phase 4: attended in this session; no lane starts, relaunches or wakes until turbo-run attend 4 --done$/m);
  assert.match(r.stdout, /^open plans: 04-02$/m);
  assert.match(r.stdout, /^released stops: 04-02-t1 \(asked ahead again\)$/m);
  const mark = readJsonFile(path.join(runDirOf(p.root), 'p4-attend.json'));
  assert.deepEqual([mark.phase, mark.sessionId, typeof mark.at], ['4', 'abc123', 'string']);
  assert.deepEqual(readJsonFile(path.join(runDirOf(p.root), 'p4-questions.json')).map((q) => [q.stopped, q.agentId]), [[false, null]]);
  assert.match(run(['status'], p.root, env), /^attended: phase 4 since \S+ in the owner's session \(hand it back: turbo-run attend 4 --done\)$/m);
  assert.deepEqual(JSON.parse(run(['status', '--json'], p.root, env)).attended.map((a) => a.phase), ['4']);
});

test('attend refuses, changing nothing, for a phase that is not the lane, a phase with every plan summarized, and inside a lane (S4)', async (t) => {
  const other = attendProject(t, { lanePhase: '5' });
  let r = await runAsync(['attend', '4'], other.p.root, other.env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /phase 4 is not the supervisor's lane \(that is phase 5\)/);
  assert.equal(await exited(other.child, 300), false, 'the supervisor still runs');
  assert.equal(fs.existsSync(path.join(runDirOf(other.p.root), 'p4-attend.json')), false);
  assert.deepEqual(other.p.claudeCalls(), []);

  const done = attendProject(t);
  fs.writeFileSync(path.join(done.p.root, '.planning', 'phases', '04-four', '04-02-SUMMARY.md'), '# done\n');
  r = await runAsync(['attend', '4'], done.p.root, done.env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /phase 4 has no plan without a summary: nothing to attend/);
  assert.equal(await exited(done.child, 300), false);
  for (const args of [['attend', '4'], ['attend', '4', '--done']]) {
    r = await runAsync(args, done.p.root, { ...done.env, TURBO_LANE: '1' });
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /refused: attend is the owner's: a lane never runs it/);
  }
  assert.equal(fs.existsSync(path.join(runDirOf(done.p.root), 'p4-attend.json')), false);
});

test('attend N --done clears the mark and does resume N --start; a plain resume N clears the mark too (S4)', async (t) => {
  const root = plainProject();
  writeSup(root, { pid: null, lane: { phase: '4', sessionId: 'abc' } });
  fs.writeFileSync(path.join(runDirOf(root), 'p4-attend.json'), '{}');
  assert.match(run(['resume', '4'], root), /phase 4 cleared; run: turbo-run start/);
  assert.equal(fs.existsSync(path.join(runDirOf(root), 'p4-attend.json')), false);

  const p = fakeProject({ phases: [{ number: '4', name: 'four', phase_complete: false }], config: { notify: { desktop: false, telegram: false }, poll_seconds: 5 } });
  t.after(() => { const pid = readSup(p.root)?.pid; if (pid) try { process.kill(pid); } catch { /* gone */ } });
  writeSup(p.root, { pid: null, lane: { phase: '4', sessionId: 'old111', restarts: 0, notified: {}, launchedAt: ago(5), fingerprint: 'x' } });
  fs.writeFileSync(path.join(runDirOf(p.root), 'p4-attend.json'), JSON.stringify({ phase: '4', at: ago(30), sessionId: 'old111' }));
  const r = await runAsync(['attend', '4', '--done'], p.root, { ...p.env, TURBO_LANE: '' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^phase 4 cleared$/m);
  assert.match(r.stdout, /started supervisor pid \d+ \(mode full\)/);
  assert.equal(fs.existsSync(path.join(runDirOf(p.root), 'p4-attend.json')), false);
  const sup = await waitFor(() => { const s = readSup(p.root); return s?.pid && s.lane?.sessionId === 'abcdef123456' ? s : null; }, 15000);
  assert.ok(sup, logOf(p.root));
  assert.ok(p.claudeCalls().some((a) => a[0] === 'rm' && a[1] === 'old111'), 'the stopped lane session goes; a new one resumes the phase');
  const stop = await runAsync(['stop'], p.root, p.env);
  assert.equal(stop.code, 0, stop.stderr);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern="S4" test/cli.test.mjs`
Expected: FAIL — `attend` is an unknown command (`usage: turbo-run <…>`, exit 1 where 0 is expected), and `resume 4` leaves `p4-attend.json` in place.

- [ ] **Step 3: Implement**

`bin/turbo-run.mjs`:

1. Add to the imports: `import { attendedPhases, clearAttend, openPlans, releaseStops, writeAttend } from '../lib/attend.mjs';`
2. In `USAGE`, replace `|resume|` with `|resume|attend|`.
3. Right before `async function main()`, add:

```js
// The owner's resume, and attend N --done (spec §8): clears the phase's lane record and its attend mark (the owner
// hands the phase back), gives turbo-phase's bounded rounds a fresh budget, arms a forced relaunch of its lane, and
// with andStart starts the supervisor.
async function resumePhase(root, id, andStart) {
  if (andStart) {
    // start would keep this range and never resume a phase outside it: refuse before anything changes
    const prev = readJson(supPath(root), null);
    const kept = keptRange(prev);
    if (kept && !inRange(id, kept)) {
      const stopFirst = supAlive(prev, pollOf(root)) ? 'turbo-run stop, then ' : '';
      die(`phase ${id} is outside the range ${rangeLabel(kept)} that start keeps; nothing was stopped, removed or started. To run phase ${id}, change the range: ${stopFirst}turbo-run start --only ${id} (or --from <phase>, or --all)`);
    }
  }
  // a live daemon (for example one waiting for the owner) rewrites supervisor.json every
  // tick; stop it first. The lane session is left alone: forceRelaunch replaces it.
  stopDaemon(root, readJson(supPath(root), null));
  fs.rmSync(path.join(runDir(root), `p${id}.json`), { force: true });
  clearAttend(root, id);
  // the owner's resume gives turbo-phase's bounded rounds a fresh budget; the steps done stay done
  clearAttempts(root, id);
  const sup = readJson(supPath(root), null);
  if (sup) {
    const lane = sup.lane && String(sup.lane.phase) === id ? { ...sup.lane, notified: {}, restarts: 0, forceRelaunch: true } : sup.lane || null;
    writeJsonAtomic(supPath(root), { ...sup, pid: null, finished: false, halted: false, lane });
  }
  if (andStart) {
    out(`phase ${id} cleared`);
    return start(root);
  }
  out(`phase ${id} cleared; run: turbo-run start`);
  return 0;
}

// spec §8 (S4): the owner takes the rest of phase N's plans into their own session (/turbo-autonomous attend N).
// Only the supervisor's own lane, and only while it has plans without a summary: refusals change nothing. The daemon
// stops first, so no tick (a wake, a relaunch) runs alongside; then the mark, which holds every lane of any later
// daemon until attend N --done or resume N clears it; then every lane session of this checkout stops (claude stop
// keeps the conversation). The checkpoints the lane stopped at are asked ahead again.
function attend(root, id) {
  const plans = openPlans(root, id);
  if (plans === null) die(`no single phase directory for phase ${id} under .planning/phases: nothing to attend`);
  if (!plans.length) die(`phase ${id} has no plan without a summary: nothing to attend. For owner-only UAT items run /gsd-verify-work ${id}, then /turbo-autonomous resume ${id}`);
  const sup = readJson(supPath(root), null);
  const lane = sup?.lane ? String(sup.lane.phase) : null;
  if (lane !== id) die(`phase ${id} is not the supervisor's lane${lane ? ` (that is phase ${lane})` : ''}: attend takes over the lane of the run (turbo-run status names it); nothing was stopped`);
  stopDaemon(root, sup);
  writeAttend(root, id, { sessionId: sup.lane.sessionId || null });
  const code = stopLanes(root, sup);
  const released = releaseStops(root, id);
  out(`phase ${id}: attended in this session; no lane starts, relaunches or wakes until turbo-run attend ${id} --done`);
  out(`open plans: ${plans.join(', ')}`);
  if (released.length) out(`released stops: ${released.join(', ')} (asked ahead again)`);
  if (code !== 0) process.stderr.write('a lane session did not stop (see the warnings above): stop it with claude stop <id> before anything runs in this checkout\n');
  return code;
}
```

4. Replace the whole `case 'resume': { … }` block in `main` with:

```js
    case 'resume': {
      const [phase] = pos;
      if (!root || !phase || !PHASE_ID.test(phase)) die('resume <phase> [--start]');
      return resumePhase(root, normalizePhaseId(phase), args.includes('--start'));
    }
    case 'attend': {
      // spec §8 (S4): attend <phase> takes the lane over for the owner's session; --done hands it back (resume --start)
      const [phase] = pos;
      if (!root || !phase || !PHASE_ID.test(phase)) die('attend <phase> [--done]');
      if (process.env.TURBO_LANE) die("refused: attend is the owner's: a lane never runs it");
      const id = normalizePhaseId(phase);
      return args.includes('--done') ? resumePhase(root, id, true) : attend(root, id);
    }
```

5. In `case 'status':` (after S3's `--watch` branch at its top), replace the line

```js
      if (args.includes('--json')) { out(JSON.stringify({ running, ...sup, ownerRequests, gatesOff: leftovers.gates }, null, 2)); return 0; }
```

with

```js
      const attended = attendedPhases(root); // spec §8: phases the owner runs in their session; no lane runs meanwhile
      if (args.includes('--json')) { out(JSON.stringify({ running, ...sup, ownerRequests, gatesOff: leftovers.gates, attended }, null, 2)); return 0; }
```

and right after the line `      for (const f of ownerRequests) out(\`owner request: ${f}\`);` add:

```js
      for (const a of attended) out(`attended: phase ${a.phase}${a.at ? ` since ${a.at}` : ''} in the owner's session (hand it back: turbo-run attend ${a.phase} --done)`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --check bin/turbo-run.mjs`, then `node --test --test-name-pattern="S4|resume" test/cli.test.mjs`
Expected: PASS (3 new tests; the existing `resume` tests unchanged: the moved code is the same).

- [ ] **Step 5: Commit**

```bash
git add bin/turbo-run.mjs test/cli.test.mjs
git commit -q -m "feat: turbo-run attend takes a lane over for the owner's session and attend --done hands it back"
```

---

### Task 6: `/turbo-autonomous attend <phase>` and the README

**Files:**
- Modify: `skills/turbo-autonomous/SKILL.md` (frontmatter; new section after S1a's `## If the arguments are \`answer\``)
- Modify: `README.md` (`## Use`; new section `## Live sittings` right before `## GSD settings turbo writes`, after S1a's `## Owner questions`)
- Test: `test/skill.test.mjs` (import; S1a's `allowed-tools` pin; append)

**Interfaces:**
- Consumes: Task 5's CLI (`attend <phase>`, `attend <N> --done`); S1a's `turbo-run questions <N>`, `questions <N> --preanswers <plan id>`, section **Answer the open questions**; `turbo-run gates off|restore`, `turbo-run state-sync`, `turbo-run doctor` (gsd-core line); `RELEASE_RULE` (Task 2).
- Produces: the owner's sitting: `/turbo-autonomous attend <phase>`.

- [ ] **Step 1: Write the failing test**

In `test/skill.test.mjs`, add right after `import fs from 'node:fs';`:

```js
import { RELEASE_RULE } from '../lib/lane-prompt.mjs';
```

In S1a's test `turbo-autonomous skill answers the open questions (S1): …`, replace `assert.match(s, /^allowed-tools: \[Bash, Read, AskUserQuestion\]$/m);` with:

```js
  assert.match(s, /^allowed-tools: \[Bash, Read, AskUserQuestion, Skill\]$/m);
```

Append:

```js
test('turbo-autonomous attend <phase> (S4): take over the lane, questions up front, GSD execute-phase one plan at a time in this checkout, hand back', () => {
  const s = fs.readFileSync('skills/turbo-autonomous/SKILL.md', 'utf8');
  assert.match(s, /^argument-hint: ".*\| resume <phase> \| attend <phase> \| answer"$/m);
  const at = s.indexOf('## If the arguments are `attend <phase>`');
  assert.ok(at > s.indexOf('## If the arguments are `answer`') && at < s.indexOf('## Otherwise'), 'its own section before the start flow');
  const a = s.slice(at, s.indexOf('## Otherwise'));
  const order = [
    'turbo-run.mjs" attend <phase>', 'turbo-run.mjs" doctor', 'git worktree list --porcelain', 'turbo-run.mjs" questions <N>',
    '**Answer the open questions**', 'turbo-run.mjs" gates off <N>', 'Skill(skill="gsd-execute-phase", args="<N> --no-transition")',
    'turbo-run.mjs" state-sync <N>', 'turbo-run.mjs" attend <N> --done',
  ];
  let last = -1;
  for (const n of order) {
    const i = a.indexOf(n);
    assert.ok(i > last, `in order: ${n}`);
    last = i;
  }
  const needles = [
    'isolation="worktree"', 'query dispatch-isolation --raw --phase', '--plan <the plan id> --force-isolation none', 'before each retry',
    'questions <N> --preanswers <plan id>', '`human-action`', RELEASE_RULE, 'never kill or stop that process', '`gap_rounds`',
    'resume <N> --start', 'Commit nothing and remove no worktree on your own',
  ];
  for (const n of needles) assert.ok(a.includes(n), n);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/skill.test.mjs`
Expected: FAIL — the changed S1a pin (`allowed-tools` without `Skill`) and the new test (`argument-hint` without `attend <phase>`).

- [ ] **Step 3: Write the skill section and the README**

`skills/turbo-autonomous/SKILL.md`:

1. Frontmatter: in the `argument-hint` line replace `| resume <phase> | answer"` with `| resume <phase> | attend <phase> | answer"`, and replace the line `allowed-tools: [Bash, Read, AskUserQuestion]` with `allowed-tools: [Bash, Read, AskUserQuestion, Skill]`.

2. Right after the section `## If the arguments are \`answer\`` (S1a) and before `## Otherwise: start the milestone run`, add (the release rule in point 6 on one line, exactly as `RELEASE_RULE`):

```markdown
## If the arguments are `attend <phase>`

The rest of the phase's plans run here, in this session, with the user, and then the phase goes back to its lane (spec §8). This is for plans that need the user while they run: a device to connect, a login, an app to quit. `<phase>` is the phase id from the arguments. Run every command from the project root.

1. **Take over the lane.** Run `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" attend <phase>`.
   - A non-zero exit: show its output and stop. A refusal changed nothing. A warning that a lane session did not stop means the user stops it (`claude stop <id>`) before anything else runs here.
   - It stopped the supervisor and the lane's session (the session's conversation is kept) and printed `phase <N>: attended …`: `<N>` below is that id. `open plans: …` names the plans without a summary; `released stops: …` names the checkpoints the lane had stopped at, which are asked ahead again.
2. **GSD core.** Run `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" doctor`. Exit code 2: show the failed checks and stop (the phase stays attended). `<gsd-core>` is the path on its `gsd-core` line.
3. **Clean checkout.** Run `git status --porcelain` and `git worktree list --porcelain`. Uncommitted changes, or a worktree besides this checkout (the stopped lane may have left an executor's work there), are the user's to decide: show them and ask what to do. Commit nothing and remove no worktree on your own. Go on only with an empty `git status --porcelain` and this checkout as the only worktree.
4. **Questions up front.** Run `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" questions <N>` and show its list next to the open plans: everything these plans will ask. Then run **Answer the open questions** (the last section) with two changes: in its point 1 keep only the questions whose `phase` is `<N>`, and leave out those whose `kind` is `human-action` (a physical action: the user does it when the run reaches it). No lane runs now, so `turbo-run answer` commits each answer itself.
5. **GSD's gates off.** Run `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" gates off <N>`, as a lane does before it executes; the lane runs those gates in parallel after the hand-back. If it refuses because another phase M still has GSD's gates off, run `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" gates restore M`, then `gates off <N>` again.
6. **Execute.** Run `Skill(skill="gsd-execute-phase", args="<N> --no-transition")` and follow GSD's workflow with these additions only:
   - One plan at a time, in this checkout: dispatch every executor without `isolation="worktree"`, as if `parallelization` were off and `USE_WORKTREES_FOR_PLAN` were `false` for every plan. Right before each executor `Agent()` call, and again before each retry of it, run `node "<gsd-core>/bin/gsd-tools.cjs" query dispatch-isolation --raw --phase <the phase as GSD writes it> --plan <the plan id> --force-isolation none`, with no other `dispatch-isolation` query in between: GSD's isolation guard reads a sentinel that goes stale after 10 minutes and that any other such query rewrites.
   - Right before each executor dispatch, and before each continuation agent GSD spawns after a checkpoint, run `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" questions <N> --preanswers <plan id>`. Add what it prints (nothing when the user answered no checkpoint of that plan ahead) unchanged at the end of the prompt GSD builds, and after it this release rule, unchanged: Never overwrite an executable, or any other file, that a running process holds open: build or copy each release into a new directory named after the UTC time under the release directory (for example release/2026-10-11T12-00-00Z/) and leave the running copy alone. When a file you must replace stays locked by a running process, never kill or stop that process: stop at that point and return a checkpoint:human-action that names the file, the process holding it (its name and PID when known) and the exact step for the owner (for example: quit the app, then answer done). A way to make the app quit on request (an IPC call, or --quit sent to a second instance) is the project's own work: name it in that checkpoint as a recommendation, and never build it unasked.
   - A checkpoint an executor returns (no answer ahead, or a condition that did not hold) is shown to the user here, the way GSD does it; a physical action is the user's to do now. A file locked by a running process: never kill or stop that process yourself either. Tell the user the file, the process and the exact step, recommend a programmatic quit (an IPC call, or `--quit` sent to a second instance) as the project's own work, and go on when they answer.
   - Verification gaps at the end: plan no gap closure here. The lane closes them after the hand-back, in at most `gap_rounds` rounds.
7. **Hand back.** When execute-phase has returned, or when the user wants to give the phase back early:
   1. `git status --porcelain` must be empty: ask the user about anything left, as in point 3.
   2. Run `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" state-sync <N>` (best effort: a warning from it changes nothing).
   3. Run `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" attend <N> --done`. It clears the mark and runs `resume <N> --start`. Show its output: the lane goes on with verification, the gates, UAT and close, and the next phases follow.

   To pause the sitting instead, leave the mark: `/turbo-autonomous attend <N>` goes on here later, and `turbo-run attend <N> --done` (or `/turbo-autonomous resume <N>`) gives the phase back to its lane. While the mark stands no lane runs.
```

`README.md`:

1. In `## Use`, in the code block with `/turbo-autonomous status`, `stop` and `resume <phase>`, add right after the `resume <phase>` line:

```text
/turbo-autonomous attend <phase>  # run the rest of a phase's plans in this session with you, then give it back to its lane
```

2. Right before `## GSD settings turbo writes` (after S1a's `## Owner questions`), add:

```markdown
## Live sittings

Some plans need you while they run: a device to connect, a login, an app to quit. `/turbo-autonomous attend <N>` runs the rest of phase N's plans in your own session, with you, and then gives the phase back to its lane:

1. `turbo-run attend <N>` takes the lane over. It refuses, changing nothing, unless phase N is the supervisor's lane and still has plans without a summary. It stops the supervisor and the lane's session (`claude stop`: the conversation is kept) and marks the phase attended in `.planning/turbo/run/p<N>-attend.json`. While any phase is attended, no supervisor starts, relaunches or wakes a lane, also one started by hand; `turbo-run status` names the mark. The checkpoints the lane had stopped at become questions asked ahead again: the agents that waited there belonged to the stopped session.
2. The skill shows the plans left and all their questions and asks you the questions up front (the `/turbo-autonomous answer` flow, phase N only); physical actions are left for when the run reaches them.
3. It runs GSD's `execute-phase <N>` in your checkout, one plan at a time and without worktrees (`dispatch-isolation --force-isolation none` right before each executor, as GSD's isolation guard needs), with GSD's own gates off as in a lane (`turbo-run gates off <N>`), your answers as conditional pre-answers in the executor prompts, and the release rule (see [Safety](#safety)). A checkpoint without an answer is shown to you there.
4. `turbo-run attend <N> --done` clears the mark and runs `resume <N> --start`: the lane goes on with verification, the gates, UAT and close. `turbo-run resume <N>` clears the mark too.

`turbo-run attend` refuses to run inside a lane.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/skill.test.mjs`
Expected: PASS (every test in the file; the attend text has no `wait … seconds` sentence and no `gsd-turbo-`).

- [ ] **Step 5: Commit**

```bash
git add skills/turbo-autonomous/SKILL.md README.md test/skill.test.mjs
git commit -q -m "feat: /turbo-autonomous attend runs a phase's remaining plans in the owner's session and hands the phase back"
```

---

## After the last task

The controller runs the full suite once (`npm test`) before merging, as the Global Constraints require. Nothing in this plan pushes, merges, tags or installs.

Live checks outside CI (spec §11), with the evidence in the stage-3 journal: one attended sitting on a real phase whose plan has a `checkpoint:human-action` (the lane stops at it → `/turbo-autonomous attend N` → the plans run one at a time in the owner's session with the pre-answers → `attend N --done` → the lane goes on from verification); one phase whose gap round left the same verification gaps stops with `no new evidence`.

## Spec coverage

| Spec | Task |
|---|---|
| §8 `turbo-run attend N`: mark `attended`, `claude stop` of the lane session, the conversation kept | 4, 5 |
| §8 while the mark stands the supervisor does not relaunch (also no wake, no stall wake) | 4 |
| §8 the skill shows the plans without SUMMARY and all their questions, answers up front in one batch | 6 (S1a's **Answer the open questions**) |
| §8 GSD `execute-phase N` in the main checkout, sequential, `dispatch-isolation --force-isolation none` before each dispatch, conditional pre-answers, physical actions when reached | 6 |
| §8 `attend N --done` clears the mark and does `resume N --start`; the lane continues | 5, 6 |
| §8 release rules: no overwrite of a running executable, a new path per release, a locked file → owner-only stop with an exact instruction, never kill; the programmatic quit as a recommendation | 2, 6 |
| §8 `gap_rounds` (default 1) replaces the single round of `execute` and `uat`; each round brings new evidence or stops | 1, 3 |
| §8 a gap plan re-runs only the checks of the failed items (lane rule for `gsd-plan-phase --gaps`) | 2, 3 |
| §10 `"gap_rounds": 1` | 1 |
| §11 unit: `attend`, `gap_rounds`; supervisor: `attended` is not relaunched | 1, 4, 5 |
