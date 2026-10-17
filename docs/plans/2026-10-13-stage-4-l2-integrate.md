# gsd-turbo Stage 4 L2 — integration and merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a lane that finished its phase in a slot take in the latest main branch, test and re-verify that result, and hand it to the supervisor, which merges exactly that tree into `main` without an LLM, completes the phase there through `gsd-tools`, pushes `main`, sends red CI back to the lane, and frees the slot only after green CI.

**Architecture:** A new last step `integrate` joins the `/turbo-phase` pipeline (`lib/phase-progress.mjs` `STEPS`). It passes by itself outside a slot (checkout mode). In a slot, the lane runs `turbo-run integrate N` (`lib/integrate.mjs`: fetch, merge `origin/<main>`, always take main's `STATE.md`/`ROADMAP.md`/`REQUIREMENTS.md`, commit the merge), a full test run, the verification status (re-verify through **Stale report** when stale), then `turbo-run lane-status N ready --base <sha>`, which validates the slot and writes the run record. The supervisor's side is `lib/merge.mjs`. L1 calls `mergeReady(ctx, lane)` for a ready record: under `locks/merge`, with the main checkout clean and on its branch, it merges the lane's verified tip with `--no-ff` only when `HEAD == base`. Otherwise it puts a `reintegrate` message in the lane's inbox, and after `merge_rounds` it asks the owner. After the merge it compares the covered files as blobs, re-stamps the verification fingerprint where the bytes differ (fact S3), and runs `gsd-tools query phase.complete N` and state-sync. It folds all of that into one commit and files a push request for `main` that S2's `pushTick` carries out. L1 then calls `mergeFollowUp(ctx, lane)` every tick: it reads that push's CI, returns `ci-red` (the log is already in the lane's inbox) or releases the slot after green CI. `mergePlanningOnly` gives L3 the same lock and checks for branches that may touch only planning files.

**Tech Stack:** Node ≥ 20 (ESM `.mjs`, `node:test`, zero npm dependencies), git, GSD 1.16 (`gsd-tools`), Claude Code background sessions (2.1.29x).

**Spec:** `docs/specs/2026-10-13-stage-4-design.md`. L2's scope: §7.1 (the lane step `integrate` after `close`, points 1–4 with 3a), §7.2 (the supervisor's merge under `locks/merge`: clean main, `HEAD == base`, reintegrate up to `merge_rounds`, the fingerprint re-stamp by blob equality, `phase.complete` + state-sync + one commit, push `main` → CI → the lane's inbox, slot release after green CI, prep/annotate by p.1–2), §7.3 (push requests in slot mode), §9 (dirty main checkout: merges wait), `merge_rounds` of §10, L2's row of §11 and the merge tests of §13; facts G6, S3, S4 of §3.

**Base:** branch `stage-4` at `d5a6ba8` with L0 (`docs/plans/2026-10-13-stage-4-l0-slots.md`) executed and merged first. Existing code is referenced by function name and anchor text, never by line number. If an anchor moved, apply the same change next to the named code.

What this plan consumes, by exact name (it re-implements none of it):
- L0 `lib/paths.mjs`: `isSlot`, `stateRoot`, `runDir` (resolves into the control root), `slotRecordFile`; `lib/slots.mjs`: `slotGit`, `readSlotRecord`, `mainBranch`, `releaseSlot`, `prepareSlot`, `setupSlots`, `SlotRefused`; `lib/merge-lock.mjs`: `withMergeLock`, `MergeLocked`, `mergeLockFile`; `lib/answers.mjs`: `commitPendingAnswers`. L0 tests: `test/helpers/slots.mjs` (`ISOLATED`, `gitIn`, `controlProject`, `fakeSlot`, `mainProject`, `slotFixture`).
- `lib/phase-progress.mjs`: `STEPS`, `completeStep`, `nextStep`, `readProgress`, `countAttempt` (through `phase-step --attempt`).
- `lib/run-status.mjs`: `LANE_STATUSES`, `writeLaneStatus`, `readLaneStatus`. `lib/inbox.mjs`: `appendInbox`, `formatInboxMessage`. `lib/questions.mjs`: `askOwner`, `readQuestions`.
- `lib/push.mjs`: `requestPush`, `requestFile`, `recordFile`, `describeRecord`, `pushTick`, `createGit`. `lib/config.mjs`: `pushSettings`, `loadConfig`. `lib/gates.mjs`: `gsdText`. `lib/state-sync.mjs`: `stateSync`. `lib/phase-files.mjs`: `findPhaseDir`, `phaseArtifacts`. `lib/fsx.mjs`: `readJson`, `writeJsonAtomic`. `lib/messages.mjs`: `msg` table `M`.
- `lib/cli-phase.mjs`: `HANDLERS`, `PHASE_COMMANDS`, `phaseArg`, `parseArgs`, `fail`, `usage`, `runPhaseCommand`, `function phaseStep`, `async function pushRequest`. `bin/turbo-run.mjs`: `USAGE`, `VALUE_FLAGS`, `case 'lane-status'`.
- Tests: `test/helpers/tmp.mjs` (`tmpDir`), `test/skill-turbo-phase.test.mjs` (`section`).

## gsd-tools 1.16 calls, pinned

Checked against `<gsd-core>/bin/lib/verification.cjs`, `phase.cjs`, `io.cjs`, `verification-command-router.cjs`, and run on a scratch project (2026-10-13):

| Call (always with `--cwd <control root>`, added by `gsdText`) | Output | Failure |
|---|---|---|
| `gsd-tools query verification.fingerprint <phase dir> <covered file>… --raw` | stdout is the bare digest, `v3:sha256:<64 hex>`. Without `--raw` it prints JSON `{ covered_files: [<declared ∪ the phase's *-PLAN.md / *-SUMMARY.md, sorted>], covered_digest }`. The digest is computed over the **working-tree bytes** (`deriveCoveredDigest` reads each file), and repo-wide planning documents (direct children of `.planning/`) are excluded. | exit 1, `Error: could not compute fingerprint — …` on stderr |
| `gsd-tools verification status <phase dir>` (also `query verification.status`) | JSON `{ status, next_action, next_command, route }`. `status` is one of `passed`, `gaps_found`, `human_needed`, `stale`, `missing`, `unparseable`, `phase_dir_not_found`. `stale` means the stored `covered_digest` differs from a digest recomputed over the current bytes. | — |
| `gsd-tools query phase.complete <N>` | JSON `{ completed_phase, phase_name, plans_executed, next_phase, …, roadmap_updated, state_updated, requirements_updated, warnings, … }`. Writes ROADMAP, REQUIREMENTS, STATE and `state.json`, and does not commit (G6). | exit 1, `Error: Phase <N> verification is incomplete: <next_action> Next: /gsd-execute-phase <NN>` (a stale or not-passed report), or `Error: Phase <N> cannot be completed: <k> plan(s) have no completion record …` |

The report's own fields are `covered_files:` (a YAML list) and `covered_digest: "v3:sha256:…"` in the `*-VERIFICATION.md` frontmatter. GSD has no verb that re-stamps them, so turbo replaces the one `covered_digest:` line itself (D11). `gsdText(core, root, args)` throws `gsd-tools <first two args> failed: <first stderr line>`.

## Decisions this plan makes where the spec is open

- **D1 The ready record.** `turbo-run lane-status N ready --base <sha>` writes the lane record `run/p<N>.json` (in the control root, through `stateRoot`) as `{ phase, status: 'ready', reason, sessionId, at, base, head, branch, slot }`. `base` is the `origin/<main>` commit the lane integrated. `head` is the slot branch's tip when the lane reported ready. `branch` is `turbo/p<N>`. `slot` is the slot's `k`. `ready` joins `LANE_STATUSES`. The command refuses outside a slot, and also when `--base` is not exactly the base of the last finished `turbo-run integrate N`, when the slot is not on its job's branch, has uncommitted tracked changes or a merge in progress, or when `base` is not an ancestor of `HEAD`. A refusal changes nothing.
- **D2 Integrate commits the merge at once.** `turbo-run integrate N` merges with `--no-ff --no-commit`, takes main's three files, and commits right away when nothing conflicts (spec p.4 commits after the tests). An uncommitted merge kept through a full test run and its fixes would fold the fixes into the merge commit, and a context pause would leave `MERGE_HEAD` behind. The fixes of p.3 become their own commits, and `base` stays an ancestor of the head. When the main branch has not moved, the three files still come back from it, in a `chore(phase-N): take …` commit.
- **D3 The three files.** `.planning/STATE.md`, `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md` are checked out from `base` (`git checkout <base> -- <file>`), at a conflict and always after the merge. A file that `base` does not have is removed (`git rm --ignore-unmatch`). This way, the merge into `main` changes none of them, and only the supervisor's `phase.complete` marks the phase.
- **D4 The step `integrate`.** It is the last element of `STEPS`. Outside a slot, `turbo-run phase-step N` marks it done the moment it becomes next, with the note `not a slot: nothing to integrate (checkout mode)`, so v0.3 lanes and hand runs end exactly as before. In a slot, `phase-step N --done integrate` is refused, and `mergeFollowUp` marks it done after the release. A lane cannot skip its own merge. Its full-test fix rounds count as `--attempt integrate` against `push.ci_fix_rounds` (spec: "до `ci_fix_rounds` попыток"), which `turbo-run integrate` prints.
- **D5 One decision per ready record.** `mergeReady` gives at most one non-`wait` outcome per ready record (keyed by its `at`). The merge record keeps `readyAt`, and later calls for the same record return `wait`. A new `lane-status N ready` gets a new decision. A crash between `git merge` and the end of the merge (state `merging`) is the exception: it is resumed.
- **D6 Owner answers ride on top.** The main checkout counts as clean when its only tracked changes are under `.planning/turbo/answers/`. `commitPendingAnswers(root)` runs inside the lock **after** the merge, not before the base check. Committing them first would move `HEAD` past `base`, and every lane with an answer pending would lose a whole reintegration round to it. L0's D14 asks for "before it checks that main is clean". The only goal of that wording is that answers never block a merge, and this order keeps it.
- **D7 Main is ready** when `mainBranch(root)` succeeds and equals the lane job's `base.branch` (the slot record), when no `MERGE_HEAD` exists, and when there is no tracked change outside the answers. Untracked files do not count: `git merge` itself refuses when one is in its way, and that refusal becomes `needs-owner`. Otherwise the outcome is `wait`, and the owner gets `mergeWaiting` once per distinct reason (spec §9: the lanes go on).
- **D8 Only the verified tip.** The supervisor fetches `refs/heads/<branch>` from the slot and merges `rec.head`, and only when `FETCH_HEAD` equals it. A lane that committed after reporting ready gets `wait` until it reports ready again. A tip no test or verifier saw is never merged.
- **D9 No second merge.** When `rec.head` is already an ancestor of `HEAD` (a restart after a crash, or a ready record repeated after a `needs-owner`), the base check and the merge are skipped. The blob check (D10) then decides whether what is in `main` is still what was verified.
- **D10 The blob check.** The paths are the report's `covered_files` plus the phase directory, compared with `git diff --name-only -z --no-renames <rec.head> HEAD -- …`. Repo-wide planning documents (`^\.planning/[^/]+$`) are left out, exactly as GSD leaves them out of the digest. A difference → `needs-owner` with the paths, and the merge stays (spec §7.2 p.4). A report without `covered_files`/`covered_digest` (GSD's legacy mtime check) is not stamped, and `phase.complete` decides.
- **D11 The re-stamp.** The digest is recomputed with the pinned call (positional files, so a comma in a path cannot split it) and compared with the stored one. When they differ, exactly one frontmatter line `covered_digest: …` is rewritten, keeping its quotes and line ending. Zero or two such lines → `needs-owner`.
- **D12 phase.complete fails.** The merge stays (`git reset --hard ORIG_HEAD` is never done). A re-stamp already written is committed alone (`docs(phase-N): re-stamp verification after the merge (turbo merge)`), so `main` stays clean and the other lanes keep merging. The lane record gets `needs-owner` with GSD's first error line, and the owner gets `laneNeedsOwner`.
- **D13 One commit.** After `phase.complete` and state-sync, every tracked change under `.planning/` (`git diff --name-only HEAD -- .planning`, then `git add -u -- .planning`) goes into `docs(phase-N): complete phase (turbo merge)`. state-sync runs with a `gsd` wrapper (`quietCommits`) that answers its `gsd-tools commit` with `{ committed: false, skipped: true }`, so its STATE.md edit lands in that same commit. state-sync is best effort: a failure is logged.
- **D14 Push through S2.** With `push.mode` not `off`, the supervisor files the phase's push request for `main` itself (`requestPush({ point: 'phase' })` in the control root), and the next tick's `pushTick` scans, pushes and watches CI as for any request. A red run's log reaches `p<N>-inbox.jsonl` through S2's `reportRed`. In slot mode, lanes never file push requests (D20), so the request file of phase N has one writer.
- **D15 Release.** `mergeFollowUp` releases on CI `green`, `none` or `cancelled` (S2 treats cancelled as "nothing tested, go on"), on `already` (the remote already had the commit), or at once with `push.mode: off`. On `red`, it returns `ci-red` once per red commit. On `timeout` or a push that ended `refused`, `diverged` or `failed`, it returns `needs-owner` once (S2 already told the owner) and keeps the slot. On `superseded` (a later merge's push replaced this watch), it follows the newest push whose commit holds this merge: green, none or cancelled releases, anything else waits. The release releases the slot (`releaseSlot(…, { outcome: 'merged' })`), marks `integrate` done, writes the lane record `done` and removes the hold.
- **D16 Rounds and the hold.** `rounds` counts the consecutive `reintegrate` outcomes of a phase and goes back to 0 at a merge. Round `merge_rounds + 1` asks the owner instead (`askOwner`, two options: wait / I will merge it myself, in the owner's language). The card's answer reaches the lane like any of its own questions. "Wait" makes the lane run `turbo-run integrate N --hold`, which writes `run/p<N>-merge-hold.json`. While any hold exists, L1 starts no new phase (`mergeHolds(root)`), and a hold newer than the merge record's `holdAt` gives a fresh round budget. The release removes the hold.
- **D17 `mergePlanningOnly` (L3).** It takes the same lock and the same main checks (D7). It fetches the job branch's tip and refuses (`refused`) when any path changed since the merge base fails `allowed(path)`. It does not require `HEAD == base`: a branch that touches only its own planning files merges three-way, and a conflict → `git merge --abort`, then `needs-owner`. It writes no lane record and no merge record, files no push request (spec: they go with the next phase merge), and does not release the slot (L3 does).
- **D18 Lock wait.** Inside a supervisor tick, the merge lock is waited for 2 s at most (`deps.mergeLockWaitMs`, default 2000). A held lock → `wait`.
- **D19 Notifications.** `mergeReady` notifies the owner itself for its `needs-owner` outcomes (`laneNeedsOwner`), except the rounds card, which reaches the owner through the question channel (`askOwner`, S1's `ownerTick`). It also notifies a waiting main checkout (`mergeWaiting`). L1 does not notify again for any outcome of L2's functions.
- **D20 Push requests in a slot (§7.3).** When `push.mode` is not `off`, `turbo-run push-request` in a slot files nothing and exits 0, saying so. With `--at wave`: `push in slots: nothing requested at a wave; the supervisor pushes main after it merges this phase`. Otherwise (`--at phase`, a plan that pushes, after a CI fix, with or without `--wait`): `push in slots: nothing requested; the supervisor merges this phase in step integrate and pushes main`. `push off` keeps its v0.3 line.
- **D21 `merge_rounds`** belongs to L1's `DEFAULTS` (L0's Interfaces). L2 reads it only through `mergeRounds(config)`: a whole number ≥ 1, else 3.

## Global Constraints

- Node ≥ 20, ESM `.mjs` only, **zero runtime npm dependencies**; tests use `node:test` and `node:assert/strict`.
- Windows and Linux (CI: Linux / Node 22; dev: Windows / Node 24): paths with `path.join` / `path.resolve`. Child processes run only through `execFileSync` or `spawnSync` with an argument array, `windowsHide: true` and a timeout, never a shell. git goes through `slotGit` (L0) or `createGit` (S2), gsd-tools through `gsdText`.
- Public repository: no personal names, private project names, hosts, user paths or emails in code, tests, fixtures or commits. Synthetic paths look like `C:\Users\dev\…` or `/home/dev/…`.
- The supervisor decides deterministically, with no LLM in its loop. `STATE.md`, `ROADMAP.md` and `REQUIREMENTS.md` in `main` change only through the supervisor, and only through `gsd-tools`.
- Spec values, verbatim:
  - §7.1: `git fetch origin && git merge origin/<main_branch>` in the slot; for `.planning/STATE.md`, `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md` the `origin` version is taken (`git checkout --theirs` at a conflict and always after the merge); conflicts in code the lane resolves itself, within its phase, or else `turbo-run ask` with options → stop for the owner; full test run `TURBO_FULL=1 turbo-run test-changed`, red → fix in the lane up to `ci_fix_rounds` attempts, then stop for the owner; 3a `gsd-tools verification status <phase dir>` in the slot: `stale` → only the verifier re-run (route «Stale report» of v0.3.2); not `passed` after it → stop for the owner; `turbo-run lane-status N ready --base <sha of origin/main that was merged>`;
  - §7.2: under `locks/merge`; main checkout clean and on `<main_branch>`, else wait and notify; `HEAD == base` → `git fetch <slot> turbo/<job>` and `git merge --no-ff FETCH_HEAD -m "Merge phase N (turbo lane k)"`; `HEAD != base` → inbox `reintegrate` to the lane, a wake as for an owner answer; more than `merge_rounds` (3) in a row → card for the owner «фаза N не успевает влиться: main меняется быстрее» with the options wait (holding new phase launches) / handle it myself; fingerprint: `git diff --quiet <lane tip> HEAD -- <files>` equal → re-stamp in the main checkout, committed with p.5; unequal → `needs-owner` with the list, the merge stays; after the merge `gsd-tools query phase.complete N`, `turbo-run state-sync`, one commit `docs(phase-N): complete phase (turbo merge)` with ROADMAP/STATE/REQUIREMENTS; `phase.complete` failed → no `git reset --hard ORIG_HEAD`, the merge stays, phase → `needs-owner` with the error; push (unless `push.mode` `off`) `main` → remote, CI watched as now; red CI → log into the lane's inbox; the lane fixes, passes 7.1 again, the supervisor merges the fix; the slot is freed only after green CI (or at once with `push.mode: off`); slot freed → job `done`; prep and annotate merge by p.1–2 without p.4–6;
  - §7.3: lanes do not push; `push-request` in slot mode: `--at wave` → nothing; `--at phase` → replaced by the integration and the push of `main`; lane branches never reach the remote;
  - §10: `merge_rounds` default `3`.
- Tests never touch the network, a real `claude`, a real `gsd-tools` or the developer's Claude home. Every git repository is a temp directory, and git runs with `ISOLATED` (L0's helper: no global or system config). gsd-tools is the fake `deps.gsd` of `test/helpers/lane-merge.mjs`. A test that pushes pushes to a bare repository in a temp directory, and sets `CLAUDE_CONFIG_DIR` to a temp directory (the push allow file).
- State files are written with `writeJsonAtomic`. One writer per run file: the lane writes `p<N>.json` (ready), `p<N>-integrate.json` and `p<N>-merge-hold.json` (creation). The supervisor writes `p<N>-merge.json`, `p<N>-push-request.json` (slot mode) and `p<N>.json` (needs-owner, done), and removes the hold at release. The lane has stopped by then: it waits for the merge.
- TDD. While implementing a task, run only the test files that task names (`node --test <files>`), never the full suite (`npm test`): the controller runs it once at merge. One commit per task, conventional style, the repository's configured identity. Never push, merge, tag or install; never `--no-verify`.

## Review Focus

1. **The owner answers a question while a lane waits to merge.** The answers file in the main checkout is modified but not committed. Expected: the merge goes on (no wait, no reintegration round lost), the answer is committed right after the merge, and the main checkout is clean afterwards. Pinned in Task 4 (`an uncommitted owner answer neither blocks the merge nor costs a round`).
2. **The supervisor crashes between `git merge` and the complete commit, and on restart `main` is unchanged, or the owner has meanwhile committed a fix to a covered file in it.** Expected: no second merge commit. Unchanged → the phase completes normally. A changed covered file → `needs-owner` naming that file, and the merge stays. Pinned in Task 5 (`a restart after the merge …`).
3. **The main checkout has `core.autocrlf=true` while the slot wrote LF (fact S3).** Expected: blob equality holds, the digest is re-stamped over the main checkout's bytes, `phase.complete` passes, the re-stamped report is in the same single commit, and the main checkout is clean. Pinned in Task 5 (`S3: …`).
4. **The lane commits again after it reported ready** (a late fix, or a confused session). Expected: the supervisor never merges a tip that was not the one reported. It waits, and the next `ready` is a new decision. Pinned in Task 4 (`a lane tip that moved after ready is never merged`).
5. **Two lanes merge one after the other, and the second push supersedes the first push's CI watch.** Expected: the first slot is released only when a later push that holds its merge is green. A red later push keeps it waiting and does not send it a `ci-red`, because that red is the other phase's. Pinned in Task 6 (`a superseded CI watch follows the later push that holds the merge`).

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/phase-progress.mjs` | modify | `STEPS` gains `integrate` after `close` |
| `lib/cli-phase.mjs` | modify | `phase-step`: integrate passes outside a slot, refused as `--done` in a slot; `integrate` command; `push-request` in a slot |
| `lib/view.mjs`, `mod/hooks/view-model.mjs` | modify | the words for step `integrate` (4 tables each), the mod's own `STEPS` |
| `lib/integrate.mjs` | create | `SHARED_PLANNING`, `integrateFile`, `holdFile`, `IntegrateRefused`, `integrateMain`, `readyRecord`, `setMergeHold` |
| `lib/run-status.mjs` | modify | `LANE_STATUSES` + `ready`; `writeLaneStatus(…, { fields })` |
| `lib/inbox.mjs` | modify | `formatInboxMessage` for `reintegrate` |
| `bin/turbo-run.mjs` | modify | `USAGE` + `integrate`; `VALUE_FLAGS` + `--base`; `case 'lane-status'` writes the ready record |
| `lib/merge.mjs` | create | `mergeFile`, `mergeState`, `mergeRounds`, `mergeHolds`, `mainNotReady`, `mergeReady`, `verificationFingerprint`, `restampDigest`, `quietCommits`, `mergeFollowUp`, `mergePlanningOnly` |
| `lib/messages.mjs` | modify | `mergeWaiting` (en, ru) |
| `skills/turbo-phase/SKILL.md` | modify | Conventions, step loop, inbox, **CI red**, `close`, new `### integrate` |
| `docs/reference.md` | modify | section `## Merging lanes (slots)`; `integrate` in the subcommand sentence |
| `test/helpers/lane-merge.mjs` | create | `laneProject`, `finishPhase`, `fakeDigest` (Task 2); `reportReady`, `laneOf` (Task 3); `fakeGsd`, `mergeCtx` (Task 4) |
| `test/integrate-step.test.mjs`, `test/integrate.test.mjs`, `test/ready.test.mjs`, `test/merge.test.mjs`, `test/merge-follow.test.mjs` | create | tests |
| `test/phase-progress.test.mjs`, `test/view-model.test.mjs`, `test/skill-turbo-phase.test.mjs` | modify | `STEPS` now ends with `integrate`; one appended skill test |

Files that sibling plans also change (merge-conflict risk; every L2 edit is anchored on a name or a quoted line): `lib/cli-phase.mjs` (L1: `laneRuns`), `bin/turbo-run.mjs` (L1: `lock`/`unlock`, `start`; L3: commands), `lib/run-status.mjs` (L1: `inferStatus`), `lib/messages.mjs` (L1, L3), `lib/view.mjs` and `mod/hooks/view-model.mjs` (L4), `skills/turbo-phase/SKILL.md` (L3 reuses its steps for `/turbo-prep`), `docs/reference.md` (all).

## Contracts

- **Ready record** `run/p<N>.json`: `{ "phase": "3", "status": "ready", "reason": "<text>", "sessionId": "", "at": "<ISO>", "base": "<40 hex>", "head": "<40 hex>", "branch": "turbo/p3", "slot": 1 }`.
- **Integrate record** `run/p<N>-integrate.json` (lane): `{ phase, main, branch, base, state: 'merging'|'conflicts'|'integrated', head?, conflicts?, at }`.
- **Merge record** `run/p<N>-merge.json` (supervisor): `{ v: 1, phase, slot, branch, state: 'merging'|'reintegrate'|'needs-owner'|'merged'|'released', readyAt, outcome, reason, laneHead, base, mergeSha, finalSha, completed, completeSha, stampSha, pushRequestId, rounds, holdAt, ciRed, ownerNotified, waitNotified, released: { ci, at }, at }` (fields appear as they are first set).
- **Hold** `run/p<N>-merge-hold.json`: `{ phase, at }`.
- **Inbox** `reintegrate`: `{ kind: 'reintegrate', base: <main HEAD>, was: <the lane's base>, round, of, seq, at }`. Printed as `reintegrate · main moved to <12 hex> after your base <12 hex> (round r of n)` plus `  run step integrate again: turbo-run phase-step N prints next integrate`.
- **`turbo-run integrate <N>`**: exit 0 with `integrated <main> at <12 hex> (<how>)`, `base <40 hex>`, `full test rounds allowed: <push.ci_fix_rounds>`. `<how>` is `merged into the phase branch`, `main had not moved; took STATE.md, ROADMAP.md and REQUIREMENTS.md from it`, or `already up to date`. Exit 4 with `conflicts: <files>` plus `resolve them within phase <N>, git add each, then run turbo-run integrate <N> again (it commits the merge)`. Exit 1 with `refused: <why>`. Exit 0 with `integrate <N>: not a slot (lanes.mode checkout or a hand run): nothing to integrate`. **`turbo-run integrate <N> --hold`**: `phase <N>: merge hold set; turbo starts no new phase until this one is merged`, exit 0 (exit 1 outside a slot).
- **`turbo-run lane-status <N> ready --base <sha>`**: `lane <N>: ready (base <12 hex>, head <12 hex>); the supervisor merges it into main`, exit 0; `refused: <why>` on stderr, exit 1.
- **`turbo-run phase-step <N> --done integrate`** in a slot: exit 1, `turbo-run phase-step: phase <N>: step integrate is marked by the supervisor after it merges the phase into main; report ready with turbo-run lane-status <N> ready --base <sha>`.
- **Commits in `main`**: `Merge phase <N> (turbo lane <k>)`; `docs(phase-<N>): complete phase (turbo merge)`; `docs(phase-<N>): re-stamp verification (turbo merge)` (a fix merge after the phase was completed); `docs(phase-<N>): re-stamp verification after the merge (turbo merge)` (phase.complete failed); `docs(turbo): owner answers` (L0's default). In the slot: `Merge <main> into turbo/p<N> (turbo integrate)`; `chore(phase-<N>): take STATE.md, ROADMAP.md, REQUIREMENTS.md from <main> (turbo integrate)`.

---

### Task 1: The step `integrate` in the pipeline

**Files:**
- Modify: `lib/phase-progress.mjs` (`export const STEPS`)
- Modify: `lib/cli-phase.mjs` (imports; `function phaseStep`)
- Modify: `lib/view.mjs`, `mod/hooks/view-model.mjs` (step words; the mod's `STEPS`)
- Modify: `test/phase-progress.test.mjs`, `test/view-model.test.mjs`
- Test: `test/integrate-step.test.mjs` (create)

**Interfaces:**
- Consumes: `isSlot(root)` (L0 `lib/paths.mjs`); `completeStep`, `nextStep`, `readProgress`; L0's `fakeSlot`.
- Produces: `STEPS = [... 'uat', 'close', 'integrate']`. `turbo-run phase-step N` outside a slot marks `integrate` done (note `not a slot: nothing to integrate (checkout mode)`) as soon as it is next. In a slot, `--done integrate` is refused. `countAttempt(root, N, 'integrate')` is valid (ATTEMPTS derives from STEPS).

- [ ] **Step 1: Write the failing tests**

Create `test/integrate-step.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { fakeSlot } from './helpers/slots.mjs';
import { STEPS, completeStep, countAttempt, readProgress } from '../lib/phase-progress.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';

// every step up to close done, and a passed verification, so that --done close passes its check
function closable(root) {
  const dir = path.join(root, '.planning', 'phases', '03-demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '03-VERIFICATION.md'), '---\nphase: 03-demo\nstatus: passed\n---\n');
  for (const s of STEPS.slice(0, STEPS.indexOf('close'))) completeStep(root, '3', s);
}
async function step(root, ...args) {
  const lines = [];
  const code = await runPhaseCommand('phase-step', args, { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) });
  return { code, lines };
}

test('integrate is the last step, after close, and counts attempts like a step', () => {
  assert.deepEqual(STEPS.slice(-3), ['uat', 'close', 'integrate']);
  const root = tmpDir('integ');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  assert.equal(countAttempt(root, '3', 'integrate'), 1);
});

test('outside a slot there is nothing to integrate: the step passes as soon as it is next, with its note', async () => {
  const root = tmpDir('integ');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  closable(root);
  const r = await step(root, '3', '--done', 'close');
  assert.equal(r.code, 0);
  assert.match(r.lines.at(-1), /^phase 3: next none \(done: .*, close, integrate\)$/);
  assert.equal(readProgress(root, '3').notes.integrate, 'not a slot: nothing to integrate (checkout mode)');
  // a later call changes nothing
  assert.match((await step(root, '3')).lines.at(-1), /^phase 3: next none/);
});

test('in a slot the step waits for the supervisor: next integrate, and the lane cannot mark it done', async () => {
  const { control, slot } = fakeSlot();
  closable(slot);
  let r = await step(slot, '3', '--done', 'close');
  assert.equal(r.code, 0);
  assert.match(r.lines.at(-1), /^phase 3: next integrate \(done: /);
  r = await step(slot, '3', '--done', 'integrate');
  assert.equal(r.code, 1);
  assert.equal(r.lines.at(-1), 'ERR turbo-run phase-step: phase 3: step integrate is marked by the supervisor after it merges the phase into main; report ready with turbo-run lane-status 3 ready --base <sha>');
  assert.equal(readProgress(slot, '3').done.includes('integrate'), false);
  assert.ok(fs.existsSync(path.join(control, '.planning', 'turbo', 'run', 'phase-p3.json')), 'the progress lives in the control root');
  // the supervisor's own mark (lib/merge.mjs) is a plain completeStep in the control root
  completeStep(control, '3', 'integrate', { note: 'merged' });
  assert.match((await step(slot, '3')).lines.at(-1), /^phase 3: next none/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integrate-step.test.mjs`
Expected: FAIL. `STEPS.slice(-3)` is `['fix', 'final-gate', 'uat']`… then `close`, and `countAttempt(…, 'integrate')` throws `unknown step: integrate`.

- [ ] **Step 3: Implement**

`lib/phase-progress.mjs`: replace the line `export const STEPS = Object.freeze(['freshness', 'discuss', 'prologue', 'plan', 'gates-off', 'execute', 'restore', 'fanout', 'fix', 'final-gate', 'uat', 'close']);` with:

```js
// integrate (Stage 4 §7.1): a lane in a slot takes in main and hands the phase to the supervisor's merge; outside a slot
// turbo-run phase-step passes it at once
export const STEPS = Object.freeze(['freshness', 'discuss', 'prologue', 'plan', 'gates-off', 'execute', 'restore', 'fanout', 'fix', 'final-gate', 'uat', 'close', 'integrate']);
```

`lib/cli-phase.mjs`:

1. Replace `import { gsdCoreDir, runDir } from './paths.mjs';` with `import { gsdCoreDir, isSlot, runDir } from './paths.mjs';`.
2. In `function phaseStep`, right after the line `    const step = String(flags.get('--done'));`, add:

```js
    // Stage 4 §7.2: in a slot the supervisor marks integrate done once it merged the phase and its CI is green
    if (step === 'integrate' && isSlot(root)) fail(`phase ${phase}: step integrate is marked by the supervisor after it merges the phase into main; report ready with turbo-run lane-status ${phase} ready --base <sha>`);
```

3. In the same function, right before the line `  const next = nextStep(p);`, add:

```js
  // outside a slot (lanes.mode checkout, a hand run) there is nothing to integrate: the step passes as soon as it is next
  if (nextStep(p) === 'integrate' && !isSlot(root)) p = completeStep(root, phase, 'integrate', { note: 'not a slot: nothing to integrate (checkout mode)' });
```

`lib/view.mjs` (four replacements, each text occurs once):
- `close: 'wrap-up', ci: 'CI check'` → `close: 'wrap-up', integrate: 'merge into main', ci: 'CI check'`
- `close: 'завершение', ci: 'проверка CI'` → `close: 'завершение', integrate: 'слияние с основной веткой', ci: 'проверка CI'`
- `close: 'wrapping up the phase' }` → `close: 'wrapping up the phase', integrate: 'merging the phase into the main branch' }`
- `close: 'завершает фазу' }` → `close: 'завершает фазу', integrate: 'вливает фазу в основную ветку' }`

`mod/hooks/view-model.mjs`: the same four replacements, and replace `export const STEPS = Object.freeze(['freshness', 'discuss', 'prologue', 'plan', 'gates-off', 'execute', 'restore', 'fanout', 'fix', 'final-gate', 'uat', 'close']);` with `export const STEPS = Object.freeze(['freshness', 'discuss', 'prologue', 'plan', 'gates-off', 'execute', 'restore', 'fanout', 'fix', 'final-gate', 'uat', 'close', 'integrate']);`.

`test/phase-progress.test.mjs`: in the two tests `review 1 (MAJOR 2): phase-step N --done close refuses …` and `review 2: the close check reads YAML inline comments …`, replace `for (const s of STEPS.slice(0, -1)) completeStep(root, '3', s);` with `for (const s of STEPS.slice(0, STEPS.indexOf('close'))) completeStep(root, '3', s);`.

`test/view-model.test.mjs`, test `every /turbo-phase step and the usual helper types are named in words …`: replace `'uat', 'close', 'ci'];` with `'uat', 'close', 'integrate', 'ci'];`. In the test whose `const steps = {` map ends `close: ['wrapping up the phase', 'завершает фазу'],`, replace that entry with `close: ['wrapping up the phase', 'завершает фазу'], integrate: ['merging the phase into the main branch', 'вливает фазу в основную ветку'],`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/integrate-step.test.mjs test/phase-progress.test.mjs test/view-model.test.mjs test/e2e-turbo-phase.test.mjs test/attend.test.mjs test/cli.test.mjs`
Expected: PASS. e2e still prints `next none` after `--done close` (a temp project is not a slot) and counts `STEPS.length` done steps. `test/skill-turbo-phase.test.mjs` fails until Task 8 adds `### integrate` to the skill; do not run it here.

- [ ] **Step 5: Commit**

```bash
git add lib/phase-progress.mjs lib/cli-phase.mjs lib/view.mjs mod/hooks/view-model.mjs test/integrate-step.test.mjs test/phase-progress.test.mjs test/view-model.test.mjs
git commit -m "feat(l2): step integrate after close; passes outside a slot, the supervisor marks it in one"
```

---

### Task 2: `turbo-run integrate N` — the lane takes in main (§7.1 p.1)

**Files:**
- Create: `lib/integrate.mjs`
- Modify: `lib/cli-phase.mjs` (imports, `PHASE_COMMANDS`, `HANDLERS`, new `function integrateCommand`)
- Modify: `bin/turbo-run.mjs` (`USAGE`)
- Create: `test/helpers/lane-merge.mjs`
- Test: `test/integrate.test.mjs` (create)

**Interfaces:**
- Consumes: L0 `isSlot`, `runDir` (control root); `readSlotRecord`, `slotGit`; `setupSlots`, `prepareSlot`, `mainProject`, `slotFixture`, `ISOLATED`, `gitIn`; `pushSettings`, `loadConfig`.
- Produces (in `lib/integrate.mjs`):
  - `SHARED_PLANNING = ['.planning/STATE.md', '.planning/ROADMAP.md', '.planning/REQUIREMENTS.md']`;
  - `integrateFile(root, phase)` → `<control>/.planning/turbo/run/p<N>-integrate.json`; `holdFile(root, phase)` → `…/p<N>-merge-hold.json`;
  - `class IntegrateRefused extends Error`;
  - `integrateMain(root, phase, { git = slotGit(), now = new Date() } = {}) → { state: 'not-slot' } | { state: 'conflicts', base, main, conflicts: string[] } | { state: 'merged'|'shared'|'up-to-date', base, main, head }`;
  - `setMergeHold(root, phase, { now = new Date() } = {}) → { phase, at }`.
- CLI: `turbo-run integrate <N> [--hold]` (Contracts). `deps.slotGit` injects git.
- Test helper: `laneProject({ files, config, job }) → { root, slot, config, fx, git, inMain, inSlot, writeMain, writeSlot, commitMain, commitSlot }`; `PHASE_DIR = '.planning/phases/03-demo'`; `fakeDigest(root, files, phaseDir)`; `finishPhase(p, { code }) → head sha`.

- [ ] **Step 1: Write the test helper and the failing tests**

Create `test/helpers/lane-merge.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ISOLATED, gitIn, mainProject, slotFixture } from './slots.mjs';
import { prepareSlot, setupSlots, slotGit } from '../../lib/slots.mjs';

export const PHASE_DIR = '.planning/phases/03-demo';
const put = (dir, rel, text) => {
  const f = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

// A project (the control root) and its slot 1 holding one job (phase 3 by default) on its turbo/* branch, built with
// L0's own setup and prepare. Git runs isolated from the developer's config.
export function laneProject({ files = {}, config = {}, job = { kind: 'phase', phase: '3' } } = {}) {
  const main = mainProject({
    files: {
      '.planning/STATE.md': '# State\n\nStatus: Ready to execute\n',
      '.planning/REQUIREMENTS.md': '# Requirements\n\n- [ ] REQ-1\n',
      '.planning/turbo/config.json': `${JSON.stringify({ max_lanes: 1, ...config })}\n`,
      'src/app.js': 'export const app = 1;\n',
      ...files,
    },
  });
  const fx = slotFixture(main.root, { max: 1 });
  setupSlots(main.root, fx.config, fx.deps);
  const slot = prepareSlot(main.root, 1, job, fx.deps).path;
  const commitIn = (dir, message) => {
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '-m', message);
    return gitIn(dir, 'rev-parse', 'HEAD');
  };
  return {
    root: main.root, slot, config: fx.config, fx, git: slotGit(ISOLATED),
    inMain: (...a) => gitIn(main.root, ...a), inSlot: (...a) => gitIn(slot, ...a),
    writeMain: (rel, text) => put(main.root, rel, text), writeSlot: (rel, text) => put(slot, rel, text),
    commitMain: (m) => commitIn(main.root, m), commitSlot: (m) => commitIn(slot, m),
  };
}

// The digest a fake gsd-tools gives, in GSD 1.16's v3 shape: each covered file's path and sha256 over its working-tree
// bytes, the phase's own plans and summaries added, repo-wide planning documents left out.
export function fakeDigest(root, files, phaseDir) {
  const own = fs.readdirSync(phaseDir).filter((f) => /-(PLAN|SUMMARY)\.md$/.test(f)).map((f) => path.relative(root, path.join(phaseDir, f)).split(path.sep).join('/'));
  const set = [...new Set([...files, ...own])].filter((f) => !/^\.planning\/[^/]+$/.test(f)).sort();
  const parts = set.map((f) => `${f}\n${createHash('sha256').update(fs.readFileSync(path.join(root, ...f.split('/')))).digest('hex')}\n`).join('');
  return `v3:sha256:${createHash('sha256').update(`v3\n${parts}`).digest('hex')}`;
}

// What a phase leaves in its slot: code, one plan with its summary, GSD's own STATE.md edit, and a passed verification
// fingerprinted over the slot's bytes. Returns the slot's new head.
export function finishPhase(p, { code = { 'src/feature.js': 'export const feature = 1;\n' } } = {}) {
  for (const [rel, text] of Object.entries(code)) p.writeSlot(rel, text);
  p.writeSlot(`${PHASE_DIR}/03-01-PLAN.md`, '---\nphase: 03-demo\nplan: 01\n---\n# Plan\n');
  p.writeSlot(`${PHASE_DIR}/03-01-SUMMARY.md`, '---\nphase: 03-demo\nplan: 01\n---\n# Summary\n');
  p.writeSlot('.planning/STATE.md', '# State\n\nStatus: Executing Phase 03\n');
  const files = Object.keys(code);
  const digest = fakeDigest(p.slot, files, path.join(p.slot, ...PHASE_DIR.split('/')));
  p.writeSlot(`${PHASE_DIR}/03-VERIFICATION.md`, ['---', 'phase: 03-demo', 'status: passed', 'score: 2/2 must-haves verified', 'covered_files:', ...files.map((f) => `  - ${f}`), `covered_digest: "${digest}"`, '---', '', '# Verification', ''].join('\n'));
  return p.commitSlot('feat(03): demo');
}
```

Create `test/integrate.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PHASE_DIR, finishPhase, laneProject } from './helpers/lane-merge.mjs';
import { IntegrateRefused, SHARED_PLANNING, holdFile, integrateFile, integrateMain } from '../lib/integrate.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { readJson } from '../lib/fsx.mjs';

const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
const merging = (dir) => fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'));

test('main has not moved: nothing to merge, but STATE.md, ROADMAP.md and REQUIREMENTS.md come back from main in one commit', () => {
  const p = laneProject();
  finishPhase(p);
  const mainHead = p.inMain('rev-parse', 'HEAD');
  const r = integrateMain(p.slot, '3', { git: p.git });
  assert.deepEqual([r.state, r.base, r.main, r.head], ['shared', mainHead, 'main', p.inSlot('rev-parse', 'HEAD')]);
  for (const f of SHARED_PLANNING) if (fs.existsSync(path.join(p.root, f))) assert.equal(read(p.slot, f), read(p.root, f), f);
  assert.equal(p.inSlot('log', '-1', '--format=%s'), 'chore(phase-3): take STATE.md, ROADMAP.md, REQUIREMENTS.md from main (turbo integrate)');
  assert.equal(p.inSlot('status', '--porcelain', '--untracked-files=no'), '');
  const rec = readJson(integrateFile(p.slot, '3'), null);
  assert.deepEqual([rec.phase, rec.main, rec.branch, rec.base, rec.state, rec.head], ['3', 'main', 'turbo/p3', mainHead, 'integrated', r.head]);
  assert.ok(fs.existsSync(path.join(p.root, '.planning', 'turbo', 'run', 'p3-integrate.json')), 'the record lives in the control root');
  // run again: already up to date, nothing new
  assert.equal(integrateMain(p.slot, '3', { git: p.git }).state, 'up-to-date');
});

test('main moved: merged into the phase branch; a STATE.md both sides changed takes main\'s version without a conflict', () => {
  const p = laneProject();
  finishPhase(p);
  p.writeMain('src/other.js', 'export const other = 2;\n');
  p.writeMain('.planning/STATE.md', '# State\n\nStatus: Phase 2 complete\n');
  const mainHead = p.commitMain('feat: phase 2');
  const r = integrateMain(p.slot, '3', { git: p.git });
  assert.deepEqual([r.state, r.base], ['merged', mainHead]);
  assert.equal(p.inSlot('rev-parse', 'HEAD^2'), mainHead);
  assert.equal(p.inSlot('log', '-1', '--format=%s'), 'Merge main into turbo/p3 (turbo integrate)');
  assert.equal(read(p.slot, '.planning/STATE.md'), '# State\n\nStatus: Phase 2 complete\n');
  assert.equal(read(p.slot, 'src/other.js'), 'export const other = 2;\n');
  assert.equal(read(p.slot, 'src/feature.js'), 'export const feature = 1;\n');
  assert.equal(merging(p.slot), false);
});

test('a conflict in code stays for the lane; after it resolves and stages the file, a second run commits the merge', () => {
  const p = laneProject();
  finishPhase(p, { code: { 'src/app.js': 'export const app = 3;\n' } });
  p.writeMain('src/app.js', 'export const app = 2;\n');
  p.commitMain('feat: app 2');
  const r = integrateMain(p.slot, '3', { git: p.git });
  assert.deepEqual([r.state, r.conflicts], ['conflicts', ['src/app.js']]);
  assert.equal(merging(p.slot), true);
  assert.equal(readJson(integrateFile(p.slot, '3'), null).state, 'conflicts');
  p.writeSlot('src/app.js', 'export const app = 3;\n');
  p.inSlot('add', 'src/app.js');
  const again = integrateMain(p.slot, '3', { git: p.git });
  assert.deepEqual([again.state, again.base], ['merged', r.base]);
  assert.equal(merging(p.slot), false);
  assert.equal(readJson(integrateFile(p.slot, '3'), null).state, 'integrated');
});

test('refusals change nothing: not this phase, uncommitted changes, a merge turbo did not start; outside a slot nothing to do', () => {
  const p = laneProject();
  finishPhase(p);
  assert.deepEqual(integrateMain(p.root, '3', { git: p.git }), { state: 'not-slot' });
  const refused = (phase, re) => assert.throws(() => integrateMain(p.slot, phase, { git: p.git }), (e) => e instanceof IntegrateRefused && re.test(e.message));
  refused('4', /this slot holds no active job of phase 4/);
  p.writeSlot('src/feature.js', 'dirty\n');
  refused('3', /uncommitted changes: src\/feature\.js; commit or discard them first/);
  p.inSlot('checkout', '--', 'src/feature.js');
  p.writeMain('src/feature.js', 'export const feature = 0;\n');
  p.commitMain('main side');
  p.inSlot('fetch', '-q', 'origin');
  try { p.inSlot('merge', '--no-ff', '--no-commit', 'origin/main'); } catch { /* a conflict: the merge stays in progress */ }
  refused('3', /a merge of [0-9a-f]{12} is in progress that turbo-run integrate did not start: finish it or abort it \(git merge --abort\) first/);
  assert.equal(read(p.slot, `${PHASE_DIR}/03-01-PLAN.md`).startsWith('---'), true);
});

test('turbo-run integrate N prints the base and the fix rounds; exit 4 on conflicts; --hold writes the hold in the control root', async () => {
  const p = laneProject();
  finishPhase(p);
  const lines = [];
  const run = (root, ...a) => runPhaseCommand('integrate', a, { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`), deps: { slotGit: p.git } });
  assert.equal(await run(p.slot, '3'), 0);
  assert.match(lines[0], /^integrated main at [0-9a-f]{12} \(main had not moved; took STATE\.md, ROADMAP\.md and REQUIREMENTS\.md from it\)$/);
  assert.equal(lines[1], `base ${p.inMain('rev-parse', 'HEAD')}`);
  assert.equal(lines[2], 'full test rounds allowed: 2');
  assert.equal(await run(p.slot, '3', '--hold'), 0);
  assert.equal(lines.at(-1), 'phase 3: merge hold set; turbo starts no new phase until this one is merged');
  assert.deepEqual(Object.keys(readJson(holdFile(p.slot, '3'), null)).sort(), ['at', 'phase']);
  assert.ok(fs.existsSync(path.join(p.root, '.planning', 'turbo', 'run', 'p3-merge-hold.json')));
  p.writeMain('src/feature.js', 'export const feature = 0;\n');
  p.commitMain('main side');
  p.writeSlot('src/feature.js', 'export const feature = 9;\n');
  p.commitSlot('slot side');
  assert.equal(await run(p.slot, '3'), 4);
  assert.deepEqual(lines.slice(-2), ['conflicts: src/feature.js', 'resolve them within phase 3, git add each, then run turbo-run integrate 3 again (it commits the merge)']);
  assert.equal(await run(p.root, '3'), 0);
  assert.equal(lines.at(-1), 'integrate 3: not a slot (lanes.mode checkout or a hand run): nothing to integrate');
  assert.equal(await run(p.root, '3', '--hold'), 1);
  assert.match(lines.at(-1), /^ERR turbo-run integrate: --hold is for a lane in a slot/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/integrate.test.mjs`
Expected: FAIL with `Cannot find module '…/lib/integrate.mjs'`.

- [ ] **Step 3: Implement**

Create `lib/integrate.mjs`:

```js
import path from 'node:path';
import { isSlot, runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { readSlotRecord, slotGit } from './slots.mjs';

// Stage 4 §7.1 p.1: the files whose main-branch version a lane always takes; the supervisor marks the phase in them
// after the merge (gsd-tools phase.complete in main).
export const SHARED_PLANNING = Object.freeze(['.planning/STATE.md', '.planning/ROADMAP.md', '.planning/REQUIREMENTS.md']);
// run files of the lane (stateRoot: they land in the control root)
export const integrateFile = (root, phase) => path.join(runDir(root), `p${phase}-integrate.json`);
export const holdFile = (root, phase) => path.join(runDir(root), `p${phase}-merge-hold.json`);

export class IntegrateRefused extends Error {}
const refuse = (text) => { throw new IntegrateRefused(text); };
const lines = (s) => String(s ?? '').split(/\r?\n/).filter(Boolean);
const changedTracked = (git, root) => lines(git(root, ['status', '--porcelain', '--untracked-files=no'])).map((l) => l.slice(3));
const inMerge = (git, root) => git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { ok: true }) !== null;

// The slot's active job for this phase, or a refusal.
function phaseJob(root, phase) {
  const job = readSlotRecord(root)?.job;
  if (!job || job.kind !== 'phase' || String(job.phase) !== String(phase) || job.state !== 'active') refuse(`this slot holds no active job of phase ${phase}`);
  return job;
}

function onJobBranch(git, root, job) {
  const current = git(root, ['symbolic-ref', '-q', '--short', 'HEAD'], { ok: true });
  if (current !== job.branch) refuse(`the slot is on ${current || 'a detached HEAD'}, not on ${job.branch}`);
}

// Stage 4 §7.1 p.1, in the lane's slot: fetch the main branch, merge it into the phase branch, take main's three shared
// planning files, and commit at once when nothing conflicts (decision D2). A conflicted merge stays in progress for the
// lane; the next call, after the lane staged its resolutions, takes the three files again and commits.
export function integrateMain(root, phase, { git = slotGit(), now = new Date() } = {}) {
  if (!isSlot(root)) return { state: 'not-slot' };
  const job = phaseJob(root, phase);
  const main = job.base.branch;
  onJobBranch(git, root, job);
  const record = (fields) => writeJsonAtomic(integrateFile(root, phase), { phase: String(phase), main, branch: job.branch, ...fields, at: now.toISOString() });
  let base;
  if (inMerge(git, root)) {
    base = git(root, ['rev-parse', 'MERGE_HEAD']);
    const rec = readJson(integrateFile(root, phase), null);
    if (rec?.base !== base) refuse(`a merge of ${base.slice(0, 12)} is in progress that turbo-run integrate did not start: finish it or abort it (git merge --abort) first`);
  } else {
    const dirty = changedTracked(git, root);
    if (dirty.length) refuse(`uncommitted changes: ${dirty.slice(0, 5).join(', ')}; commit or discard them first`);
    git(root, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${main}:refs/remotes/origin/${main}`]);
    base = git(root, ['rev-parse', '--verify', `refs/remotes/origin/${main}^{commit}`]);
    record({ base, state: 'merging' });
    try {
      git(root, ['merge', '--no-ff', '--no-commit', '--no-edit', base]);
    } catch (e) {
      // exit 1 with MERGE_HEAD: conflicts, handled below; anything else never started a merge
      if (!inMerge(git, root)) refuse(`git merge ${base.slice(0, 12)} did not start: ${String(e?.message ?? e).split(/\r?\n/)[0]}`);
    }
  }
  // §7.1 p.1: main's version of the three files, at a conflict and always after the merge (decision D3)
  for (const f of SHARED_PLANNING) {
    if (git(root, ['ls-tree', '--name-only', base, '--', f])) git(root, ['checkout', base, '--', f]);
    else git(root, ['rm', '-q', '-f', '--ignore-unmatch', '--', f]);
  }
  const conflicts = lines(git(root, ['diff', '--name-only', '--diff-filter=U']));
  if (conflicts.length) {
    record({ base, state: 'conflicts', conflicts });
    return { state: 'conflicts', base, main, conflicts };
  }
  let state = 'up-to-date';
  if (inMerge(git, root)) {
    git(root, ['commit', '-q', '-m', `Merge ${main} into ${job.branch} (turbo integrate)`]);
    state = 'merged';
  } else if (git(root, ['diff', '--cached', '--quiet'], { ok: true }) === null) {
    git(root, ['commit', '-q', '-m', `chore(phase-${phase}): take ${SHARED_PLANNING.map((f) => path.posix.basename(f)).join(', ')} from ${main} (turbo integrate)`]);
    state = 'shared';
  }
  const head = git(root, ['rev-parse', 'HEAD']);
  record({ base, state: 'integrated', head });
  return { state, base, main, head };
}

// Decision D16: the owner chose to wait while main moves faster than this phase merges; L1 starts no new phase while a
// hold exists, and the supervisor's merge gives the phase a fresh round budget. Removed at the slot's release.
export function setMergeHold(root, phase, { now = new Date() } = {}) {
  if (!isSlot(root)) throw new IntegrateRefused('--hold is for a lane in a slot (lanes.mode slots)');
  const rec = { phase: String(phase), at: now.toISOString() };
  writeJsonAtomic(holdFile(root, phase), rec);
  return rec;
}
```

`lib/cli-phase.mjs`:

1. Add to the imports: `import { IntegrateRefused, integrateMain, setMergeHold } from './integrate.mjs';` and `import { slotGit } from './slots.mjs';`.
2. In `export const PHASE_COMMANDS = new Set([`, add `'integrate'` after `'agent-tail'`.
3. In `export const HANDLERS = {`, add `  integrate: integrateCommand,` after `'agent-tail': agentTailCommand,`.
4. Right before `// Several matches mean unrelated projects share .planning/phases (GSD #2237): name them, never pick one.`, add:

```js
const INTEGRATE_USAGE = 'integrate <phase> [--hold]';
const INTEGRATED = {
  merged: 'merged into the phase branch',
  shared: 'main had not moved; took STATE.md, ROADMAP.md and REQUIREMENTS.md from it',
  'up-to-date': 'already up to date',
};

// Stage 4 §7.1 p.1: the lane takes in the main branch in its slot; --hold is the owner's "wait" on the merge card (D16).
function integrateCommand({ root, pos, flags, out, deps }) {
  const phase = phaseArg(pos, 0, INTEGRATE_USAGE);
  const now = deps.now ? deps.now() : new Date();
  if (flags.has('--hold')) {
    try {
      setMergeHold(root, phase, { now });
    } catch (e) {
      if (e instanceof IntegrateRefused) fail(e.message);
      throw e;
    }
    out(`phase ${phase}: merge hold set; turbo starts no new phase until this one is merged`);
    return 0;
  }
  let r;
  try {
    r = integrateMain(root, phase, { git: deps.slotGit || slotGit(deps.env || process.env), now });
  } catch (e) {
    if (!(e instanceof IntegrateRefused)) throw e;
    out(`refused: ${e.message}`);
    return 1;
  }
  if (r.state === 'not-slot') {
    out(`integrate ${phase}: not a slot (lanes.mode checkout or a hand run): nothing to integrate`);
    return 0;
  }
  if (r.state === 'conflicts') {
    out(`conflicts: ${r.conflicts.join(', ')}`);
    out(`resolve them within phase ${phase}, git add each, then run turbo-run integrate ${phase} again (it commits the merge)`);
    return 4;
  }
  out(`integrated ${r.main} at ${r.base.slice(0, 12)} (${INTEGRATED[r.state]})`);
  out(`base ${r.base}`);
  out(`full test rounds allowed: ${pushSettings(loadConfig(root).push).ci_fix_rounds}`);
  return 0;
}
```

`bin/turbo-run.mjs`: in `const USAGE`, replace `push-allow|state-sync|` with `push-allow|state-sync|integrate|`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/integrate.test.mjs test/integrate-step.test.mjs`
Expected: PASS (5 + 3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/integrate.mjs lib/cli-phase.mjs bin/turbo-run.mjs test/helpers/lane-merge.mjs test/integrate.test.mjs
git commit -m "feat(l2): turbo-run integrate N merges main into the lane's slot and takes main's shared planning files"
```

---

### Task 3: `lane-status N ready --base`, push requests in a slot, the `reintegrate` inbox line

**Files:**
- Modify: `lib/integrate.mjs` (append `readyRecord`)
- Modify: `lib/run-status.mjs` (`LANE_STATUSES`, `writeLaneStatus`)
- Modify: `bin/turbo-run.mjs` (imports, `VALUE_FLAGS`, `case 'lane-status'`)
- Modify: `lib/cli-phase.mjs` (`async function pushRequest`)
- Modify: `lib/inbox.mjs` (`formatInboxMessage`)
- Modify: `test/helpers/lane-merge.mjs` (append `reportReady`, `laneOf`)
- Test: `test/ready.test.mjs` (create)

**Interfaces:**
- Consumes: Task 2's `integrateMain`, `integrateFile`, `IntegrateRefused`, `phaseJob` (module-private), `inMerge`, `changedTracked`; L0 `isSlot`, `readSlotRecord`, `slotGit`.
- Produces:
  - `readyRecord(root, phase, { base, git = slotGit() } = {}) → { base, head, branch, slot }` (throws `IntegrateRefused`);
  - `LANE_STATUSES = ['running', 'paused-context', 'needs-owner', 'done', 'failed', 'ready']`;
  - `writeLaneStatus(root, phase, status, { reason, sessionId, at, fields = {} })` → `{ ...fields, phase, status, reason, sessionId, at }`;
  - `turbo-run lane-status <N> ready --base <sha> [--reason <text>]` (Contracts);
  - `push-request` in a slot (D20); `formatInboxMessage` for `kind: 'reintegrate'`.
  - Helper: `reportReady(p) → integrate result`; `laneOf(p) → supervisor.json lane entry for phase 3 in slot 1`.

- [ ] **Step 1: Write the failing tests**

Append to `test/helpers/lane-merge.mjs`:

```js
import { writeLaneStatus } from '../../lib/run-status.mjs';
import { integrateMain, readyRecord } from '../../lib/integrate.mjs';

// The lane's end of §7.1, as turbo-run integrate 3 and turbo-run lane-status 3 ready --base <sha> do it. Each ready
// record gets its own time a second apart: the merge decides once per record (decision D5), keyed by its at.
let readyCount = 0;
export function reportReady(p, { reason = 'integrated' } = {}) {
  const r = integrateMain(p.slot, '3', { git: p.git });
  if (r.state === 'conflicts') throw new Error(`conflicts: ${r.conflicts.join(', ')}`);
  readyCount += 1;
  const at = new Date(Date.parse('2026-10-13T12:00:00.000Z') + readyCount * 1000).toISOString();
  writeLaneStatus(p.slot, '3', 'ready', { reason, at, fields: readyRecord(p.slot, '3', { base: r.base, git: p.git }) });
  return r;
}

// The supervisor.json lane entry of phase 3 in slot 1 (L0's Interfaces: owned by L1).
export const laneOf = (p) => ({ key: '3', job: 'phase', phase: '3', slot: 1, slotPath: p.slot, branch: 'turbo/p3', sessionId: null, launchedAt: '2026-10-13T12:00:00.000Z', restarts: 0, notified: {}, mode: 'full' });
```

(Move the two new `import` lines to the top of the helper with the others.)

Create `test/ready.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ISOLATED } from './helpers/slots.mjs';
import { finishPhase, laneProject } from './helpers/lane-merge.mjs';
import { IntegrateRefused, integrateMain, readyRecord } from '../lib/integrate.mjs';
import { LANE_STATUSES, readLaneStatus } from '../lib/run-status.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { requestFile } from '../lib/push.mjs';
import { formatInboxMessage } from '../lib/inbox.mjs';

const BIN = path.resolve('bin/turbo-run.mjs');

test('lane-status N ready --base writes the record the supervisor reads, in the control root; a fix after integrating is fine', () => {
  assert.deepEqual(LANE_STATUSES, ['running', 'paused-context', 'needs-owner', 'done', 'failed', 'ready']);
  const p = laneProject();
  finishPhase(p);
  const r = integrateMain(p.slot, '3', { git: p.git });
  p.writeSlot('src/fix.js', 'export const fix = 1;\n');
  const head = p.commitSlot('fix: red after the merge');
  assert.deepEqual(readyRecord(p.slot, '3', { base: r.base, git: p.git }), { base: r.base, head, branch: 'turbo/p3', slot: 1 });
  const out = execFileSync(process.execPath, [BIN, 'lane-status', '3', 'ready', '--base', r.base, '--reason', 'integrated', '--project', p.slot], { env: ISOLATED, encoding: 'utf8' });
  assert.equal(out, `lane 3: ready (base ${r.base.slice(0, 12)}, head ${head.slice(0, 12)}); the supervisor merges it into main\n`);
  const rec = readLaneStatus(p.root, '3');
  assert.deepEqual({ ...rec, at: 'x' }, { base: r.base, head, branch: 'turbo/p3', slot: 1, phase: '3', status: 'ready', reason: 'integrated', sessionId: '', at: 'x' });
});

test('ready refuses what the supervisor must not merge, naming why, and writes nothing', () => {
  const p = laneProject();
  finishPhase(p);
  const refused = (root, base, re) => assert.throws(() => readyRecord(root, '3', { base, git: p.git }), (e) => e instanceof IntegrateRefused && re.test(e.message));
  refused(p.slot, '', /--base needs the full 40-hex sha that turbo-run integrate printed/);
  refused(p.slot, p.inMain('rev-parse', 'HEAD'), /is not the base of the last finished turbo-run integrate 3: run turbo-run integrate 3 first/);
  const r = integrateMain(p.slot, '3', { git: p.git });
  refused(p.slot, r.base.slice(0, 12), /40-hex/);
  p.writeSlot('src/feature.js', 'changed\n');
  refused(p.slot, r.base, /uncommitted changes: src\/feature\.js/);
  p.inSlot('checkout', '--', 'src/feature.js');
  p.inSlot('checkout', '-q', '-b', 'side');
  refused(p.slot, r.base, /the slot is on side, not on turbo\/p3/);
  p.inSlot('checkout', '-q', 'turbo/p3');
  refused(p.root, r.base, /lane-status ready is for a lane in a slot/);
  const res = spawnSync(process.execPath, [BIN, 'lane-status', '3', 'ready', '--project', p.slot], { env: ISOLATED, encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^refused: --base needs the full 40-hex sha/);
  assert.equal(readLaneStatus(p.root, '3'), null);
});

test('push-request in a slot files nothing: the supervisor pushes main after the merge (spec §7.3); push off keeps its line', async () => {
  const p = laneProject({ config: { push: { mode: 'after-wave', ci: 'none' } } });
  const lines = [];
  const run = (root, ...a) => runPhaseCommand('push-request', a, { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) });
  assert.equal(await run(p.slot, '3', '--at', 'wave'), 0);
  assert.equal(lines.at(-1), 'push in slots: nothing requested at a wave; the supervisor pushes main after it merges this phase');
  for (const args of [['--at', 'phase', '--wait'], ['--wait'], []]) {
    assert.equal(await run(p.slot, '3', ...args), 0);
    assert.equal(lines.at(-1), 'push in slots: nothing requested; the supervisor merges this phase in step integrate and pushes main');
  }
  assert.equal(fs.existsSync(requestFile(p.slot, '3')), false);
  const q = laneProject();
  assert.equal(await run(q.slot, '3', '--at', 'phase'), 0);
  assert.match(lines.at(-1), /^push off: nothing requested/);
});

test('the inbox prints a reintegrate message with what moved and what to do', () => {
  const text = formatInboxMessage({ kind: 'reintegrate', base: 'a'.repeat(40), was: 'b'.repeat(40), round: 2, of: 3, seq: 4, at: 'x' }, { phase: '3', ciFixRounds: 2 });
  assert.equal(text, `reintegrate · main moved to ${'a'.repeat(12)} after your base ${'b'.repeat(12)} (round 2 of 3)\n  run step integrate again: turbo-run phase-step 3 prints next integrate`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/ready.test.mjs`
Expected: FAIL with `does not provide an export named 'readyRecord'`.

- [ ] **Step 3: Implement**

Append to `lib/integrate.mjs`:

```js
const SHA = /^[0-9a-f]{40}$/;

// Stage 4 §7.1 p.4 (decision D1): what turbo-run lane-status N ready --base <sha> records for the supervisor. Refuses
// anything the supervisor must not merge: another base than the last finished integrate, another branch, uncommitted
// tracked changes, a merge in progress, a head that does not hold the base.
export function readyRecord(root, phase, { base, git = slotGit() } = {}) {
  if (!isSlot(root)) refuse('lane-status ready is for a lane in a slot (lanes.mode slots); outside a slot the close step records done');
  if (!SHA.test(String(base ?? ''))) refuse('--base needs the full 40-hex sha that turbo-run integrate printed on its base line');
  const job = phaseJob(root, phase);
  const rec = readJson(integrateFile(root, phase), null);
  if (rec?.state !== 'integrated' || rec.base !== base) {
    refuse(`--base ${base.slice(0, 12)} is not the base of the last finished turbo-run integrate ${phase}${rec?.base ? ` (that is ${rec.base.slice(0, 12)}, ${rec.state})` : ''}: run turbo-run integrate ${phase} first`);
  }
  onJobBranch(git, root, job);
  if (inMerge(git, root)) refuse(`a merge is still in progress: finish it with turbo-run integrate ${phase}`);
  const dirty = changedTracked(git, root);
  if (dirty.length) refuse(`uncommitted changes: ${dirty.slice(0, 5).join(', ')}; commit them first`);
  if (git(root, ['merge-base', '--is-ancestor', base, 'HEAD'], { ok: true }) === null) refuse(`HEAD does not hold the base ${base.slice(0, 12)}: run turbo-run integrate ${phase} again`);
  return { base, head: git(root, ['rev-parse', 'HEAD']), branch: job.branch, slot: readSlotRecord(root).k };
}
```

`lib/run-status.mjs`: replace `export const LANE_STATUSES = ['running', 'paused-context', 'needs-owner', 'done', 'failed'];` with:

```js
// ready (Stage 4 §7.1 p.4): a lane in a slot finished integrate and waits for the supervisor's merge (lib/merge.mjs)
export const LANE_STATUSES = ['running', 'paused-context', 'needs-owner', 'done', 'failed', 'ready'];
```

and replace the whole `export function writeLaneStatus(` function with:

```js
// fields: the ready record's base, head, branch and slot (lib/integrate.mjs readyRecord); never a core key.
export function writeLaneStatus(root, phase, status, { reason = '', sessionId = '', at = new Date().toISOString(), fields = {} } = {}) {
  if (!LANE_STATUSES.includes(status)) throw new Error(`unknown lane status: ${status}`);
  const rec = { ...fields, phase: String(phase), status, reason, sessionId, at };
  writeJsonAtomic(file(root, phase), rec);
  return rec;
}
```

`bin/turbo-run.mjs`:

1. Add the import `import { IntegrateRefused, readyRecord } from '../lib/integrate.mjs';`.
2. In `const VALUE_FLAGS = new Set([`, add `'--base'` after `'--reason'`.
3. In `case 'lane-status': {`, replace the lines from `      if (!phase || !PHASE_ID.test(phase) || !LANE_STATUSES.includes(status)) die(` through `      out(\`lane ${id}: ${status}\`);` with:

```js
      if (!phase || !PHASE_ID.test(phase) || !LANE_STATUSES.includes(status)) die(`lane-status <phase> <${LANE_STATUSES.join('|')}> [--reason <text>] [--base <sha>]`);
      const id = normalizePhaseId(phase);
      // Stage 4 §7.1 p.4: ready carries what the supervisor's merge checks (lib/integrate.mjs readyRecord)
      let fields = {};
      if (status === 'ready') {
        try {
          fields = readyRecord(root, id, { base: flag(args, '--base') });
        } catch (e) {
          if (e instanceof IntegrateRefused) die(`refused: ${e.message}`);
          throw e;
        }
      }
      writeLaneStatus(root, id, status, { reason: flag(args, '--reason'), fields });
      out(status === 'ready' ? `lane ${id}: ready (base ${fields.base.slice(0, 12)}, head ${fields.head.slice(0, 12)}); the supervisor merges it into main` : `lane ${id}: ${status}`);
```

`lib/cli-phase.mjs`, in `async function pushRequest`, right after the line `  const settings = pushSettings(config.push);`, add:

```js
  // Stage 4 §7.3 (D20): a lane in a slot never pushes; the supervisor merges the phase and pushes main
  if (isSlot(root) && settings.mode !== 'off') {
    out(point === 'wave' ? 'push in slots: nothing requested at a wave; the supervisor pushes main after it merges this phase' : 'push in slots: nothing requested; the supervisor merges this phase in step integrate and pushes main');
    return 0;
  }
```

`lib/inbox.mjs`, in `export function formatInboxMessage`, replace its first line `  if (m.kind !== 'ci-red') return \`${m.kind} · ${JSON.stringify(m)}\`;` with:

```js
  // Stage 4 §7.2 p.3: main moved before the supervisor could merge; the lane integrates again
  if (m.kind === 'reintegrate') {
    return [
      `reintegrate · main moved to ${String(m.base ?? '').slice(0, 12)} after your base ${String(m.was ?? '').slice(0, 12)} (round ${m.round} of ${m.of})`,
      `  run step integrate again: turbo-run phase-step ${phase} prints next integrate`,
    ].join('\n');
  }
  if (m.kind !== 'ci-red') return `${m.kind} · ${JSON.stringify(m)}`;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/ready.test.mjs test/integrate.test.mjs test/inbox.test.mjs test/push-cli.test.mjs test/run-status.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/integrate.mjs lib/run-status.mjs bin/turbo-run.mjs lib/cli-phase.mjs lib/inbox.mjs test/helpers/lane-merge.mjs test/ready.test.mjs
git commit -m "feat(l2): lane-status N ready --base records what the merge checks; slots never file push requests"
```

---

### Task 4: `mergeReady` — the lock, the main checks, reintegrate, the merge

**Files:**
- Create: `lib/merge.mjs`
- Modify: `lib/messages.mjs` (`mergeWaiting` in `M.en` and `M.ru`)
- Modify: `test/helpers/lane-merge.mjs` (append `fakeGsd`, `mergeCtx`)
- Test: `test/merge.test.mjs` (create)

**Interfaces:**
- Consumes: L0 `withMergeLock`, `MergeLocked`, `mergeLockFile`, `commitPendingAnswers`, `mainBranch`, `readSlotRecord`, `slotGit`, `SlotRefused`; `readLaneStatus`, `writeLaneStatus`; `appendInbox`; `askOwner`, `readQuestions`; Task 2's `holdFile`, `setMergeHold`; Task 3's `reportReady`, `laneOf`.
- Produces (in `lib/merge.mjs`):
  - `MERGE_ROUNDS_DEFAULT = 3`; `mergeRounds(config) → number`;
  - `mergeFile(root, phase)`; `mergeState(root, phase) → MergeRecord | null`;
  - `mergeHolds(root) → string[]` (phases with a hold, sorted);
  - `mainNotReady(git, root, want) → string | null`;
  - `mergeReady(ctx, lane) → Promise<{ outcome: 'merged'|'reintegrate'|'needs-owner'|'wait', reason?, sha? }>`.
- Helper: `fakeGsd({ calls, fail }) → (args, { cwd }) => string`; `mergeCtx(p, { push, lang, merge_rounds, gsd }) → { ctx, notes, logs, calls }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/helpers/lane-merge.mjs` (imports to the top):

```js
import { createGit } from '../../lib/push.mjs';
import { pushSettings } from '../../lib/config.mjs';

const fpOf = (text) => ({
  files: [...text.matchAll(/^ {2}- (.+?)\r?$/gm)].map((m) => m[1]),
  digest: /^covered_digest: "?([^"\r\n]+)"?\r?$/m.exec(text)?.[1] ?? null,
  status: /^status: (\w+)\r?$/m.exec(text)?.[1] ?? null,
});

// gsd-tools as lib/merge.mjs calls it (deps.gsd), on the files of cwd: GSD 1.16's verification.fingerprint (--raw),
// verification status and phase.complete (which refuses a stale or not-passed report, then marks ROADMAP and STATE).
// fail: { '<first two args>': '<stderr line>' } makes that call fail as gsdText reports it.
export function fakeGsd({ calls = [], fail = {} } = {}) {
  return (args, { cwd }) => {
    calls.push(args.join(' '));
    const key = args.slice(0, 2).join(' ');
    if (fail[key]) throw new Error(`gsd-tools ${key} failed: ${fail[key]}`);
    const status = (dir) => {
      const name = fs.readdirSync(dir).find((n) => n.endsWith('-VERIFICATION.md'));
      if (!name) return 'missing';
      const v = fpOf(fs.readFileSync(path.join(dir, name), 'utf8'));
      return v.digest === fakeDigest(cwd, v.files, dir) ? v.status : 'stale';
    };
    if (key === 'query verification.fingerprint') return `${fakeDigest(cwd, args.slice(3).filter((a) => a !== '--raw'), args[2])}\n`;
    if (key === 'verification status') return JSON.stringify({ status: status(args[2]) });
    if (key === 'query phase.complete') {
      const s = status(path.join(cwd, ...PHASE_DIR.split('/')));
      if (s !== 'passed') throw new Error(`gsd-tools query phase.complete failed: Error: Phase ${args[2]} verification is incomplete: ${s === 'stale' ? 'Verification is stale' : `status ${s}`}`);
      fs.appendFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), `- [x] Phase ${args[2]} complete\n`);
      fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), `# State\n\nStatus: Phase ${args[2]} complete\n`);
      return JSON.stringify({ completed_phase: args[2], roadmap_updated: true, state_updated: true, requirements_updated: false, warnings: [] });
    }
    throw new Error(`fake gsd-tools: unexpected call ${args.join(' ')}`);
  };
}

// The supervisor's ctx for lib/merge.mjs: isolated git, the fake gsd-tools, no state-sync, recorded notifications.
export function mergeCtx(p, { push = { mode: 'off' }, lang = 'en', merge_rounds, gsd, now = '2026-10-13T13:00:00.000Z' } = {}) {
  const notes = [];
  const logs = [];
  const calls = [];
  const config = { ...p.config, lang, push: pushSettings(push), ...(merge_rounds === undefined ? {} : { merge_rounds }) };
  const ctx = {
    root: p.root,
    config,
    deps: {
      log: (line) => logs.push(line),
      notify: async (key, vars) => { notes.push([key, vars]); },
      now: () => new Date(now),
      gitAt: p.git,
      git: createGit(p.root, { env: ISOLATED }),
      gsd: gsd || fakeGsd({ calls }),
      stateSync: () => ({ synced: false, reason: 'test' }),
      mergeLockWaitMs: 200,
    },
  };
  return { ctx, notes, logs, calls };
}
```

Create `test/merge.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { finishPhase, laneOf, laneProject, mergeCtx, reportReady } from './helpers/lane-merge.mjs';
import { MERGE_ROUNDS_DEFAULT, mergeHolds, mergeReady, mergeRounds, mergeState } from '../lib/merge.mjs';
import { mergeLockFile } from '../lib/merge-lock.mjs';
import { setMergeHold } from '../lib/integrate.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';
import { readInbox } from '../lib/inbox.mjs';
import { readQuestions } from '../lib/questions.mjs';

const mergeOf = (p) => p.inMain('rev-list', '--merges', '-n', '1', 'HEAD');

test('mergeRounds: a whole number from 1, else 3', () => {
  assert.equal(MERGE_ROUNDS_DEFAULT, 3);
  for (const [v, want] of [[1, 1], [5, 5], [undefined, 3], [0, 3], [-1, 3], [2.5, 3], ['2', 3], [null, 3]]) assert.equal(mergeRounds({ merge_rounds: v }), want, String(v));
});

test('HEAD == base: the verified tip merges with --no-ff and the spec\'s message; the merge tree is the lane\'s tree; the same ready record is decided once', async () => {
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  const rec = readLaneStatus(p.root, '3');
  const m = mergeCtx(p);
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  const merge = mergeOf(p);
  assert.equal(p.inMain('log', '-1', '--format=%s', merge), 'Merge phase 3 (turbo lane 1)');
  assert.deepEqual([p.inMain('rev-parse', `${merge}^1`), p.inMain('rev-parse', `${merge}^2`)], [rec.base, rec.head]);
  assert.equal(p.inMain('rev-parse', `${merge}^{tree}`), p.inMain('rev-parse', `${rec.head}^{tree}`));
  assert.equal(r.sha, p.inMain('rev-parse', 'HEAD'));
  const st = mergeState(p.root, '3');
  assert.deepEqual([st.state, st.readyAt, st.laneHead, st.mergeSha, st.rounds], ['merged', rec.at, rec.head, merge, 0]);
  const again = await mergeReady(m.ctx, laneOf(p));
  assert.deepEqual([again.outcome, again.reason], ['wait', 'phase 3\'s ready record was handled already (merged)']);
  assert.equal(p.inMain('rev-list', '--merges', '--count', 'HEAD'), '1');
});

test('HEAD != base: a reintegrate message in the lane\'s inbox, once per ready record; after it integrates again the merge goes through and the rounds reset', async () => {
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  p.writeMain('src/other.js', 'export const other = 2;\n');
  const moved = p.commitMain('feat: another phase merged first');
  const m = mergeCtx(p);
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'reintegrate');
  assert.match(r.reason, /^main is at [0-9a-f]{12}, the lane integrated [0-9a-f]{12} \(round 1 of 3\)$/);
  const msg = readInbox(p.root, '3').at(-1);
  assert.deepEqual([msg.kind, msg.base, msg.round, msg.of], ['reintegrate', moved, 1, 3]);
  assert.equal((await mergeReady(m.ctx, laneOf(p))).outcome, 'wait');
  assert.equal(readInbox(p.root, '3').length, 1, 'no second message for the same ready record');
  reportReady(p);
  assert.equal((await mergeReady(m.ctx, laneOf(p))).outcome, 'merged');
  assert.equal(mergeState(p.root, '3').rounds, 0);
});

test('more than merge_rounds in a row: a card for the owner instead; the owner\'s wait (a hold) gives a fresh budget', async () => {
  const p = laneProject();
  finishPhase(p);
  const m = mergeCtx(p, { merge_rounds: 1, lang: 'ru' });
  const move = (n) => { p.writeMain(`src/m${n}.js`, `export const m = ${n};\n`); p.commitMain(`feat: m${n}`); };
  reportReady(p);
  move(1);
  assert.equal((await mergeReady(m.ctx, laneOf(p))).outcome, 'reintegrate');
  reportReady(p);
  move(2);
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'needs-owner');
  assert.match(r.reason, /^the main branch moved 1 times in a row before phase 3 could be merged; owner question ask-1$/);
  const q = readQuestions(p.root, '3').find((x) => x.id === 'ask-1');
  assert.equal(q.options.length, 2);
  assert.match(q.question, /^Фазу 3 не удаётся влить/);
  assert.equal(readLaneStatus(p.root, '3').status, 'needs-owner');
  assert.equal(m.notes.length, 0, 'the card reaches the owner through the question channel, not a second notification');
  // the owner chose to wait: the lane sets the hold and integrates again; main moves once more
  setMergeHold(p.slot, '3', { now: new Date('2026-10-13T14:00:00.000Z') });
  assert.deepEqual(mergeHolds(p.root), ['3']);
  reportReady(p);
  move(3);
  const after = await mergeReady(m.ctx, laneOf(p));
  assert.equal(after.outcome, 'reintegrate');
  assert.match(after.reason, /\(round 1 of 1\)$/);
});

