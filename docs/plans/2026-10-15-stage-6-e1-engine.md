# gsd-turbo Stage 6 E1 — the exec engine (`turbo-run exec N`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Build only after the go/no-go of the spec §5 says yes (or "weak yes": then `exec.enabled` stays `false`).**

**Goal:** A lane's step `execute` conducts GSD's executors itself: each plan is dispatched as soon as every plan it needs (by the graph of `lib/exec-graph.mjs`) is merged and an executor slot is free; each returned executor's worktree branch is merged by GSD's own `worktree.cleanup-wave` with a one-entry manifest under a per-phase lock, then targeted tests of that merge run, then the lane writes the ROADMAP/STATE tracking. A plan waiting for the owner holds only its dependents. A crash loses nothing. When every plan is merged, GSD's execute-phase runs only its tail. This plan builds the deterministic part: the record, the queue, the merge path, the CLI and the measurement line. The skill text and the view are plan E3; `test-changed --merge`, `questions --keep-running` and the inbox answer are plan E2 (this plan calls them as subprocesses and fakes them in tests).

**Architecture:** `lib/exec-state.mjs` holds the record `<localRunDir>/exec-p<N>.json` (spec §6.8), its state machine and the pure queue (`nextBatch`). `lib/exec-merge.mjs` wraps the git and `gsd-tools` calls of a merge (artifact check on the agent branch, one-entry manifest, `worktree.record-agent`, `worktree.cleanup-wave` with lock retries, tracking, salvage), every side effect injected. `lib/cli-exec.mjs` routes `turbo-run exec` (a lane command) and owns eligibility (`exec off: <why>`), the crash reconcile on `--plan`, `--release`, `--done` and the clock. `lib/config.mjs` gets `exec.*` and the new `max_executors` default. `bin/turbo-run.mjs`'s `attend` calls `--release` in the slot first.

**Tech Stack:** Node ≥ 20 (ESM `.mjs`, `node:test`, zero npm dependencies), git (`worktree add/remove`, `merge-base`, `rev-parse`, `log`, `branch -m`), GSD 1.16 `gsd-tools` verbs `query dispatch-isolation`, `query state.begin-phase`, `query worktree.record-agent`, `query worktree.cleanup-wave`, `query roadmap.update-plan-progress`, `commit`.

**Spec:** `docs/specs/2026-10-15-stage-6-design.md` — §1 criteria 1–7, §2 decisions 2–4 and D3–D10, §3 (G1, G7–G18, T1, T3, T4, T6, T7), §6 entirely, §7, §8 (`exec` rows), §11, §12 (E1 rows).

**Base:** branch `web` with the spec and A (`web-stage6`) merged. Topic branch `web-stage6-e1-engine`. Existing code is referenced by function name and anchor text, never by line number.

What this plan consumes, by exact name (it re-implements none of it):
- `lib/exec-graph.mjs`: `planInfo`, `planIdOf`, `resolveDeps`, `gsdWaves`, `planEdges`, `planOrder`, `criticalPath`, `canonId`, `pathsMeet`, `EDGE_KINDS`.
- `lib/phase-files.mjs`: `findPhaseDir`, `phaseArtifacts`. `lib/cli-phase.mjs`: `planSetCheck`, `PHASE_COMMANDS`, `VALUE_FLAGS`, the handler table and its helpers (`parseArgs`, `phaseArg`, `usage`, `fail`, `coreOrFail`, `relTo`). `lib/phase-progress.mjs`: `countAttempt`.
- `lib/gsd.mjs`: `runGsdJson`. `lib/paths.mjs`: `localRunDir`, `locksDir`, `logsDir`, `isSlot`. `lib/fsx.mjs`: `readJson`, `writeJsonAtomic`. `lib/questions.mjs`: `withFileLock`. `lib/merge-lock.mjs`: `pidAlive` (the lock owner check pattern). `lib/staleness.mjs`: `gitRunner`. `lib/config.mjs`: `loadConfig`, `DEFAULTS`, the `planDraftsSettings` validation pattern.
- Tests: `test/helpers/tmp.mjs` (`tmpGitRepo`), `test/helpers/whatif.mjs` (`planText`, `phaseRepo`), `test/helpers/fake-gsd.mjs` (`fakeGsdCore`; extended here with the worktree verbs), `test/helpers/slots.mjs` (`ISOLATED`, `gitIn`, `controlProject`, `fakeSlot`).

## Decisions this plan makes where the spec is open

