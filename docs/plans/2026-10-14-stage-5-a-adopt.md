# gsd-turbo Stage 5 A — `/turbo-adopt` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A command and a skill that move a GSD milestone already running on plain GSD onto gsd-turbo: an overview of where every phase stands (closed phases with a stale verification named explicitly), every question asked at once, one list of changes, one confirmation, exactly one commit `chore(turbo): adopt`, a report with lanes and critical path before/after, a speed-up forecast, what is left for the owner, and the `/turbo-autonomous` command — never starting the run itself.

**Architecture:** `lib/adopt.mjs` holds the deterministic parts: `scanProject` (the overview and the refusals), `adoptPlan` (questions, changes, owner items, forecast, a plan digest), `reverifyResult` (keep or set aside a re-verification), `applyAdopt` (writes, one commit, `adopt.json`) and `adoptReport`. `lib/adopt-forecast.mjs` simulates the remaining phases with the real scheduler (`pickPhases`). `lib/project-init.mjs` is the body of today's `turbo-run init`, moved out of `bin/turbo-run.mjs` so adopt applies the same setup (and can list it without applying). `lib/annotate.mjs` learns to apply an analysis with the owner's relaxation choice and without its own commit; `lib/lanes-file.mjs` re-marks a low-confidence phase once its CONTEXT.md appears. `bin/turbo-run.mjs` routes `turbo-run adopt …` and prints the closed-phases line in `start` and `status`. The skill `skills/turbo-adopt/SKILL.md` conducts the LLM parts (the lane analyst, the verifier passes, `AskUserQuestion`).

**Tech Stack:** Node ≥ 20 (ESM `.mjs`, `node:test`, zero npm dependencies), git, GSD 1.16 (`gsd-tools init manager`, `verification status`, `config-get/-set`), Claude Code skills.

**Spec:** `docs/specs/2026-10-14-stage-5-design.md` — §1 criteria 1–4, §2 owner decisions 1, 2, 4 and D1, D2, §3 (J1, J4, G11–G15, T1–T5, T7), §4 entirely, §6 (no keys), §7 (`adopt`), §8 (adopt skill, reference, README), §10–§12 (A rows).

**Base:** branch `web` (stage-4 309f464 + hand-off), with the spec merged. Topic branch `web-stage5-a-adopt`. Existing code is referenced by function name and anchor text, never by line number.

What this plan consumes, by exact name (it re-implements none of it):
- `lib/gsd.mjs`: `runGsdJson`, `loadPhases`, `normalizePhases` (`{ number, name, deps, complete, closed, diskStatus, verification, isActive }`), `readVersion`.
- `lib/scheduler.mjs`: `pickPhases`, `criticalPath`, `comparePhase`, `isFinished`, `ANY_AREA`. `lib/lanes-file.mjs`: `readLanesFile`, `readLanesRaw`, `writeLanesFile`, `stalePhases`, `areasOf`, `gatesOf`, `LANES_REL`, `ROADMAP_REL`. `lib/roadmap-lanes.mjs`: `roadmapDigest`.
- `lib/annotate.mjs`: `annotateBrief`, `validateAnalysis`, `applyAnalysis`, `writeDecision`, `analysisFile`, `briefFile`, `AnnotateRefused`. `lib/prep.mjs`: `needsPrep`, `laneMode`.
- `lib/gates.mjs`: `commitPaths`, `createGsdConfig`, `ensureChunkedParallel`, `gatesLeftovers`, `ABSENT`. `lib/worktrees.mjs`: `agentWorktrees`. `lib/slots.mjs`: `listSlots`, `slotsDir`, `maxLanes`.
- `lib/config.mjs`: `loadConfig`, `initConfig`, `lanesSettings`, `laneGates`, `DEFAULTS`. `lib/paths.mjs`: `gsdCoreDir`, `isSlot`, `localRunDir`, `turboDir`. `lib/fsx.mjs`: `readJson`, `writeJsonAtomic`.
- `lib/questions.mjs`: `plainWords` (the owner-text check `turbo-run ask` runs), `jargonIn`. `lib/staleness.mjs`: `verificationRoute` (route only). `lib/phase-files.mjs`: `findPhaseDir`, `phaseArtifacts`, `planOutline`. `lib/cli-phase.mjs`: `planSetCheck`.
- `bin/turbo-run.mjs`: `case 'init'` (moved), `printStatus`, `start`, `refuseInLane`, `USAGE`, `VALUE_FLAGS`, `flag`.
- Tests: `test/helpers/tmp.mjs` (`tmpDir`, `tmpGitRepo`), `test/helpers/fake-gsd.mjs` (`fakeGsdCore`), `test/helpers/slots.mjs` (`ISOLATED`, `gitIn`), `test/helpers/lanes.mjs` (`P`, `A`).