test('the main checkout dirty or on another branch: wait, the owner told once per reason; nothing merged', async () => {
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  const m = mergeCtx(p);
  p.writeMain('src/app.js', 'export const app = 5;\n');
  let r = await mergeReady(m.ctx, laneOf(p));
  assert.deepEqual([r.outcome, r.reason], ['wait', 'the main checkout has uncommitted changes: src/app.js']);
  await mergeReady(m.ctx, laneOf(p));
  assert.deepEqual(m.notes, [['mergeWaiting', { phase: '3', why: 'the main checkout has uncommitted changes: src/app.js' }]]);
  p.inMain('checkout', '--', 'src/app.js');
  p.inMain('checkout', '-q', '-b', 'side');
  r = await mergeReady(m.ctx, laneOf(p));
  assert.deepEqual([r.outcome, r.reason], ['wait', 'the main checkout is on side, not on main']);
  assert.equal(m.notes.length, 2);
  p.inMain('checkout', '-q', 'main');
  assert.equal(p.inMain('rev-list', '--merges', '--count', 'HEAD'), '0');
  assert.equal((await mergeReady(m.ctx, laneOf(p))).outcome, 'merged');
});

test('an uncommitted owner answer neither blocks the merge nor costs a round; it is committed after the merge (Review Focus 1)', async () => {
  const p = laneProject({ files: { '.planning/turbo/answers/p9.json': '[]\n' } });
  finishPhase(p);
  reportReady(p);
  p.writeMain('.planning/turbo/answers/p9.json', '[{"id":"9-01-t1"}]\n');
  const m = mergeCtx(p);
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  assert.equal(p.inMain('status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(p.inMain('show', 'HEAD:.planning/turbo/answers/p9.json'), '[{"id":"9-01-t1"}]');
  assert.equal(readInbox(p.root, '3').length, 0);
});

test('a lane tip that moved after ready is never merged (Review Focus 4)', async () => {
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  p.writeSlot('src/late.js', 'export const late = 1;\n');
  p.commitSlot('feat: after ready');
  const m = mergeCtx(p);
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'wait');
  assert.match(r.reason, /^the lane's branch turbo\/p3 is at [0-9a-f]{12}, not at the [0-9a-f]{12} it reported ready; waiting for its next ready$/);
  assert.equal(p.inMain('rev-list', '--merges', '--count', 'HEAD'), '0');
});

test('a held merge lock or no ready record: wait, nothing changes', async () => {
  const p = laneProject();
  finishPhase(p);
  const m = mergeCtx(p);
  let r = await mergeReady(m.ctx, laneOf(p));
  assert.deepEqual([r.outcome, r.reason], ['wait', 'phase 3 has no ready record for turbo/p3']);
  reportReady(p);
  fs.mkdirSync(path.dirname(mergeLockFile(p.root)), { recursive: true });
  fs.writeFileSync(mergeLockFile(p.root), 'other-process');
  r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'wait');
  assert.match(r.reason, /^main is busy: another turbo-run holds the merge lock/);
  fs.rmSync(mergeLockFile(p.root));
  assert.equal(mergeState(p.root, '3'), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/merge.test.mjs`
Expected: FAIL with `Cannot find module '…/lib/merge.mjs'`.

- [ ] **Step 3: Implement**

Create `lib/merge.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { MergeLocked, withMergeLock } from './merge-lock.mjs';
import { commitPendingAnswers } from './answers.mjs';
import { SlotRefused, mainBranch, readSlotRecord, slotGit } from './slots.mjs';
import { readLaneStatus, writeLaneStatus } from './run-status.mjs';
import { appendInbox } from './inbox.mjs';
import { askOwner } from './questions.mjs';
import { holdFile } from './integrate.mjs';

// Stage 4 §7.2: the supervisor merges a lane's verified phase into the main branch, without an LLM, one writer at a time
// (locks/merge). Its record per phase, written only here: run/p<N>-merge.json in the control root.
export const MERGE_ROUNDS_DEFAULT = 3;
export const mergeFile = (root, phase) => path.join(runDir(root), `p${phase}-merge.json`);
export const mergeState = (root, phase) => readJson(mergeFile(root, phase), null);

const SHA = /^[0-9a-f]{40}$/;
const HOLD_RE = /^p(.+)-merge-hold\.json$/;
const ANSWERS_DIR = '.planning/turbo/answers/';
const short = (s) => String(s ?? '').slice(0, 12);
const firstLine = (e) => String(e?.message ?? e).split(/\r?\n/)[0].slice(0, 300);
// git -z output as names
const zList = (s) => String(s ?? '').split('\0').map((x) => x.replace(/^\n+/, '')).filter(Boolean);
const gitOf = (deps) => deps.gitAt || slotGit(deps.env || process.env);
// 0 yes, 1 no; a missing object (128) reads as no
function isAncestor(git, root, a, b) {
  try {
    return git(root, ['merge-base', '--is-ancestor', a, b], { ok: true }) !== null;
  } catch {
    return false;
  }
}
function tryGit(git, root, args) {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
}

// merge_rounds (spec §10, the key is L1's DEFAULTS): a whole number from 1, else 3.
export function mergeRounds(config) {
  const n = config?.merge_rounds;
  return Number.isInteger(n) && n >= 1 ? n : MERGE_ROUNDS_DEFAULT;
}

// The phases whose owner chose to wait while main moves too fast (decision D16): L1 starts no new phase while any.
export function mergeHolds(root) {
  let names = [];
  try {
    names = fs.readdirSync(runDir(root));
  } catch {
    return [];
  }
  return names.map((n) => HOLD_RE.exec(n)?.[1]).filter(Boolean).sort();
}

// The owner's card when main moves faster than the phase can merge (spec §7.2 p.3): plain words, the recommended first.
const MERGE_CARD = {
  en: (phase, n) => ({
    question: `Phase ${phase} cannot be merged: the main branch keeps changing before the phase catches up with it`,
    context: `Turbo asked the phase to catch up ${n} times in a row, and each time another merge came first.`,
    options: [
      { label: 'Wait', description: 'Turbo starts no new phases until this one is merged, and the phase catches up once more.' },
      { label: 'I will merge it myself', description: 'The phase stops here; you merge it into the main branch yourself and then resume it.' },
    ],
    recommended: 1,
  }),
  ru: (phase, n) => ({
    question: `Фазу ${phase} не удаётся влить: основная ветка меняется быстрее, чем фаза успевает её догнать`,
    context: `Turbo ${n} раз подряд просил фазу догнать основную ветку, и каждый раз раньше вливалось что-то другое.`,
    options: [
      { label: 'Подождать', description: 'Turbo не запускает новые фазы, пока эта не вольётся, а фаза догоняет основную ветку ещё раз.' },
      { label: 'Волью сам', description: 'Фаза останавливается; вы сами вливаете её в основную ветку и затем возобновляете её.' },
    ],
    recommended: 1,
  }),
};

// Why the main checkout cannot take a merge now, or null (decision D7): on the job's main branch, no merge in progress,
// no tracked change except the owner's answers (committed after the merge, decision D6).
export function mainNotReady(git, root, want) {
  let branch;
  try {
    branch = mainBranch(root, { git });
  } catch (e) {
    if (e instanceof SlotRefused) return e.message;
    throw e;
  }
  if (branch !== want) return `the main checkout is on ${branch}, not on ${want}`;
  if (git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { ok: true }) !== null) return 'a merge is in progress in the main checkout';
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']).split(/\r?\n/).filter(Boolean).map((l) => l.slice(3)).filter((p) => !p.startsWith(ANSWERS_DIR));
  if (dirty.length) return `the main checkout has uncommitted changes: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ` and ${dirty.length - 5} more` : ''}`;
  return null;
}

// Inside the merge lock, synchronous (withFileLock releases when fn returns): every git and gsd-tools call is sync, and
// the notifications are returned for mergeReady to send after the lock.
function mergeLocked(ctx, lane, rec) {
  const { root, config, deps } = ctx;
  const git = gitOf(deps);
  const phase = String(lane.phase);
  const nowDate = deps.now ? deps.now() : new Date();
  const now = nowDate.toISOString();
  const notes = [];
  const mr = mergeState(root, phase) || { v: 1, phase, rounds: 0 };
  const save = (fields) => writeJsonAtomic(mergeFile(root, phase), Object.assign(mr, fields, { at: now }));
  const wait = (reason) => ({ result: { outcome: 'wait', reason }, notes });
  const done = (result, fields) => {
    save({ ...fields, readyAt: rec.at, outcome: result.outcome, reason: result.reason ?? null });
    return { result, notes };
  };
  const owner = (reason, fields = {}) => {
    writeLaneStatus(root, phase, 'needs-owner', { reason, at: now });
    notes.push(['laneNeedsOwner', { phase, reason }]);
    return done({ outcome: 'needs-owner', reason }, { state: 'needs-owner', ...fields });
  };
  // decision D5: one decision per ready record; only a merge a crash interrupted is taken up again
  if (mr.readyAt === rec.at && mr.state !== 'merging') return wait(`phase ${phase}'s ready record was handled already (${mr.state})`);
  const want = readSlotRecord(lane.slotPath)?.job?.base?.branch;
  if (!want) return wait(`slot ${lane.slot} holds no job record for phase ${phase}`);
  const why = mainNotReady(git, root, want);
  if (why) {
    if (mr.waitNotified !== why) {
      notes.push(['mergeWaiting', { phase, why }]);
      save({ waitNotified: why });
    }
    return wait(why);
  }
  const head = git(root, ['rev-parse', 'HEAD']);
  // decision D9: the lane's head already in main (a restart after a crash, a repeat after needs-owner): no second merge
  const inMain = isAncestor(git, root, rec.head, 'HEAD');
  let mergeSha = inMain ? (mr.mergeSha ?? null) : null;
  if (!inMain) {
    if (head !== rec.base) {
      // spec §7.2 p.3: main moved since the lane's integrate; up to merge_rounds in a row, then the owner (D16)
      const max = mergeRounds(config);
      const hold = readJson(holdFile(root, phase), null);
      const fresh = typeof hold?.at === 'string' && hold.at !== mr.holdAt;
      const round = (fresh ? 0 : Number(mr.rounds) || 0) + 1;
      const holdFields = fresh ? { holdAt: hold.at } : {};
      if (round > max) {
        const lang = config.lang === 'ru' ? 'ru' : 'en';
        const asked = askOwner(root, phase, MERGE_CARD[lang](phase, max), { lang, now: nowDate });
        return done({ outcome: 'needs-owner', reason: `the main branch moved ${max} times in a row before phase ${phase} could be merged; owner question ${asked.question.id}` }, { state: 'needs-owner', rounds: max, ...holdFields });
      }
      appendInbox(root, phase, { kind: 'reintegrate', base: head, was: rec.base, round, of: max }, { now: nowDate });
      return done({ outcome: 'reintegrate', reason: `main is at ${short(head)}, the lane integrated ${short(rec.base)} (round ${round} of ${max})` }, { state: 'reintegrate', rounds: round, ...holdFields });
    }
    // spec §7.2 p.2 (D8): exactly the tip the lane verified and reported ready
    git(root, ['fetch', '--quiet', '--no-tags', lane.slotPath, `refs/heads/${lane.branch}`]);
    const tip = git(root, ['rev-parse', 'FETCH_HEAD']);
    if (tip !== rec.head) return wait(`the lane's branch ${lane.branch} is at ${short(tip)}, not at the ${short(rec.head)} it reported ready; waiting for its next ready`);
    save({ state: 'merging', readyAt: rec.at, laneHead: rec.head, base: rec.base, slot: lane.slot, branch: lane.branch, mergeSha: null, waitNotified: null });
    try {
      git(root, ['merge', '--no-ff', '--no-edit', '-m', `Merge phase ${phase} (turbo lane ${lane.slot})`, rec.head]);
    } catch (e) {
      tryGit(git, root, ['merge', '--abort']);
      return owner(`merging phase ${phase} into ${want} failed: ${firstLine(e)}; nothing was merged`);
    }
    mergeSha = git(root, ['rev-parse', 'HEAD']);
    save({ mergeSha });
  } else if (mr.state !== 'merging') {
    save({ state: 'merging', readyAt: rec.at, laneHead: rec.head, base: rec.base, slot: lane.slot, branch: lane.branch, waitNotified: null });
  }
  // decision D6: the owner's answers that came in meanwhile go on top of the merge
  try {
    commitPendingAnswers(root);
  } catch (e) {
    deps.log(`merge p${phase}: owner answers not committed: ${firstLine(e)}`);
  }
  // §7.2 p.4–6: Task 5 (re-stamp, phase.complete, the commit, the push request)
  const finalSha = git(root, ['rev-parse', 'HEAD']);
  return done({ outcome: 'merged', sha: finalSha }, { state: 'merged', rounds: 0, mergeSha, finalSha, ciRed: null, ownerNotified: null });
}

// Stage 4 §7.2, called by L1 for a lane whose record says ready. At most one decision per ready record (D5); every
// other call waits. Notifications go out after the lock (D19).
export async function mergeReady(ctx, lane) {
  const { root, deps } = ctx;
  const phase = String(lane?.phase ?? '');
  const rec = readLaneStatus(root, phase);
  if (rec?.status !== 'ready' || !SHA.test(String(rec.base ?? '')) || !SHA.test(String(rec.head ?? '')) || rec.branch !== lane?.branch) {
    return { outcome: 'wait', reason: `phase ${phase} has no ready record for ${lane?.branch}` };
  }
  let r;
  try {
    r = withMergeLock(root, () => mergeLocked(ctx, lane, rec), { waitMs: deps.mergeLockWaitMs ?? 2000 });
  } catch (e) {
    if (e instanceof MergeLocked) return { outcome: 'wait', reason: e.message };
    deps.log(`merge p${phase}: ${firstLine(e)}`);
    return { outcome: 'wait', reason: `the merge stopped: ${firstLine(e)}` };
  }
  for (const [key, vars] of r.notes) {
    try {
      await deps.notify(key, vars);
    } catch (e) {
      deps.log(`merge p${phase}: notify ${key}: ${firstLine(e)}`);
    }
  }
  const { outcome, reason, sha } = r.result;
  if (outcome !== 'wait') deps.log(`merge p${phase}: ${outcome}${sha ? ` ${short(sha)}` : ''}${reason ? `: ${reason}` : ''}`);
  return r.result;
}
```

`lib/messages.mjs`: in `M.en`, after the `ciUnavailable` entry, add:

```js
    mergeWaiting: ['Phase {phase} waits to be merged', 'The main checkout is not ready: {why}. turbo merges phase {phase} once it is clean and on its branch; the other phases go on.'],
```

and in `M.ru`, after its `ciUnavailable` entry:

```js
    mergeWaiting: ['Фаза {phase} ждёт слияния', 'Основная рабочая копия не готова: {why}. turbo вольёт фазу {phase}, когда копия будет чистой и на своей ветке; остальные фазы идут дальше.'],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/merge.test.mjs test/notify.test.mjs`
Expected: PASS (`notify.test.mjs`'s `every message exists in en and ru with the same placeholders` covers `mergeWaiting`).

- [ ] **Step 5: Commit**

```bash
git add lib/merge.mjs lib/messages.mjs test/helpers/lane-merge.mjs test/merge.test.mjs
git commit -m "feat(l2): mergeReady merges a verified lane under the merge lock, or asks it to reintegrate"
```

---

### Task 5: After the merge — re-stamp, `phase.complete`, state-sync, one commit, the push request

**Files:**
- Modify: `lib/merge.mjs` (imports; helpers before `function mergeLocked`; the `§7.2 p.4–6` anchor)
- Test: `test/merge.test.mjs` (append)

**Interfaces:**
- Consumes: `findPhaseDir`, `phaseArtifacts`; `gsdText`; `gsdCoreDir`; `stateSync`; `requestPush`, `requestFile`; Task 4's `mergeLocked`, `owner`, `save`, `done`.
- Produces (in `lib/merge.mjs`):
  - `verificationFingerprint(text) → { files: string[], digest: string } | null`;
  - `restampDigest(text, digest) → string | null` (exactly one `covered_digest:` line in the frontmatter);
  - `quietCommits(gsd) → (args) => object` (a `commit` answers `{ committed: false, skipped: true, reason: 'the turbo merge commits it' }`);
  - `mergeReady` now completes the phase: the outcome `merged` carries `sha` = the head of `main` after the complete commit. The merge record gains `completed`, `completeSha`, `stampSha`, `pushRequestId`.
- `ctx.deps.gsd(args, { cwd }) → string` (default: `gsdText(gsdCoreDir(root), cwd, args)`); `ctx.deps.stateSync(root, phase)` (default: `stateSync` with `quietCommits`).

- [ ] **Step 1: Write the failing tests**

Append to `test/merge.test.mjs` (add the imports at the top):

```js
import { tmpDir } from './helpers/tmp.mjs';
import { ISOLATED, gitIn } from './helpers/slots.mjs';
import { PHASE_DIR, fakeDigest, fakeGsd } from './helpers/lane-merge.mjs';
import { quietCommits, restampDigest, verificationFingerprint, mergeFile } from '../lib/merge.mjs';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';
import { requestFile } from '../lib/push.mjs';

const VERIFICATION = `${PHASE_DIR}/03-VERIFICATION.md`;
const readMain = (p, rel) => fs.readFileSync(path.join(p.root, ...rel.split('/')), 'utf8');

test('verificationFingerprint reads a block or a flow list, quoted or not, LF or CRLF; restampDigest rewrites exactly one line', () => {
  const block = '---\nstatus: passed\ncovered_files:\n  - src/a.js\n  - ".planning/phases/03-demo/03-01-SUMMARY.md"\ncovered_digest: "v3:sha256:old"\n---\n# body\ncovered_digest: not frontmatter\n';
  assert.deepEqual(verificationFingerprint(block), { files: ['src/a.js', '.planning/phases/03-demo/03-01-SUMMARY.md'], digest: 'v3:sha256:old' });
  assert.deepEqual(verificationFingerprint(block.replace(/\n/g, '\r\n')), { files: ['src/a.js', '.planning/phases/03-demo/03-01-SUMMARY.md'], digest: 'v3:sha256:old' });
  assert.deepEqual(verificationFingerprint("---\ncovered_files: [src/a.js, 'src/b.js']\ncovered_digest: v3:sha256:x\n---\n"), { files: ['src/a.js', 'src/b.js'], digest: 'v3:sha256:x' });
  assert.equal(verificationFingerprint('---\nstatus: passed\n---\n'), null, 'a legacy report without a fingerprint');
  assert.equal(verificationFingerprint('# no frontmatter\n'), null);
  assert.equal(restampDigest(block, 'v3:sha256:new'), block.replace('"v3:sha256:old"', '"v3:sha256:new"'));
  const crlf = block.replace(/\n/g, '\r\n');
  assert.equal(restampDigest(crlf, 'v3:sha256:new'), crlf.replace('"v3:sha256:old"', '"v3:sha256:new"'));
  assert.equal(restampDigest('---\ncovered_digest: a\ncovered_digest: b\n---\n', 'v3:sha256:n'), null);
  assert.equal(restampDigest('---\nstatus: passed\n---\n', 'v3:sha256:n'), null);
});

test('quietCommits answers state-sync\'s commit itself and passes every other call on', () => {
  const seen = [];
  const gsd = quietCommits((args) => { seen.push(args[0]); return { ok: true }; });
  assert.deepEqual(gsd(['commit', 'docs: x', '--files', '.planning/STATE.md']), { committed: false, skipped: true, reason: 'the turbo merge commits it' });
  assert.deepEqual(gsd(['state', 'patch', '{}']), { ok: true });
  assert.deepEqual(seen, ['state']);
});

test('after the merge: phase.complete in main and one commit with ROADMAP and STATE; nothing re-stamped when the bytes agree', async () => {
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  const m = mergeCtx(p);
  const before = fs.readFileSync(path.join(p.slot, ...VERIFICATION.split('/')), 'utf8');
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  assert.equal(p.inMain('log', '-1', '--format=%s'), 'docs(phase-3): complete phase (turbo merge)');
  assert.equal(p.inMain('rev-parse', 'HEAD^'), mergeOf(p), 'one commit after the merge');
  assert.deepEqual(p.inMain('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), ['.planning/ROADMAP.md', '.planning/STATE.md']);
  assert.match(readMain(p, '.planning/ROADMAP.md'), /- \[x\] Phase 3 complete/);
  assert.equal(readMain(p, VERIFICATION), before);
  assert.deepEqual(m.calls.filter((c) => !c.startsWith('query verification.fingerprint')), ['query phase.complete 3']);
  assert.equal(p.inMain('status', '--porcelain', '--untracked-files=no'), '');
  const st = mergeState(p.root, '3');
  assert.deepEqual([st.completed, st.completeSha, st.finalSha, st.pushRequestId], [true, r.sha, r.sha, null]);
});

test('S3: core.autocrlf=true in main, LF in the slot: equal blobs, the digest re-stamped over main\'s bytes, phase.complete passes, one commit (Review Focus 3)', async () => {
  const p = laneProject();
  finishPhase(p);
  p.inMain('config', 'core.autocrlf', 'true');
  reportReady(p);
  const m = mergeCtx(p);
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  assert.match(readMain(p, 'src/feature.js'), /\r\n$/, 'the main checkout wrote CRLF');
  const fp = verificationFingerprint(readMain(p, VERIFICATION));
  assert.equal(fp.digest, fakeDigest(p.root, fp.files, path.join(p.root, ...PHASE_DIR.split('/'))));
  assert.deepEqual(p.inMain('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), ['.planning/ROADMAP.md', '.planning/STATE.md', VERIFICATION]);
  assert.equal(p.inMain('status', '--porcelain', '--untracked-files=no'), '');
});

test('phase.complete fails: the merge stays, a re-stamp is committed alone, the phase waits for the owner with GSD\'s error', async () => {
  const p = laneProject();
  finishPhase(p);
  p.inMain('config', 'core.autocrlf', 'true');
  reportReady(p);
  const calls = [];
  const m = mergeCtx(p, { gsd: fakeGsd({ calls, fail: { 'query phase.complete': 'Error: Phase 3 cannot be completed: 1 plan(s) have no completion record' } }) });
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'needs-owner');
  assert.equal(r.reason, 'phase.complete failed after the merge of phase 3: gsd-tools query phase.complete failed: Error: Phase 3 cannot be completed: 1 plan(s) have no completion record; the merge stays');
  assert.equal(p.inMain('rev-list', '--merges', '--count', 'HEAD'), '1');
  assert.equal(p.inMain('log', '-1', '--format=%s'), 'docs(phase-3): re-stamp verification after the merge (turbo merge)');
  assert.equal(p.inMain('status', '--porcelain', '--untracked-files=no'), '');
  assert.deepEqual([readLaneStatus(p.root, '3').status, m.notes.at(-1)[0]], ['needs-owner', 'laneNeedsOwner']);
  assert.equal(mergeState(p.root, '3').completed, undefined);
});

test('a restart after the merge: no second merge commit; a covered file changed in main meanwhile goes to the owner (Review Focus 2)', async () => {
  const crashAfterMerge = (p) => {
    const rec = readLaneStatus(p.root, '3');
    p.inMain('fetch', '-q', p.slot, 'refs/heads/turbo/p3');
    p.inMain('merge', '--no-ff', '-q', '-m', 'Merge phase 3 (turbo lane 1)', rec.head);
    writeJsonAtomic(mergeFile(p.root, '3'), { v: 1, phase: '3', state: 'merging', readyAt: rec.at, laneHead: rec.head, base: rec.base, slot: 1, branch: 'turbo/p3', mergeSha: p.inMain('rev-parse', 'HEAD'), rounds: 0 });
  };
  const clean = laneProject();
  finishPhase(clean);
  reportReady(clean);
  crashAfterMerge(clean);
  const r = await mergeReady(mergeCtx(clean).ctx, laneOf(clean));
  assert.equal(r.outcome, 'merged', r.reason);
  assert.equal(clean.inMain('rev-list', '--merges', '--count', 'HEAD'), '1');
  assert.equal(clean.inMain('log', '-1', '--format=%s'), 'docs(phase-3): complete phase (turbo merge)');

  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  crashAfterMerge(p);
  p.writeMain('src/feature.js', 'export const feature = 2;\n');
  p.commitMain('fix: by hand in main');
  const m = mergeCtx(p);
  const owner = await mergeReady(m.ctx, laneOf(p));
  assert.equal(owner.outcome, 'needs-owner');
  assert.equal(owner.reason, 'the merged tree differs from what phase 3\'s verification covered: src/feature.js; the merge stays');
  assert.equal(p.inMain('rev-list', '--merges', '--count', 'HEAD'), '1');
  assert.ok(!m.calls.includes('query phase.complete 3'));
});

test('push on: the supervisor files the push request for main at the head after the complete commit', async () => {
  process.env.CLAUDE_CONFIG_DIR = tmpDir('home');
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  const m = mergeCtx(p, { push: { mode: 'after-phase', ci: 'none' } });
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  const req = readJson(requestFile(p.root, '3'), null);
  assert.deepEqual([req.branch, req.head, req.phase], ['main', r.sha, '3']);
  assert.equal(mergeState(p.root, '3').pushRequestId, req.id);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/merge.test.mjs`
Expected: FAIL with `does not provide an export named 'quietCommits'`.

- [ ] **Step 3: Implement**

`lib/merge.mjs`:

1. Replace `import { runDir } from './paths.mjs';` with `import { gsdCoreDir, runDir } from './paths.mjs';` and add:

```js
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { gsdText } from './gates.mjs';
import { stateSync } from './state-sync.mjs';
import { requestPush } from './push.mjs';
```

2. Right before the comment line `// Inside the merge lock, synchronous (withFileLock releases when fn returns): …`, add:

```js
const DIGEST = /^v\d+:sha256:[0-9a-f]{64}$/;
// GSD 1.16 isSharedPlanningDoc: a direct child of .planning/ never enters a phase's digest
const SHARED_DOC = /^\.planning\/[^/]+$/;

// covered_files and covered_digest of a *-VERIFICATION.md frontmatter (GSD 1.16 #4155): a block or a flow list, quoted
// or plain values. null for a report without both (GSD's legacy mtime check).
export function verificationFingerprint(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(text ?? '').replace(/^\uFEFF/, ''));
  if (!fm) return null;
  const lines = fm[1].split(/\r?\n/);
  const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
  let files = null;
  let digest = null;
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    if (kv[1] === 'covered_digest') digest = unquote(kv[2]);
    if (kv[1] !== 'covered_files') continue;
    const flow = /^\[(.*)\]$/.exec(kv[2].trim());
    if (flow) files = flow[1].split(',').map(unquote).filter(Boolean);
    else {
      files = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) files.push(unquote(lines[++i].replace(/^\s*-\s+/, '')));
    }
  }
  return files?.length && digest ? { files, digest } : null;
}

// The report with its one covered_digest line carrying digest, its quotes and line ending kept; null unless the
// frontmatter has exactly one such line (decision D11).
export function restampDigest(text, digest) {
  let n = 0;
  const out = String(text).replace(/^(---\r?\n[\s\S]*?\r?\n---)/, (fm) => fm.replace(/^(covered_digest:[ \t]*)(["']?)[^\r\n"']*\2([ \t]*)$/gm, (_, key, q, tail) => {
    n += 1;
    return `${key}${q}${digest}${q}${tail}`;
  }));
  return n === 1 ? out : null;
}

// decision D13: state-sync's own commit is folded into the merge's one commit
export function quietCommits(gsd) {
  return (args) => (args[0] === 'commit' ? { committed: false, skipped: true, reason: 'the turbo merge commits it' } : gsd(args));
}

function gsdOf(root, deps) {
  if (deps.gsd) return deps.gsd;
  return (args, { cwd }) => {
    const core = gsdCoreDir(root);
    if (!core) throw new Error('gsd-core not found (run turbo-run doctor)');
    return gsdText(core, cwd, args);
  };
}
const jsonOf = (text) => {
  const s = String(text ?? '');
  const at = s.indexOf('{');
  try {
    return at < 0 ? null : JSON.parse(s.slice(at));
  } catch {
    return null;
  }
};
function syncState(root, phase, deps) {
  if (deps.stateSync) return deps.stateSync(root, phase);
  const gsd = gsdOf(root, deps);
  return stateSync({ root, phase, gsd: quietCommits((args) => jsonOf(gsd(args, { cwd: root }))) });
}

// Every tracked change under .planning/ in one commit (decision D13); the new head, or null when nothing changed.
function commitPlanning(git, root, message) {
  if (!zList(git(root, ['diff', '--name-only', '-z', 'HEAD', '--', '.planning'])).length) return null;
  git(root, ['add', '-u', '--', '.planning']);
  git(root, ['commit', '-q', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}
```

3. In `function mergeLocked`, replace these three lines:

```js
  // §7.2 p.4–6: Task 5 (re-stamp, phase.complete, the commit, the push request)
  const finalSha = git(root, ['rev-parse', 'HEAD']);
  return done({ outcome: 'merged', sha: finalSha }, { state: 'merged', rounds: 0, mergeSha, finalSha, ciRed: null, ownerNotified: null });
```

with:

```js
  // spec §7.2 p.4 (S3, D10, D11): the covered files are the lane's blobs; this checkout's bytes may differ (core.autocrlf),
  // so the fingerprint is taken again here and written into the report
  const gsd = gsdOf(root, deps);
  let stage = 'the verification fingerprint';
  let stamped = false;
  try {
    const dir = findPhaseDir(root, phase);
    const name = dir ? phaseArtifacts(dir).verification : null;
    const file = name ? path.join(dir, name) : null;
    const fp = file ? verificationFingerprint(fs.readFileSync(file, 'utf8')) : null;
    if (fp) {
      const relDir = path.relative(root, dir).split(path.sep).join('/');
      const differ = zList(git(root, ['diff', '--name-only', '-z', '--no-renames', rec.head, 'HEAD', '--', ...fp.files, relDir])).filter((f) => !SHARED_DOC.test(f));
      if (differ.length) return owner(`the merged tree differs from what phase ${phase}'s verification covered: ${differ.slice(0, 10).join(', ')}${differ.length > 10 ? ` and ${differ.length - 10} more` : ''}; the merge stays`, { mergeSha });
      const digest = String(gsd(['query', 'verification.fingerprint', dir, ...fp.files, '--raw'], { cwd: root })).trim();
      if (!DIGEST.test(digest)) return owner(`gsd-tools verification.fingerprint gave no digest for phase ${phase} (${digest.slice(0, 80)}); the merge stays`, { mergeSha });
      if (digest !== fp.digest) {
        const text = restampDigest(fs.readFileSync(file, 'utf8'), digest);
        if (text === null) return owner(`phase ${phase}'s verification report has no single covered_digest line to re-stamp; the merge stays`, { mergeSha });
        fs.writeFileSync(file, text);
        stamped = true;
      }
    }
    if (!mr.completed) {
      // spec §7.2 p.5 (G6, D12, D13): GSD marks the phase in ROADMAP, REQUIREMENTS and STATE; turbo commits once
      stage = 'gsd-tools query phase.complete';
      try {
        gsd(['query', 'phase.complete', phase], { cwd: root });
      } catch (e) {
        const stampSha = stamped ? commitPlanning(git, root, `docs(phase-${phase}): re-stamp verification after the merge (turbo merge)`) : null;
        return owner(`phase.complete failed after the merge of phase ${phase}: ${firstLine(e)}; the merge stays`, { mergeSha, stampSha });
      }
      stage = 'state-sync';
      try {
        syncState(root, phase, deps);
      } catch (e) {
        deps.log(`merge p${phase}: state-sync: ${firstLine(e)}`);
      }
      stage = 'the commit';
      save({ completed: true, completeSha: commitPlanning(git, root, `docs(phase-${phase}): complete phase (turbo merge)`) });
    } else if (stamped) {
      // a fix merged after the phase was completed (red CI): only the fingerprint
      stage = 'the commit';
      commitPlanning(git, root, `docs(phase-${phase}): re-stamp verification (turbo merge)`);
    }
  } catch (e) {
    return owner(`${stage} failed after the merge of phase ${phase}: ${firstLine(e)}; the merge stays`, { mergeSha });
  }
  // spec §7.2 p.6 (D14): main goes to the remote through the supervisor's push work; red CI reaches this phase's inbox
  const finalSha = git(root, ['rev-parse', 'HEAD']);
  let pushRequestId = null;
  if (config.push?.mode && config.push.mode !== 'off') {
    try {
      pushRequestId = requestPush({ root, phase, point: 'phase', settings: config.push, git: deps.git, now: nowDate }).request?.id ?? null;
    } catch (e) {
      return owner(`the push request for main after phase ${phase} failed: ${firstLine(e)}; the merge stays`, { mergeSha });
    }
  }
  return done({ outcome: 'merged', sha: finalSha }, { state: 'merged', rounds: 0, mergeSha, finalSha, pushRequestId, ciRed: null, ownerNotified: null });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/merge.test.mjs`
Expected: PASS (all of Task 4's tests still pass: the fake phase.complete succeeds on a fresh report, and the merge commit is found with `rev-list --merges`).

- [ ] **Step 5: Commit**

```bash
git add lib/merge.mjs test/merge.test.mjs
git commit -m "feat(l2): after the merge re-stamp the fingerprint, complete the phase in one commit, request the push of main"
```

---

### Task 6: `mergeFollowUp` — CI of the merge, `ci-red`, release of the slot

**Files:**
- Modify: `lib/merge.mjs` (imports; append)
- Test: `test/merge-follow.test.mjs` (create)

**Interfaces:**
- Consumes: L0 `releaseSlot`, `readSlotRecord`; `completeStep`, `nextStep`, `readProgress`, `STEPS`; `recordFile`, `describeRecord`, `pushTick`; `writeLaneStatus`; Task 2's `holdFile`, `setMergeHold`; Task 4/5's `mergeReady`, `mergeState`, `mergeFile`.
- Produces: `mergeFollowUp(ctx, lane) → Promise<{ outcome: 'released'|'ci-red'|'needs-owner'|'wait', reason?: string, sha?: string }>` (D15). `released` has already released the slot, marked `integrate` done, written the lane record `done` and removed the hold. `ci-red` comes once per red commit, and S2's `reportRed` has already put the log into the lane's inbox. `needs-owner` comes once per push outcome (S2 already told the owner) and writes the lane record `needs-owner`.

- [ ] **Step 1: Write the failing tests**

Create `test/merge-follow.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { gitIn } from './helpers/slots.mjs';
import { finishPhase, laneOf, laneProject, mergeCtx, reportReady } from './helpers/lane-merge.mjs';
import { mergeFollowUp, mergeHolds, mergeReady, mergeState } from '../lib/merge.mjs';
import { setMergeHold } from '../lib/integrate.mjs';
import { STEPS, completeStep, readProgress } from '../lib/phase-progress.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';
import { readSlotRecord } from '../lib/slots.mjs';
import { pushTick, recordFile } from '../lib/push.mjs';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';

// the push allow file lives in turbo's own directory: a throwaway one for this file
process.env.CLAUDE_CONFIG_DIR = tmpDir('home');

// A lane merged into main, its steps through close done (the supervisor marks integrate).
async function merged({ push = { mode: 'off' }, remote = false } = {}) {
  const p = laneProject();
  let bare = null;
  if (remote) {
    bare = path.join(tmpDir('bare'), 'remote.git');
    gitIn(p.root, 'init', '-q', '--bare', '-b', 'main', bare);
    p.inMain('remote', 'add', 'origin', bare);
    p.inMain('push', '-q', 'origin', 'main');
  }
  for (const s of STEPS.slice(0, STEPS.indexOf('integrate'))) completeStep(p.root, '3', s);
  finishPhase(p);
  reportReady(p);
  const m = mergeCtx(p, { push });
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  return { p, m, sha: r.sha, bare };
}
// What S2's CI watch leaves in the phase's push record, for a push of sha.
function ciRecord(p, sha, state, { phase = '3', requestId = mergeState(p.root, '3').pushRequestId, at = '2026-10-13T13:05:00.000Z' } = {}) {
  writeJsonAtomic(recordFile(p.root, phase), {
    requestId, phase, remote: 'origin', at, outcome: 'pushed', branch: 'main', sha,
    lastPush: { requestId, sha, branch: 'main', remote: 'origin', at, ci: { state, since: at, runs: [] } },
  });
}

test('push off: the slot is released at once; integrate done, the lane done, the hold gone; a second call waits', async () => {
  const { p, m, sha } = await merged();
  setMergeHold(p.slot, '3');
  const r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.deepEqual(r, { outcome: 'released', sha });
  const job = readSlotRecord(p.slot).job;
  assert.deepEqual([job.state, job.outcome], ['done', 'merged']);
  assert.ok(readProgress(p.root, '3').done.includes('integrate'));
  assert.equal(readProgress(p.root, '3').notes.integrate, `merged into main at ${sha.slice(0, 12)}; CI off`);
  const lane = readLaneStatus(p.root, '3');
  assert.deepEqual([lane.status, lane.reason], ['done', `merged into main at ${sha.slice(0, 12)}; CI off`]);
  assert.deepEqual(mergeHolds(p.root), []);
  assert.equal(mergeState(p.root, '3').state, 'released');
  assert.equal((await mergeFollowUp(m.ctx, laneOf(p))).outcome, 'wait');
});

test('push on, through S2\'s pushTick to a local bare remote: wait until pushed, then released with CI none', async () => {
  const { p, m, sha, bare } = await merged({ push: { mode: 'after-phase', ci: 'none' }, remote: true });
  let r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.deepEqual(r, { outcome: 'wait', reason: `the supervisor has not pushed main at ${sha.slice(0, 12)} yet` });
  await pushTick(m.ctx, new Date('2026-10-13T13:01:00.000Z'));
  assert.equal(gitIn(p.root, 'ls-remote', bare, 'refs/heads/main').split(/\s/)[0], sha);
  r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.deepEqual(r, { outcome: 'released', sha });
  assert.equal(readLaneStatus(p.root, '3').reason, `merged into main at ${sha.slice(0, 12)}; CI none`);
});

test('CI pending waits; red is told once per red commit and keeps the slot; green releases', async () => {
  const { p, m, sha } = await merged({ push: { mode: 'after-phase', ci: 'github' } });
  ciRecord(p, sha, 'pending');
  assert.equal((await mergeFollowUp(m.ctx, laneOf(p))).outcome, 'wait');
  ciRecord(p, sha, 'red');
  let r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.deepEqual(r, { outcome: 'ci-red', reason: `CI is red on main at ${sha.slice(0, 12)} after the merge of phase 3`, sha });
  r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.deepEqual(r, { outcome: 'wait', reason: `CI is red on ${sha.slice(0, 12)}; phase 3 fixes it` });
  assert.equal(readSlotRecord(p.slot).job.state, 'active');
  ciRecord(p, sha, 'green');
  assert.equal((await mergeFollowUp(m.ctx, laneOf(p))).outcome, 'released');
});

test('a refused push or a CI timeout goes to the owner once and keeps the slot', async () => {
  const { p, m, sha } = await merged({ push: { mode: 'after-phase', ci: 'github' } });
  const id = mergeState(p.root, '3').pushRequestId;
  writeJsonAtomic(recordFile(p.root, '3'), { requestId: id, phase: '3', remote: 'origin', at: 'x', outcome: 'refused', branch: 'main', sha, findings: [{ file: 'a.log', kind: 'forbidden name *.log' }] });
  let r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.deepEqual(r, { outcome: 'needs-owner', reason: 'refused: a.log (forbidden name *.log); nothing was pushed' });
  assert.equal(readLaneStatus(p.root, '3').status, 'needs-owner');
  assert.equal((await mergeFollowUp(m.ctx, laneOf(p))).outcome, 'wait');
  ciRecord(p, sha, 'timeout', { requestId: id });
  r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'needs-owner');
  assert.match(r.reason, /CI timeout/);
  assert.equal(readSlotRecord(p.slot).job.state, 'active');
});

test('a superseded CI watch follows the later push that holds the merge (Review Focus 5)', async () => {
  const { p, m, sha } = await merged({ push: { mode: 'after-phase', ci: 'github' } });
  ciRecord(p, sha, 'superseded');
  assert.match((await mergeFollowUp(m.ctx, laneOf(p))).reason, /no push that holds it has a result yet$/);
  // another phase merged and pushed after this one: its commit holds this merge
  p.writeMain('src/next.js', 'export const next = 1;\n');
  const later = p.commitMain('Merge phase 4 (turbo lane 2)');
  ciRecord(p, later, 'red', { phase: '4', requestId: 'r4', at: '2026-10-13T13:10:00.000Z' });
  const r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'wait', 'the red belongs to the later push\'s phase');
  assert.match(r.reason, /the CI of the later push [0-9a-f]{12} that holds this merge is red$/);
  ciRecord(p, later, 'green', { phase: '4', requestId: 'r4', at: '2026-10-13T13:10:00.000Z' });
  assert.equal((await mergeFollowUp(m.ctx, laneOf(p))).outcome, 'released');
  assert.equal(readLaneStatus(p.root, '3').reason, `merged into main at ${sha.slice(0, 12)}; CI green`);
});

test('a CI fix after red: the lane integrates again, the fix merges without a second phase.complete, the new push is watched', async () => {
  const { p, m, sha } = await merged({ push: { mode: 'after-phase', ci: 'github' } });
  ciRecord(p, sha, 'red');
  assert.equal((await mergeFollowUp(m.ctx, laneOf(p))).outcome, 'ci-red');
  p.writeSlot('src/feature.js', 'export const feature = 1; // fixed\n');
  p.commitSlot('fix(03): CI red');
  // the lane's step integrate again: its re-verify refreshes the report (here: the fake verifier's fingerprint)
  const fix = reportReadyAfterFix(p);
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  assert.equal(m.calls.filter((c) => c === 'query phase.complete 3').length, 1);
  // the slot's own "Merge main into turbo/p3" is in main's history too: count the supervisor's merges by their message
  assert.equal(p.inMain('log', '--merges', '--format=%s', 'HEAD').split('\n').filter((s) => s === 'Merge phase 3 (turbo lane 1)').length, 2);
  const st = mergeState(p.root, '3');
  assert.deepEqual([st.state, st.ciRed, st.finalSha === r.sha], ['merged', null, true]);
  assert.notEqual(st.pushRequestId, null);
  assert.ok(fix);
});
```

Add this helper to the same file, below `ciRecord`:

```js
import { PHASE_DIR, fakeDigest } from './helpers/lane-merge.mjs';
// The lane's re-verify after its fix (§7.1 p.3a), as the fake verifier does it: a fresh fingerprint over the slot's
// bytes, committed; then integrate and ready.
function reportReadyAfterFix(p) {
  const file = path.join(p.slot, ...PHASE_DIR.split('/'), '03-VERIFICATION.md');
  const text = fs.readFileSync(file, 'utf8');
  const digest = fakeDigest(p.slot, ['src/feature.js'], path.join(p.slot, ...PHASE_DIR.split('/')));
  fs.writeFileSync(file, text.replace(/^covered_digest: .*$/m, `covered_digest: "${digest}"`));
  p.commitSlot('docs(phase-3): re-verify after the CI fix');
  return reportReady(p);
}
```

(Move the added `import` line to the top of the file with the others.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/merge-follow.test.mjs`
Expected: FAIL with `does not provide an export named 'mergeFollowUp'`.

- [ ] **Step 3: Implement**

`lib/merge.mjs`:

1. Replace `import { SlotRefused, mainBranch, readSlotRecord, slotGit } from './slots.mjs';` with `import { SlotRefused, mainBranch, readSlotRecord, releaseSlot, slotGit } from './slots.mjs';`. Replace `import { requestPush } from './push.mjs';` with `import { describeRecord, recordFile, requestPush } from './push.mjs';`. Add `import { completeStep, nextStep, readProgress } from './phase-progress.mjs';`.
2. Append:

```js
const RECORD_RE = /^p(.+)-push\.json$/;
// CI verdicts that free the slot (decision D15): cancelled ran nothing, as S2's lanes treat it
const RELEASE_CI = new Set(['green', 'none', 'cancelled']);

// A later push of main superseded this merge's CI watch: the newest push whose commit holds the merge decides.
function coveringPush(root, git, mr) {
  let names = [];
  try {
    names = fs.readdirSync(runDir(root));
  } catch {
    // no run directory: nothing pushed
  }
  const later = names.map((n) => RECORD_RE.exec(n)?.[1]).filter(Boolean)
    .map((p) => readJson(recordFile(root, p), null)?.lastPush)
    .filter((lp) => lp && SHA.test(String(lp.sha)) && lp.ci?.state !== 'superseded' && isAncestor(git, root, mr.finalSha, lp.sha))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const lp = later[0];
  if (!lp) return { state: 'wait', reason: `a later push superseded the CI of ${short(mr.finalSha)}, and no push that holds it has a result yet` };
  if (RELEASE_CI.has(lp.ci?.state)) return { state: lp.ci.state };
  return { state: 'wait', reason: `the CI of the later push ${short(lp.sha)} that holds this merge is ${lp.ci?.state ?? 'unknown'}` };
}

// What S2's push work made of this merge's push request.
function pushVerdict(root, git, mr) {
  const rec = readJson(recordFile(root, mr.phase), null);
  if (rec?.requestId !== mr.pushRequestId) return { state: 'wait', reason: `the supervisor has not pushed main at ${short(mr.finalSha)} yet` };
  if (rec.outcome !== 'pushed') return { state: 'owner', reason: describeRecord(rec).line, key: `${rec.requestId}:${rec.outcome}` };
  const lp = rec.lastPush?.requestId === rec.requestId ? rec.lastPush : null;
  if (rec.already || !lp) return { state: 'none' };
  const s = lp.ci?.state;
  if (s === 'pending') return { state: 'wait', reason: `CI on ${short(lp.sha)} is still running` };
  if (s === 'red') return { state: 'red', sha: lp.sha };
  if (s === 'timeout') return { state: 'owner', reason: describeRecord(rec).line, key: `${rec.requestId}:timeout` };
  if (s === 'superseded') return coveringPush(root, git, mr);
  return { state: RELEASE_CI.has(s) ? s : 'none' };
}

// Stage 4 §7.2 p.6–7, called by L1 every tick while mergeState(root, N).state is 'merged': the slot stays held until
// main's CI is green (or at once with push.mode off); red CI goes back to the lane, once per red commit.
export async function mergeFollowUp(ctx, lane) {
  const { root, config, deps } = ctx;
  const phase = String(lane?.phase ?? '');
  const mr = mergeState(root, phase);
  if (mr?.state !== 'merged') return { outcome: 'wait', reason: `phase ${phase} has nothing merged to follow (${mr?.state ?? 'no merge record'})` };
  const git = gitOf(deps);
  const nowDate = deps.now ? deps.now() : new Date();
  const now = nowDate.toISOString();
  const save = (fields) => writeJsonAtomic(mergeFile(root, phase), { ...mr, ...fields, at: now });
  let ci = 'off';
  if (config.push?.mode && config.push.mode !== 'off' && mr.pushRequestId) {
    const v = pushVerdict(root, git, mr);
    if (v.state === 'wait') return { outcome: 'wait', reason: v.reason };
    if (v.state === 'red') {
      if (mr.ciRed === v.sha) return { outcome: 'wait', reason: `CI is red on ${short(v.sha)}; phase ${phase} fixes it` };
      save({ ciRed: v.sha });
      deps.log(`merge p${phase}: CI red on ${short(v.sha)}; the lane fixes it`);
      return { outcome: 'ci-red', reason: `CI is red on main at ${short(v.sha)} after the merge of phase ${phase}`, sha: v.sha };
    }
    if (v.state === 'owner') {
      if (mr.ownerNotified === v.key) return { outcome: 'wait', reason: v.reason };
      save({ ownerNotified: v.key });
      writeLaneStatus(root, phase, 'needs-owner', { reason: v.reason, at: now });
      return { outcome: 'needs-owner', reason: v.reason };
    }
    ci = v.state;
  }
  const note = `merged into main at ${short(mr.finalSha)}; CI ${ci}`;
  releaseSlot(root, lane.slot, { outcome: 'merged', now: () => nowDate, config });
  if (nextStep(readProgress(root, phase)) === 'integrate') completeStep(root, phase, 'integrate', { note, now: nowDate });
  writeLaneStatus(root, phase, 'done', { reason: note, at: now });
  fs.rmSync(holdFile(root, phase), { force: true });
  save({ state: 'released', released: { ci, at: now } });
  deps.log(`merge p${phase}: released slot ${lane.slot} (CI ${ci})`);
  return { outcome: 'released', sha: mr.finalSha };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/merge-follow.test.mjs test/merge.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/merge.mjs test/merge-follow.test.mjs
git commit -m "feat(l2): mergeFollowUp frees the slot after green CI and sends red CI back to the lane"
```

---

### Task 7: `mergePlanningOnly` for prep and annotate (L3)

**Files:**
- Modify: `lib/merge.mjs` (append)
- Test: `test/merge-follow.test.mjs` (append)

**Interfaces:**
- Consumes: Task 4's `mainNotReady`, `gitOf`, `isAncestor`, `tryGit`, `zList`; `withMergeLock`, `MergeLocked`; `readSlotRecord`.
- Produces: `mergePlanningOnly(ctx, lane, { allowed }) → Promise<{ outcome: 'merged'|'refused'|'needs-owner'|'wait', reason?: string, sha?: string }>` (D17). The `lane` fields it uses: `job`, `phase`, `slot`, `slotPath`, `branch`. Merge message: `Merge <job>[ <phase>] (turbo lane <k>)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/merge-follow.test.mjs` (add `mergePlanningOnly` to the `../lib/merge.mjs` import):

```js
const prepLane = (p) => ({ key: 'prep-4', job: 'prep', phase: '4', slot: 1, slotPath: p.slot, branch: 'turbo/prep-4' });
const onlyPhase4 = { allowed: (f) => f.startsWith('.planning/phases/04-') };

test('mergePlanningOnly: a prep branch that touches only its phase directory merges even after main moved; a repeat is a no-op', async () => {
  const p = laneProject({ job: { kind: 'prep', phase: '4' } });
  p.writeSlot('.planning/phases/04-next/04-CONTEXT.md', '# Context\n');
  const tip = p.commitSlot('docs(04): context');
  p.writeMain('src/other.js', 'export const other = 1;\n');
  p.commitMain('feat: elsewhere');
  const m = mergeCtx(p);
  const r = await mergePlanningOnly(m.ctx, prepLane(p), onlyPhase4);
  assert.deepEqual([r.outcome, r.sha], ['merged', p.inMain('rev-parse', 'HEAD')]);
  assert.equal(p.inMain('log', '-1', '--format=%s'), 'Merge prep 4 (turbo lane 1)');
  assert.equal(p.inMain('rev-parse', 'HEAD^2'), tip);
  assert.deepEqual(await mergePlanningOnly(m.ctx, prepLane(p), onlyPhase4), { outcome: 'merged', reason: 'already in main', sha: r.sha });
  assert.equal(p.inMain('rev-list', '--merges', '--count', 'HEAD'), '1');
  assert.equal(readSlotRecord(p.slot).job.state, 'active', 'L3 releases the slot itself');
});

test('mergePlanningOnly refuses a branch that touched anything else, needs the owner on a conflict, waits for a dirty main; main stays as it was', async () => {
  const p = laneProject({ job: { kind: 'prep', phase: '4' } });
  p.writeSlot('.planning/phases/04-next/04-CONTEXT.md', '# Context\n');
  p.writeSlot('src/app.js', 'export const app = 9;\n');
  p.commitSlot('docs(04): context and a code edit');
  const m = mergeCtx(p);
  const head = p.inMain('rev-parse', 'HEAD');
  let r = await mergePlanningOnly(m.ctx, prepLane(p), onlyPhase4);
  assert.deepEqual(r, { outcome: 'refused', reason: 'the branch turbo/prep-4 changes files it may not: src/app.js; nothing was merged' });
  assert.equal(p.inMain('rev-parse', 'HEAD'), head);

  const q = laneProject({ job: { kind: 'prep', phase: '4' } });
  q.writeSlot('.planning/phases/04-next/04-CONTEXT.md', '# Context: lane\n');
  q.commitSlot('docs(04): context');
  q.writeMain('.planning/phases/04-next/04-CONTEXT.md', '# Context: by hand\n');
  q.commitMain('docs(04): by hand');
  const mq = mergeCtx(q);
  r = await mergePlanningOnly(mq.ctx, prepLane(q), onlyPhase4);
  assert.equal(r.outcome, 'needs-owner');
  assert.match(r.reason, /^merging turbo\/prep-4 into main failed: .+; nothing was merged$/);
  assert.equal(fs.existsSync(path.join(q.root, '.git', 'MERGE_HEAD')), false);
  assert.equal(q.inMain('status', '--porcelain', '--untracked-files=no'), '');
  q.writeMain('src/app.js', 'dirty\n');
  r = await mergePlanningOnly(mq.ctx, prepLane(q), onlyPhase4);
  assert.deepEqual(r, { outcome: 'wait', reason: 'the main checkout has uncommitted changes: src/app.js' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/merge-follow.test.mjs`
Expected: FAIL with `does not provide an export named 'mergePlanningOnly'`.

- [ ] **Step 3: Implement**

Append to `lib/merge.mjs`:

```js
// Stage 4 §6.1, §6.2, §7.2 p.1–2 for L3 (decision D17): a prep or annotate branch that may change only planning files
// (allowed(path) for every path it changed since its merge base) merges under the same lock and main checks. No base
// equality (it merges three-way; a conflict goes to the owner), no lane or merge record, no push, no release.
export async function mergePlanningOnly(ctx, lane, { allowed }) {
  const { root, deps } = ctx;
  const git = gitOf(deps);
  const label = `${lane.job}${lane.phase ? ` ${lane.phase}` : ''}`;
  let r;
  try {
    r = withMergeLock(root, () => {
      const want = readSlotRecord(lane.slotPath)?.job?.base?.branch;
      if (!want) return { outcome: 'wait', reason: `slot ${lane.slot} holds no job record for ${label}` };
      const why = mainNotReady(git, root, want);
      if (why) return { outcome: 'wait', reason: why };
      git(root, ['fetch', '--quiet', '--no-tags', lane.slotPath, `refs/heads/${lane.branch}`]);
      const tip = git(root, ['rev-parse', 'FETCH_HEAD']);
      if (isAncestor(git, root, tip, 'HEAD')) return { outcome: 'merged', reason: 'already in main', sha: git(root, ['rev-parse', 'HEAD']) };
      const fork = git(root, ['merge-base', 'HEAD', tip]);
      const bad = zList(git(root, ['diff', '--name-only', '-z', '--no-renames', fork, tip])).filter((f) => !allowed(f));
      if (bad.length) return { outcome: 'refused', reason: `the branch ${lane.branch} changes files it may not: ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? ` and ${bad.length - 10} more` : ''}; nothing was merged` };
      try {
        git(root, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${label} (turbo lane ${lane.slot})`, tip]);
      } catch (e) {
        tryGit(git, root, ['merge', '--abort']);
        return { outcome: 'needs-owner', reason: `merging ${lane.branch} into ${want} failed: ${firstLine(e)}; nothing was merged` };
      }
      return { outcome: 'merged', sha: git(root, ['rev-parse', 'HEAD']) };
    }, { waitMs: deps.mergeLockWaitMs ?? 2000 });
  } catch (e) {
    if (e instanceof MergeLocked) return { outcome: 'wait', reason: e.message };
    deps.log(`merge ${label}: ${firstLine(e)}`);
    return { outcome: 'wait', reason: `the merge stopped: ${firstLine(e)}` };
  }
  if (r.outcome !== 'wait') deps.log(`merge ${label}: ${r.outcome}${r.sha ? ` ${short(r.sha)}` : ''}${r.reason ? `: ${r.reason}` : ''}`);
  return r;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/merge-follow.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/merge.mjs test/merge-follow.test.mjs
