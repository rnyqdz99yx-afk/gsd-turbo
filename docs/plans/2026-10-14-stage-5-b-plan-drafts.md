# gsd-turbo Stage 5 B — plan drafts and reconcile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the planning time of a phase with a long chain of plans. Inside a lane's step `plan`, while GSD's chunked planning runs, the plans of the later Waves are written as drafts at the same time as the first Wave; at its Wave each draft is reconciled against the plans before it (now written) by a short planner revision, and only a reconciled draft becomes the plan, through a deterministic `turbo-run plan-drafts N --promote` with checks. Any failure falls back to GSD's own single-plan call for that plan. GSD's plan checker and revision loop are never bypassed. A measurement line per phase in `supervisor.log` lets the owner compare with drafts on and off.

**Architecture:** `lib/phase-files.mjs` gains a row parser for GSD's chunked outline (`outlineRows`). `lib/plan-drafts.mjs` holds the draft record (`<localRunDir>/drafts-p<N>/drafts.json` in the lane's checkout), the eligibility rule, the draft paragraph, predecessor selection, the reconcile block, the promote checks, the guard used by `planSetCheck`, and the planning summary for the log and the view. `lib/cli-phase.mjs` routes `turbo-run plan-drafts` (a lane command) and extends `planSetCheck`. `lib/phase-progress.mjs` records when each step started and ended; `phase-step N --done plan` writes the measurement line. `lib/config.mjs` gets `plan_drafts.*`. `skills/turbo-phase/SKILL.md` gets the section **Plan drafts** and two sentences in step **plan**. The view shows the drafts' progress during planning.

**Tech Stack:** Node ≥ 20 (ESM `.mjs`, `node:test`, zero npm dependencies), git (`hash-object`, `rev-parse`, `log --diff-filter=A`), GSD 1.16 chunked planning (`workflows/plan-phase/steps/chunked-planning-mode.md`, `references/planner-chunked.md`, `references/planner-revision.md`).

**Spec:** `docs/specs/2026-10-14-stage-5-design.md` — §1 criteria 5–9, §2 owner decision 3 and D3–D6, §3 (J2, J3, G1–G10), §5 entirely, §6, §7 (`plan-drafts`), §8 (turbo-phase text), §9 (view), §10–§12 (B rows).

**Base:** branch `web` (stage-4 309f464 + hand-off), with the spec merged. Topic branch `web-stage5-b-drafts`. Existing code is referenced by function name and anchor text, never by line number.

What this plan consumes, by exact name (it re-implements none of it):
- `lib/phase-files.mjs`: `planOutline`, `outlinePlanIds`, `findPhaseDir`, `phaseArtifacts`, private `cellsOf`, `OUTLINE_RE`, `OUTLINE_DONE_RE`, `hasFrontmatter`.
- `lib/annotate.mjs`: `filesModified(text)`. `lib/staleness.mjs`: `extractRefs`, `gitRunner`, `planFileOf`.
- `lib/cli-phase.mjs`: `planSetCheck`, `phaseStep`, `HANDLERS`, `PHASE_COMMANDS`, `VALUE_FLAGS`, `parseArgs`, `phaseArg`, `usage`, `fail`, `coreOrFail`, `relTo`. `lib/phase-progress.mjs`: `readProgress`, `completeStep`, `nextStep`, `STEPS`.
- `lib/paths.mjs`: `localRunDir`, `logsDir`, `isSlot`. `lib/fsx.mjs`: `readJson`, `writeJsonAtomic`. `lib/config.mjs`: `loadConfig`, `DEFAULTS`, the `lanesSettings` validation pattern.
- `lib/view.mjs` and `mod/hooks/view-model.mjs`: the step words tables (`step: { plan: … }`), `laneCwd` (via `lib/lanes-state.mjs`).
- Tests: `test/helpers/tmp.mjs` (`tmpDir`, `tmpGitRepo`), `test/helpers/plans.mjs` (`writePhase`), `test/helpers/slots.mjs` (`ISOLATED`, `gitIn`).

## As implemented (after the spec review of 2026-10-14)