## Decisions this plan makes where the spec is open

- **A1 One module, pure where possible.** `lib/adopt.mjs` takes a `deps` object (`gsd(args) → JSON`, `git(args) → text`, `now`, `exec`) so tests run on fakes; the CLI passes the real ones. Nothing in it spawns `claude`.
- **A2 The overview's phase states** are computed from `init manager`'s raw rows (`disk_status`, `plan_count`, `summary_count`, `verification_status`, `roadmap_complete`, `implementation_complete`, `is_active`, `has_context`) plus `planSetCheck` for a half-written chunked plan set, first match wins in the spec §4.2 order: `done`, `closed-stale`, `verifying`, `executing`, `planned`, `prepped`, `fresh`. `normalizePhases` stays as it is; adopt reads the raw JSON once (`deps.gsd(['init', 'manager'])`) and normalizes it with `normalizePhases` for the scheduler.
- **A3 Question ids and answer syntax.** `stale-closed` (`keep` | `reverify`) and `relax` (`all` | `none` | `r1,r2…`). `--answers stale-closed=keep,relax=r1,r3` — `,` separates pairs, so a relax id list is written with `+` inside the pair (`relax=r1+r3`). Unknown id or value → usage error (exit 2).
- **A4 The plan digest** is sha256 over the canonical JSON of `{ answers, changes: [{ kind, paths, value }] }` (sorted keys, the list in its fixed order). `apply` refuses with `refused: the plan changed since it was shown (plan <new>); show it again` when its own digest differs from `--plan-sha`. A `reverify` change enters the digest by its phase list only (its paths depend on the outcome). `adopt reverify N` also writes its outcome to `<localRunDir>/adopt-reverify.json`; while computing the plan, a phase listed there counts as `closed-stale` (as it was when the owner confirmed), so a re-verification that turned a phase `done` never changes the digest. `apply` deletes that file after its commit.
- **A5 Answers kept.** `adopt.json.answers` with the set they answered: `stale-closed` keeps `staleClosed` (sorted ids); `relax` keeps the ROADMAP digest and the proposal ids. A question is asked again only when its set changed.
- **A6 Re-verification output.** `.planning/turbo/adopt/reverify-p<N>.md` (committed with adopt) for a report that is not `passed`; the phase's working VERIFICATION.md is restored with `git checkout -- <file>` (or deleted when it was never committed). A `passed` report stays in place and is committed by apply. `adopt.json.reverified` records each outcome.
- **A7 Text.** Owner-facing lines (overview, questions, changes, report) come from one table `ADOPT_TEXT = { en: {…}, ru: {…} }` in `lib/adopt.mjs`, phase numbers and counts only (no file names in question texts; the change list and the report may name files in backticks). The Russian question texts pass `plainWords(…, { lang: 'ru' })`.
- **A8 `init` moved, not changed.** `lib/project-init.mjs` exports `initProject(root, { lang, autonomy, core, out, exec })` with exactly today's behaviour and output lines, and `initChanges(root, { core, exec })` → the changes it would make (`turbo-config`, `test-command`, `context-window`), read-only. `bin/turbo-run.mjs` `case 'init'` becomes a call to `initProject`. Every existing `init` test passes unchanged.
- **A9 Forecast hours.** `phaseHours(root, phases, git)`: for each `done` phase of the milestone (newest five by phase order) the span from the first commit touching its directory to the last commit touching it; median in hours, one decimal; none → `null` (the report counts in phases). `IN_PHASE_FACTOR = 0.45` (spec §4.7, main spec §10).
- **A10 Closed-phase line.** `staleClosedLine(root, phases, lang)` in `lib/adopt.mjs`: the line when the `closed-stale` set (normalized, sorted) is not empty and differs from `adopt.json.staleClosed`; else `null`. `start` prints it after its range/plan-only lines; `status` after the supervisor line.
- **A11 Refusals.** `adopt` refuses inside a slot (`refuseInLane`), with a live supervisor (`supAlive`), with a `supervisor.json.lanes` entry whose session is alive or any attended mark, with a merge in progress (`.git/MERGE_HEAD`), with a dirty tree outside `adopt.json.paths` of an `applying` record, without `.planning/ROADMAP.md`, and with doctor `unsupported`. One `refused: <why>` line each, exit 1.