git commit -m "feat(l2): mergePlanningOnly merges prep and annotate branches that touch only allowed paths"
```

---

### Task 8: The skill and the reference

**Files:**
- Modify: `skills/turbo-phase/SKILL.md`
- Modify: `docs/reference.md`
- Test: `test/skill-turbo-phase.test.mjs` (append one test)

**Interfaces:**
- Consumes: the CLI lines of Tasks 1–3 (Contracts): `turbo-run integrate N`, `--hold`, `lane-status N ready --base`, `phase-step N --attempt integrate`, `push in slots: …`, the `reintegrate` inbox kind.
- Produces: `### integrate` in the skill, after `### close` (the first skill test checks that every `STEPS` element has a section, in order).

- [ ] **Step 1: Write the failing test**

Append to `test/skill-turbo-phase.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/skill-turbo-phase.test.mjs`
Expected: FAIL. The first test fails with `step integrate in order`, and the new one fails on `turbo-run integrate N`.

- [ ] **Step 3: Edit the skill and the reference**

`skills/turbo-phase/SKILL.md`:

1. Conventions: replace `- Never \`git push\`, never force, never \`--no-verify\`. With \`push.mode\` set, you ask and the supervisor pushes (section **Push and CI**).` with:

```markdown
- Never `git push`, never force, never `--no-verify`. With `push.mode` set, you ask and the supervisor pushes (section **Push and CI**). In a slot (a lane of `lanes.mode` slots), the supervisor also merges the phase into the main branch after step **integrate**, and then pushes the main branch.
```