The spec (§5, §6, §7, §9) is corrected to match; where this plan's text differs, the spec and the code win:
- Cut: the rolling "draft later" re-dispatch (drafts go out once, at most `max_parallel`, default **8**; the rest is
  GSD's), `plan-drafts --status`, the pane line (Task 9), timings for steps other than `plan`.
- Timings live in `run/plan-clock-p<N>.json`, not in `phase-p<N>.json` (no writer of that file has to carry them).
- `--plan` also removes drafts an agent left in the phase directory and prints `commit first: <ids>`; it applies only
  to the waves after the one GSD plans now; `min_waves` decides only before the first draft; `drafts off: plan checker
  disabled` when GSD's `plan_checker` / `workflow.plan_check` is false.
- `--drafting`/`--reconcile` record HEAD and the state of the phase directory, ROADMAP.md and STATE.md;
  `--drafted`/`--reconciled` refuse on a planner's own commit or another change there (G16, G17). Every `use: gsd`
  marks the record `replanned`; `--drafted`, `--reconciled` and `--replan` remove a draft written into the phase
  directory (with a commit when it was committed).
- Predecessors also include the earlier plans the draft's `## Draft assumptions` names. The guard (B11) reads the
  newest adding commit and refuses any plan file equal to a recorded drafted/reconciled blob.
- `filesModified` of `lib/annotate.mjs` is not imported (it would pull annotate's imports into the lane commands):
  `lib/plan-drafts.mjs` reads `files_modified` with its own `frontList`, which also reads `depends_on`.
- The skill section **Plan drafts** sits after **Stale report**; its tests are `test/skill-plan-drafts.test.mjs`, and
  the clock tests `test/plan-clock.test.mjs` (both separate files, so the merge with other branches stays clean).

## Decisions this plan makes where the spec is open

- **B1 Where things live.** Draft files and the record: `<localRunDir(root)>/drafts-p<N>/` (the lane's own checkout: the slot, or the main checkout in `checkout` mode), ignored by git through `.planning/turbo/.gitignore`'s `run/`. A new `prepareSlot` wipes them with the slot; the record and the files go together. The measurement line goes to `<logsDir(root)>/supervisor.log` (the control root), appended the way `lib/watchdog.mjs` appends its line (`<ISO> <line>\n`).
- **B2 Blobs.** A file's identity is `git hash-object <file>` (works for untracked drafts). "Committed" means `git status --porcelain -- <file>` is empty and `git rev-parse HEAD:<rel>` equals its hash.
- **B3 Outline rows.** `outlineRows(text, prefix) → [{ id, objective, wave, dependsOn: string[], requirements: string[] }]` from the first table outside fences whose header has a Plan ID column (the `outlinePlanIds` header rule), plus the columns `Wave` and `Depends On` (`Depends`, `Depends on`, case-insensitive). `wave`: an integer ≥ 1; blank → 1 (GSD's rule); anything else → `NaN` (ineligible). `dependsOn`: every `<prefix>-NN` id in the cell; `none`, `—`, `-`, empty → `[]`. `outlinePlanIds` keeps its behaviour (its tests unchanged).
- **B4 Eligibility.** `draftsPlan(root, phase, { config })` returns `{ use: false, why }` for each spec §5.3 reason, in this order of checks: `plan_drafts.enabled` false; no outline; outline unfinished; no Wave or Depends On column; a row without an id; a wave that is not an integer; a dependency outside the outline; a dependency in the same or a later wave; the outline's sha256 changed against the record (the record is reset first, then the rules run again); fewer than `min_waves` waves holding a plan whose `<id>-PLAN.md` is not written. Else `{ use: true, waves, draftNow, draftLater }`: every unwritten plan of wave ≥ 2 without a usable record (`drafted`, `reconciling`, `reconciled`, `promoted`), earliest waves first, `draftNow` filled up to `max_parallel` minus the records in state `drafting`.
- **B5 Predecessors.** For a plan p: its `dependsOn`, plus every plan q of an earlier wave whose `filesModified` (from its committed plan file) meets `filesModified(draft) ∪ extractRefs(draft).paths`. Sorted by outline order.
- **B6 The draft paragraph** (printed by `--drafting`, added unchanged at the end of GSD's single-plan prompt):
  ```
  **Draft (gsd-turbo).** The plans before this one are not written yet. Plan from their outline rows below and from the code as it is now. Write exactly one file, <abs draft path>, instead of <phase dir>/<id>-PLAN.md, and write nothing in the phase directory. Keep the frontmatter wave: <w> and depends_on: [<ids>] of the outline row. End the plan with a section ## Draft assumptions: per earlier plan, each thing this plan takes from it (a file it creates or changes, a function, type or command it adds, a decision), one line each.
  Outline rows of the earlier plans:
  | Plan ID | Objective | Wave | Depends On | Requirements |
  |---|---|---|---|---|
  <the rows of every plan of an earlier wave, as the outline has them>
  ```
- **B7 `--drafted` checks.** The draft file exists, starts with `---`, its frontmatter `wave` equals the row's, its `depends_on` set equals the row's, it has a `## Draft assumptions` heading, and no file `<phase dir>/<id>-PLAN.md` was created by the draft agent (if one exists while the record says `drafting`, refuse: `the draft agent wrote into the phase directory: delete <file>`; the lane deletes it and replans). Pass → `drafted` with `blobs.drafted`.
- **B8 `--reconcile`.** `use: gsd` when the record is absent, `replanned`, or the draft's hash differs from its recorded blob (`drafted` or, on a rerun, `reconciled`). Refused when a predecessor is not committed. Else `reconciling`, `against` = each predecessor's committed blob, and the block: `reconcile <id>: <n> plans before it`, then `draft: <abs path>`, `before: <abs path>` per predecessor, `outline: <abs path>`, `row: | … |`, `context: <abs path or none>`, `assumptions:` and the lines of the draft's `## Draft assumptions` section.
- **B9 `--reconciled`.** Refused unless the record is `reconciling` and every `against` blob is still the committed blob of that predecessor. `--verdict passed` → `reconciled`, `blobs.reconciled` = the draft's hash now. `--verdict failed` → `replanned` with the reason.
- **B10 `--promote`.** Refused unless: `reconciled`; the draft's hash equals `blobs.reconciled`; `against` blobs unchanged; the draft starts with `---`; `wave`/`depends_on` equal the row; no `filesModified` overlap with an already written plan of the same wave; `<phase dir>/<id>-PLAN.md` does not exist. Then: remove the `## Draft assumptions` section (from its heading to the next heading of the same or a higher level, or the end), write `<id>-PLAN.md` atomically (temp file in the phase directory's parent, rename), record `promoted` with `blobs.promoted`, print `promoted <id>: <rel path>`.
- **B11 The guard** (`draftsGuard(root, phase) → null | why`, called by `planSetCheck` when its own checks pass): for every record not `replanned` whose `<id>-PLAN.md` exists: the file's first-add commit blob (`git log --diff-filter=A --format=%H -- <rel>`, oldest; `git rev-parse <c>:<rel>`), or, when it is not committed yet, its working hash, must equal `blobs.promoted`. Else `plan <id> came from a draft without a passed reconcile: …`. No record → `null`.
- **B12 Timings.** `phase-p<N>.json` gains `started: { <step>: ISO }` (set by `phase-step N` the first time it prints that step as next; a resume does not reset it) and `doneAt: { <step>: ISO }` (set by `completeStep`). `--json` adds `timings: { <step>: { started, done, ms } }`. `--done plan` appends `phase <N> plan: <h>h<mm>m wall clock · <summary>` to the log and to the step's note, where `<summary>` is `drafts on: P plans in W waves, D drafted, R reconciled, F replanned` or `drafts off: <why>` (the last `--plan` answer, from the record) or `drafts off: not asked` (no record).
- **B13 Config.** `plan_drafts: { enabled: true, min_waves: 3, max_parallel: 6 }` in `DEFAULTS`; `planDraftsSettings(raw)` checks: `enabled` boolean, `min_waves` integer 2–20, `max_parallel` integer 1–20 (digit strings accepted, as `mergeRounds`); anything else throws the config error naming the key.
- **B14 View.** `turbo-run view --json` adds to a phase lane in step `plan`: `planning: { waves, wavesDone, drafted, reconciled, replanned }` (from the record in `laneCwd`), or nothing without a record. Both renderers write the step as `planning · wave 3 of 8 · 2 of 9 drafts reconciled` / `планирование · волна 3 из 8 · сверено 2 из 9 черновиков`.

## Global Constraints

- Node ≥ 20, ESM `.mjs` only, **zero runtime npm dependencies**; tests use `node:test` and `node:assert/strict`.
- Windows and Linux: paths with `path.join`; child processes only through `execFileSync` with an argument array, `windowsHide: true` and a timeout, never a shell. git paths with `/`.
- Public repository: synthetic names only.
- A draft never enters the phase directory except through `--promote`; `--promote` never overwrites an existing plan file; turbo never commits a plan itself (the lane commits with GSD's message). Without an eligible outline everything behaves byte for byte as v0.4.
- State files with `writeJsonAtomic`. Tests never touch the network, a real `claude` or GSD core, or the developer's Claude home; spawned `bin/turbo-run.mjs` runs get the isolated env (`ISOLATED`, no `TURBO_CONTROL_ROOT`, empty `CLAUDE_CONFIG_DIR`).
- TDD; run only the named test files per task; full `npm test` once before hand-back. One commit per task (`feat(drafts): …`, `test(drafts): …`, `docs: …`). Never push, merge, tag or install.

## Review Focus

1. **A draft can never be executed unreconciled.** A plan file placed in the phase directory by anything but `--promote` while a record exists → `phase-step N --check plan` prints `incomplete` and `--done plan` refuses. Pinned in Task 5.
2. **Predecessor drift.** A predecessor changed (re-committed) between `--reconcile` and `--reconciled`/`--promote` → refused. Pinned in Task 4.
3. **Fallback is total.** Each `drafts off` reason (B4) returns before any file is written; with `plan_drafts.enabled: false`, `--plan` writes no record. Pinned in Task 3.
4. **Resume.** A second `--plan` after an interruption reuses `drafted`/`reconciled` drafts whose hash matches, redrafts `drafting` ones without a valid file, and a changed outline resets the record. Pinned in Task 3/4.
5. **GSD's outline variety**: extra columns, bold or code in cells, links in the id cell, blank Wave, `none`/`—` in Depends On, CRLF. Pinned in Task 1.
6. **The skill text** keeps GSD's checker loop, the per-plan owner questions and the wait-for-subagents rule. Pinned in Task 8.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/phase-files.mjs` | modify | `outlineRows` |
| `lib/config.mjs` | modify | `plan_drafts` defaults, `planDraftsSettings` |
| `lib/plan-drafts.mjs` | create | record, eligibility, paragraph, predecessors, reconcile, promote, guard, summary |
| `lib/cli-phase.mjs` | modify | `plan-drafts` handler, `PHASE_COMMANDS`, `VALUE_FLAGS` (`--drafting`, `--drafted`, `--reconcile`, `--reconciled`, `--verdict`, `--promote`, `--replan`, `--reason`), `planSetCheck` → `draftsGuard`, measurement on `--done plan` |
| `lib/phase-progress.mjs` | modify | `started`, `doneAt`, `markStarted`, `timings` |
| `bin/turbo-run.mjs` | modify | `USAGE` (add `plan-drafts`) |
| `skills/turbo-phase/SKILL.md` | modify | Conventions exception, step **plan** points 2–3, section **Plan drafts** |
| `lib/view.mjs`, `mod/hooks/view-model.mjs` | modify | `planning` in the lane model and the step line |
| `docs/reference.md` | modify | `## Plan drafts`; keys in `## Config`; `plan-drafts` in the command list |
| `test/outline-rows.test.mjs`, `test/plan-drafts.test.mjs`, `test/plan-drafts-git.test.mjs`, `test/cli-plan-drafts.test.mjs` | create | tests |
| `test/config.test.mjs`, `test/phase-progress.test.mjs` (phase-step and `planSetCheck` tests), `test/skill-turbo-phase.test.mjs`, `test/view-model.test.mjs`, `test/view.test.mjs` | modify | tests |

Overlap with plan A (`2026-10-14-stage-5-a-adopt.md`): `bin/turbo-run.mjs` (`USAGE` line), `docs/reference.md` (different sections). Resolve by keeping both sides.

## Contracts

- **`turbo-run plan-drafts <N> --plan [--json]`** — `drafts off: <why>` or `drafts on: <W> waves, <P> plans · draft now: <ids|none> · draft later: <ids|none>` (exit 0 both). `--json`: `{ use, why?, waves: [[ids]…], draftNow, draftLater }`.
- **`--drafting <id>`** — the B6 paragraph (exit 0); `refused: <why>` (exit 1: not eligible, wave 1, already written, already drafted).
- **`--drafted <id>`** — `drafted <id>` or `refused: <why>` (B7).
- **`--reconcile <id>`** — `use: gsd (<why>)` or the B8 block, exit 0; `refused: <why>` exit 1.
- **`--reconciled <id> --verdict passed|failed [--reason <text>]`** — `reconciled <id>` / `replanned <id>` or `refused: …`.
- **`--promote <id>`** — `promoted <id>: <rel path>` or `refused: …`.
- **`--replan <id> [--reason <text>]`** — `replanned <id>` (always exit 0 for a known id; a draft file is kept for the record, never moved).
- **`--status [--json]`** — one line per plan (`<id> wave <w>: <state>`), then `timings: outline <ISO> · first plan <ISO> · last plan <ISO>`; `--json` the record plus `summary`.
- **Record** `<localRunDir>/drafts-p<N>/drafts.json`: `{ v: 1, phase, outline: { file, sha256 }, lastPlan: { use, why?, at }, plans: { <id>: { wave, dependsOn, state, draft, blobs: { drafted?, reconciled?, promoted? }, against?: { <id>: <blob> }, reason?, at: { <state>: ISO } } } }`.
- **`planSetCheck`** additionally returns `{ why: 'plan <id> came from a draft without a passed reconcile: …' }` (B11).
- **Log line** (B12): `phase 33 plan: 1h12m wall clock · drafts on: 10 plans in 8 waves, 9 drafted, 8 reconciled, 1 replanned`.

---

### Task 1: outline rows

**Files:** modify `lib/phase-files.mjs`; create `test/outline-rows.test.mjs`.

- [ ] **Step 1: Tests first.** GSD's own example table (`references/planner-chunked.md`: `| 33-01 | … | 1 | none | REQ-1 |`) → rows with `wave` 1, `dependsOn` []; a 10-row, 8-wave outline with `Depends On` cells `33-01`, `33-02, 33-03`, `**33-04**`, `` `33-05` ``, `[33-06](33-06-PLAN.md)`; blank Wave → 1; `2a` → `NaN`; extra columns (`Notes`) and a different column order; a table without a Wave column → rows with `wave: undefined` and a `columns` flag the caller reads; fenced tables ignored; CRLF; `outlinePlanIds` results unchanged on the same texts.
- [ ] **Step 2:** `node --test test/outline-rows.test.mjs test/phase-files.test.mjs` (the latter holds `outlinePlanIds`' tests) — new tests fail.
- [ ] **Step 3:** Implement `outlineRows(text, prefix) → { columns: { wave: bool, dependsOn: bool }, rows }` with the existing private helpers.
- [ ] **Step 4:** Run — green. **Step 5:** Commit `feat(drafts): read the rows of GSD's chunked plan outline`.

### Task 2: config

**Files:** modify `lib/config.mjs`, `test/config.test.mjs`.

- [ ] **Step 1: Tests first.** Defaults present; `planDraftsSettings({})` → defaults; `'4'` accepted for `min_waves`; `enabled: 'yes'`, `min_waves: 1`, `max_parallel: 0`, `max_parallel: 21` → throw naming `plan_drafts.<key>`.
- [ ] **Step 2–4:** fail, implement (B13), green (`node --test test/config.test.mjs`).
- [ ] **Step 5:** Commit `feat(drafts): plan_drafts config keys`.

### Task 3: the record and eligibility

**Files:** create `lib/plan-drafts.mjs`, `test/plan-drafts.test.mjs`.

**Interfaces:** `draftsDir(root, phase)`, `readDrafts(root, phase)`, `writeDrafts(root, phase, rec)`, `draftsPlan(root, phase, { config, now }) → B4 result` (writes `lastPlan` and resets on an outline change), `draftParagraph(root, phase, id) → string` (B6, used by `--drafting`, which records `drafting`), `checkDraft(root, phase, id) → null | why` (B7).

- [ ] **Step 1: Tests first** (temp dirs, phase dir via `writePhase`): every B4 reason in its order, each leaving no record when `enabled` is false and a `lastPlan` with `use: false` otherwise; a 4-wave outline with wave 1 written → `draftNow` = waves 2–4 up to `max_parallel`, `draftLater` the rest; records `drafting` count against `max_parallel`; a changed outline resets the record; `draftParagraph` contains the absolute draft path, `wave: <w>`, the `depends_on` ids and the rows of earlier waves only, no control characters; `checkDraft` each B7 refusal.
- [ ] **Step 2–4:** fail, implement, green (`node --test test/plan-drafts.test.mjs`).
- [ ] **Step 5:** Commit `feat(drafts): the draft record and when drafts are used`.

### Task 4: reconcile, promote, replan (with git)

**Files:** modify `lib/plan-drafts.mjs`; create `test/plan-drafts-git.test.mjs`.

**Interfaces:** `predecessors(root, phase, id) → [{ id, file }]` (B5), `startReconcile(root, phase, id, { git })` (B8), `finishReconcile(root, phase, id, verdict, { reason, git })` (B9), `promote(root, phase, id, { git })` (B10), `replan(root, phase, id, { reason })`, `stripAssumptions(text)`.

- [ ] **Step 1: Tests first** (`tmpGitRepo`, a phase with a 3-wave outline): (a) full happy path: wave-1 plan committed → `startReconcile` for the wave-2 draft → block lists the predecessor → `finishReconcile passed` → `promote` writes `<id>-PLAN.md` without the assumptions section, the record `promoted`; (b) `startReconcile` refused while the predecessor is uncommitted; (c) the predecessor re-committed after `startReconcile` → `finishReconcile` refused; after `finishReconcile` → `promote` refused; (d) the draft edited after `finishReconcile` → `promote` refused; (e) wave/depends_on mismatch → refused; same-wave `files_modified` overlap with an already written plan → refused; target exists → refused; (f) `finishReconcile failed` and `replan` → `use: gsd` on the next `startReconcile`; (g) B5: a wave-1 plan that is no dependency but shares a modified file is a predecessor, one that shares nothing is not; (h) `stripAssumptions` with the section in the middle, at the end, with CRLF.
- [ ] **Step 2–4:** fail, implement, green (`node --test test/plan-drafts-git.test.mjs`).
- [ ] **Step 5:** Commit `feat(drafts): reconcile against the written plans and promote with checks`.

### Task 5: the guard in `planSetCheck`

**Files:** modify `lib/plan-drafts.mjs` (`draftsGuard`), `lib/cli-phase.mjs` (`planSetCheck`); tests in `test/plan-drafts-git.test.mjs`.

- [ ] **Step 1: Tests first.** (a) promoted and committed plan → `planSetCheck` `ok`; (b) a draft copied into the phase directory by hand (record `reconciled`, never promoted) and committed → `why` names the plan; `phase-step N --done plan` refuses with it; (c) same but uncommitted → `why`; (d) a `replanned` record and a GSD-written plan → `ok`; (e) no record → v0.4 result exactly (existing `planSetCheck` tests unchanged and green); (f) a plan promoted, then revised by the checker in a later commit → `ok` (first-add blob is the promoted one).
- [ ] **Step 2–4:** fail, implement (B11), green (`node --test test/plan-drafts-git.test.mjs test/phase-progress.test.mjs`; the existing `planSetCheck` tests live in the latter).
- [ ] **Step 5:** Commit `feat(drafts): the plan step refuses a plan that skipped its reconcile`.

### Task 6: timings and the measurement line

**Files:** modify `lib/phase-progress.mjs`, `lib/cli-phase.mjs` (`phaseStep`), `lib/plan-drafts.mjs` (`draftsSummary`); tests in `test/phase-progress.test.mjs`.

- [ ] **Step 1: Tests first.** `phase-step N` printing `next plan` sets `started.plan` once (a second call keeps it); `--done plan` sets `doneAt.plan`, appends exactly one line matching `^\S+ phase N plan: \d+h\d{2}m wall clock · drafts (on: \d+ plans in \d+ waves, \d+ drafted, \d+ reconciled, \d+ replanned|off: .+)$` to the control root's `logs/supervisor.log` (a slot fixture: the line lands in the control root, not the slot), and the same text in `notes.plan` (with the lane's own note after it); `--json` has `timings.plan.ms`; a progress file from v0.4 (no `started`) still works (`ms` null, the line says `wall clock unknown`).
- [ ] **Step 2–4:** fail, implement (B12), green.
- [ ] **Step 5:** Commit `feat(drafts): planning wall clock per phase in the supervisor log`.

### Task 7: the CLI

**Files:** modify `lib/cli-phase.mjs` (`HANDLERS['plan-drafts']`, `PHASE_COMMANDS`, `VALUE_FLAGS`), `bin/turbo-run.mjs` (`USAGE`); create `test/cli-plan-drafts.test.mjs`.

- [ ] **Step 1: Tests first** (spawned CLI, isolated env, a temp git project with a fake GSD core): each action's first line and exit code per the Contracts; usage error (exit 2) for no action, two actions, `--verdict` other than passed/failed, an id outside the outline; inside a slot fixture the record lands in the slot's `run/` and the log line in the control root.
- [ ] **Step 2–4:** fail, implement, green (`node --test test/cli-plan-drafts.test.mjs test/cli-project-arg.test.mjs`).
- [ ] **Step 5:** Commit `feat(drafts): turbo-run plan-drafts`.

### Task 8: the skill text

**Files:** modify `skills/turbo-phase/SKILL.md`, `test/skill-turbo-phase.test.mjs`.

- [ ] **Step 1: Tests first.** Pin: the Conventions exception list names "the reconcile prompt of **Plan drafts**"; step **plan** point 2 has the sentence that runs **Plan drafts** after GSD's outline and before its first Wave; point 3 names the guard's refusal and its way out; the section **Plan drafts** contains, in order, `turbo-run plan-drafts N --plan`, `--drafting`, ONE message with GSD's first-Wave dispatch, `run_in_background=true`, `--drafted`, `--replan`, `--reconcile`, `use: gsd`, `--reconciled`, `--promote`, `marker_received`, **List and classify**, GSD's step 9 and plan checker unchanged, the wait before **Stopping early** or the context pause; the reconcile prompt has `dimension: "draft-reconcile"`, `severity: "blocker"`, `planner-revision.md`, `## RECONCILE PASSED`, `## RECONCILE FAILED`, `REVISION_CONFLICT`.
- [ ] **Step 2:** Run `node --test test/skill-turbo-phase.test.mjs` — fails.
- [ ] **Step 3:** Edit the skill:
  - **Conventions**, the "Never rebuild by hand a prompt …" sentence: add `the reconcile prompt of **Plan drafts**` to its list of exceptions.
  - Step **plan**, point 2, after "…when it reaches its step 15 (Auto-Advance Check), do not launch execute-phase; come back here (G5).": add "When GSD's outline is complete (its chunked planning's §8.5.1) and before its first Wave is dispatched, run section **Plan drafts**; it changes only how the plans of the later Waves are dispatched, and every plan's commit is still followed by the questions below."
  - Step **plan**, point 3, append: "`plan <id> came from a draft without a passed reconcile`: run `turbo-run plan-drafts N --replan <id>`, delete that plan file, commit the deletion with `gsd-tools commit \"docs(phase-N): drop a plan that skipped its reconcile\" --files <the file>`, and run point 2 again: GSD plans it anew."
  - New section after step **plan** (or as `#### Plan drafts` inside it), text:

  ```markdown
  ### Plan drafts

  Spec Stage 5 §5. GSD's chunked planning plans one Wave at a time, because a planner reads the plans written before its own. Here the plans of the later Waves are first written as drafts, all at the same time as the first Wave; at its Wave each draft is checked against the plans before it, now written (a reconcile pass), and only a reconciled draft becomes the plan. GSD's outline, its commits, its plan checker and its revision loop run as GSD says. This section runs only from point 2 of step **plan**: never for `--gaps`, `--reviews` or a freshness revision.

  1. `turbo-run plan-drafts N --plan`. `drafts off: <why>`: nothing more of this section runs; GSD plans as usual. `drafts on: …` names `draft now: <ids>` and `draft later: <ids>`.
  2. **Drafts.** For each id of `draft now`: `turbo-run plan-drafts N --drafting <id>`; it prints a paragraph. Then, in ONE message: GSD's dispatch of its first Wave, exactly as GSD says, and for each of these ids `Agent(subagent_type="gsd-planner", description="turbo draft <id> phase N", run_in_background=true, prompt=<GSD's single-plan prompt for that plan (§8.5.2 point 4, with that plan's outline row), built as GSD builds it, with the paragraph added unchanged at its end>)`. The paragraph names the draft file: the draft agent writes nothing in the phase directory. Do not wait for the drafts: the first Wave goes on as GSD says (its commits, then **List and classify**).
     - A draft agent returns `## PLAN COMPLETE`: `turbo-run plan-drafts N --drafted <id>`. Any other return, or `refused: …`: `turbo-run plan-drafts N --replan <id> --reason "<one line>"`; that plan takes GSD's own path at its Wave. A refusal that names a file the agent wrote into the phase directory: delete that file first.
     - After each draft return, while point 1 named `draft later`: run `turbo-run plan-drafts N --plan` again and dispatch its new `draft now` ids the same way, in a message of their own.
  3. **Each later Wave**, at GSD's §8.5.2 point 4: first wait for the draft agents of this Wave's plans. Then for each entry of the runnable set: `turbo-run plan-drafts N --reconcile <id>`. `use: gsd …`: GSD's own single-plan Agent call for that entry. `reconcile <id>: …`: one reconcile Agent call for it (the prompt below). `refused: …`: `turbo-run plan-drafts N --replan <id> --reason "<the line>"`, then GSD's own call for it. Make all of the Wave's calls in ONE message.
  4. **A reconcile return.** `## RECONCILE PASSED`: `turbo-run plan-drafts N --reconciled <id> --verdict passed`, then `turbo-run plan-drafts N --promote <id>`. `promoted <id>: <path>` is that entry's `marker_received`: GSD's points 6 and 7 for it (the file on disk; its commit `docs(<padded phase>): plan <id> (chunked)`, in outline row order), then **List and classify**, as after every plan's commit. `## RECONCILE FAILED`, `## REVISION_CONFLICT`, no marker, or `refused: …` from `--reconciled` or `--promote`: `turbo-run plan-drafts N --replan <id> --reason "<one line>"` (or `--reconciled <id> --verdict failed --reason "<…>"` for a failed return), then GSD's own single-plan Agent call for that entry and GSD's points 5 to 8 for it.
  5. After the last Wave GSD goes on with its own step 9 (`## PLANNING COMPLETE`), its plan checker and its revision loop, unchanged.
  6. Before **Stopping early** or the context pause, wait for every draft and reconcile agent you started, as for any subagent. Drafts stay on disk for the next session: `--plan` and `--reconcile` reuse what is recorded.

  The reconcile prompt, one per entry (`<…>` from the block `--reconcile` printed), followed by the **Temporary files** paragraph (Conventions):

      <revision_context>
      **Phase:** N
      **Mode:** revision (gsd-turbo draft reconcile)

      <required_reading>
      - <draft> (the plan to check: a draft written before the plans it builds on existed)
      - <each before: path> (the plans before it, as committed)
      - <outline> (its row: <row>)
      - <context> (USER DECISIONS)
      </required_reading>

      **Checker issues:**
      - plan: "<id>"
        dimension: "draft-reconcile"
        severity: "blocker"
        required_property: "every file, symbol, interface, command and decision this plan takes from the plans before it matches what those plans now say; its wave and depends_on equal its outline row; it does not redo work a plan before it already does; nothing it relies on is missing from them"
        description: "<the assumptions lines>"
      </revision_context>

      <instructions>
      Read <gsd-core>/references/planner-revision.md first. Edit only <draft>, in place, with the smallest changes that make the required property hold, and keep its ## Draft assumptions section up to date. Write nothing in the phase directory and no other file. Return ## RECONCILE PASSED with one line per change (or "no change") when the property holds after your edits. Return ## RECONCILE FAILED with the reason when it cannot hold without rewriting the plan (a plan before it took another approach, the plan's scope moved, a dependency is missing from its outline row). A ## REVISION_CONFLICT as planner-revision.md describes counts as failed.
      </instructions>
  ```
- [ ] **Step 4:** Run `node --test test/skill-turbo-phase.test.mjs test/skill-turbo-prep.test.mjs` — green (`/turbo-prep` reads only freshness, discuss and prologue: unaffected).
- [ ] **Step 5:** Commit `feat(drafts): the turbo-phase plan step drafts later Waves and reconciles them`.

### Task 9: the view

**Files:** modify `lib/view.mjs`, `mod/hooks/view-model.mjs`; tests `test/view.test.mjs`, `test/view-model.test.mjs`.

- [ ] **Step 1: Tests first.** A lane in step `plan` with a record in its slot (`laneCwd`) → `view --json` has `planning` (B14); the pane line en and ru as in B14; no record → today's text exactly; a lane in another step → no `planning`.
- [ ] **Step 2–4:** fail, implement (both renderers, same words), green.
- [ ] **Step 5:** Commit `feat(drafts): the pane shows drafts during planning`.

### Task 10: docs

**Files:** modify `docs/reference.md`.

- [ ] **Step 1:** `## Plan drafts`: when drafts are used and when not, where drafts live, the reconcile and promote checks, the fallback, the guard, the measurement line and how to compare (`plan_drafts.enabled: false` on one phase), the cost; the three keys in `## Config`; `plan-drafts` in the lane command list.
- [ ] **Step 2:** Commit `docs: plan drafts`.

## Acceptance (the controller checks before merge)

- `npm test` green on the branch (Linux) and CI green (Ubuntu + Windows).
- Review Focus 1–6 each pinned by a named test.
- Scan of the code range clean (synthetic `C:\Users\dev\…` hits only).
- Live checks left for the owner's PC (spec §12 items 5–6) written into the journal as `re-check after install`.