- **X1 Record path and lock.** `exec-p<N>.json` in `localRunDir(root)` (the lane's own checkout: slot or main checkout); the lock `exec-p<N>` in `locksDir(root)` (the control root's, like `merge`), `withFileLock` with `waitMs` 60 s, `staleMs` 30 min, owner check by pid.
- **X2 Graph identity.** `graphSha` = sha256 over the sorted `<file>\0<git hash-object>` of the phase's non-gap plan files. A different `graphSha` on `--plan` rebuilds plans and edges; states of plans still in the graph are kept; a plan whose SUMMARY is on HEAD becomes `done-before` unless it is `merged`.
- **X3 Effective `worktree.baseRef`.** Read in this order, first that sets it wins: `<root>/.claude/settings.local.json`, `<root>/.claude/settings.json`, `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json`. Anything but `"head"` → `exec off: worktree.baseRef is not "head" (…)`.
- **X4 Isolation.** `gsd-tools query dispatch-isolation --raw --phase N` must print `harness-worktree`; any plan whose `writes` meet a submodule path (`git config --file .gitmodules --get-regexp '^submodule\..*\.path$'`, matched with `pathsMeet` both ways) or whose frontmatter has `cross_ai: true` → `exec off`.
- **X5 Queue order.** `nextBatch` uses the remaining-path priority of the graph module (minutes unknown at run time: every plan weighs 1, so the priority is the longest remaining chain in plans), then `planOrder`.
- **X6 `dispatched` timeout.** 30 minutes without `--running` → back to `waiting` on the next `--next` (`stale dispatch: <id>`).
- **X7 Merge retries.** `cleanup-wave` output with `config.lock` or `index.lock` in its error (or a git exit with those words): 3 more tries after 2, 4, 8 s; then `blocked` with the last error.
- **X8 Tests after a merge.** `--returned` runs `turbo-run test-changed --merge <sha>` as a child process of the same `node` and `bin/turbo-run.mjs` (`process.execPath`, `SELF`), cwd the lane checkout, timeout 15 min; exit 0 green, else red with its last non-empty output line. Injected in tests.
- **X9 Salvage name.** `turbo-salvage/<plan id>-<UTC yyyymmddThhmmssZ>` (`git branch -m`); the worktree is removed with `git worktree remove --force` only after the rename; never `branch -D` on a branch with commits not on HEAD.
- **X10 Measurement line.** `phase <N> execute: <h>h<mm>m wall clock · exec on: <P> plans (<D> done before), max <k> at once, <M> merges, <R> red, owner waits <W>m` (owner waits = the sum over plans of the time in state `owner`). `phase-step N --done execute` writes `… · exec off: <why>` from the record's `lastPlan` when the record says off, `exec off: not asked` without a record (and, when `exec on` already wrote its line at `--done`, nothing more).

## Global Constraints

- Node ≥ 20, ESM `.mjs` only, **zero runtime npm dependencies**; tests use `node:test` and `node:assert/strict`.
- Windows and Linux: paths with `path.join`; child processes only through `execFileSync`/`spawnSync` with an argument array, `windowsHide: true` and a timeout, never a shell. git paths with `/`.
- Public repository: synthetic names only (`demo-app`, `C:\Users\dev\…`).
- turbo never merges an agent branch by itself: only `gsd-tools … worktree.cleanup-wave`. It never deletes a branch with commits that are not on HEAD (salvage renames). It never writes STATE.md or ROADMAP.md except through `gsd-tools` in the tracking step. With `exec.enabled: false` or any `exec off` reason, nothing is written but the record's `lastPlan`.
- State files with `writeJsonAtomic`. Tests never touch the network, a real `claude` or GSD core, or the developer's Claude home; spawned CLI runs get `ISOLATED`, an empty `CLAUDE_CONFIG_DIR`, no `TURBO_CONTROL_ROOT`.
- TDD; run only the named test files per task; full `npm test` once before hand-back. One commit per task (`feat(exec): …`, `test(exec): …`, `docs: …`). Never push, merge, tag or install.

## Review Focus