2. The step loop, point 4: replace `The close section marks itself.` with `The close section marks itself; step **integrate** is marked by the supervisor.`

3. The `Inbox:` paragraph: append the sentence `` `reintegrate` messages → the main branch moved before the supervisor could merge this phase: finish the point you are in, then the step loop runs step **integrate** again. ``

4. **CI red**, point 3: replace `3. \`turbo-run push-request N\`. When a \`--wait\` command sent you here, run that command again.` with:

```markdown
3. `turbo-run push-request N`. When a `--wait` command sent you here, run that command again. When it prints `push in slots: …`, this lane runs in a slot: go to the step loop instead. Step **integrate** merges the fix with the main branch, and the supervisor pushes it.
```

5. `### close`, point 6: append the sentence `In a slot it prints \`push in slots: …\` (exit 0): go on.` Replace point 8 with:

```markdown
8. Point 7's `--done close` printed the next step. `next integrate` (this lane runs in a slot): the step loop. `next none`: `turbo-run lane-status N done --reason "<one line: gates run, fixes, UAT counts, the owner checklist file if any>"`, then end your turn.
```

6. Append at the end of the file:

```markdown
### integrate

Spec §7.1: a lane in a slot takes in the main branch, checks the result again and hands it to the supervisor, which merges it into the main branch (§7.2). `turbo-run phase-step N` shows this step only in a slot; elsewhere it passes by itself.

1. `turbo-run integrate N`. It fetches the main branch, merges it into this phase's branch, and always takes the main branch's `.planning/STATE.md`, `.planning/ROADMAP.md` and `.planning/REQUIREMENTS.md`: the supervisor marks this phase in them after the merge. Its lines:
   - exit 0 with `integrated …`, then `base <sha>` and `full test rounds allowed: <n>`: keep the sha and the number, then point 2.
   - exit 4 with `conflicts: <files>`: resolve each file within this phase's scope. Keep what the main branch changed and redo this phase's change on top of it; never drop the other side's change. `git add` each file, then run `turbo-run integrate N` again (it commits the merge). When a conflict cannot be resolved that way (both sides change the same behaviour in ways that do not fit together), **stop for the owner** with a decision (`turbo-run ask N`): what conflicts, in plain words, and whose change it is. The options: keep the main branch's behaviour and adapt this phase, keep this phase's behaviour, or stop the phase here, each saying what you will do.
   - exit 1 with `refused: …`: do what it names (commit or discard stray changes, finish or abort a merge you started by hand), then run it again once. Refused again → **fail** with its line.
2. `TURBO_FULL=1 turbo-run test-changed`. Red: find the cause with systematic debugging and fix it in one commit; it is this phase's code after the merge. Each fix round starts with `turbo-run phase-step N --attempt integrate`. When `n` is above the `full test rounds allowed` of point 1 → **stop for the owner** ("full test suite red after taking in the main branch"). Then run point 2 again.
3. `gsd-tools verification status <phase dir>`: `passed` → point 4. `stale` (the merge or a fix changed files the report covers) → **Stale report**, then read the status it ends with. Anything but `passed` → **stop for the owner** ("verification <status> after taking in the main branch").
4. `turbo-run lane-status N ready --base <the sha of point 1>`. On `refused: …`, do what it names (commit a stray change; a merge in progress: point 1), then run it again once. Refused again → **fail** with its line.
5. End your turn without marking this step done. The supervisor merges the phase, pushes the main branch, and marks this step done once CI is green. It wakes this session when it needs you:
   - the inbox has `reintegrate` (the main branch moved first): the step loop; this step runs again from point 1;
   - the inbox has `ci-red` (the main branch's CI is red after the merge): **CI red** (section **Push and CI**), then the step loop;
   - the owner answered the card about the main branch moving faster than this phase merges (**Lane questions**). The first option (wait) → `turbo-run integrate N --hold`, then the step loop. The second option (they merge it themselves) → `turbo-run lane-status N needs-owner --reason "the owner merges phase N by hand"`, then end your turn.
```

