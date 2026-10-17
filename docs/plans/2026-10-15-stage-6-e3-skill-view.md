# gsd-turbo Stage 6 E3 — the lane's exec loop (skill text) and the pane line Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Build only after the go/no-go of the spec §5 says yes or weak yes.**

**Goal:** The lane's `/turbo-phase` step `execute` runs the exec loop when `turbo-run exec N --plan` says `exec on`, and GSD's execute-phase exactly as now when it says `exec off`. The live view shows the queue: how many plans are done, at work, waiting for the owner and waiting for earlier plans.

**Architecture:** Text only in `skills/turbo-phase/SKILL.md` (step **execute** point 1, a new section **Exec loop**, two sentences in **Conventions** and **The step loop**), pinned by `test/skill-exec-loop.test.mjs`. The view reads `<laneCwd>/.planning/turbo/run/exec-p<N>.json` (schema: spec §6.8) and adds `exec` to a lane in step `execute`; both renderers (`lib/view.mjs`, `mod/hooks/view-model.mjs`) print the same words.

**Spec:** `docs/specs/2026-10-15-stage-6-design.md` — §6.1, §6.3–§6.11 (the lane's side), §9, §10.

**Base:** branch `web` with the spec merged. Topic branch `web-stage6-e3-skill-view`. Independent of E1/E2 in code: the skill names their commands and lines exactly as the spec's §8 and E1's Contracts; the view reads the record by its schema (a test writes a record by hand).

What this plan consumes: `skills/turbo-phase/SKILL.md` sections **Conventions**, **The step loop**, **Owner questions** (**Pre-answers**, **At a checkpoint**, **Delivery**), **Push and CI** (**A plan that pushes**), **Plan drafts**, step **execute**; `lib/view.mjs` (the step words tables, the lane model, `laneCwd` via `lib/lanes-state.mjs`), `mod/hooks/view-model.mjs`; tests `test/skill-turbo-phase.test.mjs` (pattern), `test/view.test.mjs`, `test/view-model.test.mjs`.

## Decisions

- **V1** The record is read with `readJson` (no import of `lib/exec-state.mjs`, which E1 creates): `{ plans: { <id>: { state } }, red }` → `exec: { done, total, running, owner, waiting, red }` where `done` counts `merged` and `done-before`, `running` counts `dispatched` and `running`, `waiting` counts `waiting`, `red` is `Boolean(red)`; a record whose `released` or `handoff` is set is not shown (GSD's tail or the owner's sitting runs).
- **V2** Words: en `running plans · 7 of 17 done · 3 at work · 1 waits for you · 6 wait for others`, `· tests red, fixing`; ru `выполняются планы · готово 7 из 17 · в работе 3 · ждёт вас 1 · ждут других 6`, `· тесты красные, чиню`. Zero counts are left out (`· 0 waits for you` never appears).
- **V3** The skill's loop never dispatches a plan that no `dispatch` line named, and never merges by hand: both pinned.

## Global Constraints

- Without an exec record the view prints today's text exactly; with `exec off` the skill runs today's text exactly (pinned).
- The owner's texts follow the existing plain-words rules of the view (no jargon beyond what the pane already shows for subagents).
- TDD; targeted tests; full `npm test` once before hand-back; one commit per task.

## Review Focus

1. Step **execute** with `exec off` is today's step, word for word, after its new first sentence.
2. The loop keeps every existing rule: **Pre-answers** per executor, the release rule and **Temporary files** in each executor prompt, **At a checkpoint**, the wait for background agents before any stop or pause, `turbo-run inbox N` and `push-request` at the new points.
3. One Agent dispatch per message (G12), `isolation="worktree"`, `run_in_background=true`, the sentinel before each dispatch.

---

### Task 1: the skill text

**Files:** modify `skills/turbo-phase/SKILL.md`; create `test/skill-exec-loop.test.mjs`.

- [ ] **Step 1: Tests first.** Pin, in order inside section **Exec loop**: `turbo-run exec N --next`; for each `dispatch` line `turbo-run questions N --preanswers`, `dispatch-isolation --raw --phase N --plan`, `isolation="worktree"`, `run_in_background=true`, `Execute plan`, `turbo-run exec N --running`; "ONE Agent call per message"; `turbo-run exec N --returned`; `## CHECKPOINT REACHED` → `turbo-run exec N --checkpoint`; `held:`; `turbo-run exec N --continue`; `turbo-run exec N --failed`; `--retry`; `turbo-run inbox N` after each return; `owner-answer` → **Delivery**; `push: batch` → `turbo-run push-request N --at wave`; `turbo-run context N` before each batch; `red` → `--retest` and `--attempt exec-red`; `stop: …` → **Stopping early**; `all merged` → `turbo-run exec N --done` → `Skill(skill="gsd-execute-phase", args="N --no-transition")`; the two prohibitions (V3). Step **execute** point 1 starts with `turbo-run exec N --plan` and keeps today's `Skill(skill="gsd-execute-phase", args="N --no-transition")` sentence for `exec off`. **Conventions**' exception list names "the executor prompts of **Exec loop**". `test/skill-turbo-phase.test.mjs` stays green unchanged except where it pins point 1's first words.
- [ ] **Step 2:** `node --test test/skill-exec-loop.test.mjs test/skill-turbo-phase.test.mjs` — fails.
- [ ] **Step 3:** Edit the skill:
  - **Conventions**, the sentence "Never rebuild by hand a prompt …": add `the executor prompts of **Exec loop** (built exactly as GSD's execute-phase step 3 builds them)` to its list of exceptions.
  - **The step loop**, point 2, the sentence "Wherever GSD's execute-phase runs inside a step … before each wave or plan you dispatch": add "(in **Exec loop**: before each batch of dispatches)".
  - Step **execute**, point 1, replace its first sentence by: "`turbo-run exec N --plan`. `exec off: <why>` → `Skill(skill="gsd-execute-phase", args="N --no-transition")`, as follows. `exec on: …` → section **Exec loop**; it ends by running the same Skill for GSD's tail only; then point 2." Keep the rest of point 1 unchanged.
  - Step **execute**, the paragraph "After each wave of point 1 …": add "With **Exec loop**, its own points replace this paragraph."
  - New section after **Plan drafts**:

  ```markdown
  ### Exec loop

  Spec Stage 6 §6. The plans of the phase run as a graph: each one goes to an executor as soon as every plan it needs is merged and one of `max_executors` slots is free; GSD's execute-phase runs afterwards only for its tail (aggregate, gates, verifier, roadmap). turbo-run exec decides what runs and merges each executor's branch with GSD's own cleanup; you build the executor prompts as GSD does and handle the returns. Never dispatch a plan no `dispatch` line named, and never merge, rebase or delete an executor's branch or worktree yourself.

  1. `turbo-run context N` (at or above the stop percentage: point 7), then `turbo-run exec N --next`. For each `dispatch <id> · base <sha> · …` line, one at a time, ONE Agent call per message (simultaneous worktree creation fights over git's config lock):
     a. `turbo-run questions N --preanswers <id>` (section **Owner questions**).
     b. `gsd-tools query dispatch-isolation --raw --phase N --plan <id>` (the isolation guard reads it).
     c. `Agent(subagent_type=<the executor type GSD's per-plan-executor-routing.md gives>, description="Execute plan <NN> of phase N", isolation="worktree", run_in_background=true, prompt=<the prompt of GSD's execute-phase step 3, worktree mode, built exactly as GSD builds it, with EXPECTED_BASE = the base of the line, then the pre-answers paragraph, the release rule (Conventions) and the **Temporary files** paragraph>)`.
     d. `turbo-run exec N --running <id> --agent <agent id>`.
     The other lines: `owner …` (a plan waits for the owner), `waiting … on …`, `red: …` (point 5) need nothing now. The closing line: `idle: …` → wait for the next return; `stop: …` → point 6; `all merged` → point 8.
  2. **A return.** An executor finished (its task notification, or its result):
     - a normal end: `turbo-run exec N --returned <id> --worktree <path> --branch <branch>` (from its `<worktree_metadata>`, else from the Agent result). `merged <id> · tests green · …` → point 3. `red <id>: …` → point 5. `failed <id>: …` → point 4. `blocked <id>: …`: nothing now (its dependents wait; the others go on; point 6 stops for it at the end).
     - `## CHECKPOINT REACHED`: `turbo-run exec N --checkpoint <id> --agent <agent id> --task <task number>`. `held: …`: the owner's card is open and only the plans that need this one wait; go on. `answered: …`: **Delivery** at once. (The rest of **At a checkpoint** applies: the unmet and human-action cases add their flags to this command.)
     - an error: GSD's failure classification (`gsd-tools query agent.classify-failure`); quota → wait the hinted time, then `turbo-run exec N --retry <id>`; anything else → `turbo-run exec N --failed <id> --reason "<one line>"`.
  3. **After each return:** `turbo-run inbox N` (`ci-red` → **CI red**; `owner-answer` → **Delivery**: the same agent through SendMessage, then `turbo-run exec N --running <id> --agent <agent id>`; or, when that fails, `turbo-run exec N --continue <id>` first, then the continuation executor with EXPECTED_BASE = the base it printed, then `--running`). The line said `push: batch` → `turbo-run push-request N --at wave`. A plan that pushes (**A plan that pushes**): after its merge, `turbo-run push-request N --wait` as written there. Then point 1.
  4. **A failed plan.** Its dependents wait; go on with point 1. `--retry` is allowed once per plan.
  5. **Red tests after a merge.** No new dispatches (`--next` prints none); the running executors go on and their returns are merged as usual. `turbo-run phase-step N --attempt exec-red` (`n` above 2 → **stop for the owner** ("tests red after the merges")). Find the cause with systematic debugging and fix it in one commit `fix(phase-N): resolve post-merge failure after plan <id>`, then `turbo-run exec N --retest`: `green: …` → point 1; `red: …` → this point again.
  6. **`stop: …`** (nothing runs and nothing can start): **Stopping early** — `stop: only the owner can unblock: …` → `turbo-run lane-status N needs-owner --reason "owner questions <ids>"` (their cards are open: no new card); `stop: nothing can run: …` → **stop for the owner** with that line.
  7. **Context at the stop percentage:** dispatch nothing more; wait for every running executor's return and handle it (points 2–3); then the context pause of **The step loop** point 2.
  8. **`all merged`:** `turbo-run exec N --done`. `hand-off: …` → `Skill(skill="gsd-execute-phase", args="N --no-transition")`: GSD finds every plan summarized and runs only its tail. Then point 2 of step **execute**. `refused: …` → **fail** with that line.
  ```
- [ ] **Step 4:** Run `node --test test/skill-exec-loop.test.mjs test/skill-turbo-phase.test.mjs test/skill-turbo-prep.test.mjs` — green.
- [ ] **Step 5:** Commit `feat(exec): the turbo-phase execute step runs the plans as a graph`.

### Task 2: the view

**Files:** modify `lib/view.mjs`, `mod/hooks/view-model.mjs`; tests `test/view.test.mjs`, `test/view-model.test.mjs`.

- [ ] **Step 1: Tests first.** A slot lane in step `execute` with a hand-written `exec-p<N>.json` in its slot → `view --json` has `exec` (V1); the pane line en and ru (V2), zero counts left out, `red` suffix; a `released` or `handoff` record → no `exec`; no record → today's text exactly; a lane in another step → no `exec`.
- [ ] **Step 2–4:** fail, implement (both renderers, same words), green (`node --test test/view.test.mjs test/view-model.test.mjs test/view-wait.test.mjs`).
- [ ] **Step 5:** Commit `feat(exec): the pane shows the plan queue`.

## Acceptance

- `npm test` green (Linux) and CI green (Ubuntu + Windows); Review Focus 1–3 pinned; scan clean.