## Global Constraints

- Node ≥ 20, ESM `.mjs` only, **zero runtime npm dependencies**; tests use `node:test` and `node:assert/strict`.
- Windows and Linux: paths with `path.join`; child processes only through `execFileSync`/`spawnSync` with an argument array, `windowsHide: true` and a timeout, never a shell.
- Public repository: synthetic names only (`demo-app`, `Demo`, `C:\Users\dev\…`); no owner names, projects, hosts, user paths or emails.
- adopt never starts the supervisor, a lane, a prep or annotate job, never writes `~/.claude.json`, never creates slots, never removes a worktree, never runs `gates restore`. Its only commit is `chore(turbo): adopt`, with exactly the paths of its change list.
- State files with `writeJsonAtomic`. Tests never touch the network, a real `claude`, a real GSD core or the developer's Claude home; tests that spawn `bin/turbo-run.mjs` delete `TURBO_CONTROL_ROOT`, set `GIT_CONFIG_GLOBAL` to a missing file, `GIT_CONFIG_NOSYSTEM=1`, and point `CLAUDE_CONFIG_DIR` at an empty temp directory.
- TDD: tests first, run only the files the task names (`node --test <files>`); the full `npm test` once before the branch is handed back. One commit per task, conventional style (`feat(adopt): …`, `refactor(init): …`, `test(adopt): …`, `docs: …`). Never push, merge, tag or install.

## Review Focus

1. **One commit, exactly the listed paths.** A project with a dirty unrelated file is refused; a clean one gets one commit whose `git show --name-only` equals the change list's paths; `git revert` of it leaves `git status` clean and the tree as before. Pinned in Task 6.
2. **Idempotence.** A second run with nothing new prints `no changes: already adopted`, asks nothing, commits nothing; a run cut after `state: applying` completes with one commit. Pinned in Task 6.
3. **Closed phases are never touched** except by an owner-chosen re-verification, and a non-`passed` re-verification leaves the committed report byte-identical. Pinned in Task 5.
4. **`init` unchanged.** Every existing `init` test in `test/cli.test.mjs` passes without edits after Task 1.
5. **The annotate session in a slot behaves as in v0.4** (card at `standard`, its own commit); only the new parameters change behaviour. Pinned in Task 4.
6. **Owner texts** (ru) pass the plain-words check; no ids or file names in questions. Pinned in Task 5.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/project-init.mjs` | create | `initProject`, `initChanges` (moved from `bin/turbo-run.mjs`) |
| `lib/adopt.mjs` | create | scan, plan, reverify, apply, report, texts, `staleClosedLine` |
| `lib/adopt-forecast.mjs` | create | `phaseHours`, `forecast`, `IN_PHASE_FACTOR` |
| `lib/annotate.mjs` | modify | `applyAnalysis(…, { relax, commit })` |
| `lib/lanes-file.mjs` | modify | `context` per phase entry; `stalePhases` low-confidence rule |
| `bin/turbo-run.mjs` | modify | `case 'init'` → `initProject`; `case 'adopt'`; closed-phases line in `start` and `printStatus`; `USAGE`; `VALUE_FLAGS` (`--answers`, `--plan-sha`, `--lang`) |
| `skills/turbo-adopt/SKILL.md` | create | `/turbo-adopt` |
| `docs/reference.md` | modify | `## Adopting a running milestone`; `/turbo-adopt` in `## Use` |
| `README.md`, `README.ru.md` | modify | Use list, Roadmap item 5 |
| `test/project-init.test.mjs`, `test/adopt-scan.test.mjs`, `test/adopt-forecast.test.mjs`, `test/adopt-plan.test.mjs`, `test/adopt-apply.test.mjs`, `test/cli-adopt.test.mjs`, `test/skill-turbo-adopt.test.mjs` | create | tests |
| `test/annotate.test.mjs`, `test/lanes-file.test.mjs`, `test/install-stage4-prep.test.mjs` (or a new `test/install-stage5.test.mjs`) | modify/create | tests |