`docs/reference.md`:

1. In the sentence that starts `Below, \`turbo-run\` stands for this \`node …/turbo-run.mjs\` call;`, replace `\`lane-status\`, \`state-sync\`,` with `\`lane-status\`, \`integrate\`, \`state-sync\`,`.
2. Right before `## Owner questions`, add:

```markdown
## Merging lanes (slots)

With `lanes.mode: "slots"`, a phase ends with the step `integrate`. Its lane, in its slot, runs `turbo-run integrate <N>`: it fetches the main branch, merges it into `turbo/p<N>`, and always takes the main branch's `STATE.md`, `ROADMAP.md` and `REQUIREMENTS.md`. The lane then runs the full test suite, re-verifies when the merge staled the verification, and reports `turbo-run lane-status <N> ready --base <sha>`. The supervisor merges under one lock (`.planning/turbo/locks/merge`), and only when the main checkout is clean, on its branch, and its `HEAD` is still that base: `Merge phase <N> (turbo lane <k>)`, exactly the tree the lane tested. When the main branch moved first, the lane gets a `reintegrate` message and integrates again. After `merge_rounds` (default 3) such rounds in a row, you get a question: wait (turbo starts no new phase meanwhile) or merge it yourself. After the merge, the supervisor re-stamps the verification fingerprint (the main checkout may write other line endings), runs GSD's `phase.complete`, commits `docs(phase-<N>): complete phase (turbo merge)`, and pushes the main branch when `push.mode` is set. Red CI goes to the lane's inbox, and the lane fixes it and integrates again. The slot is freed after green CI, or at once with `push.mode: off`. Lanes in slots never push: `push-request` there prints `push in slots: …`. The supervisor's record per phase is `.planning/turbo/run/p<N>-merge.json`. A main checkout with uncommitted changes, or on another branch, makes merges wait (you are told once); the lanes go on.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/skill-turbo-phase.test.mjs test/skill.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/turbo-phase/SKILL.md docs/reference.md test/skill-turbo-phase.test.mjs
git commit -m "docs(l2): step integrate in /turbo-phase and the merge of lanes in the reference"
```