1. **No plan runs before its predecessors are merged**, and none while HEAD is red (D7). Pinned in Task 3.
2. **Base safety.** A dependent is dispatched with `base` = HEAD after its predecessors' merges, and the one-entry `cleanup-wave` passes its merge-base check after sibling merges. Pinned in Task 5 (real worktrees).
3. **Nothing is lost or done twice after a crash**: a branch with its SUMMARY is merged, a partial branch is renamed and kept, a merged plan is never re-queued. Pinned in Task 7.
4. **Owner stops hold only dependents**; `stop:` only when nothing else runs or is ready. Pinned in Task 3 and 6.
5. **`exec off` is total**: each reason returns before anything but `lastPlan` is written. Pinned in Task 4.
6. **Tracking only on green**, by `gsd-tools`, once per plan. Pinned in Task 6.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/config.mjs` | modify | `exec: { enabled: false, push_every: 3 }`, `max_executors: 4`, `execSettings(config)` |
| `lib/exec-state.mjs` | create | record read/write, states and transitions, `nextBatch`, `stopReason`, summary for the view and the log |
| `lib/exec-merge.mjs` | create | branch artifact check, manifest, record-agent, cleanup-wave with retries, tracking, salvage, partial merge |
| `lib/cli-exec.mjs` | create | `turbo-run exec` actions, eligibility, crash reconcile, release, done, clock |
| `lib/cli-phase.mjs` | modify | `PHASE_COMMANDS` + `exec`, `VALUE_FLAGS` (`--running`, `--returned`, `--checkpoint`, `--continue`, `--failed`, `--retry`, `--task`, `--worktree`, `--branch`), `--done execute` measurement line |
| `bin/turbo-run.mjs` | modify | `USAGE`; `attend` calls `exec N --release` in the lane checkout before it stops the lane |
| `docs/reference.md` | modify | `## Execution graph` (after `## What-if: plans as a graph`), `exec.*` and `max_executors` in `## Config`, `exec` in the lane command list |
| `test/helpers/fake-gsd.mjs` | modify | the stub answers `query dispatch-isolation`, `query state.begin-phase`, `query worktree.record-agent`, `query worktree.cleanup-wave` (real `git merge --no-ff` + merge-base check + `worktree remove`), `query roadmap.update-plan-progress`, `commit` |
| `test/exec-state.test.mjs`, `test/exec-merge.test.mjs`, `test/cli-exec.test.mjs`, `test/exec-resume.test.mjs` | create | tests |
| `test/config.test.mjs`, `test/phase-progress.test.mjs` | modify | tests |

