# Stage 4 — reconciliation of the L1–L4 plans (binding)

The four plans `2026-10-13-stage-4-l1-lanes.md`, `-l2-integrate.md`, `-l3-prep.md` and `-l4-view.md` were written in
parallel against L0's Interfaces (`2026-10-13-stage-4-l0-slots.md`). Where they disagree, **this file wins** over
every plan. An implementer reads this file first, applies each ruling that names its sub-project, and records each
application as a `Deviation (reconcile R<n>):` line in the commit body of the task it changes.

## Order of implementation

1. L0 (done; review fixes on `stage-4-l0`), merged into `stage-4` first.
2. **L1** on top of `stage-4` (it owns the shared modules: `lib/lanes-state.mjs`, `lib/config.mjs` keys,
   `lib/run-status.mjs` statuses, `lib/scheduler.mjs`, `lib/lane-plugins.mjs`, `printStatus`).
3. **L2, L3, L4 in parallel**, each branched from `stage-4` after L1 is merged. Merge order back: L2, L3, L4.
   Expected textual overlaps (resolve by keeping both sides): `lib/phase-progress.mjs` (L2's `integrate` step,
   L3's `PREP_STEPS`), `lib/run-status.mjs`, `lib/cli-phase.mjs`, `bin/turbo-run.mjs` routing,
   `docs/reference.md`, `skills/turbo-phase/SKILL.md`, the step words in `lib/view.mjs` and
   `mod/hooks/view-model.mjs`.

## Rulings

**R1 — one reader of `supervisor.json` (L1 owns).** `lib/lanes-state.mjs` (`supervisorLanes`, `laneForPhase`,
`laneAt`, `laneCwd`, `recordKey`, `laneKey`, `lanesSummary`, `nextLine`, `laneLabel`, `compareLanes`, `JOBS`,
`DONE_STATUSES`) is the only reader. L4 drops its Task 1 (`lib/sup-lanes.mjs`) and uses these names
(`supLanes` → `supervisorLanes(sup, root)`, `laneFor` → `laneForPhase`, `laneDir` → `laneCwd`). A checkout-mode
lane reads as `slot: 0, slotPath: root` (L1's form; L4's `slot: null` is dropped).

**R2 — `context`, `agent-tail`, `activePhase` (L1 owns).** L1 Task 4 changes `lib/context.mjs`,
`lib/agent-tail.mjs` and `activePhase` in `lib/phase-progress.mjs`. L4 drops its Task 7 except what L1 left
undone, which it does through the R1 names.

**R3 — status text (L1 owns), view (L4 owns).** `printStatus` / `status` / `status --json` per lane with the
summary line: L1 Task 11. L4 does not edit `printStatus`; it only adds `next` to `status --json` if L1 has not.
`turbo-run view`, the pane, `status --watch`, toasts, Telegram card titles and the demo: L4.

**R4 — "what is next" is computed once (L1).** The scheduler writes `supervisor.json.next`
(`{ phase, why, waitsFor, gate? }`). L4's `runPlan`/`nextWaiting` read `sup.next` and do not recompute it.
L4's `waitReason` stays only as a pure formatter of a `Next` value into owner words (no scheduling logic). L4
drops `areasMeet`; anything that needs an overlap imports `areasOverlap` from `lib/scheduler.mjs` (which never
imports `lib/view.mjs`).

**R5 — the merge is two calls (L2's model; L1 adapts).** `mergeReady` → `merged` means merged into `main` and
`phase.complete` committed; **the slot is still held** and the lane entry stays. Each tick, for a phase lane whose
`mergeState(root, N)?.state === 'merged'`, L1 calls `mergeFollowUp(ctx, lane)`:
`released` → L1 finishes the lane (remove the session, notify `phaseDone`, remove the temp dir, `releaseGatesOf`,
delete the entry; L2 already released the slot); `ci-red` → wake the lane's session with the inbox prompt;
`needs-owner` → notify once, keep calling; `wait` → nothing. L1's Interfaces text "merged: … push/CI done … slot
released by L2" is replaced by this.
`reintegrate` carries **no** `prompt`: L1 wakes the lane with its own inbox wake prompt (the same wording as S2's
red-CI wake: run `turbo-run inbox N`). L2 counts rounds; L1 does not.
While `mergeHolds(root)` is non-empty, L1 starts no new **phase** lane (prep/annotate may run).

**R6 — config helpers live in `lib/config.mjs` (L1).** `mergeRounds(config)`, `maxPrep(config, lanes)`,
`laneGates(config)`, `GATE_NAMES` are L1's. L2 imports `mergeRounds` from `lib/config.mjs` and does not define its
own (`MERGE_ROUNDS_DEFAULT` dropped). L3 imports `maxPrep` and uses `GATE_NAMES`/`laneGates` instead of its own
`GATES`/`projectGates` (keep `projectGates` only as `export const projectGates = laneGates` if its tests need the
name).

**R7 — jobs API (L3's signature, L1 adapts).** `pendingJobs({ root, config, lanes, range, mode, failed }, phases)`
returns `Array<{ kind: 'prep'|'annotate', phase: string|null }>` (L0's job field name `kind`). `failed` = the keys of
`supervisor.json.jobsFailed` (L3 must not queue them). L1 maps `kind` → `LaneEntry.job`.
`finishJob(ctx, lane)` returns `{ outcome: 'merged'|'failed'|'needs-owner'|'wait', reason? }` — L3 maps
`mergePlanningOnly`'s `refused` to `failed` (and releases the slot `failed`, as its plan says).
`jobPrompts({ ctx, lane, resume, wake })` as L3 wrote it; any non-null `wake` gives the resume prompt.

**R8 — annotation freshness (L3's semantics, L1 adapts).** `readLanesFile(root)`: `null` → at most one phase lane
(no markup yet). `fresh: false` does **not** limit lanes: phases whose ROADMAP section changed are absent from
`phases` and therefore read as `**` (they run alone), unchanged phases keep their marks; L3's `pendingJobs` queues
the annotate job that refreshes them. `confidence` is `'high'|'low'` only (no `medium`).

**R9 — prep merge predicate.** Prep and annotate merges use L3's `allowedFor(job)`; L2's `startsWith` example is
illustrative only.

**R10 — `start --plan-only` (L1 implements).** As specified in L3's Interfaces ("Plan-only start — L1"):
`planOnly: true` in `supervisor.json`, no phase lanes, daemon ends when `pendingJobs` is `[]` and no job lane runs,
one notification `milestonePrepared` (en «Milestone prepared», ru «Майлстоун подготовлен»). L1 adds it as a task
after its Task 11.

**R11 — statuses.** `LANE_STATUSES` gains `ready`, `prepped`, `annotated` in L1. L2 and L3 do not add them again.

**R12 — the annotate pseudo-phase.** `annotate` is never a phase for L1 (no phase lane, no `attend`, no wake for
its card); its owner card is answered like any question (L3). L4 titles it «Lane markup» / «Разметка полос».

## Shared rules for every implementer

- Tests: only the touched test files during work; the full suite once at the end of the sub-project.
- Never commit to `stage-4` directly; work on `stage-4-l<k>`, push, CI green, then the controller merges.
- Public repo hygiene: synthetic paths (`C:\Users\dev\…`), no private names; scan added lines before every push.