---

## After the last task

The controller runs the full suite once (`npm test`) before merging into `stage-4`, as the Global Constraints require. Nothing in this plan pushes, merges, tags or installs.

Live check outside CI, on the reference project, by the controller, after L1 lands (L1 calls `mergeReady` and `mergeFollowUp`). Two independent phases run in two slots. The first reports ready and is merged (`Merge phase <N> (turbo lane <k>)` plus `docs(phase-<N>): complete phase (turbo merge)` in `main`, ROADMAP checked off). The second gets `reintegrate`, integrates again, and is merged. With `push.mode` set, each slot is freed only after its push's CI is green. The journal records `p<N>-merge.json` for both phases, and that the main checkout's `git status` is clean after each merge.

## Spec coverage

| Spec | Task |
|---|---|
| §7.1 new step `integrate` after `close` | 1 (`STEPS`), 8 (skill) |
| §7.1 p.1 `git fetch origin && git merge origin/<main_branch>`; STATE/ROADMAP/REQUIREMENTS from `origin` at a conflict and always after | 2 (D2, D3) |
| §7.1 p.2 the lane resolves code conflicts itself, else `turbo-run ask` with options → stop for the owner | 2 (exit 4 and resume), 8 |
| §7.1 p.3 `TURBO_FULL=1 turbo-run test-changed`, fixes up to `ci_fix_rounds`, then stop | 2 (`full test rounds allowed`), 1 (`--attempt integrate`), 8 |
| §7.1 p.3a `gsd-tools verification status` in the slot, `stale` → Stale report, not `passed` → stop | 8 |
| §7.1 p.4 commit, `turbo-run lane-status N ready --base <sha>` | 2 (D2), 3 (D1) |
| §7.2 p.1 under `locks/merge`, main clean and on `<main_branch>`, else wait and notify | 4 (D6, D7, `mergeWaiting`) |
| §7.2 p.2 `HEAD == base` → fetch `turbo/<job>` from the slot, `merge --no-ff -m "Merge phase N (turbo lane k)"`; the tree = the lane's | 4 (D8) |
| §7.2 p.3 `HEAD != base` → inbox `reintegrate` + wake; > `merge_rounds` in a row → the owner's card (wait with launches held / handle it myself) | 4 (D16), 2 (`--hold`), 3 (inbox line), 8; the wake: L1 |
| §7.2 p.4 blob equality of the covered files, re-stamp through `gsd-tools … verification.fingerprint`, committed with p.5; unequal → `needs-owner` with the list, the merge stays | 5 (D10, D11) |
| §7.2 p.5 `phase.complete N`, state-sync, one commit `docs(phase-N): complete phase (turbo merge)`; failure → no reset, `needs-owner` with the error | 5 (D12, D13) |
| §7.2 p.6 push `main`, CI as now, red → the lane's inbox; the lane fixes, 7.1 again, the fix merged; slot freed after green CI or at once with `push.mode: off` | 5 (D14), 6 (D15) |
| §7.2 p.7 slot freed → job `done`; the branch deleted at the next prepare | 6 (`releaseSlot`); the deletion: L0 `prepareSlot` |
| §7.2 prep and annotate by p.1–2 without p.4–6 | 7 (D17) |
| §7.3 `push-request` in slot mode: `--at wave` nothing, `--at phase` replaced | 3 (D20), 8 |
| §9 dirty main checkout → merges wait, lanes go on | 4 |
| §10 `merge_rounds` = 3 | 4 (`mergeRounds`, D21); the `DEFAULTS` key: L1 |
| §13 integration with a conflict and without; merge with `HEAD == base` and `!=` | 2, 4 |
| G6 `phase.complete` writes, does not commit; needs summaries and a passed verification | 5 |
| S3 EOL and the fingerprint | 5 (Review Focus 3) |
| S4 `--no-transition` | unchanged: every `gsd-execute-phase` call of the skill already passes it, the Stale report's full route included |