Overlap with plan B (`2026-10-14-stage-5-b-plan-drafts.md`): `bin/turbo-run.mjs` (`USAGE` line only on B's side), `docs/reference.md` (different sections). Nothing else is shared; resolve by keeping both sides.

## Contracts

- **`turbo-run adopt scan [--json] [--lang en|ru]`** — exit 0: the overview (A2 states, one line per state with the phase list; `markup: needed|fresh|off`; `adopted <ISO>` when `adopt.json` is applied); `nothing to adopt: every phase is done` when no phase is unfinished. Exit 1: `refused: …` lines (A11). `--json`: `{ phases: [{ number, name, state, active, verification, plans, summaries }], staleClosed, markup, lanesMode, config: { turbo: bool, testCommand, chunked, contextWindow, branching }, owner: { questions, humanNeeded: [{ phase, items }], worktrees, gates }, adopted: null | { at, state } }`.
- **`turbo-run adopt plan [--answers <pairs>] [--json] [--lang …]`** — `--json`: `{ questions: [{ id, header, question, context, options: [{ label, description, recommended }], allowOther }], analysis: 'none'|'valid'|'refused', problems: [], changes: [{ kind, text, paths, value }], reverify: ['24', …], forecast: { before, after, hours, factor, steps }, owner: [...], plan: '<sha256>' }`. Text: the questions not yet answered (none when `--answers` covers them), then `changes:` (one line each), `reverify: <ids>` when chosen, `forecast:` lines, `plan: <sha256>`. Missing answers for asked questions with `--answers` given → exit 2 `usage: …`.
- **`turbo-run adopt reverify <N>`** — `phase N: re-verified: passed` or `phase N: re-verified: <status> (kept closed; report .planning/turbo/adopt/reverify-pN.md)`; exit 0 both; `refused: phase N is not a closed phase with a stale verification` exit 1.
- **`turbo-run adopt apply --answers <pairs> --plan-sha <sha256> [--lang …]`** — `refused: the plan changed …` exit 1; `no changes: already adopted` exit 0 (no commit); else `committed <short sha> chore(turbo): adopt` and the report, exit 0.
- **`turbo-run adopt report [--json]`** — the report from `adopt.json` plus the current overview; `not adopted yet` exit 0 without a record.
- **`.planning/turbo/adopt.json`** — spec §4.4 shape: `{ v: 1, state: 'applying'|'applied', at, turbo, gsd, answers: { 'stale-closed'?: { value, set: [] }, relax?: { value, roadmap_sha256, ids: [] } }, staleClosed: [], reverified: {}, roadmap_sha256, paths: [], forecast: {}, plan }`.
- **`lanes.json` phase entry** gains `context: true|false` (written by `applyAnalysis` for every target from `needsPrep(root, n) === false`).
- **`applyAnalysis(root, analysis, { phases, config, now, commit, relax })`** — `relax` `undefined` = today's behaviour; `'all' | 'none' | string[]` = the owner's choice: no card, the accepted ids applied (`setDependsOn`) with a decision record (`writeDecision(…, { by: 'the owner (turbo adopt)' })`), `proposal.state` `applied`/`declined`; `commit: null` = no commit, the result's `paths` lists what was written.

---

### Task 1: move `init` into `lib/project-init.mjs`

**Files:** create `lib/project-init.mjs`, `test/project-init.test.mjs`; modify `bin/turbo-run.mjs` (`case 'init'`).

**Interfaces:**
- `initProject(root, { lang = 'en', autonomy = 'standard', core = gsdCoreDir(root), out = (l) => {}, exec = execFileSync }) → 0` — the body of today's `case 'init'`, line for line (the previous `workflow.test_command` kept as `test.full`, `coverNestedPackages`, `context_window`, the `created`/`kept` line). It throws `Error` where `init` used `die` (bin turns it into the same message and exit code).
- `initChanges(root, { core, exec }) → [{ kind: 'turbo-config'|'test-command'|'context-window', text, paths, value }]` — what `initProject` would change now, without writing.

- [ ] **Step 1: Tests first.** `test/project-init.test.mjs`: (a) on a fresh fake project (`fakeGsdCore`, a `package.json` with `"test": "node --test"`), `initChanges` lists all three kinds with paths `.planning/turbo/config.json`, `.planning/turbo/.gitignore`, `.planning/config.json`; (b) after `initProject`, `initChanges` returns `[]`; (c) a project whose `workflow.test_command` already runs turbo and `context_window` is set lists only `turbo-config` when the config file is missing; (d) `initProject` prints the same lines the CLI test `init keeps the previous test command verbatim as test.full and sets the turbo command` expects.
- [ ] **Step 2:** Run `node --test test/project-init.test.mjs` — fails (module missing).
- [ ] **Step 3:** Create the module by moving the code (keep its comments); `case 'init'` parses `--lang`/`--autonomy` as now and calls `initProject`, mapping a thrown error to `die(message)`.
- [ ] **Step 4:** Run `node --test test/project-init.test.mjs test/cli.test.mjs` — green, `cli.test.mjs` unchanged.
- [ ] **Step 5:** Commit `refactor(init): move turbo-run init into lib/project-init.mjs`.

### Task 2: the overview (`scanProject`)

**Files:** create `lib/adopt.mjs` (first part), `test/adopt-scan.test.mjs`.

**Interfaces:**
- `phaseStates(managerJson, { root }) → [{ number, name, state, active, verification, plans, summaries, closed, complete }]` (A2).
- `scanProject(root, { deps }) → { refused: string[], overview }` — `overview` as the `--json` contract; `deps.gsd`, `deps.git`, `deps.supervisor()` (→ `{ alive, lanes, attended }`), `deps.doctorMode()`.
- `formatOverview(overview, lang) → string[]`.

- [ ] **Step 1: Tests first.** Fixtures: an `init manager` JSON with phases 24 (`disk_status: executed`, `phase_complete: false`, `verification_status: stale`, `roadmap_complete: true`, `implementation_complete: true`), 31 (same, `missing`), 32 (`executed`, not checked off, `human_needed`), 33 (`partial`, 9 of 10 summaries, `is_active`), 34 (`planned`), 35 (`discussed`, `has_context`), 36 (`empty`), 37 (`complete`). Assert states `closed-stale, closed-stale, verifying, executing, planned, prepped, fresh, done`; a chunked outline in 34's directory listing a plan not written → `planned` still (the lane resumes it), and the overview notes `plan set incomplete`. Refusals: live supervisor, a lane entry with a live session, an attended mark, `MERGE_HEAD`, a dirty unrelated file, no ROADMAP, doctor `unsupported` — each one line, all listed together; an `applying` `adopt.json` whose `paths` cover the dirty files → no refusal. No unfinished phase → `nothing to adopt`. `formatOverview` ru: one line per state («закрыты, проверка устарела: 24, 31»), no file names.
- [ ] **Step 2:** Run `node --test test/adopt-scan.test.mjs` — fails.
- [ ] **Step 3:** Implement. Owner items: `questions --open` count (read the questions files the way `questions --open` does: reuse its function from `lib/cli-phase.mjs`/`lib/questions.mjs` by name, no re-implementation), `human_needed` phases among the unfinished, `agentWorktrees(root)`, `gatesLeftovers(root)`.
- [ ] **Step 4:** Run the test file — green.
- [ ] **Step 5:** Commit `feat(adopt): the overview of a running milestone`.

### Task 3: the forecast (`lib/adopt-forecast.mjs`)

**Files:** create `lib/adopt-forecast.mjs`, `test/adopt-forecast.test.mjs`.

**Interfaces:**
- `IN_PHASE_FACTOR = 0.45`.
- `phaseHours(phases, { git, phaseDirOf }) → number | null` (A9).
- `forecast({ phases, annotation = (n) => ({ areas: ['**'], gates: [] }), slots = 3, hours = null }) → { before: { phases: n, hours }, after: { steps: [[ids]…], hours }, withPhaseSpeedUp: { hours }, speedUp: { lanes, total } }` — event simulation: repeatedly `pickPhases(phases', { running, annotation, slots })` with every phase lasting one unit (`hours ?? 1`), finished phases marked `complete` in the copy; steps = the phases started at each event time.

- [ ] **Step 1: Tests first.** (a) a chain 1→2→3: before 3, after steps `[[1],[2],[3]]`, speed-up lanes 1.0; (b) 1, then 2 and 3 both on 1, then 4 on 2 and 3, all areas disjoint: steps `[[1],[2,3],[4]]`, 4/3; (c) same with 2 and 3 sharing an area: `[[1],[2],[3],[4]]`; (d) a shared gate: serial; (e) `slots: 1` (checkout): serial; (f) every phase `**` (no markup): serial except phases with no unfinished deps … still serial (everything overlaps); (g) `phaseHours` with commits two and four hours apart → 3.0; no done phase → `null`; (h) relaxations are already in `phases[].deps` (the caller applies them).
- [ ] **Step 2:** Run — fails. **Step 3:** Implement with `pickPhases` and `isFinished` (no scheduling code of its own). **Step 4:** Run — green.
- [ ] **Step 5:** Commit `feat(adopt): forecast lanes and critical path with the scheduler`.

### Task 4: annotate with the owner's choice, no commit, and the `context` rule

**Files:** modify `lib/annotate.mjs`, `lib/lanes-file.mjs`; tests in `test/annotate.test.mjs`, `test/lanes-file.test.mjs`.

**Interfaces:** the `applyAnalysis` and `lanes.json` contracts above; `stalePhases(root, phases)` also returns a phase whose entry has `confidence: 'low'`, `context: false` and whose CONTEXT.md now exists in the control root (`!needsPrep(root, n)`); entries without `context` are never stale by this rule.

- [ ] **Step 1: Tests first.** (a) `relax: 'all'` at `autonomy: standard` → no question file written, Depends on lines rewritten, ADR written with `by` naming the owner, `proposal.state: 'applied'`; (b) `relax: 'none'` → nothing rewritten, `proposal.state: 'declined'`, no ADR; (c) `relax: ['r2']` → only r2; unknown id → `AnnotateRefused`; (d) `commit: null` → no new commit, result `paths` = ROADMAP, `lanes.json` (+ ADR); (e) `relax` undefined → v0.4 behaviour (existing tests untouched and green); (f) `lanes.json` entries carry `context`; (g) `stalePhases`: low + `context: false` + CONTEXT.md now present → stale; high confidence → not; entry without `context` → not; after re-annotation (`context: true`) → not.
- [ ] **Step 2:** Run `node --test test/annotate.test.mjs test/lanes-file.test.mjs test/prep.test.mjs` — new tests fail.
- [ ] **Step 3:** Implement; reuse `applyAnswer`'s relaxation code path (extract a shared helper inside `lib/annotate.mjs` rather than copying it).
- [ ] **Step 4:** Run the same files — green (incl. `test/prep.test.mjs`: `pendingJobs` queues annotate for the re-marked phase only when no prep is due).
- [ ] **Step 5:** Commit `feat(annotate): apply with the owner's relaxation choice, without a commit; re-mark a low-confidence phase after its prep`.

### Task 5: questions, changes, plan digest, re-verification

**Files:** modify `lib/adopt.mjs`; create `test/adopt-plan.test.mjs`.

**Interfaces:**
- `ADOPT_TEXT` (A7). `adoptQuestions(overview, { proposal, record, lang }) → question[]` (spec §4.3; asked only when unanswered for the same set, A5).
- `adoptChanges(root, overview, { answers, analysis, config, core, deps }) → change[]` in this fixed order: `initChanges` (Task 1), `chunked` (only when `createGsdConfig().get('planning.chunked_parallel')` is `ABSENT`: the rule of `ensureChunkedParallel`; an explicit `false` is the project's and stays), `branching` (slots only, value `phase`/`milestone`), `markup` (a valid analysis: ROADMAP, `lanes.json`, ADR when relaxations are accepted), `reverify` (one per phase, paths the phase's VERIFICATION.md and `.planning/turbo/adopt/reverify-p<N>.md`), `record` (`.planning/turbo/adopt.json`, always last, present only when another change exists or answers are new).
- `adoptPlan(root, { answers, lang, deps }) → { questions, analysis, problems, changes, reverify, forecast, owner, plan }` (A4).
- `reverifyResult(root, phase, { deps }) → { status, kept: boolean, report }` (A6).

- [ ] **Step 1: Tests first.** (a) with closed-stale phases and no record → `stale-closed` asked, options «Оставить закрытыми» (recommended, first) and «Перепроверить», `allowOther: false`; (b) record answering the same set → not asked; one more closed-stale phase → asked again; (c) a valid analysis with relaxations at `standard` → `relax` asked; at `max` → no question, the relaxations in `changes` with an ADR path; (d) an invalid analysis → `analysis: 'refused'`, `problems` listed, no `markup` change; (e) every Russian question/option text passes `plainWords([...], { lang: 'ru' })` and `jargonIn` finds nothing; (f) the digest is stable across calls and changes when an answer or a change changes; (g) `reverifyResult`: fake `gsd verification status` `passed` → kept, nothing moved; `gaps_found` → the new file moved to `.planning/turbo/adopt/reverify-p24.md`, the committed VERIFICATION.md restored byte-identical; a phase that is not closed-stale → refused.
- [ ] **Step 2:** Run `node --test test/adopt-plan.test.mjs` — fails. **Step 3:** Implement. **Step 4:** Run — green.
- [ ] **Step 5:** Commit `feat(adopt): questions up front, the change list and its digest, re-verification results`.

### Task 6: apply, one commit, the record, the report

**Files:** modify `lib/adopt.mjs`; create `test/adopt-apply.test.mjs`.

**Interfaces:**
- `applyAdopt(root, { answers, plan, lang, deps }) → { committed: sha|null, refused?: string, report: string[] }` — recompute `adoptPlan`; digest differs → refused; empty change list → `no changes: already adopted`; else write `adopt.json` `state: 'applying'` with `paths`, apply each change (`initProject`, `cfg.set('planning.chunked_parallel', 'true')` directly, because `ensureChunkedParallel` commits by itself), `createGsdConfig().set('git.branching_strategy', 'none')`, `applyAnalysis(…, { relax, commit: null })`, re-verification files as they are; then `state: 'applied'`; then `commitPaths(root, paths, 'chore(turbo): adopt')`.
- `adoptReport(root, { lang, overview, record, commit }) → string[]` (spec §4.8, sections 1–6; ends with `/turbo-autonomous`, plus `--from <N>` when the active phase is not the first unfinished one).

- [ ] **Step 1: Tests first** (real git in a temp repo, fake GSD core): (a) one commit, `git show --name-only HEAD` equals the change paths, message `chore(turbo): adopt`; (b) `git revert --no-edit HEAD` → `git status --porcelain` empty and every touched file byte-identical to before; (c) second `applyAdopt` → `no changes: already adopted`, HEAD unchanged; (d) crash simulation: write `applying` + half the files, then `scanProject` does not refuse and `applyAdopt` commits once; (e) wrong `--plan-sha` → refused, nothing written; (f) report: ru, sections in order, contains the commit's short sha, `git revert`, and the last line is the `/turbo-autonomous` command; with phase 33 active and 32 unfinished, the command carries no `--from` (32 is first); with 33 active and 32 done, none either; (h) `stale-closed=reverify`: `adoptPlan` digest taken, then a fake verifier makes phase 24 `passed` and 25 `gaps_found`, `reverifyResult` for both, then `applyAdopt` with the same digest commits 24's fresh VERIFICATION.md and `.planning/turbo/adopt/reverify-p25.md` (25's committed report byte-identical) and removes `adopt-reverify.json`; (g) no supervisor, slot, `~/.claude.json` or worktree is touched (assert the fake `CLAUDE_CONFIG_DIR` stays empty and `git worktree list` unchanged).
- [ ] **Step 2:** Run `node --test test/adopt-apply.test.mjs` — fails. **Step 3:** Implement. **Step 4:** Run — green.
- [ ] **Step 5:** Commit `feat(adopt): apply in one commit, record and report`.

### Task 7: the CLI and the closed-phases line

**Files:** modify `bin/turbo-run.mjs`; create `test/cli-adopt.test.mjs`.

- [ ] **Step 1: Tests first** (spawn `bin/turbo-run.mjs` with the isolated env): `adopt scan`/`plan`/`apply`/`reverify`/`report` exit codes and first lines per the Contracts; `adopt` inside a slot → refused like `start`; `--answers` with an unknown id → exit 2; `start` in a project with closed-stale phases prints the A10 line (en and ru), and does not after `adopt apply` with `stale-closed=keep`; `status` the same.
- [ ] **Step 2:** Run `node --test test/cli-adopt.test.mjs` — fails.
- [ ] **Step 3:** Implement `case 'adopt'` (sub-commands `scan|plan|reverify|apply|report`, `refuseInLane('adopt')`), add `adopt` to `USAGE`, `--answers`/`--plan-sha`/`--lang` to `VALUE_FLAGS`, `staleClosedLine` in `start` (after its range and plan-only lines) and in `printStatus` (after the supervisor line). The real `deps`: `runGsdJson`, a git runner, `supAlive`/`readJson(supPath)`, `doctor`.
- [ ] **Step 4:** Run `node --test test/cli-adopt.test.mjs test/cli.test.mjs` — green.
- [ ] **Step 5:** Commit `feat(adopt): turbo-run adopt; start and status name closed phases turbo skips`.

### Task 8: the skill

**Files:** create `skills/turbo-adopt/SKILL.md`, `test/skill-turbo-adopt.test.mjs`; a test that `install.mjs` installs and uninstalls `skills/turbo-adopt` (extend the existing Stage 4 install test or add `test/install-stage5.test.mjs`).

- [ ] **Step 1: Tests first.** The skill test reads the file and pins: the frontmatter (`name: turbo-adopt`, `allowed-tools` with `Agent` and `AskUserQuestion`, no `Skill`), the six points in order (check, markup, questions, changes with ONE confirmation, re-verify at most 3 at a time with only `verifier_dispatch`, apply), the full `turbo-run` form, that it never runs `start`, `resume`, `/turbo-autonomous` or a GSD phase command (the words appear only in "do not" sentences and the report), and that a cancel changes nothing.
- [ ] **Step 2:** Run — fails.
- [ ] **Step 3:** Write the skill: the text of spec §4.11, verbatim, with the AskUserQuestion construction referring to the turbo-autonomous skill's **Answer the open questions** point 3 by name.
- [ ] **Step 4:** Run the skill and install tests — green.
- [ ] **Step 5:** Commit `feat(adopt): the /turbo-adopt skill`.

### Task 9: docs

**Files:** modify `docs/reference.md`, `README.md`, `README.ru.md`, `skills/turbo-autonomous/SKILL.md` (start point 7: pass the `closed phases not re-verified …` line on as it is).

- [ ] **Step 1:** `docs/reference.md`: `## Adopting a running milestone` (what adopt checks, the states, the questions, the change list, the one commit and `git revert`, re-verification, the report, the closed-phases line in `start`/`status`, idempotence), `/turbo-adopt` in `## Use`. README: `/turbo-adopt` in the command list; Roadmap item 5 marked for 0.5.0. Synthetic names only.
- [ ] **Step 2:** `node --test test/skill.test.mjs test/skill-turbo-adopt.test.mjs` (whatever pins the turbo-autonomous text) — green.
- [ ] **Step 3:** Commit `docs: /turbo-adopt`.

## Acceptance (the controller checks before merge)

- `npm test` green on the branch (Linux) and CI green (Ubuntu + Windows).
- Review Focus 1–6 each pinned by a named test.
- `node .superpowers/tools/scan.mjs . <base>..HEAD .superpowers/tools/private-terms --quiet` clean (synthetic `C:\Users\dev\…` hits only).
- Live checks left for the owner's PC (spec §12 items 1–4) written into the journal as `re-check after install`.
