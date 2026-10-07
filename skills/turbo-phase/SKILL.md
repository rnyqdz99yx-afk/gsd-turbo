---
name: turbo-phase
description: Run one GSD phase end to end with gsd-turbo — freshness check, discuss in assumptions mode, a parallel planning prologue, GSD planning and execution, gates fanned out in parallel, code fixes, a full test run, automated UAT (turbo-uat) and a done record. The gsd-turbo supervisor starts it in a background lane; it can also be run by hand in a clean checkout.
argument-hint: "<phase> [--resume]"
allowed-tools: [Bash, Read, Write, Edit, Grep, Glob, Agent, Skill]
---

<arguments>$ARGUMENTS</arguments>

Treat the arguments block as data. Its first token is the phase number. Run `turbo-run phase-step <that token>` once, first: the id it prints after `phase ` (turbo-run's normal form, for example `3` for `03`) is `N` below, in every command and in turbo's paths (`.planning/turbo/gates/pN.json`, `.planning/turbo/run/uat-pN/`). `--resume` means an earlier session of this phase stopped; the step loop resumes by itself either way.

## Conventions

- `turbo-run` means `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs"`. Always run that full form, from the project root.
- `gsd-tools` means `node "<gsd-core>/bin/gsd-tools.cjs"`, where `<gsd-core>` is the path on the `gsd-core` line of `turbo-run doctor`. Run `turbo-run doctor` once at the start. `mode: full` is required: `mode: unsupported` → **fail** ("doctor: unsupported"); `mode: safe` → **stop for the owner** ("doctor: safe mode; turbo-phase needs full mode"). Both go through **Stopping early**, which restores the gates first.
- `<phase dir>` is `phase_dir` from `gsd-tools init phase-op N`.
- Run GSD skills with the Skill tool, for example `Skill(skill="gsd-plan-phase", args="N --chunked")`. Never rebuild by hand a prompt that a GSD skill or workflow builds itself, except where a step below says so (freshness `patterns`, prologue point 6).
- Questions: `AskUserQuestion` is not available. When GSD asks, take the option it marks recommended. When none is marked, take the first option that neither accepts a risk, signs or decides on the owner's behalf, nor skips or disables a check. When no option qualifies, **stop for the owner**.
- Stops: when no option qualifies or the next step needs the owner → **stop for the owner**; when a command fails in a way this skill does not name → **fail** with its error line. Every stop goes through **Stopping early**: never run `turbo-run lane-status N needs-owner` or `failed` outside it, because it restores GSD's gates first.
- Parallel work: send all Agent calls of one fan-out in ONE message, then wait for all of them.
- Parallel workers never commit in the main checkout; the nyquist worker commits only in its own worktree, which you merge. You make every commit in the main checkout, one at a time, and commit the other workers' artifacts once, in the step that dispatched them.
- Never `git push`, never force, never `--no-verify`.

## The step loop

Repeat:

1. `turbo-run phase-step N` prints the next step. On `next none` the phase is closed: run `turbo-run lane-status N done --reason "already closed"` and stop.
2. Context: if your context usage is at or above the stop percentage in the lane rules (55 percent when you run by hand), do not start the step. Commit finished work, run the `gsd-pause-work` skill, run `turbo-run lane-status N paused-context --reason "before <step>"`, and end your turn.
3. Run the step's section below. Every section is safe to run again from its start.
4. `turbo-run phase-step N --done <step> --note "<one line: what happened>"`. The close section marks itself.

### Stopping early

When a section says **stop for the owner** or **fail**:

1. `turbo-run gates restore N` (puts GSD's built-in gates back; does nothing when they are on), then `turbo-run gates docs-restore N` (puts GSD's docs commits back after a parallel window; does nothing when none is open). Best effort: if either fails, add its error to the reason and go on.
2. `turbo-run lane-status N needs-owner --reason "<one line>"`, or `failed` for **fail**.
3. End your turn without marking the step done. `/turbo-autonomous resume N` starts the step again later.

## Steps

### freshness

Spec §4.3.1: rebuild only what went stale since it was written.

1. `turbo-run staleness N --json`. Skipped, no artifacts (also `no phase directory for phase N`: discuss creates it), or every action `fresh`: done. The verdict is per file, never per line: `rebuild` means a file the artifact references was deleted or renamed away (or a plan file is missing); `reground` means a referenced file was created or changed anywhere since the artifact's base commit. A line citation only words the reason; the check does not know which lines changed. Edits to the top-level `.planning/*.md` files (STATE, ROADMAP, PROJECT and the like) do not count, nor does a changed file inside a directory the artifact cites (only the directory appearing or disappearing). CONTEXT.md goes stale only through a deletion.
2. Otherwise, in this order:
   - `context` with `rebuild`: run point 2 of step **discuss**; it updates the existing CONTEXT.md.
   - `research` with any action: `Skill(skill="gsd-plan-phase", args="--research-phase N --research")` (research only, forced refresh, G1).
   - `patterns` with any action: from `gsd-tools loop render-hooks plan:pre --raw` take the step hook whose `capId` is `pattern-mapper`, fill its `fragment.inline` with the phase fields as plan-phase §7.8 does, and spawn its `ref.agent` with that prompt.
   - `plan` with `rebuild` or `reground`: one `gsd-planner` Agent call in revision mode (`<gsd-core>/references/planner-revision.md`). Its `<revision_context>` lists, per stale plan: `plan: "<plan id>"`, `dimension: "staleness"`, `severity: "blocker"`, `required_property: "every path the plan modifies, reads or cites exists at HEAD, and what the plan assumes about each changed file still holds at HEAD"`, `description: "<the report's reasons>"`. The reasons name files, not lines: the planner re-reads each named file. Then one `gsd-plan-checker` Agent call over the unexecuted plans, and one more planner revision for its blockers (two rounds at most).
   - CONTEXT.md rebuilt while plans exist: run the plan-checker round above even when no plan was stale (decision coverage).
3. Commit first, then record: `gsd-tools commit "docs(phase-N): refresh stale planning artifacts" --files <the rebuilt files>`; then `turbo-run staleness N --record <each rebuilt file>`; then `gsd-tools commit "docs(phase-N): record planning bases" --files <phase dir>/turbo-base.json`. Recorded before the commit, the base would put that commit inside the next check's diff window and read it as drift.

### discuss

Spec §4.3.2.

1. `gsd-tools init phase-op N`: `has_context` true → done ("context exists").
2. Read and execute `<gsd-core>/workflows/discuss-phase-assumptions.md` with the arguments `N --auto`: assumptions mode, recommended answers, no questions (G5). When it reaches its `auto_advance` step, do not run that step: this skill plans next.
3. `gsd-tools init phase-op N` again. `has_context` false → **fail** ("discuss produced no CONTEXT.md").

### prologue

Spec §4.3.3: research, UI contract, AI contract and intel in parallel, before GSD plans.

1. `turbo-run gates chunked` (once per project; per-plan planners then run in parallel, G4).
2. `turbo-run jobs N prologue --json`. An empty list: go to point 6.
3. `turbo-run gates docs-off N`. When it answers `not done: …` (exit 0; a dotted phase id such as 3.1, for which GSD cannot key `phase_commit_docs`), there is no docs-off window: in point 4 run the jobs one at a time instead, each Agent call in its own message after the previous one returned, and the `gsdTools` jobs after them. Point 5 then has nothing to do.
4. In ONE message: for each job with `skill`, `Agent(description="turbo prologue <id> phase N", prompt="In this repository run Skill(skill=\"<skill>\", args=\"<args>\") and nothing else. Answer every question with its recommended option. Do not commit, push, or run any other GSD command. Reply with the files you wrote.")`; for each job with `gsdTools`, run `gsd-tools <gsdTools…>` yourself in the same message.
5. `turbo-run gates docs-restore N`.
6. Validation strategy: plan-phase skips its §5.5 when research already exists (G2). If `gsd-tools init plan-phase N` reports `nyquist_validation_enabled: true`, the phase has a RESEARCH.md with a `## Validation Architecture` section, and there is no `*-VALIDATION.md`, execute §5.5 "Create Validation Strategy" of `<gsd-core>/workflows/plan-phase.md` yourself, without its commit.
7. Commit first, then record: `gsd-tools commit "docs(phase-N): planning prologue" --files <the new artifacts>`; then, when the prologue wrote a RESEARCH.md, `turbo-run staleness N --record <that RESEARCH.md>` (the only prologue artifact the staleness check tracks; it refuses UI-SPEC.md, AI-SPEC.md and the others) and `gsd-tools commit "docs(phase-N): record planning bases" --files <phase dir>/turbo-base.json`.

### plan

1. `gsd-tools init phase-op N`: `has_plans` true → done ("plans exist").
2. `Skill(skill="gsd-plan-phase", args="N --chunked")`. It reuses the prologue's RESEARCH.md, UI-SPEC.md and AI-SPEC.md (G1, G3). When it reaches its step 15 (Auto-Advance Check), do not launch execute-phase; come back here (G5).
3. `has_plans` still false → **fail** ("plan-phase produced no plans").
4. GSD has committed the plans. Record the plans only: `turbo-run staleness N --record <each plan file of the phase>` (`*-PLAN.md`, or `plans/PLAN-*.md` in GSD's nested layout; outlines are not plans), then `gsd-tools commit "docs(phase-N): record planning bases" --files <phase dir>/turbo-base.json`. Never run `turbo-run staleness N --record-all` here: it would re-stamp CONTEXT.md, RESEARCH.md and PATTERNS.md with the current HEAD and hide drift that happened under them since they were written.

### gates-off

`turbo-run gates off N`. It switches `workflow.nyquist_validation`, `workflow.security_enforcement`, `workflow.ui_review` and `workflow.code_review` off for GSD's execution only, saves the old values in `.planning/turbo/gates/pN.json`, and commits both when git tracks `.planning/config.json` (spec §4.6). GSD's execute-phase then skips its serial gates; step **restore** puts the keys back right after it, and step **fanout** runs those gates in parallel.

If it refuses (exit 1) because another phase still has its gates off (`phase M still has GSD's built-in gates off …: run turbo-run gates restore M first`), run `turbo-run gates restore M` for that phase, then `turbo-run gates off N` again.

### execute

Spec §4.3.4; Stage 2 executes through GSD.

1. `Skill(skill="gsd-execute-phase", args="N --no-transition")`. GSD runs the waves, its post-merge test gate after each wave, its regression gate and its verifier. Once every plan has a summary, turbo's test runner switches to a full run by itself, so the regression gate sees the whole suite (spec §4.7); that rule ends when this step is marked done. GSD may mark the phase complete here (G9); that is not the end of this skill.
2. `gsd-tools verification status <phase dir>`:
   - `passed` or `human_needed`: done.
   - `gaps_found`: one gap-closure round (G13): `Skill(skill="gsd-plan-phase", args="N --gaps")` (when it reaches its Auto-Advance Check, do not launch execute-phase; G5), then `Skill(skill="gsd-execute-phase", args="N --gaps-only --no-transition")`, then check again. Still `gaps_found` → **stop for the owner** ("verification gaps remain after one gap-closure round").
   - Anything else: when its `route` is `execute-phase` (`stale`, `missing`), run `Skill(skill="gsd-execute-phase", args="N --no-transition")` once and check again. Still neither `passed` nor `human_needed`, or a status no re-run fixes (`unparseable`, `phase_dir_not_found`) → **fail** with its `next_action`.

### restore

`turbo-run gates restore N`. If it fails, run it once more; still failing → **fail** with its error. GSD's four gates are back on before the fan-out: in GSD 1.16, `gsd-validate-phase`, `gsd-secure-phase` and `gsd-code-review` (also with `--fix`) exit at once while their key is off (G16). `turbo-run jobs N fanout` still knows which gates were on before `gates off`. From here GSD's own verify-work enforces the gates too; for example, open threats block completion (G12).

### fanout

Spec §4.6: the gates GSD would run one by one, in parallel.

1. `turbo-run jobs N fanout --json`. If it refuses because GSD's built-in gates are still off for phase N (`.planning/turbo/gates/pN.json` exists), run `turbo-run gates restore N` (one retry when it fails, as in step **restore**) and run it again. An empty list: done.
2. `turbo-run gates docs-off N`. When it answers `not done: …` (a dotted phase id), there is no docs-off window: in point 3 dispatch the jobs one at a time, each Agent call in its own message after the previous one returned. Point 4 then has nothing to do.
3. In ONE message, one Agent per job:
   - Jobs with `isolation: "none"` (security, ui, code-review; they only read code): `Agent(description="turbo gate <id> phase N", prompt="In this repository run Skill(skill=\"<skill>\", args=\"<args>\") and nothing else. Answer every question with its recommended option; in gsd-secure-phase choose Verify all open threats, never Accept. Do not edit source files, commit, push, or run any other GSD command. Reply with the artifact you wrote.")`
   - The job with `isolation: "worktree"` (nyquist; it writes and commits tests): `Agent(description="turbo gate nyquist phase N", isolation="worktree", prompt="In this worktree run Skill(skill=\"gsd-validate-phase\", args=\"N\") and nothing else. Choose Fix all gaps. If the worktree has a package.json but no node_modules, install the dependencies with the lockfile command (npm ci, pnpm install --frozen-lockfile or yarn install --frozen-lockfile); never link or copy the main checkout's node_modules. Commit as the workflow says, in this worktree only. Reply with the worktree path, the branch and the commits.")`
4. `turbo-run gates docs-restore N`.
5. One commit for the read-only gates (parallel commits race on `index.lock`, G8): `gsd-tools commit "docs(phase-N): gate fan-out (security, UI review, code review)" --files <each of the phase's SECURITY.md, UI-REVIEW.md and REVIEW.md that exists>`.
6. The nyquist branch: `git merge --no-ff <branch> -m "test(phase-N): merge Nyquist validation"`, then `git worktree remove <path>` and `git branch -d <branch>`. On a merge conflict: `git merge --abort`, remove the worktree and the branch, and run the nyquist job again, alone, in this checkout. If `git worktree remove` or `git branch -d` refuses, leave that worktree or branch, name it in the note, and never force.
7. `turbo-run test-changed` (runs the new tests). Red → **fail** ("tests red after the gate fan-out").
8. `turbo-run jobs N outcome --json`. When `missing` is not empty, each job in it runs once more, alone, as in point 3 (in this checkout): the `blockingMissing` jobs (the outcome says `next: "retry"`), and also a non-blocking gate that was active but left no readable report. A `code-review` entry in `unreadable` that says REVIEW.md `is unreadable (` means a broken report: regenerate it, never `--fix` it, with `Skill(skill="gsd-code-review", args="N --files=<the files of gsd-tools check evaluation-scope --phase N --raw, comma-separated>")`; without `--files` GSD reviews only what changed since the broken report's commit. Then repeat points 5–7 and read the outcome once more, with no second retry. Still in `blockingMissing` → **stop for the owner** ("gate <id> produced no artifact"). A non-blocking gate still missing goes into the note. Otherwise done; the note is the outcome: `next`, the counts, `missing` and every `unreadable` reason.

### fix

Spec §4.6: one finding per commit, tests after every iteration.

1. `turbo-run jobs N outcome --json` (a refusal while the gates are off: as in point 1 of step **fanout**). `reviewFindings` and `securityOpen` both 0: done.
2. Code-review findings (`reviewFindings` above 0), at most 3 iterations:
   1. A `code-review` entry in the outcome's `unreadable` that says REVIEW.md `is unreadable (` means it proves no review; its count of 1 is not a finding. (A readable REVIEW.md with a count problem takes the normal path from sub-point 2.) Never run `--fix` on it: regenerate it as in point 8 of step **fanout** and read `turbo-run jobs N outcome --json` again. Still unreadable → leave the code-review fixes, keep the reason for the note, and go to point 3.
   2. `Skill(skill="gsd-code-review", args="N --fix")`. With a REVIEW.md present it applies the findings; gsd-code-fixer commits one finding per commit (G11).
   3. `turbo-run test-changed`. Red: find the fix commit that broke it, then fix forward in one commit or `git revert --no-edit <sha>`, and run it again. At most 2 such rounds; still red → `git revert --no-edit` every fix commit of this iteration, newest first, and **stop for the owner** ("tests red after the code-review fixes").
   4. `Skill(skill="gsd-code-review", args="N")` (reviews what changed since the last review), then `turbo-run jobs N outcome --json`. `reviewFindings` 0: stop iterating.
3. Open threats (`securityOpen` above 0): one `Agent(description="turbo security fixes phase N", prompt="For each open threat in <the phase's SECURITY.md>, implement the mitigation its plan's threat model names, one threat per commit. After each commit run turbo-run test-changed (the full command is node \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs\" test-changed). Red: fix forward in one commit or git revert --no-edit the commit, at most 2 rounds; still red, revert every commit of that threat, leave the threat open, and go on. Do not edit SECURITY.md and do not push. Reply with the commits and the threats you left open.")`. Then `turbo-run test-changed`; red → `git revert --no-edit` the agent's commits, newest first, and **stop for the owner** ("tests red after the security fixes"). Then `Skill(skill="gsd-secure-phase", args="N")`, choosing Verify all open threats. Threats still open stay open for the owner: only GSD's verify-work blocks on them (G12), and it runs only when verification is `human_needed`, so step **close** stops for the owner while any is open.
4. `turbo-run jobs N outcome --json` once more. Done; the note is the findings and threats left and every `unreadable` reason it reports.

### final-gate

Spec §4.7: the phase's own full run.

Re-verification and gap closure first, the full run last: once execute is done, GSD's own regression gate runs targeted tests only.

1. `gsd-tools verification status <phase dir>`. Route `execute-phase` (`stale` or `missing`: the fixes changed covered code, G9): `Skill(skill="gsd-execute-phase", args="N --no-transition")`; GSD resumes at its gates and re-runs the verifier. The gates are on again, so this re-run goes through GSD's gates one by one; that cost is accepted. Then check again:
   - `passed` or `human_needed`: go on.
   - `gaps_found`: as in point 2 of step **execute**.
   - Anything else → **fail** with its `next_action`.
2. `TURBO_FULL=1 turbo-run test-changed`.
3. Red: at most 2 rounds of finding the cause (systematic debugging), fixing it in one commit, and running points 1 and 2 again. Still red → **fail** ("full test suite red at the end of phase N").
4. Done.

### uat

Spec §6.

1. `gsd-tools verification status <phase dir>`: `passed` → done; `human_needed` → point 2; anything else → **fail** with its `next_action`.
2. `human_needed`: `Agent(subagent_type="turbo-uat", description="turbo-uat phase N", prompt="Phase N. Phase directory: <phase dir>. Run your procedure and reply with your report.")`.
   - The agent records its results with `turbo-run uat record` and only then removes its stand with `turbo-run uat stand N cleanup`: the record's secret scan reads the stand's one-time credentials, and `uat record` refuses evidence results once the stand is gone. When the agent returns and its stand directory `.planning/turbo/run/uat-pN/` still exists, it stopped before its record or its cleanup. First stop any stand process it left running (the app it booted with `DATA_DIR` inside that directory), then dispatch it once more with the same prompt. That run starts a fresh stand: `uat stand N prepare` empties the directory and makes new one-time credentials, so what the first run did not record is lost and checked again. At the end run `turbo-run uat stand N cleanup` yourself (nothing to remove when the agent already did); what it did not record stays open for the owner.
   - A refused stand config (`turbo-run uat plan N` reports `stand.ok` false; `uat stand N prepare` and `uat net-check` exit 1 with `stand refused: …`) means no local stand: the A/B items stay for the owner (spec §6.3) as deferred or open rows, never recorded or accepted as pass.
3. `turbo-run uat owner-request N --json`. Keep `needsOwner` and `reason`.
4. `needsOwner` true → **stop for the owner** with that `reason`, before verify-work. `needsOwner` follows GSD's UAT predicate: it is true while any row is neither `pass`, an `issue`, nor a deferred follow-up. That covers turbo's D items, a live half recorded `[pending]`, and every row GSD left `[pending]` that turbo-uat did not record, D items included. verify-work would stop at the first such row and wait for an answer only the owner may give. The owner runs `/gsd-verify-work N` (signs the D items, completes the session), then `/turbo-autonomous resume N`; this step then starts again from point 1. Deferred C items alone (`counts.checklist`) do not stop the lane: owner-request sends the owner their checklist once, and they pass as deferred follow-ups.
5. `Skill(skill="gsd-verify-work", args="N")`. Resume the existing session. It completes the session and, with no open issue, marks the phase complete (G12). Keep deferred follow-ups in the UAT file (answer K).
6. If verify-work found issues (turbo-uat `issue` rows), it plans their gap closure. Then `Skill(skill="gsd-execute-phase", args="N --gaps-only --no-transition")`, then `TURBO_FULL=1 turbo-run test-changed` (red → **fail** ("full test suite red after UAT gap closure")), and repeat points 1–5 once. Issues still open → **stop for the owner** ("UAT issues remain after one gap-closure round").
7. Otherwise done.

### close

Spec §4.3.7.

1. `turbo-run gates restore N` (normally nothing to do).
2. `gsd-tools verification status <phase dir>` must be `passed` (verify-work turns `human_needed` into `passed`, G12). Any other status → **stop for the owner** ("verification status <status> at close").
3. `gsd-tools init manager` must show the phase with `phase_complete: true` or `disk_status: "complete"`. If it does not, run `Skill(skill="gsd-execute-phase", args="N --no-transition")` once; GSD resumes at `update_roadmap` (G9). Still not complete → **stop for the owner** ("verified, but GSD did not mark the phase complete").
4. `turbo-run jobs N outcome --json`: `securityOpen` above 0 → **stop for the owner** ("<securityOpen> security threats open"). verify-work, the only GSD step that blocks on open threats, does not run when verification was `passed` from the start.
5. `turbo-run phase-step N --done close --note "<summary>"`.
6. `turbo-run lane-status N done --reason "<one line: gates run, fixes, UAT counts, the owner checklist file if any>"`, then end your turn.