## Interfaces for L1, L3, L4

Everything below is exported exactly as written. L1, L3 and L4 import these names and never re-implement them. `root` is always the control root; `ctx` is the supervisor's `{ root, config, deps }`; `lane` is a `supervisor.json.lanes` entry (L0's Interfaces: `{ key, job, phase, slot, slotPath, branch, sessionId, launchedAt, restarts, notified, mode }`).

**Run files (in `runDir(root)` of the control root)**
- The ready record is the lane record `run/p<N>.json`, written by `turbo-run lane-status N ready --base <sha>` in the slot: `{ phase: string, status: 'ready', reason: string, sessionId: string, at: string (ISO), base: string (40 hex, the origin/<main> commit the lane integrated), head: string (40 hex, the slot branch's tip when it reported ready), branch: string ('turbo/p<N>'), slot: number (k) }`. Read it with `readLaneStatus(root, N)`. `LANE_STATUSES = ['running', 'paused-context', 'needs-owner', 'done', 'failed', 'ready']` (`lib/run-status.mjs`). `writeLaneStatus(root, phase, status, { reason, sessionId, at, fields })` keeps `fields` besides its own keys.
- Merge record `run/p<N>-merge.json` = `mergeFile(root, N)`, written only by `lib/merge.mjs`. Read it with `mergeState(root, N) → MergeRecord | null`. `MergeRecord = { v: 1, phase, slot, branch, state: 'merging'|'reintegrate'|'needs-owner'|'merged'|'released', readyAt, outcome, reason, laneHead, base, mergeSha, finalSha, completed, completeSha, stampSha, pushRequestId, rounds, holdAt, ciRed, ownerNotified, waitNotified, released: { ci, at }, at }`. Fields appear as they are first set.
- Integrate record `run/p<N>-integrate.json` = `integrateFile(root, N)` (`lib/integrate.mjs`, written by the lane): `{ phase, main, branch, base, state: 'merging'|'conflicts'|'integrated', head?, conflicts?, at }`.
- Hold `run/p<N>-merge-hold.json` = `holdFile(root, N)`: `{ phase, at }`. The lane writes it (`turbo-run integrate N --hold`, `setMergeHold(root, phase, { now })`), and `mergeFollowUp` removes it at the release. `mergeHolds(root) → string[]` lists the phases holding (`lib/merge.mjs`).
- Inbox kinds a lane in a slot gets: `reintegrate` `{ kind: 'reintegrate', base, was, round, of, seq, at }` (L2) and `ci-red` (S2's `reportRed`, now for the push of `main` that L2 requested under the phase's id).