Overlap with E2: `lib/cli-phase.mjs` (E1: `PHASE_COMMANDS`, `VALUE_FLAGS`, the new `exec` handler, `--done execute`; E2: the `questions` handler only — `--keep-running` takes no value), `bin/turbo-run.mjs` (E1: `USAGE`, `attendLane`; E2: `case 'test-changed'` and bin's `VALUE_FLAGS` `--merge`), `docs/reference.md` (different sections). Resolve by keeping both sides. With E3: none in code; E3 reads the record schema of the spec §6.8 and `execSummary`'s shape from the Contracts.

## Contracts

- **Record** (spec §6.8) plus `lastPlan: { use, why?, at }`, `clock: { started, done }`, per plan `ownerSince`/`ownerMs`.
- **`turbo-run exec <N> --plan [--json]`** — `exec off: <why>` (exit 0) or `exec on: <P> plans (<D> done before), <E> edges (depends_on <a>, files <b>, key_links <c>), critical path <id> → … , max <k> at once` (exit 0); then, after a reconcile, one line per action it took: `merged after a crash: <id>`, `salvaged: <id> → <branch>`, `requeued: <id>`. `--json`: `{ use, why?, plans, edges, critical, actions }`. Refusals (`refused: …`, exit 1): no phase directory, no plans.
- **`--next [--json]`** — zero or more `dispatch <id> · base <sha> · plan <rel> · files <list|none> · deletions <list|none>`, then `owner <id>: <qid>`, `waiting <id> on <ids>`, `red: after <id>: <line>`, and exactly one closing line: `idle: <n> running`, `stop: only the owner can unblock: <qids>`, `stop: nothing can run: <ids> failed or blocked`, or `all merged`. Exit 0.
- **`--running <id> --agent <a>`** — `running <id> · agent <a>`; refused unless the plan is `dispatched` or `owner` (a continuation).
- **`--returned <id> [--worktree <p> --branch <b>]`** — `merged <id> · tests green · ready now: <ids|none>[ · push: batch]` (exit 0); `red <id>: <line>` (exit 0, the record is red); `failed <id>: <why>` (exit 0); `blocked <id>: <reason>` (exit 0); `refused: …` (exit 1: not running, unknown id).
- **`--checkpoint <id> --agent <a> --task <t>`** — runs `turbo-run questions N --stop <id>-t<t> --agent <a> --keep-running` (E2) and prints its line, then `owner <id> · dependents waiting: <ids|none> · still running: <ids|none>`; `answered: …` from questions → plan back to `running` (same agent) and its line passed on.
- **`--continue <id>`** — refused unless `owner`; merges the partial branch (one-entry `cleanup-wave`, no tests, no tracking), prints `base <sha>`; the plan stays `owner` until `--running`.
- **`--failed <id> --reason <text>`**, **`--retry <id>`** (once per plan: `failed` → `waiting`), **`--retest`** (`green: dispatching again` / `red: <line>`), **`--status [--json]`** (`<id> · <state> · <detail>` per plan), **`--release`** (`released: merged <ids>, salvaged <ids>`), **`--done`** (`hand-off: gsd-execute-phase N --no-transition` or `refused: <why>`).

---

### Task 1: config

**Files:** modify `lib/config.mjs`, `test/config.test.mjs`.

- [ ] **Step 1: Tests first.** Defaults present (`exec.enabled` false, `exec.push_every` 3, `max_executors` 4); `execSettings({})` → defaults; `'6'` accepted for `max_executors`; `enabled: 'yes'`, `max_executors: 0`, `21`, `push_every: 0`, `51` → throw naming the key.
- [ ] **Step 2–4:** fail, implement, green (`node --test test/config.test.mjs`). The what-if calculator reads `max_executors` too (`bin/turbo-run.mjs` `case 'exec-whatif'`): its table now stops at 4 unless `--max-executors`; adjust `docs/reference.md`'s what-if paragraph in Task 10.
- [ ] **Step 5:** Commit `feat(exec): exec config keys; max_executors defaults to 4`.

### Task 2: the fake GSD core learns the worktree verbs

**Files:** modify `test/helpers/fake-gsd.mjs`; create `test/exec-merge.test.mjs` (first tests only).

- [ ] **Step 1: Tests first** (temp git repo, `fakeGsdCore`): `query dispatch-isolation --raw --phase 3` prints what the test set (`harness-worktree` by default); `query worktree.record-agent --manifest m.json --agent-id a --path p --branch worktree-agent-a --base <sha> --files "x y" --deletions ""` appends one entry (refuses a missing field, exit 1); `query worktree.cleanup-wave --manifest m.json` for each entry: `merge-base HEAD <branch>` must equal `expected_base` (else JSON `ok: false`, reason `base_mismatch`), `git merge --no-ff -m "chore: merge executor worktree (<branch>)"` (a conflict → `merge --abort`, `merge_failed`), `git worktree remove --force`, `git branch -d`; prints the JSON shape of GSD's `cmdWorktreeCleanupWave` (`{ ok, plan: { entries }, result: { ok, … } }`); `query roadmap.update-plan-progress N <id> complete` ticks `- [ ] <id>` in `.planning/ROADMAP.md`; `commit "<msg>" --files …` commits those files when changed (`nothing_to_commit` otherwise).
- [ ] **Step 2–4:** fail, implement in the stub (plain CommonJS, as the file's rule says), green (`node --test test/exec-merge.test.mjs`, then the existing users of `fakeGsdCore` (`grep -l fake-gsd test/*.mjs`), unchanged and green).
- [ ] **Step 5:** Commit `test(exec): the fake gsd-tools merges executor worktrees like cleanup-wave`.

### Task 3: the record and the queue

**Files:** create `lib/exec-state.mjs`, `test/exec-state.test.mjs`.

**Interfaces:** `execFile(root, phase)`, `readExec(root, phase)`, `writeExec(root, phase, rec)`, `newRecord({ phase, plans, edges, head, maxExecutors, now })`, `transition(rec, id, to, extra, now)` (throws on a move the state machine does not allow: `waiting→dispatched→running→merged`, `running→owner|failed|blocked`, `owner→running`, `failed→waiting` once, `dispatched→waiting` on timeout), `nextBatch(rec, { now }) → { dispatch: [ids], owner, waiting, red, closing }`, `stopReason(rec)`, `execSummary(rec) → { done, total, running, owner, waiting, red }`.

- [ ] **Step 1: Tests first** (pure, no git): a diamond (01 → 02, 01 → 03, 02+03 → 04): only 01 first; 02 and 03 after 01 is `merged`; 04 only after both; `max_executors` 1 gives one at a time in priority order (the longer chain first); `red` → no `dispatch`, closing `idle` while something runs; an `owner` plan holds its dependents only, an independent plan is still dispatched; all others merged and only `owner` left → `stop: only the owner can unblock: <qid>`; `failed`/`blocked` with nothing else → `stop: nothing can run …`; a `dispatched` older than 30 min → back to `waiting` with a line; every disallowed transition throws; `execSummary` counts.
- [ ] **Step 2–4:** fail, implement, green (`node --test test/exec-state.test.mjs`).
- [ ] **Step 5:** Commit `feat(exec): the exec record and its ready queue`.

### Task 4: eligibility and `--plan`

**Files:** create `lib/cli-exec.mjs` (`execPlan`), tests in `test/cli-exec.test.mjs`.

- [ ] **Step 1: Tests first** (temp git project with `phaseRepo`, `fakeGsdCore`, a `.claude/settings.local.json` with `worktree.baseRef: "head"`): each `exec off` reason of spec §6.2 in this order, each writing nothing but `lastPlan` (`exec.enabled` false; `phase-step --check plan` not complete; isolation not `harness-worktree`; baseRef missing or `"origin"` in each of the three layers, X3; a plan touching a submodule path; `cross_ai: true`; a `depends_on` cycle; a dropped `depends_on` token; the phase attended (`run/p<N>-attend.json`); no plan without SUMMARY) ; `exec on` writes the record (edges from `planEdges`, `done-before` for plans with SUMMARY, `graphSha`), runs `state.begin-phase` once (a second `--plan` does not run it again), prints the line of the Contracts; a changed plan file → new `graphSha`, states kept (X2).
- [ ] **Step 2–4:** fail, implement, green (`node --test test/cli-exec.test.mjs`).
- [ ] **Step 5:** Commit `feat(exec): when a phase can run as a graph`.

### Task 5: the merge path (real worktrees)

**Files:** create `lib/exec-merge.mjs`; tests in `test/exec-merge.test.mjs`.

**Interfaces:** `branchArtifacts({ git, branch, base, planId, summaryRel }) → { summary: bool, commits: n, selfCheckFailed: bool }`, `mergeOne({ root, phase, id, entry, gsd, git, sleep }) → { ok, merge?: sha, reason? }` (manifest file under `<localRunDir>/exec-p<N>/<id>.manifest.json`, `record-agent`, `cleanup-wave`, X7 retries), `track({ gsd, phase, id }) → { committed: bool }`, `salvage({ git, root, worktree, branch, id, now }) → name`.

- [ ] **Step 1: Tests first** (a temp repo; worktrees made with real `git worktree add -b worktree-agent-<x> <path> <base>` in place of the harness; commits in them by `gitIn`): (a) two plans dispatched at the same base, both commit and write their SUMMARY; merge the second first, then the first: both pass the merge-base check and land with `--no-ff`; (b) a dependent dispatched after (a) with base = the new HEAD: its worktree forks from it and merges; (c) a branch whose base is not its fork point → `base_mismatch` → `{ ok: false }`, nothing merged; (d) two branches changing the same undeclared line → the second `merge_failed`, the repo clean (no MERGE_HEAD); (e) a `config.lock` error from the stub twice then success → merged after 2 retries (sleep injected); always failing → `blocked` with the error; (f) `branchArtifacts` without SUMMARY or with `## Self-Check: FAILED`; (g) `track` ticks the ROADMAP and commits once, a second call commits nothing; (h) `salvage` renames the branch, removes the worktree, keeps the commits.
- [ ] **Step 2–4:** fail, implement, green (`node --test test/exec-merge.test.mjs`).
- [ ] **Step 5:** Commit `feat(exec): merge one executor branch with GSD's cleanup-wave`.

### Task 6: the CLI actions

**Files:** modify `lib/cli-exec.mjs`, `lib/cli-phase.mjs` (`PHASE_COMMANDS`, `VALUE_FLAGS`, the `exec` handler), `bin/turbo-run.mjs` (`USAGE`); tests in `test/cli-exec.test.mjs`.

- [ ] **Step 1: Tests first** (fake core, real worktrees; the two E2 subprocesses, `test-changed --merge` and `questions … --keep-running`, are injected through `runExecCommand(args, { root, out, err, deps })`, so these tests do not wait for E2; one spawned-CLI test covers only the wiring, with a project whose `test.full` is `node -e ""` so the real `test-changed` runs green without E2's flag being needed for an empty diff): the Contracts' first lines and exit codes for every action; `--next` → `--running` → `--returned` happy path prints `merged … · tests green · ready now: …`; `push: batch` after `exec.push_every` merges with `push.mode: after-wave` only; red tests → `red …`, `--next` dispatches nothing, `--retest` green → dispatching again; `--attempt exec-red` counted (third red → the line says stop for the owner); `--checkpoint` → `owner`, dependents wait, an independent plan still dispatched; `answered:` passed on → `running`; `--continue` merges the partial branch and prints the new base; `--failed`/`--retry` once; `--status` lines; usage errors (exit 2): no action, two actions, unknown id; the record lands in the slot's `run/` in a slot fixture and the lock in the control root.
- [ ] **Step 2–4:** fail, implement, green (`node --test test/cli-exec.test.mjs test/cli-project-arg.test.mjs`).
- [ ] **Step 5:** Commit `feat(exec): turbo-run exec`.

### Task 7: crash, resume and release

**Files:** modify `lib/cli-exec.mjs`; create `test/exec-resume.test.mjs`.

- [ ] **Step 1: Tests first** (record + real worktrees left as a dead session would leave them): `running` + branch with SUMMARY → `--plan` merges it (`merged after a crash`); `running` + branch with commits and no SUMMARY → renamed to `turbo-salvage/<id>-…`, worktree gone, plan `waiting` (`salvaged`); `running` + nothing → `requeued`; `merged` whose merge commit is not on HEAD (a reset) → by disk: SUMMARY on HEAD → `done-before`, else `waiting`; `owner` with the question still open → kept; answered → stays `owner` and `--next` prints it for **Delivery**; `red` → `--next` refuses to dispatch until `--retest`; `--release` merges returned branches, salvages running ones, marks `released`, and a later `--plan` after `attend --done` reads SUMMARYs made in the sitting as `done-before`; no worktree of the record left after `--release`.
- [ ] **Step 2–4:** fail, implement, green (`node --test test/exec-resume.test.mjs`).
- [ ] **Step 5:** Commit `feat(exec): a crashed or released exec loses nothing`.

### Task 8: attend releases first

**Files:** modify `bin/turbo-run.mjs` (`attendLane`: before stopping the lane session, run `exec N --release` in the lane checkout when its record exists and is not `released`; print its line); tests in `test/attend.test.mjs` (or the existing attend CLI test file).

- [ ] **Step 1: Tests first.** An attend on a slot lane with an exec record: the release line printed before `open: cd …`; a merged-returned branch is merged; the record `released`; no record → today's output exactly.
- [ ] **Step 2–4:** fail, implement, green.
- [ ] **Step 5:** Commit `feat(exec): attend releases a running exec first`.

### Task 9: `--done`, the clock and the measurement line

**Files:** modify `lib/cli-exec.mjs`, `lib/cli-phase.mjs` (`--done execute`); tests in `test/cli-exec.test.mjs`, `test/phase-progress.test.mjs`.

- [ ] **Step 1: Tests first.** `--done` refuses while a plan is not `merged`/`done-before`, HEAD is red, or a worktree of the record exists; else writes `handoff`, `clock.done`, appends exactly one X10 line to the control root's `logs/supervisor.log` (slot fixture: not the slot's) and prints `hand-off: gsd-execute-phase N --no-transition`; owner waits summed from `ownerSince`; `phase-step N --done execute` with an `exec off` record writes the `exec off` line, without a record `exec off: not asked`, after an `exec on` `--done` nothing more.
- [ ] **Step 2–4:** fail, implement, green.
- [ ] **Step 5:** Commit `feat(exec): hand the tail to GSD and measure the execute step`.

### Task 10: docs

**Files:** modify `docs/reference.md`.

- [ ] **Step 1:** `## Execution graph`: when it runs (`exec.enabled`, the `exec off` reasons), what the lane does (the loop in one paragraph; the commands table of spec §8), merges and tests, owner questions that hold only dependents, red tests, crash and attend, the hand-off to GSD's tail, the measurement line and how to compare with `turbo-run exec-whatif`; `exec.enabled`, `exec.push_every`, `max_executors` (new default and meaning) in `## Config`; `exec` in the lane command list; the what-if paragraph's `max_executors` note.
- [ ] **Step 2:** Commit `docs: the execution graph`.

## Acceptance (the controller checks before merge)

- `npm test` green on the branch (Linux) and CI green (Ubuntu + Windows).
- Review Focus 1–6 each pinned by a named test.
- Scan of the code range clean (synthetic `C:\Users\dev\…` hits only).
- Live checks of spec §13 items 2–6 and 8–12 written into the journal as `re-check after install`.