**lib/merge.mjs**
- `mergeReady(ctx, lane) → Promise<{ outcome: 'merged'|'reintegrate'|'needs-owner'|'wait', reason?: string, sha?: string }>`: §7.2 p.1–6 for a lane whose record says `ready`. At most one non-`wait` outcome per ready record (`at`); repeated calls for it return `wait`. `merged`: `sha` is the head of `main` after `docs(phase-N): complete phase (turbo merge)`. The slot is still held, and a push request for `main` is filed when `push.mode` is not `off`. `reintegrate`: a `reintegrate` message is already in the lane's inbox. `needs-owner`: the lane record already says `needs-owner`, and the owner was already notified (`laneNeedsOwner`) or asked (the `merge_rounds` card, through `askOwner`). `wait`: main is busy, dirty or on another branch (the owner is told once per reason, `mergeWaiting`), the lane's tip moved after ready, there is no ready record, or this record was already decided.
- `mergeFollowUp(ctx, lane) → Promise<{ outcome: 'released'|'ci-red'|'needs-owner'|'wait', reason?: string, sha?: string }>`: §7.2 p.6–7 while `mergeState(root, N)?.state === 'merged'`. `released`: the slot is already released (`releaseSlot(…, { outcome: 'merged' })`), the step `integrate` is marked done, the lane record says `done` (reason `merged into main at <12 hex>; CI <green|none|cancelled|off>`), and the hold is removed. `ci-red`: once per red commit; the log is in the lane's inbox; the slot stays held. `needs-owner`: once per push outcome (`refused`, `diverged`, `failed`, CI `timeout`), already notified by S2's push work; the lane record says `needs-owner`; the slot stays held. `wait`: anything else.
- `mergePlanningOnly(ctx, lane, { allowed: (path) => boolean }) → Promise<{ outcome: 'merged'|'refused'|'needs-owner'|'wait', reason?: string, sha?: string }>`: §7.2 p.1–2 for prep and annotate branches. It uses `lane.job`, `lane.phase` (null for annotate), `lane.slot`, `lane.slotPath`, `lane.branch`. `allowed` gets each path (repository-relative, `/`) the branch changed since its merge base with `HEAD`; one `false` → `refused` and nothing merged. It does not need `HEAD == base`; a three-way conflict → `git merge --abort`, then `needs-owner`. `merged` also covers a tip already in `main` (`reason: 'already in main'`). It writes no lane record and no merge record, files no push request, and does not release the slot: L3 calls `releaseSlot(root, lane.slot, { outcome: 'merged' | 'failed' })` itself. The merge message is `Merge <job>[ <phase>] (turbo lane <k>)`.
- Also exported: `MERGE_ROUNDS_DEFAULT = 3`; `mergeRounds(config) → number` (`config.merge_rounds`, a whole number ≥ 1, else 3); `mergeFile`; `mergeState`; `mergeHolds`; `mainNotReady(git, root, want) → string | null`; `verificationFingerprint(text) → { files, digest } | null`; `restampDigest(text, digest) → string | null`; `quietCommits(gsd)`.
- `ctx.deps` used: `log(line)`, `notify(key, vars) → Promise`, `now() → Date`, `git` (`createGit(root)`; only for the push request). Optional injections (tests, or L1 when it needs them): `gitAt(dir, args, { ok }) → string` (default `slotGit(process.env)`), `gsd(args, { cwd }) → string` (default `gsdText(gsdCoreDir(root), cwd, args)`), `stateSync(root, phase)` (default `stateSync` with `quietCommits`), and `mergeLockWaitMs` (default 2000).
- `ctx.config` used: `push` (normalized by `pushSettings`, as `runtimeConfig` does), `lang`, `merge_rounds`, and `lanes` / `max_lanes` (for `releaseSlot`). **L1 adds `DEFAULTS.merge_rounds = 3`** next to its other keys; L2 never adds it.

**What L1 does with these**
- Every tick, for each phase lane in a slot: first, if `mergeState(root, N)?.state === 'merged'` → `await mergeFollowUp(ctx, lane)`. Then, if `readLaneStatus(root, N)?.status === 'ready'` → `await mergeReady(ctx, lane)`. Both are idempotent and cheap when nothing changed.
- `mergeReady` outcomes: `merged` → keep the lane entry and its slot; do not wake the lane. `reintegrate` → wake the lane session like an owner answer (its prompt names `turbo-run inbox N`). `needs-owner` → the lane waits for the owner; do not notify again. `wait` → nothing.
- `mergeFollowUp` outcomes: `released` → the phase is finished (`finishLane`): drop `supervisor.json.lanes[N]` and its session; never relaunch it. `ci-red` → wake the lane session (inbox `ci-red`). `needs-owner` → the lane waits for the owner; do not notify again. `wait` → nothing.
- A fresh lane record with status `ready` means the lane's turn ended and it waits for the merge. Never relaunch it for that, never read it as `paused-context`, and do not count it as a restart.
- While `mergeHolds(root)` is not empty, start no new phase job (prep and annotate may go on).
- In `lanes.mode: "checkout"` none of this runs: `phase-step` passes `integrate` by itself, and the lane ends with `lane-status N done` as in v0.3.
- The wake prompts: for `reintegrate` and `ci-red`, the existing "run `turbo-run inbox N`" wording of S2's red-CI wake is enough. The skill's step loop routes both.

**What L3 does with these**
- Merges a finished prep (`lane-status N prepped`, L3's status) or annotate job with `mergePlanningOnly(ctx, lane, { allowed })`. Prep's `allowed`: `(p) => p.startsWith('.planning/phases/<the phase directory name>/')`. Annotate's: ROADMAP, `.planning/turbo/lanes.json` and the decision files. Then `releaseSlot` with `merged`, or `failed` on `refused`.
- `/turbo-prep` reuses `/turbo-phase`'s steps through `phase-step`. `integrate` is the last step, and prep stops before `plan`, so it never reaches it.

**What L4 shows**
- `STEPS` (`lib/phase-progress.mjs`) ends with `integrate`; its words are in `lib/view.mjs` and `mod/hooks/view-model.mjs` (`integrate`: `merge into main` / `слияние с основной веткой`; active `merging the phase into the main branch` / `вливает фазу в основную ветку`).
- Per lane, read-only: `readLaneStatus(root, N).status === 'ready'` (waits for the merge); `mergeState(root, N)` (`state`, `rounds` of `mergeRounds(config)`, `ciRed`, `reason`); `mergeHolds(root)` (new phases held).

**CLI**
- `turbo-run integrate <N> [--hold]` (`lib/cli-phase.mjs` handler `integrate`; `deps.slotGit` injects git): exit 0 `integrated …` + `base <40 hex>` + `full test rounds allowed: <n>`; exit 4 `conflicts: <files>`; exit 1 `refused: …`; exit 0 `integrate <N>: not a slot …` outside a slot. `--hold`: exit 0, or exit 1 outside a slot.
- `turbo-run lane-status <N> ready --base <sha> [--reason <text>]`: exit 0 `lane <N>: ready (base <12 hex>, head <12 hex>); the supervisor merges it into main`; exit 1 `refused: <why>` on stderr.
- `turbo-run phase-step <N> --done integrate` is refused (exit 1) in a slot.
- `turbo-run push-request <N> …` in a slot with `push.mode` not `off`: exit 0, `push in slots: nothing requested at a wave; …` (`--at wave`) or `push in slots: nothing requested; the supervisor merges this phase in step integrate and pushes main`.

**Messages (`lib/messages.mjs`)**: `mergeWaiting` `{ phase, why }` (en, ru). L2's `needs-owner` notifications use `laneNeedsOwner` `{ phase, reason }`.
