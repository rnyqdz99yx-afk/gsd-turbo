# gsd-turbo Stage 4 L1 — several lanes: supervisor and scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run up to `max_lanes` independent phases (and prep/annotate jobs) at once, each in its own slot, with a supervisor that starts, relaunches, wakes, answers, attends and stops every lane on its own, a scheduler that never runs two phases with overlapping `Areas`, a shared `Gates` entry or a dependency between them, and `lanes.mode: "checkout"` that stays exactly v0.3.

**Architecture:** `lib/scheduler.mjs` gains the pure parts: `areasOverlap` (spec §6.3), `criticalPath`, `annotationOf` and `pickPhases` (readiness = deps ∧ Areas disjoint ∧ Gates free ∧ a free slot ∧ < `max_lanes`; critical path first; one phase lane while the annotation is missing or stale). `lib/supervisor.mjs` keeps v0.3's single-lane `step` untouched for checkout mode (state `lane`) and adds `stepSlots` for slots mode (state `lanes`): every lane is stepped on its own (an error in one lane rolls back only that lane), new lanes get a prepared slot from L0, a lane whose record says `ready` goes to L2's `mergeReady`, a prep/annotate job whose record says `prepped`/`annotated` goes to L3's `finishJob`, and lanes that cannot go on stop alone. The per-lane helpers (`startLane`, `wakeSession`, `checkStall`, `wakeForAnswers`, the relaunches) learn where a lane runs (its slot, its key, its job) without changing what they do for v0.3's lane. `lib/lanes-state.mjs` is the one reader of `supervisor.json` lanes for everyone else (`supervisorLanes`, `laneForPhase`, `laneAt`). `lib/gate-locks.mjs` and `turbo-run lock|unlock` are the one-off resource mutexes. `lib/lane-plugins.mjs` loads L2's and L3's modules when they exist. The stall check reads the newest write over the lane's whole `subagents/` tree.

**Tech Stack:** Node ≥ 20 (ESM `.mjs`, `node:test`, zero npm dependencies), git, Claude Code background sessions (2.1.29x), GSD 1.16.

**Spec:** `docs/specs/2026-10-13-stage-4-design.md` — L1's scope: §5 (scheduler and supervisor: `supervisor.json.lanes`, readiness, critical-path order, one lane without annotation, `turbo-run lock/unlock`, the merge lock order, `lanes.mode: "checkout"` = v0.3), §8 (owner: `attend N` stops only lane N and prints `cd <slot> && claude`, `stop` stops every lane, prep and annotate, `status` per lane with the summary line), §9 (failures), the §10 keys `max_prep`, `lanes.gates`, `merge_rounds`, the L1 tests of §13 (unit, and the supervisor e2e with a fake `claude`). §11: L1 consumes L0's interfaces and fixes the job interface L3 plugs into.

**Base:** branch `stage-4` with the L0 plan (`docs/plans/2026-10-13-stage-4-l0-slots.md`) executed and merged (this plan was written at `d5a6ba8`, before L0's code existed). Existing code is referenced by function name and anchor text, never by line number. If an anchor moved, apply the same change next to the named code.

What this plan consumes, by exact name (it re-implements none of it):
- L0 (its section "Interfaces for L1–L4"): `lib/slots.mjs` `listSlots`, `prepareSlot`, `releaseSlot`, `slotForPhase`, `setupSlots`, `slotsDir`, `maxLanes`, `SlotRefused`; `lib/trust.mjs` `trustState`, `trustLine`; `lib/paths.mjs` `stateRoot`, `dirKey`; `lib/claude.mjs` `buildBgArgs({ …, controlRoot })` (through `createClaude().launchBg(opts, cwd)`); `lib/config.mjs` `lanesSettings`, `DEFAULTS.lanes`; the slot record `Job` (`kind`, `phase`, `branch`, `state`); the documented `supervisor.json.lanes` shape and its invariant.
- `lib/supervisor.mjs`: `startLane`, `finishLane`, `step`, `tick`, `failedTick`, `checkStall`, `wakeSession`, `wakeForAnswers`, `relaunchAfterFailedWake`, `relaunchCounted`, `holdDowngradedLane`, `currentAsk`, `replied`, `laneAgents`, `removeSession`, `logSkipped`, `resumableLane`, `runDaemon`, the constants `MAX_LAUNCH_FAILURES`, `UNTRUSTED_RE`, `laneMode`, `relaunchMode`, `isFresh`.
- `lib/scheduler.mjs`: `comparePhase`, `isFinished`, `inRange`, `rangeLabel`, `rangeBlocker`, `relaunchDecision`. `lib/run-status.mjs`: `LANE_STATUSES`, `readLaneStatus`, `writeLaneStatus`, `inferStatus`, `isAgentAlive`, `turnEnded`, `unknownAgentState`.
- `lib/wake.mjs`: `createLaneProbe`, `activityOf`, `answerWakePrompt`, `stallWakePrompt`; `lib/transcripts.mjs`: `laneTranscript`, `laneAgents`, `projectDirs`, `findTranscript`.
- `lib/attend.mjs`: `attendedPhases`, `writeAttend`, `attendFile`, `attendGates`, `openPlans`, `releaseStops`. `lib/questions.mjs`: `deliveryState`, `askNamed`, `dropLaneQuestions`, `readQuestions`, `refreshQuestions`. `lib/lane-tmp.mjs`: `prepareLaneTmp`, `removeLaneTmp`. `lib/lane-prompt.mjs`: `laneSystemPrompt`, `laneUserPrompt`. `lib/messages.mjs`: `msg`, `M`, `W`, `PREPARE`.
- `bin/turbo-run.mjs`: `makeCtx`, `daemon`, `start`, `printStatus`, `stopLanes`, `projectLaneAgents`, `resumePhase`, `attend`, `runtimeConfig`, `fingerprint`, `VALUE_FLAGS`, `USAGE`, `main`'s `switch (cmd)`.
- Tests: `test/helpers/tmp.mjs` (`tmpDir`), `test/helpers/transcripts.mjs` (`entry`, `projectDirFor`, `writeSession`, `writeAgent`, `writeJob`, `setMtime`, `AGENT`, `AGENT2`), `test/cli.test.mjs` (`fakeProject`, `runAsync`, `run`, `writeSup`, `readSup`, `runDirOf`, `sleeper`).

## Decisions this plan makes where the spec is open

- **D1 Two state shapes.** `lanes.mode: "checkout"` keeps v0.3's `supervisor.json` byte for byte: `lane` (one entry), v0.3's `step`, v0.3's halts (`s.halted` on any lane failure). Slots mode writes `lanes` (keyed map) and `lanesMode: "slots"`, never `lane`. Every reader outside the supervisor goes through `supervisorLanes(sup, root)` (`lib/lanes-state.mjs`), which shows a checkout lane in the slots shape (`slot: 0`, `slotPath: <root>`, `branch: null`). So v0.3's ~170 test references to `s.lane` stay valid, and "checkout = v0.3" is proved by the unchanged v0.3 suites.
- **D2 Slots need full mode.** Slots mode runs only when `lanes.mode` is `"slots"` **and** doctor reports full mode: a safe-mode lane (gsd-autonomous) never writes `ready` and runs GSD's transition, so it cannot be merged by L2. Under safe mode the daemon runs checkout mode and logs once `lanes.mode slots needs full mode (doctor: safe); one lane runs in this checkout`.
- **D3 Lane keys and records.** `key` = `<N>` (phase), `prep-<N>`, `annotate` (L0's documented keys). A lane's run record is `readLaneStatus(root, recordKey(lane))`: `<N>` for a phase and for its prep (both never run at once: L1 never schedules two lanes of one phase), `annotate` for annotate. L1 owns the statuses: `LANE_STATUSES` gains `ready` (L2 writes it with `--base`), `prepped` and `annotated` (L3 writes them). A lane ends when its fresh record has a done status of its job (`DONE_STATUSES`: phase `ready`, `done`; prep `prepped`; annotate `annotated`) **and** its session's turn has ended.
- **D4 Critical path first.** The spec's order "comparePhase, then the chain length" would never reach the chain length (`comparePhase` is total), so the scheduler sorts by the length of the chain of unfinished phases that wait on a phase (longest first), then by `comparePhase`. Checkout mode keeps `nextPhase` (v0.3's order).
- **D5 Annotation.** `readLanesFile(root)` (L3) returns `null` or `{ fresh, phases }`. `null` or `fresh: false` → at most one phase lane (spec §5). A phase missing from `phases`, or with `confidence: "low"`, has areas `**` (it overlaps every phase); its `gates` still count. L3 encodes §6.4's partial staleness by leaving the changed phases out of `phases` with `fresh: true`.
- **D6 A lane stops alone.** In slots mode a phase lane that fails, makes no progress after `max_restarts_without_progress`, cannot launch `MAX_LAUNCH_FAILURES` times, leaves the roadmap, or meets `Workspace not trusted` gets `halted: { why, at }` and one `laneStopped` notification; its slot keeps the work (the job stays active), its phase, areas and gates stay taken, its dependents wait; the other lanes go on. `turbo-run resume N` clears the halt and relaunches it in the same slot; a new `start` does too. The daemon halts when every lane is halted and nothing could start in that tick. A prep/annotate job that fails the same ways is not halted: its slot is released with `failed` (`deps.slots.release`), it is recorded in `jobsFailed` and not proposed again until the next `start`.
- **D7 Per-lane errors.** A throw inside one lane's step (a launch, an `rm`, L2's merge) restores only that lane's entry (plus `laneKeep`) and counts against that lane (`launchFailures`, `failingSince`); the other lanes keep this tick's changes. Global errors (GSD's phase list, `claude agents`) still go through v0.3's `failedTick`.
- **D8 New lanes launch through their own step.** The scheduler prepares a slot and writes an entry with `sessionId: null, launch: 'new'`; the entry's own step launches it, so a failed launch is counted on the lane and retried in the same slot, never a second slot for the same job. A supervisor that died between `prepareSlot` and its state write finds the slot's active job at the next start and adds an entry with `launch: 'resume'` (an alive session of that lane in that slot is adopted by `startLane`).
- **D9 Phases before jobs.** Jobs (prep, annotate) get only the slots left after the ready phases; when a ready phase waits for a slot, no job starts in that tick. At most `max_prep` jobs run at once (default `max_lanes`); every lane together stays ≤ `max_lanes`.
- **D10 Slots the supervisor uses.** A free slot that Claude Code does not trust is never used: the owner gets one `slotUntrusted` per slot with L0's `trustLine`. A slot whose `prepareSlot` throws is skipped for `blocked_minutes_before_notify` minutes (one `slotRefused` per slot and reason) while the other slots are used.
- **D11 Attend in slots mode.** `turbo-run attend N` writes the mark, stops only lane N's sessions (`claude stop`, the conversation is kept), releases its stops and prints `open: cd "<slot>" && claude`; the daemon keeps running and, while the mark stands, never starts, relaunches or wakes lane N and stops any session of lane N that still appears (a launch or wake that registered late). Other lanes and the scheduler go on (the attended phase stays excluded). `attend N --done` stays `resume N --start`. Checkout mode keeps v0.3's attend (stops the daemon, holds every lane).
- **D12 Owner commands from a slot.** `start`, `daemon`, `status`, `view`, `stop`, `resume` and `attend` run on `stateRoot(root)`: typed in a slot (the owner's attend sitting), they act on the control root.
- **D13 Gate locks.** `turbo-run lock <gate> <N> [--wait-seconds <s>]` takes `locks/gates/<gate>.json` (`{ gate, phase, at }`, created with `wx`) for phase N, waiting (default 540 s, polled every 2 s) while the file names another phase or another running phase declares the gate in `supervisor.json.lanes`; exit 0 taken (or already N's), 3 timed out (the owner is notified: `gateWait`), 2 usage or unknown gate, 1 other errors. `turbo-run unlock <gate> <N>` removes N's lock (exit 0; `not locked` is 0 too; another phase's lock: exit 1, nothing changed). Gate names: `GATE_NAMES` plus `lanes.gates`. The supervisor releases a lane's locks when the lane ends (merged or a failed job); a halted lane keeps them (its work is pending), and a lock nobody holds a lane for (the owner's own, or a crash's) stays until `unlock` — never swept, so an owner's manual lock is never taken away. Held locks block phases that declare the gate. Lanes in slots get one rule (`LOCK_RULE`) in their system prompt.
- **D14 Plugins.** L2's `lib/merge.mjs` and L3's `lib/prep.mjs` / `lib/lanes-file.mjs` are loaded by `loadLanePlugins()` with a dynamic import that turns only "this file does not exist" into `null`. Without L2 a `ready` lane waits (logged once); without L3 there are no jobs and no annotation (one phase lane at a time). So L1 merges into `stage-4` in any order with L2–L4.
- **D15 Stall over the whole tree.** A lane's last write is the newest mtime over its session transcript and every file under `<project dir>/<session id>/subagents/` (recursive, links not followed), together with v0.3's per-agent times. Before this, nested (level-2) subagents' writes were ignored and a busy lane was woken twice (journal defect).
- **D16 Status.** `status` in slots mode prints `lanes: <n> · questions: <n> · next: <next line>` (Russian with `lang: "ru"`), then per lane `lane <key>: <what> · slot <k> <path> · session <id> · restarts <r> · since <at>` and one line: `attended …: cd "<slot>" && claude`, `stopped (<why>): turbo-run resume <N>`, `relaunch pending (resume)` or `watch: claude attach <id>`. The next line comes from `supervisor.json.next`, which the daemon writes every tick.

## Global Constraints

- Node ≥ 20, ESM `.mjs` only, **zero runtime npm dependencies**; tests use `node:test` and `node:assert/strict`.
- Windows and Linux (CI: Linux / Node 22; dev: Windows / Node 24): paths with `path.join` / `path.resolve`; child processes only through `execFileSync`, `spawnSync` or `spawn` with an argument array, `windowsHide: true` and a timeout, never a shell.
- Public repository: no personal names, private project names, hosts, user paths or emails in code, tests, fixtures or commits; synthetic paths look like `C:\Users\dev\…` or `/home/dev/…`.
- Spec values, verbatim:
  - `supervisor.json`: `lanes: { "<phase>": { slot, sessionId, job: "phase"|"prep"|"annotate", … } }` instead of one `lane`; everything done for `s.lane` (launch, relaunch after context, the stall wake, answer delivery, `attend`, the restart limit) is done per entry;
  - ready to launch: all `Depends on` finished (`isFinished`) and inside the run's range; its `Areas` do not overlap the `Areas` of running phases (a phase without annotation = `**`, overlaps all); none of its `Gates` is taken by a running phase; a free trusted slot exists; running lanes < `max_lanes`;
  - order: critical path first (D4); without `lanes.json` or with a stale one — at most one phase lane while the annotation runs;
  - a phase's `Gates` are taken for the whole phase; `turbo-run lock <gate> <N>` / `unlock` — file mutexes in `locks/` for one-off actions (deploy, packaging), waiting with a timeout and a notification;
  - one merge file lock (`locks/merge`): a lane's merge, the owner's answer commit, the merge of prep and annotation take it in turn;
  - `lanes.mode: "checkout"` — one lane in the main checkout, no slots, no integration: exactly v0.3;
  - §6.3: two masks overlap when one static prefix (up to the first `*`/`?`/`[`/`{`) is a prefix of the other by path segments;
  - §8: `attend N` stops only lane N; the others go on; the command prints `cd <slot> && claude`; `attend N --done` gives the phase back; `main` is not touched; `stop` — every lane, prep and annotate; slots and branches stay; `status` lists the lanes: phase, slot, step, questions; summary line `3 полосы · 1 вопрос · следующая: фаза 36 ждёт фазу 34`;
  - §9: a lane that fails or runs out of restarts → only it is `failed`/`needs-owner`; the others go on; phases that depend on it wait; a supervisor restart reads `lanes`, finds the sessions by slot and goes on; a dirty slot without a job is not used; a lost trust → the lane waits, the owner gets the §4.1 line;
  - §10: `max_prep` default `max_lanes`; `lanes.gates` default `[]`; `merge_rounds` default `3`; the gate dictionary `prod-deploy`, `owner-live`, `owner-signature`, `packaged-build`.
- Lane prompts (`--append-system-prompt` and the user prompt) contain no `"` and no `%` and never start with `-`.
- The supervisor decides deterministically; no LLM in its loop. It calls `mergeReady` and `finishJob` one at a time, never two at once; they take the merge lock themselves (L0's `withMergeLock`).
- Tests never touch the network, a real `claude`, the developer's `~/.claude.json` or Claude home: every test sets `CLAUDE_CONFIG_DIR` to a temp directory, slots are faked in memory (`test/helpers/lanes.mjs`) or are plain temp directories, `claude` is an in-process fake or the fake binary of `test/cli.test.mjs`.
- State files are written with `writeJsonAtomic` (`lib/fsx.mjs`).
- TDD. While implementing a task, run only the test files that task names (`node --test <files>`), never the full suite (`npm test`): the controller runs it once at merge. One commit per task, conventional style, the repository's configured identity. Never push, merge, tag or install; never `--no-verify`.

## Review Focus

1. **The supervisor dies between preparing a slot and writing `supervisor.json`** (killed, power loss), or the owner stops it while a lane runs. Expected: the next start finds the slot's active job, adopts the alive session or resumes the lane in that same slot; no second slot is ever prepared for the same phase; a lane whose slot no longer holds its job is dropped with a log line. Pinned in Task 10 (`a restart keeps the recorded lanes, adopts their sessions, and resumes an orphan slot job…`).
2. **One lane keeps failing to launch (or its slot loses trust) while two others run.** Expected: only that lane counts failures and stops (`laneStopped`), the others keep what this tick did (a new session id, a relaunch), the run goes on; the whole tick is never rolled back. Pinned in Task 8 (`an error in one lane rolls back only that lane…`).
3. **The owner attends phase N while the daemon is in the middle of a wake or relaunch of lane N** (the session registers after attend stopped the listed ones). Expected: the next tick stops that session; lane N is never relaunched or woken while the mark stands; other lanes go on. Pinned in Task 8 (`an attended lane is held alone…`).
4. **`lanes.json` missing, stale, or with `confidence: "low"`, or masks written as `src\api\*.ts`, `./SRC/Api/`, `!src/x`.** Expected: never two phase lanes without a fresh annotation; a low-confidence phase overlaps everything; Windows separators, `./`, case and negation never produce a false "no overlap". Pinned in Task 2 (`areasOverlap: …`, `pickPhases: one phase lane without a fresh annotation…`).
5. **A lane whose session is busy only in nested (level-2) subagents** for longer than `stall_minutes`. Expected: it is never stall-woken while any file under its `subagents/` tree keeps changing. Pinned in Task 3 (`the probe's last write covers nested subagents…`).

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/config.mjs` | modify | `DEFAULTS.max_prep`, `DEFAULTS.merge_rounds`, `DEFAULTS.lanes.gates`; `GATE_NAMES`, `GATE_RE`, `laneGates`, `mergeRounds`, `maxPrep` |
| `lib/scheduler.mjs` | modify | `ANY_AREA`, `maskPrefix`, `areasOverlap`, `annotationOf`, `criticalPath`, `pickPhases` |
| `lib/transcripts.mjs` | modify | `sessionTreeMtimeMs` |
| `lib/wake.mjs` | modify | `createLaneProbe` methods take the lane's directory; `activity` covers the whole `subagents/` tree |
| `lib/run-status.mjs` | modify | `LANE_STATUSES` gains `ready`, `prepped`, `annotated` |
| `lib/lanes-state.mjs` | create | `JOBS`, `DONE_STATUSES`, `laneKey`, `recordKey`, `laneCwd`, `compareLanes`, `laneLabel`, `supervisorLanes`, `laneForPhase`, `laneAt`, `nextLine`, `lanesSummary`, `setupLines` |
| `lib/context.mjs`, `lib/agent-tail.mjs`, `lib/phase-progress.mjs` | modify | read lanes through `supervisorLanes` |
| `lib/cli-phase.mjs` | modify | comment on `laneRuns` (slots lanes never commit in this checkout) |
| `lib/gate-locks.mjs` | create | `gateFile`, `readGate`, `heldGates`, `gateDeclaredBy`, `acquireGate`, `releaseGate`, `releaseGatesOf` |
| `lib/lane-prompt.mjs` | modify | `LOCK_RULE`; `laneSystemPrompt({ …, slots })` |
| `lib/lane-plugins.mjs` | create | `PLUGIN_FILES`, `loadLanePlugins` |
| `lib/messages.mjs` | modify | `gateWait`, `laneStopped`, `slotUntrusted`, `slotRefused` (en, ru) |
| `lib/supervisor.mjs` | modify | `placeOf`, `wakePrompt`, generalized helpers; `stepSlots`, `laneStep`, `schedule`, `settle`, `mergeStep`, `finishJobStep`, `haltLane`, `failJob`, `dropLane`; `resumableLanes` |
| `bin/turbo-run.mjs` | modify | `makeCtx` (async, slots deps, plugins), `daemon`, `start` (slots setup), `status`, `stop`, `resume`, `attend` per lane, `lock`/`unlock`, owner commands on `stateRoot` |
| `docs/reference.md` | modify | `## Several lanes`; Config rows `max_prep`, `merge_rounds`, `lanes.gates`; `max_lanes` row |
| `skills/turbo-autonomous/SKILL.md` | modify | attend in a slot |
| `test/helpers/lanes.mjs` | create | `P`, `lanesHarness`, `freshLanes`, `annotated`, `readyRecord` |
| `test/lanes-state.test.mjs`, `test/gate-locks.test.mjs`, `test/lane-plugins.test.mjs`, `test/supervisor-lanes.test.mjs`, `test/supervisor-jobs.test.mjs`, `test/e2e-lanes.test.mjs` | create | tests |
| `test/config.test.mjs`, `test/scheduler.test.mjs`, `test/wake.test.mjs`, `test/context.test.mjs`, `test/agent-tail.test.mjs`, `test/phase-progress.test.mjs`, `test/cli-questions.test.mjs`, `test/lane-prompt.test.mjs`, `test/notify.test.mjs`, `test/supervisor.test.mjs`, `test/cli.test.mjs` | modify | imports, appended tests; `fakeProject` defaults to checkout mode |

## Contracts

- **Lane entry** (`supervisor.json.lanes[key]`, slots mode). L0's documented fields: `{ key, job, phase, slot, slotPath, branch, sessionId, launchedAt, restarts, notified, mode }`. L1's own fields: `launch: 'new'|'resume'` (only while `sessionId` is null), `fingerprint`, `blockedSince`, `forceRelaunch`, `stall`, `woken`, `halted: { why: 'failed'|'noProgress'|'launch'|'missing'|'untrusted', at, error?, id?, restarts? }`, `launchFailures`, `failingSince`, `failingNotified`, `mergeWait`, `jobWait`, `areas: string[]` and `gates: string[]` (phase lanes; refreshed every tick from the annotation). L2's own field: `merge` (opaque to L1, persisted).
- **Top level** (slots mode): `{ lanesMode: 'slots', lanes, finished, halted, poll_seconds, range?, next, jobsFailed?, slotNotes?, slotRefused?, noPhases?, noReady?, skippedClosed?, pid, updatedAt }`; `next = null | { phase, why: 'deps'|'areas'|'gates'|'slots'|'annotation', waitsFor: string[], gate? }`.
- **`ctx` additions** (slots mode only; absent = checkout): `ctx.lanes = 'slots'`; `ctx.deps.slots = { list(), free({ skip }), untrusted(), prepare(slot, job), release(k, outcome), forJob(phase, kind) }`; `ctx.deps.mergeReady`, `ctx.deps.pendingJobs`, `ctx.deps.jobPrompts`, `ctx.deps.finishJob` (each a function or null); `ctx.deps.lanesFile() → LanesFile | null`; `ctx.deps.fingerprint(phase, cwd)`; `ctx.deps.lanes.{session,activity,replied}(…, cwd)`.
- **Gate lock file** `<control>/.planning/turbo/locks/gates/<gate>.json`: `{ "gate": "prod-deploy", "phase": "34", "at": "<ISO>" }`.
- **CLI** `turbo-run lock <gate> <N> [--wait-seconds <s>]`: `locked <gate> for phase <N>` / `<gate> is already held by phase <N>`; on stderr `gate <gate> is held by phase <M> since <at> (<lock|declared by its lane>); waited <s> s`. `turbo-run unlock <gate> <N>`: `unlocked <gate>` / `<gate> is not locked`; on stderr `gate <gate> is held by phase <M>, not <N>; nothing changed`.

---
### Task 1: Config keys `max_prep`, `merge_rounds`, `lanes.gates`

**Files:**
- Modify: `lib/config.mjs` (`DEFAULTS`; new exports after `lanesSettings`)
- Test: `test/config.test.mjs` (import line, L0's `lanes` test, then append)

**Interfaces:**
- Consumes: `DEFAULTS`, `loadConfig`, `lanesSettings` (L0).
- Produces: `DEFAULTS.max_prep = null`, `DEFAULTS.merge_rounds = 3`, `DEFAULTS.lanes.gates = []`; `GATE_NAMES = ['prod-deploy', 'owner-live', 'owner-signature', 'packaged-build']`; `GATE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/`; `laneGates(config) → string[]` (dictionary, then the project's, each once); `mergeRounds(config) → number` (1–20); `maxPrep(config, lanes) → number` (null → `lanes`; else 0..`lanes`). Each throws `invalid turbo config <key>: <why>`.

- [ ] **Step 1: Write the failing test**

In `test/config.test.mjs`, replace the import line from `../lib/config.mjs` (after L0 it reads `import { DEFAULTS, LANE_MODES, loadConfig, initConfig, deepMerge, fullEntries, lanesSettings, pushSettings } from '../lib/config.mjs';`) with:

```js
import { DEFAULTS, GATE_NAMES, LANE_MODES, loadConfig, initConfig, deepMerge, fullEntries, laneGates, lanesSettings, maxPrep, mergeRounds, pushSettings } from '../lib/config.mjs';
```

In L0's test `lanes (Stage 4 L0): defaults, a valid hand-edited value, and every invalid one stops with the key named`, `DEFAULTS.lanes` now also holds L1's `gates` (which `lanesSettings` leaves to L1). Replace its first three lines:

```js
  assert.deepEqual(DEFAULTS.lanes, { mode: 'slots', dir: '', copy: ['.env', '*/.env', '.env.local', '*/.env.local'], install: '', trust_write: true });
  assert.deepEqual(LANE_MODES, ['slots', 'checkout']);
  assert.deepEqual(lanesSettings(), DEFAULTS.lanes);
```

with:

```js
  assert.deepEqual(DEFAULTS.lanes, { mode: 'slots', dir: '', copy: ['.env', '*/.env', '.env.local', '*/.env.local'], install: '', trust_write: true, gates: [] });
  assert.deepEqual(LANE_MODES, ['slots', 'checkout']);
  const { gates: _l1Gates, ...l0 } = DEFAULTS.lanes; // lanes.gates is L1's (laneGates)
  assert.deepEqual(lanesSettings(), l0);
```

and its last line `assert.deepEqual(lanesSettings(loadConfig(root).lanes), { ...DEFAULTS.lanes, mode: 'checkout' });` with:

```js
  assert.deepEqual(lanesSettings(loadConfig(root).lanes), { ...l0, mode: 'checkout' });
```

Append:

```js
test('Stage 4 L1 keys: max_prep, merge_rounds and lanes.gates, their defaults and every invalid value', () => {
  assert.equal(DEFAULTS.max_prep, null);
  assert.equal(DEFAULTS.merge_rounds, 3);
  assert.deepEqual(DEFAULTS.lanes.gates, []);
  assert.deepEqual(GATE_NAMES, ['prod-deploy', 'owner-live', 'owner-signature', 'packaged-build']);
  assert.deepEqual(laneGates(DEFAULTS), GATE_NAMES);
  assert.deepEqual(laneGates({ lanes: { gates: [' db-migrate ', 'prod-deploy'] } }), [...GATE_NAMES, 'db-migrate']);
  for (const gates of ['x', [''], ['Prod'], ['a b'], ['-x'], [3], ['x'.repeat(41)]]) {
    assert.throws(() => laneGates({ lanes: { gates } }), /^Error: invalid turbo config lanes\.gates: must be a list of names/, JSON.stringify(gates));
  }
  assert.equal(mergeRounds(DEFAULTS), 3);
  assert.equal(mergeRounds({ merge_rounds: ' 5 ' }), 5);
  for (const v of [0, 21, 2.5, '-1', 'x', false]) assert.throws(() => mergeRounds({ merge_rounds: v }), /merge_rounds: must be a whole number from 1 to 20/, String(v));
  assert.equal(maxPrep(DEFAULTS, 3), 3);
  assert.equal(maxPrep({ max_prep: 0 }, 3), 0);
  assert.equal(maxPrep({ max_prep: 2 }, 3), 2);
  for (const v of [-1, 4, 1.5, '2']) assert.throws(() => maxPrep({ max_prep: v }, 3), /max_prep: must be null or a whole number from 0 to max_lanes \(3\)/, String(v));
  // a hand-edited file reaches them through loadConfig; the rest keeps its default
  const root = tmpDir('l1keys');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify({ max_prep: 1, lanes: { gates: ['db-migrate'] } }));
  const c = loadConfig(root);
  assert.deepEqual([maxPrep(c, 3), mergeRounds(c), laneGates(c).at(-1), c.lanes.mode], [1, 3, 'db-migrate', 'slots']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `The requested module '../lib/config.mjs' does not provide an export named 'GATE_NAMES'`.

- [ ] **Step 3: Implement**

`lib/config.mjs` — in `DEFAULTS`, right after the line `  max_lanes: 3,`, add:

```js
  // spec §6.1, §10 (Stage 4 L1): prep and annotate jobs at once; null: max_lanes
  max_prep: null,
  // spec §7.2, §10: integrations a phase repeats while main keeps moving before the owner decides (L2 counts them)
  merge_rounds: 3,
```

In the `lanes:` line L0 added to `DEFAULTS`, add `gates: []` as the last key, so it reads:

```js
  lanes: { mode: 'slots', dir: '', copy: ['.env', '*/.env', '.env.local', '*/.env.local'], install: '', trust_write: true, gates: [] },
```

Right after the closing brace of `export function lanesSettings`, add:

```js
// spec §6.2, §10 (Stage 4 L1): the shared resources a phase may hold for its whole run (its ROADMAP Gates line) or for
// one action (turbo-run lock): this dictionary and the project's own lanes.gates.
export const GATE_NAMES = Object.freeze(['prod-deploy', 'owner-live', 'owner-signature', 'packaged-build']);
export const GATE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// The dictionary, then the project's own gates, each once. A bad name stops with the key named: it becomes a file name
// in locks/gates/.
export function laneGates(config) {
  const own = config?.lanes?.gates ?? [];
  if (!Array.isArray(own) || own.some((g) => typeof g !== 'string' || !GATE_RE.test(g.trim()))) {
    throw new Error('invalid turbo config lanes.gates: must be a list of names (lower-case letters, digits and -, at most 40, not starting with -)');
  }
  return [...new Set([...GATE_NAMES, ...own.map((g) => g.trim())])];
}

// merge_rounds: a whole number from 1 to 20; a digit string too (the file is edited by hand).
export function mergeRounds(config) {
  const v = config?.merge_rounds ?? DEFAULTS.merge_rounds;
  const n = typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('invalid turbo config merge_rounds: must be a whole number from 1 to 20');
  return n;
}

// max_prep: null (the default) is max_lanes (lanes); else a whole number from 0 (no prep) to max_lanes.
export function maxPrep(config, lanes) {
  const v = config?.max_prep ?? null;
  if (v === null) return lanes;
  if (!Number.isInteger(v) || v < 0 || v > lanes) throw new Error(`invalid turbo config max_prep: must be null or a whole number from 0 to max_lanes (${lanes})`);
  return v;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/config.test.mjs`
Expected: PASS (the new test, L0's edited test, the others unchanged).

- [ ] **Step 5: Commit**

```bash
git add lib/config.mjs test/config.test.mjs
git commit -q -m "feat(lanes): max_prep, merge_rounds and lanes.gates config keys"
```

---

### Task 2: Scheduler — `areasOverlap`, annotation, critical path, `pickPhases`

**Files:**
- Modify: `lib/scheduler.mjs` (append)
- Test: `test/scheduler.test.mjs` (import line, then append)

**Interfaces:**
- Consumes: `comparePhase`, `isFinished`, `inRange` (same file).
- Produces:
  - `ANY_AREA = ['**']`.
  - `maskPrefix(mask) → { segs: string[], partial: string | null }` — the static part of a mask (lower case, `/` separators, no leading `./` or `/`): whole segments, then `partial` = the start of the next segment before a wildcard (`''` when the wildcard starts it; `null` for a mask without wildcards, which names one exact path). Empty, negated (`!…`) → `{ segs: [], partial: '' }` (everything). A trailing `/` → the directory and everything in it.
  - `areasOverlap(a: string[], b: string[]) → boolean` — spec §6.3, conservative; a non-array is `**`; `[]` overlaps nothing.
  - `annotationOf(lanesFile, number) → { areas: string[], gates: string[] }` — `lanesFile = null | { fresh, phases: { [N]: { areas, gates, confidence } } }`; a missing phase, `confidence: 'low'` or bad `areas` → `['**']`; gates as named.
  - `criticalPath(phases) → Map<string, number>` — per unfinished phase, 1 + the longest chain of unfinished phases that wait on it.
  - `pickPhases(phases, { range, running, exclude, annotation, heldGates, slots, oneLane }) → { picked: Phase[], next: Next | null }`; `running: [{ phase, areas, gates }]`, `exclude: string[]`, `annotation: (number) → { areas, gates }`, `heldGates: [{ gate, phase }]`, `slots: number`, `oneLane: boolean`; `Next = { phase, why: 'deps'|'areas'|'gates'|'slots'|'annotation', waitsFor: string[], gate? }`.

- [ ] **Step 1: Write the failing test**

In `test/scheduler.test.mjs`, replace the import line from `../lib/scheduler.mjs` with:

```js
import { comparePhase, nextPhase, relaunchDecision, isFinished, inRange, rangeBlocker, rangeLabel, ANY_AREA, annotationOf, areasOverlap, criticalPath, maskPrefix, pickPhases } from '../lib/scheduler.mjs';
```

Append:

```js
test('maskPrefix: the static part of a mask by path segments, lower case, Windows separators and ./ removed', () => {
  assert.deepEqual(maskPrefix('src/api/*.ts'), { segs: ['src', 'api'], partial: '' });
  assert.deepEqual(maskPrefix('src/ap*'), { segs: ['src'], partial: 'ap' });
  assert.deepEqual(maskPrefix('README.md'), { segs: ['readme.md'], partial: null });
  assert.deepEqual(maskPrefix('docs/'), { segs: ['docs'], partial: '' });
  assert.deepEqual(maskPrefix('**'), { segs: [], partial: '' });
  assert.deepEqual(maskPrefix(' ./a//b/c?.js '), { segs: ['a', 'b'], partial: 'c' });
  assert.deepEqual(maskPrefix('src\\Api\\[ab].ts'), { segs: ['src', 'api'], partial: '' });
  assert.deepEqual(maskPrefix('!src/x'), { segs: [], partial: '' });
  assert.deepEqual(maskPrefix(''), { segs: [], partial: '' });
  assert.deepEqual(ANY_AREA, ['**']);
});

test('areasOverlap (spec §6.3): one static prefix is a prefix of the other by segments; false overlaps only cost parallelism (Review Focus 4)', () => {
  const yes = [
    [['src/**'], ['src/api/x.ts']],
    [['src/api/'], ['src/api']],
    [['src/a*'], ['src/ab/c.ts']],
    [['src/a*'], ['src/ab*']],
    [['src'], ['src/x/y.ts']],
    [['**'], ['docs/a.md']],
    [['src\\api\\*.ts'], ['./SRC/Api/user.ts']],
    [['!src/x'], ['lib/y']],
    [['src/*.ts'], ['src/deep/a.js']],
    [['lib/{a,b}.js'], ['lib/c.js']],
    [['a.md', 'src/**'], ['src/z']],
    [['README.md'], ['readme.md']],
  ];
  const no = [
    [['src/a*'], ['src/b/c.ts']],
    [['src/api/**'], ['src/apix/**']],
    [['src/a.ts'], ['src/b.ts']],
    [['docs/**'], ['src/**']],
    [[], ['**']],
  ];
  for (const [a, b] of yes) {
    assert.equal(areasOverlap(a, b), true, `${a} / ${b}`);
    assert.equal(areasOverlap(b, a), true, `${b} / ${a}`);
  }
  for (const [a, b] of no) {
    assert.equal(areasOverlap(a, b), false, `${a} / ${b}`);
    assert.equal(areasOverlap(b, a), false, `${b} / ${a}`);
  }
  assert.equal(areasOverlap(undefined, ['x']), true, 'no list is everything');
});

test('annotationOf: lanes.json areas and gates; a missing phase, low confidence or no file is ** with its gates', () => {
  const file = { fresh: true, phases: { 3: { areas: ['src/a/**'], gates: ['prod-deploy'], confidence: 'high' }, 4: { areas: ['src/b/**'], gates: ['owner-live'], confidence: 'low' } } };
  assert.deepEqual(annotationOf(file, '3'), { areas: ['src/a/**'], gates: ['prod-deploy'] });
  assert.deepEqual(annotationOf(file, '4'), { areas: ['**'], gates: ['owner-live'] });
  assert.deepEqual(annotationOf(file, '5'), { areas: ['**'], gates: [] });
  assert.deepEqual(annotationOf(null, '3'), { areas: ['**'], gates: [] });
  assert.deepEqual(annotationOf({ fresh: true, phases: { 3: { areas: 'src', gates: null } } }, '3'), { areas: ['**'], gates: [] });
});

test('criticalPath: the longest chain of unfinished phases waiting on each phase; finished phases do not count; a cycle ends', () => {
  const P2 = (number, deps = [], complete = false) => ({ number, deps, complete });
  const cp = criticalPath([P2('1'), P2('2', ['1']), P2('3', ['2']), P2('4'), P2('5', ['4']), P2('6', [], true), P2('7', ['6'])]);
  assert.deepEqual(Object.fromEntries(cp), { 1: 3, 2: 2, 3: 1, 4: 2, 5: 1, 7: 1 });
  assert.equal(criticalPath([P2('8', ['9']), P2('9', ['8'])]).size, 2);
});

const A = (areas, gates = [], confidence = 'high') => ({ areas: Array.isArray(areas) ? areas : [areas], gates, confidence });

test('pickPhases: deps, areas, gates, held locks and slots; the critical path first (spec §5)', () => {
  const phases = [P('1'), P('2'), P('3', ['1']), P('4'), P('5', ['9'])]; // 9 is not in the milestone: satisfied
  const file = { fresh: true, phases: { 1: A('src/a/**'), 2: A('src/b/**', ['prod-deploy']), 3: A('src/c/**'), 4: A('src/a/x.ts'), 5: A('docs/**', ['prod-deploy']) } };
  const annotation = (n) => annotationOf(file, n);
  // 1 leads (3 waits on it), then 2; 4 overlaps 1 (src/a); 5 shares prod-deploy with 2
  let r = pickPhases(phases, { annotation, slots: 3 });
  assert.deepEqual(r.picked.map((p) => p.number), ['1', '2']);
  assert.deepEqual(r.next, { phase: '4', why: 'areas', waitsFor: ['1'] });
  r = pickPhases(phases, { annotation, slots: 3, running: [{ phase: '1', areas: ['src/a/**'], gates: [] }] });
  assert.deepEqual(r.picked.map((p) => p.number), ['2']);
  r = pickPhases(phases, { annotation, slots: 1 });
  assert.deepEqual(r.picked.map((p) => p.number), ['1']);
  assert.deepEqual(r.next, { phase: '2', why: 'slots', waitsFor: [] });
  r = pickPhases(phases, { annotation, slots: 3, heldGates: [{ gate: 'prod-deploy', phase: '7' }] });
  assert.deepEqual(r.picked.map((p) => p.number), ['1']);
  assert.deepEqual(r.next, { phase: '2', why: 'gates', waitsFor: ['7'], gate: 'prod-deploy' });
  r = pickPhases(phases, { annotation, slots: 3, exclude: ['2', '4'] });
  assert.deepEqual(r.picked.map((p) => p.number), ['1', '5']);
  assert.deepEqual(pickPhases([P('1'), P('2', ['1'])], { slots: 2, running: [{ phase: '1', areas: ['**'], gates: [] }] }), { picked: [], next: { phase: '2', why: 'deps', waitsFor: ['1'] } });
  assert.deepEqual(pickPhases([P('1', [], true)], { slots: 2 }), { picked: [], next: null });
  assert.deepEqual(pickPhases([P('1'), P('2')], { slots: 2, range: { from: '2', to: null }, annotation }).picked.map((p) => p.number), ['2']);
});

test('pickPhases: one phase lane without a fresh annotation; a phase missing from it overlaps every other (Review Focus 4)', () => {
  const phases = [P('1'), P('2'), P('3')];
  assert.deepEqual(pickPhases(phases, { slots: 3, oneLane: true }).picked.map((p) => p.number), ['1']);
  assert.deepEqual(pickPhases(phases, { slots: 3, oneLane: true, running: [{ phase: '1', areas: ['src/**'], gates: [] }] }), { picked: [], next: { phase: '2', why: 'annotation', waitsFor: ['1'] } });
  const file = { fresh: true, phases: { 1: A('a/**'), 2: A('b/**') } };
  const r = pickPhases(phases, { slots: 3, annotation: (n) => annotationOf(file, n) });
  assert.deepEqual(r.picked.map((p) => p.number), ['1', '2']);
  assert.deepEqual(r.next, { phase: '3', why: 'areas', waitsFor: ['1'] });
  // without an annotation function every phase is **
  assert.deepEqual(pickPhases(phases, { slots: 3 }).picked.map((p) => p.number), ['1']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/scheduler.test.mjs`
Expected: FAIL — `does not provide an export named 'ANY_AREA'`.

- [ ] **Step 3: Implement**

Append to `lib/scheduler.mjs`:

```js
// spec §6.2, §6.3 (Stage 4 L1): a phase without annotation may touch any path.
export const ANY_AREA = Object.freeze(['**']);

// Brace and extglob openers count too: everything after them is not static.
const GLOB_META = /[*?[{(]/;

// spec §6.3: the static part of a path mask, up to its first wildcard: whole segments, then the start of the next one
// (partial: '' when the wildcard starts the segment; null for a mask without wildcards, one exact path). Lower case:
// Windows and macOS do not tell File.ts from file.ts, and a false overlap only costs parallelism. An empty or negated
// mask (!x) is everything; a trailing / is the directory and everything in it.
export function maskPrefix(mask) {
  let m = String(mask ?? '').trim().replace(/\\/g, '/').toLowerCase();
  while (m.startsWith('./')) m = m.slice(2);
  m = m.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (!m || m.startsWith('!')) return { segs: [], partial: '' };
  const i = m.search(GLOB_META);
  if (i < 0) return m.endsWith('/') ? { segs: m.slice(0, -1).split('/'), partial: '' } : { segs: m.split('/'), partial: null };
  const parts = m.slice(0, i).split('/');
  const partial = parts.pop();
  return { segs: parts, partial };
}

// Two static parts overlap when the shorter is a prefix of the longer by segments: an exact path that ends first may
// be a directory of the other; a wildcard segment overlaps every segment that starts with its static start.
function prefixOverlap(a, b) {
  const n = Math.min(a.segs.length, b.segs.length);
  for (let i = 0; i < n; i++) if (a.segs[i] !== b.segs[i]) return false;
  if (a.segs.length === b.segs.length) {
    if (a.partial === null || b.partial === null) return true;
    return a.partial.startsWith(b.partial) || b.partial.startsWith(a.partial);
  }
  const [short, long] = a.segs.length < b.segs.length ? [a, b] : [b, a];
  return short.partial === null || long.segs[short.segs.length].startsWith(short.partial);
}

// spec §6.3: whether two phases' Areas may touch one path. Conservative: a non-array is everything, [] is nothing.
export function areasOverlap(a, b) {
  const list = (x) => (Array.isArray(x) ? x : ANY_AREA).map(maskPrefix);
  const pb = list(b);
  return list(a).some((x) => pb.some((y) => prefixOverlap(x, y)));
}

// spec §6.2–§6.4 (D5): one phase's areas and gates from lanes.json (L3's readLanesFile); a phase missing from it, with
// confidence low or without a list of masks is ** (it overlaps every phase). Its gates count whatever its confidence.
export function annotationOf(lanesFile, number) {
  const e = lanesFile?.phases?.[String(number)];
  const gates = Array.isArray(e?.gates) ? e.gates.filter((g) => typeof g === 'string' && g) : [];
  const ok = Boolean(e) && e.confidence !== 'low' && Array.isArray(e.areas) && e.areas.every((m) => typeof m === 'string');
  return { areas: ok ? [...e.areas] : [...ANY_AREA], gates };
}

// spec §5 (D4): per unfinished phase, 1 + the longest chain of unfinished phases that wait on it. A dependency cycle
// is cut where it closes.
export function criticalPath(phases) {
  const open = phases.filter((p) => !isFinished(p));
  const waiting = new Map(open.map((p) => [p.number, []]));
  for (const p of open) for (const d of p.deps) if (waiting.has(d)) waiting.get(d).push(p.number);
  const memo = new Map();
  const len = (n, stack) => {
    if (memo.has(n)) return memo.get(n);
    if (stack.has(n)) return 0;
    stack.add(n);
    const v = 1 + Math.max(0, ...waiting.get(n).map((m) => len(m, stack)));
    stack.delete(n);
    memo.set(n, v);
    return v;
  };
  return new Map(open.map((p) => [p.number, len(p.number, new Set())]));
}

const EVERYWHERE = () => ({ areas: [...ANY_AREA], gates: [] });

// spec §5: the phases to launch now, at most `slots`, in critical-path order: unfinished, in the range, not running or
// excluded, every dependency of the milestone finished, Areas disjoint from every running and picked phase, no Gates
// entry held by one of them or by a lock (heldGates), and with oneLane (no fresh annotation) only while no phase lane
// runs. next: the first ready phase left out and why, else the first one waiting on its dependencies, else null.
export function pickPhases(phases, { range = null, running = [], exclude = [], annotation = EVERYWHERE, heldGates = [], slots = 0, oneLane = false } = {}) {
  const byNum = new Map(phases.map((p) => [p.number, p]));
  const skip = new Set([...exclude.map(String), ...running.map((r) => String(r.phase))]);
  const open = phases.filter((p) => !isFinished(p) && inRange(p.number, range) && !skip.has(p.number));
  const depsOf = (p) => p.deps.filter((d) => byNum.has(d) && !isFinished(byNum.get(d)));
  const cp = criticalPath(phases);
  const order = (a, b) => (cp.get(b.number) ?? 1) - (cp.get(a.number) ?? 1) || comparePhase(a.number, b.number);
  const taken = running.map((r) => ({ phase: String(r.phase), areas: Array.isArray(r.areas) ? r.areas : ANY_AREA, gates: Array.isArray(r.gates) ? r.gates : [] }));
  const picked = [];
  let next = null;
  const miss = (p, why, waitsFor, gate) => { next ??= { phase: p.number, why, waitsFor, ...(gate ? { gate } : {}) }; };
  for (const p of open.filter((x) => !depsOf(x).length).sort(order)) {
    const a = annotation(p.number);
    if (oneLane && taken.length) { miss(p, 'annotation', taken.map((t) => t.phase)); continue; }
    const clash = taken.find((t) => areasOverlap(a.areas, t.areas));
    if (clash) { miss(p, 'areas', [clash.phase]); continue; }
    const holder = taken.find((t) => t.gates.some((g) => a.gates.includes(g)));
    if (holder) { miss(p, 'gates', [holder.phase], holder.gates.find((g) => a.gates.includes(g))); continue; }
    const lock = heldGates.find((h) => a.gates.includes(h.gate));
    if (lock) { miss(p, 'gates', lock.phase ? [String(lock.phase)] : [], lock.gate); continue; }
    if (picked.length >= slots) { miss(p, 'slots', []); continue; }
    picked.push(p);
    taken.push({ phase: p.number, areas: a.areas, gates: a.gates });
  }
  if (!next) {
    const waiting = open.filter((p) => depsOf(p).length).sort(order)[0];
    if (waiting) next = { phase: waiting.number, why: 'deps', waitsFor: depsOf(waiting).sort(comparePhase) };
  }
  return { picked, next };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/scheduler.test.mjs`
Expected: PASS (new and existing tests).

- [ ] **Step 5: Commit**

```bash
git add lib/scheduler.mjs test/scheduler.test.mjs
git commit -q -m "feat(lanes): Areas overlap, critical path and the readiness of several phases"
```

---

### Task 3: Stall check over the whole `subagents/` tree; the probe reads a lane in its slot

**Files:**
- Modify: `lib/transcripts.mjs` (new export after `laneTranscript`), `lib/wake.mjs` (`createLaneProbe`)
- Test: `test/wake.test.mjs` (import lines, then append)

**Interfaces:**
- Consumes: `laneTranscript`, `laneAgents`, `projectDirs`, `tailEntries` (`lib/transcripts.mjs`), `activityOf`.
- Produces: `sessionTreeMtimeMs(main: { file, sessionId }) → number | null` — the newest mtime of the transcript and of every `*.jsonl` file under `<dirname(file)>/<sessionId>/subagents/` (recursive, links not followed, at most 8 levels). `createLaneProbe(root, env)` methods take the lane's directory as their last, optional argument: `session(jobId, cwd = root)`, `activity(jobId, now, stallMs, cwd = root)`, `replied(jobId, sinceMs, cwd = root)`; `activity(...).lastMs` is the newer of v0.3's value and `sessionTreeMtimeMs`.

- [ ] **Step 1: Write the failing test**

In `test/wake.test.mjs`, replace `import { AGENT, entry, projectDirFor, setMtime, writeAgent, writeJob, writeSession } from './helpers/transcripts.mjs';` with:

```js
import { AGENT, AGENT2, DEFAULT_META, entry, projectDirFor, setMtime, writeAgent, writeJob, writeSession } from './helpers/transcripts.mjs';
import { sessionTreeMtimeMs } from '../lib/transcripts.mjs';
```

Append:

```js
test('the probe\'s last write covers nested subagents: any transcript under the session\'s subagents tree (journal: a busy lane was woken twice; Review Focus 5)', () => {
  const base = tmpDir('tree');
  const root = path.join(base, 'app');
  fs.mkdirSync(root);
  const home = path.join(base, 'home');
  const dir = projectDirFor(home, root);
  writeJob(home, JOB, { sessionId: SID, cwd: root });
  setMtime(writeSession(dir, SID, [entry.user('go', at('10:00'))]), new Date(at('10:00')));
  setMtime(writeAgent(dir, SID, AGENT, [entry.agentUser(AGENT, 'task', at('10:01'))]), new Date(at('10:01')));
  // a level-2 agent: the lane's agent list leaves it out (it reports to its parent)
  const nested = writeAgent(dir, SID, AGENT2, [entry.agentUser(AGENT2, 'sub', at('10:02'))], { ...DEFAULT_META, spawnDepth: 2, parentAgentId: AGENT });
  setMtime(nested, new Date(at('10:30')));
  // and one a level deeper; meta files and other files are no transcript writes
  const deeper = path.join(dir, SID, 'subagents', 'nested', 'agent-a1111111111111111.jsonl');
  fs.mkdirSync(path.dirname(deeper), { recursive: true });
  fs.writeFileSync(deeper, '{}\n');
  setMtime(deeper, new Date(at('10:35')));
  for (const meta of fs.readdirSync(path.join(dir, SID, 'subagents')).filter((n) => n.endsWith('.meta.json'))) setMtime(path.join(dir, SID, 'subagents', meta), new Date(at('10:01')));
  fs.writeFileSync(path.join(dir, SID, 'subagents', 'notes.txt'), 'x'); // written now: not a transcript
  const probe = createLaneProbe(root, { CLAUDE_CONFIG_DIR: home });
  assert.equal(probe.activity(JOB, new Date(at('10:40')), 15 * 60000).lastMs, Date.parse(at('10:35')));
  assert.equal(sessionTreeMtimeMs({ file: path.join(dir, `${SID}.jsonl`), sessionId: SID }), Date.parse(at('10:35')));
  assert.equal(sessionTreeMtimeMs({ file: path.join(dir, 'missing.jsonl'), sessionId: 'missing' }), null);
});

test('the probe reads a lane that runs in another directory (its slot) when given that directory (Stage 4 L1)', () => {
  const base = tmpDir('probe-slot');
  const root = path.join(base, 'app');
  const slot = path.join(base, 'app.turbo', 'lane-1');
  fs.mkdirSync(root);
  fs.mkdirSync(slot, { recursive: true });
  const home = path.join(base, 'home');
  const dir = projectDirFor(home, slot);
  writeJob(home, JOB, { sessionId: SID, cwd: slot });
  setMtime(writeSession(dir, SID, [entry.user('go', at('10:00')), entry.assistant({ ts: at('10:05'), text: 'ok' })]), new Date(at('10:05')));
  const probe = createLaneProbe(root, { CLAUDE_CONFIG_DIR: home });
  assert.equal(probe.session(JOB, slot), SID);
  assert.equal(probe.activity(JOB, new Date(at('10:10')), 15 * 60000, slot).lastMs, Date.parse(at('10:05')));
  assert.equal(probe.replied(JOB, Date.parse(at('10:01')), slot), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/wake.test.mjs`
Expected: FAIL — `does not provide an export named 'sessionTreeMtimeMs'`.

- [ ] **Step 3: Implement**

`lib/transcripts.mjs` — right after the closing brace of `export function laneTranscript`, add:

```js
const TREE_DEPTH = 8;

// spec §5.5.6 (Stage 4 L1, D15): a lane's newest transcript write, its own and every subagent's at any depth: the
// transcript's mtime and every *.jsonl under <project dir>/<session id>/subagents/, recursively (links are not
// followed). Nested agents report to their parent, not to the lane, so the lane's agent list leaves them out; their
// writes are still the lane working. null when nothing can be read.
export function sessionTreeMtimeMs(main) {
  let best = null;
  const take = (file) => {
    try {
      const ms = fs.statSync(file).mtimeMs;
      if (best === null || ms > best) best = ms;
    } catch { /* gone meanwhile */ }
  };
  take(main.file);
  const walk = (dir, depth) => {
    if (depth > TREE_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) take(p);
    }
  };
  walk(path.join(path.dirname(main.file), String(main.sessionId), 'subagents'), 0);
  return best;
}
```

`lib/wake.mjs` — replace the import `import { laneAgents, laneTranscript, projectDirs, tailEntries } from './transcripts.mjs';` with:

```js
import { laneAgents, laneTranscript, projectDirs, sessionTreeMtimeMs, tailEntries } from './transcripts.mjs';
```

Replace the whole `createLaneProbe` function with:

```js
// The supervisor's read-only view of a lane's transcripts (S0): the session id to resume, the lane's activity, and
// whether the lane session itself answered since a time. cwd is the lane's directory: this checkout (v0.3) or its slot
// (Stage 4), where Claude Code keeps the lane's transcripts. The cache lives as long as the daemon, so each tick reads
// only what grew.
export function createLaneProbe(root, env = process.env) {
  const home = claudeHome(env);
  let cache = {};
  return {
    session(jobId, cwd = root) {
      return laneTranscript({ home, root: cwd, jobId })?.sessionId || null;
    },
    // D15: the newest write is taken over the lane's whole subagents tree too, nested agents included
    activity(jobId, now, stallMs, cwd = root) {
      const main = laneTranscript({ home, root: cwd, jobId });
      if (!main) return { lastMs: null, active: 0 };
      const used = {};
      const t = laneAgents({ dirs: projectDirs(home, cwd), main, root: cwd, now, stallMs, cache, used });
      cache = used;
      const a = activityOf(t);
      const tree = sessionTreeMtimeMs(main);
      return { lastMs: tree === null ? a.lastMs : Math.max(a.lastMs ?? tree, tree), active: a.active };
    },
    // An assistant entry of the lane session (the model's own output, not a synthetic error) newer than sinceMs:
    // what a woken session did itself. The wake prompt it records, and the writes of claude stop, are no answer.
    replied(jobId, sinceMs, cwd = root) {
      const main = laneTranscript({ home, root: cwd, jobId });
      if (!main) return false;
      return tailEntries(main.file).entries.some((e) => e?.type === 'assistant' && e.message?.model !== '<synthetic>' && Date.parse(e.timestamp) > sinceMs);
    },
  };
}
```

Note: the cache stays as v0.3 has it (`used` replaces it at each `activity` call). With several lanes each call drops the other lanes' entries, so a lane re-reads more of its transcripts; correctness is unaffected (the cache only saves reads). Do not merge the caches: entries of lanes that ended would then never leave it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/wake.test.mjs test/supervisor-wake.test.mjs`
Expected: PASS (both new tests; the existing probe test keeps `lastMs: 10:20`: its only subagent transcript is that one, and meta files do not count).

- [ ] **Step 5: Commit**

```bash
git add lib/transcripts.mjs lib/wake.mjs test/wake.test.mjs
git commit -q -m "fix(stall): a lane's last write covers its whole subagents tree; the probe reads a lane in its slot"
```

---

### Task 4: Lane state for every reader; the new lane statuses

**Files:**
- Create: `lib/lanes-state.mjs`, `test/lanes-state.test.mjs`
- Modify: `lib/run-status.mjs` (`LANE_STATUSES`), `lib/context.mjs` (`measureContext`), `lib/agent-tail.mjs` (`agentTail`), `lib/phase-progress.mjs` (`activePhase`), `lib/cli-phase.mjs` (`laneRuns` exported, comment)
- Test: `test/context.test.mjs`, `test/agent-tail.test.mjs`, `test/phase-progress.test.mjs`, `test/cli-questions.test.mjs` (append)

**Interfaces:**
- Consumes: `comparePhase` (`lib/scheduler.mjs`), `dirKey` (`lib/paths.mjs`), `laneTranscript`, `projectDirs`, `findAgentTranscript`, `findTranscript`.
- Produces (`lib/lanes-state.mjs`):
  - `JOBS = ['phase', 'prep', 'annotate']`; `DONE_STATUSES = { phase: ['ready', 'done'], prep: ['prepped'], annotate: ['annotated'] }`.
  - `laneKey({ job, phase }) → '<N>' | 'prep-<N>' | 'annotate'`; `recordKey(lane) → '<N>' | 'annotate'`; `laneCwd(root, lane) → string` (`slotPath` resolved, else `root`).
  - `compareLanes(a, b)` (phase lanes by `comparePhase`, then prep, then annotate); `laneLabel(lane, lang = 'en') → 'phase 34' | 'prep of phase 34' | 'annotation'` (ru: `фаза 34`, `подготовка фазы 34`, `разметка`).
  - `supervisorLanes(sup, root = null) → LaneEntry[]` — `sup.lanes` entries (with `key`, `job`, `phase` normalized), or v0.3's `sup.lane` as `{ ...lane, key: N, job: 'phase', phase: N, slot: 0, slotPath: <root>, branch: null }`, or `[]`; sorted by `compareLanes`.
  - `laneForPhase(sup, root, phase) → LaneEntry | null` (phase job only); `laneAt(sup, root, dir) → LaneEntry | null` (the lane whose `slotPath` is `dir`).
  - `nextLine(next, lang = 'en') → string | null`; `lanesSummary({ lanes, questions, next }, lang = 'en') → string`; `setupLines(result) → string[]` (the lines `start` prints after L0's `setupSlots`).
- Produces (`lib/run-status.mjs`): `LANE_STATUSES = ['running', 'paused-context', 'needs-owner', 'done', 'failed', 'ready', 'prepped', 'annotated']` (L2 writes `ready`, L3 `prepped` and `annotated`; nothing in checkout mode writes them).
- Produces (`lib/cli-phase.mjs`): `laneRuns(root, deps) → boolean` exported, unchanged: true only for v0.3's `lane` (slots lanes never commit in the main checkout, L0 D14).

- [ ] **Step 1: Write the failing tests**

Create `test/lanes-state.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { DONE_STATUSES, JOBS, compareLanes, laneAt, laneCwd, laneForPhase, laneKey, laneLabel, lanesSummary, nextLine, recordKey, setupLines, supervisorLanes } from '../lib/lanes-state.mjs';
import { LANE_STATUSES } from '../lib/run-status.mjs';

const base = tmpDir('lstate');
const root = path.join(base, 'app');
const slot = (k) => path.join(base, 'app.turbo', `lane-${k}`);
fs.mkdirSync(root, { recursive: true });
for (const k of [1, 2, 3]) fs.mkdirSync(slot(k), { recursive: true });

const SUP = {
  lanesMode: 'slots',
  lanes: {
    annotate: { key: 'annotate', job: 'annotate', phase: null, slot: 3, slotPath: slot(3), sessionId: 's3' },
    'prep-36': { key: 'prep-36', job: 'prep', phase: '36', slot: 2, slotPath: slot(2), sessionId: 's2' },
    34: { key: '34', job: 'phase', phase: '34', slot: 1, slotPath: slot(1), sessionId: 's1' },
  },
};

test('keys, records and labels of the three jobs; the statuses that end each of them', () => {
  assert.deepEqual(JOBS, ['phase', 'prep', 'annotate']);
  assert.deepEqual(DONE_STATUSES, { phase: ['ready', 'done'], prep: ['prepped'], annotate: ['annotated'] });
  for (const s of ['ready', 'prepped', 'annotated']) assert.ok(LANE_STATUSES.includes(s), s);
  assert.deepEqual([laneKey({ job: 'phase', phase: '34' }), laneKey({ job: 'prep', phase: '36' }), laneKey({ job: 'annotate', phase: null })], ['34', 'prep-36', 'annotate']);
  assert.deepEqual([recordKey({ job: 'phase', phase: '34' }), recordKey({ job: 'prep', phase: '36' }), recordKey({ job: 'annotate', phase: null }), recordKey({ phase: 7 })], ['34', '36', 'annotate', '7']);
  assert.equal(laneCwd(root, { phase: '7' }), root);
  assert.equal(laneCwd(root, { phase: '7', slotPath: slot(1) }), path.resolve(slot(1)));
  assert.deepEqual(['phase', 'prep', 'annotate'].map((job) => laneLabel({ job, phase: '36' })), ['phase 36', 'prep of phase 36', 'annotation']);
  assert.deepEqual(['phase', 'prep', 'annotate'].map((job) => laneLabel({ job, phase: '36' }, 'ru')), ['фаза 36', 'подготовка фазы 36', 'разметка']);
});

test('supervisorLanes: slots lanes in order (phases, prep, annotate); v0.3\'s lane in the same shape; nothing without either', () => {
  assert.deepEqual(supervisorLanes(SUP, root).map((l) => l.key), ['34', 'prep-36', 'annotate']);
  const v03 = supervisorLanes({ lane: { phase: 7, sessionId: 'abc', restarts: 1, mode: 'full' } }, root);
  assert.deepEqual(v03, [{ phase: '7', sessionId: 'abc', restarts: 1, mode: 'full', key: '7', job: 'phase', slot: 0, slotPath: path.resolve(root), branch: null }]);
  assert.deepEqual(supervisorLanes(null, root), []);
  assert.deepEqual(supervisorLanes({ lane: null }, root), []);
  assert.equal(laneForPhase(SUP, root, '34').slot, 1);
  assert.equal(laneForPhase(SUP, root, '36'), null, 'a prep lane is no phase lane');
  assert.equal(laneAt(SUP, root, slot(2)).key, 'prep-36');
  assert.equal(laneAt(SUP, root, root), null, 'slots mode: no lane works in the main checkout');
  assert.equal(laneAt({ lane: { phase: '7' } }, root, root).phase, '7');
  assert.deepEqual([{ job: 'annotate' }, { job: 'phase', phase: '10' }, { job: 'prep', phase: '2' }, { job: 'phase', phase: '9' }].sort(compareLanes).map((l) => l.phase ?? 'a'), ['9', '10', '2', 'a']);
});

test('the summary line of status (spec §8): lanes, questions and what the next phase waits for, in English and Russian', () => {
  const next = { phase: '36', why: 'deps', waitsFor: ['34'] };
  assert.equal(lanesSummary({ lanes: 3, questions: 1, next }), 'lanes: 3 · questions: 1 · next: phase 36 waits for phase 34');
  assert.equal(lanesSummary({ lanes: 3, questions: 1, next }, 'ru'), 'полосы: 3 · вопросы: 1 · следующая: фаза 36 ждёт фазу 34');
  assert.equal(lanesSummary({ lanes: 0, questions: 0, next: null }), 'lanes: 0 · questions: 0');
  assert.equal(nextLine({ phase: '36', why: 'deps', waitsFor: ['34', '35'] }), 'phase 36 waits for phases 34, 35');
  assert.equal(nextLine({ phase: '36', why: 'deps', waitsFor: ['34', '35'] }, 'ru'), 'фаза 36 ждёт фазы 34, 35');
  assert.equal(nextLine({ phase: '36', why: 'areas', waitsFor: ['34'] }), 'phase 36 waits for phase 34 (same files)');
  assert.equal(nextLine({ phase: '36', why: 'areas', waitsFor: ['34'] }, 'ru'), 'фаза 36 ждёт фазу 34 (общие файлы)');
  assert.equal(nextLine({ phase: '36', why: 'gates', waitsFor: ['34'], gate: 'prod-deploy' }), 'phase 36 waits for prod-deploy (held by phase 34)');
  assert.equal(nextLine({ phase: '36', why: 'gates', waitsFor: ['34'], gate: 'prod-deploy' }, 'ru'), 'фаза 36 ждёт prod-deploy (держит фаза 34)');
  assert.equal(nextLine({ phase: '36', why: 'gates', waitsFor: [], gate: 'prod-deploy' }), 'phase 36 waits for prod-deploy');
  assert.equal(nextLine({ phase: '36', why: 'slots', waitsFor: [] }), 'phase 36 waits for a free slot');
  assert.equal(nextLine({ phase: '36', why: 'slots', waitsFor: [] }, 'ru'), 'фаза 36 ждёт свободный слот');
  assert.equal(nextLine({ phase: '36', why: 'annotation', waitsFor: ['34'] }), 'phase 36 waits for the lane annotation');
  assert.equal(nextLine({ phase: '36', why: 'annotation', waitsFor: ['34'] }, 'ru'), 'фаза 36 ждёт разметку');
  assert.equal(nextLine(null), null);
});

test('setupLines: what start prints after building the slots (L0 setupSlots result)', () => {
  const p = 'C:\\Users\\dev\\app.turbo\\lane-';
  assert.deepEqual(setupLines({
    dir: 'C:\\Users\\dev\\app.turbo',
    slots: [
      { k: 1, path: `${p}1`, action: 'kept', why: null, trust: { status: 'already' } },
      { k: 2, path: `${p}2`, action: 'created', why: null, trust: { status: 'trusted' } },
      { k: 3, path: `${p}3`, action: 'created', why: null, trust: { status: 'manual', line: `open claude in ${p}3 once and accept the trust dialog`, why: 'unknown format' } },
      { k: 4, path: `${p}4`, action: 'refused', why: 'not a slot of this project', trust: null },
    ],
    backup: 'C:\\Users\\dev\\.claude.json.turbo-bak-20261013T120000Z',
  }), [
    `lane-1: kept ${p}1`, 'lane-1: trusted (already)',
    `lane-2: created ${p}2`, 'lane-2: trusted',
    `lane-3: created ${p}3`, `lane-3: open claude in ${p}3 once and accept the trust dialog (unknown format)`,
    'lane-4: refused: not a slot of this project',
    'backup: C:\\Users\\dev\\.claude.json.turbo-bak-20261013T120000Z',
  ]);
});
```

Append to `test/context.test.mjs`:

```js
test('slots mode: the phase\'s lane comes from supervisor.json lanes and its transcript from its slot (Stage 4 L1)', () => {
  const f = setup();
  const slot = path.join(path.dirname(f.root), 'my project.turbo', 'lane-1');
  fs.mkdirSync(path.join(f.root, '.planning', 'turbo', 'run'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.planning', 'turbo', 'run', 'supervisor.json'), JSON.stringify({
    lanesMode: 'slots',
    lanes: {
      3: { key: '3', job: 'phase', phase: '3', slot: 1, slotPath: slot, sessionId: 'abcd1234' },
      'prep-4': { key: 'prep-4', job: 'prep', phase: '4', slot: 2, slotPath: `${slot}-2`, sessionId: 'eeee1111' },
    },
  }));
  f.transcript(keyOf(slot), 'abcd1234-5678-90ab', [assistant(slot, usage(0, 0, 330000))]);
  assert.deepEqual([measure(f).used, measure(f).source], [330000, 'lane']);
});
```

Append to `test/agent-tail.test.mjs`:

```js
test('agent-tail finds an agent of a slot lane: every lane\'s transcript directory is searched (Stage 4 L1)', () => {
  const { root, env } = setup();
  const home = env.CLAUDE_CONFIG_DIR;
  const slot = path.join(path.dirname(root), 'app.turbo', 'lane-1');
  fs.mkdirSync(slot, { recursive: true });
  const jobId = '1a2b3c4d';
  const sid = `${jobId}-2222-4333-8444-555555555555`;
  const dir = projectDirFor(home, slot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${JSON.stringify(entry.user('go', at(0)))}\n`);
  writeAgent(dir, sid, AGENT, [entry.agentUser(AGENT, 'Execute plan 01 of phase 3', at(0))]);
  fs.mkdirSync(path.join(root, '.planning', 'turbo', 'run'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'run', 'supervisor.json'), JSON.stringify({ lanesMode: 'slots', lanes: { 3: { key: '3', job: 'phase', phase: '3', slot: 1, slotPath: slot, sessionId: jobId } } }));
  assert.equal(agentTail({ root, agentId: AGENT, env }).agentId, AGENT);
});
```

Append to `test/phase-progress.test.mjs`:

```js
test('activePhase in slots mode: no lane works in the main checkout while lanes run; with none, the newest unfinished run (Stage 4 L1)', () => {
  const root = project();
  completeStep(root, '4', 'freshness', { now: new Date('2026-01-02T00:00:00Z') });
  const sup = path.join(root, '.planning', 'turbo', 'run', 'supervisor.json');
  writeJsonAtomic(sup, { lanesMode: 'slots', lanes: { 7: { key: '7', job: 'phase', phase: '7', slot: 1, slotPath: path.join(root, '..', 'elsewhere') } } });
  assert.equal(activePhase(root), null);
  writeJsonAtomic(sup, { lanesMode: 'slots', lanes: {} });
  assert.equal(activePhase(root), '4');
});
```

Append to `test/cli-questions.test.mjs` (add `laneRuns` to its import from `../lib/cli-phase.mjs`):

```js
test('laneRuns: only v0.3\'s lane commits in this checkout; slots lanes never do, so the owner\'s answer is committed by turbo-run answer (Stage 4 L1, L0 D14)', () => {
  const root = project();
  const file = path.join(root, '.planning', 'turbo', 'run', 'supervisor.json');
  withLane(root);
  assert.equal(laneRuns(root, { supervisorAlive: () => true }), true);
  writeJsonAtomic(file, { lanesMode: 'slots', lanes: { 32: { key: '32', job: 'phase', phase: '32', slot: 1, slotPath: tmpDir('slot'), sessionId: '1a2b3c4d' } } });
  assert.equal(laneRuns(root, { supervisorAlive: () => true }), false);
});
```

(`test/cli-questions.test.mjs` imports `tmpDir` already through `project`'s default; if not, add `import { tmpDir } from './helpers/tmp.mjs';`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/lanes-state.test.mjs test/context.test.mjs test/agent-tail.test.mjs test/phase-progress.test.mjs test/cli-questions.test.mjs`
Expected: FAIL — `Cannot find module '…/lib/lanes-state.mjs'` (and `laneRuns` not exported).

- [ ] **Step 3: Implement**

Create `lib/lanes-state.mjs`:

```js
import path from 'node:path';
import { comparePhase } from './scheduler.mjs';
import { dirKey } from './paths.mjs';

// spec §5 (Stage 4 L1): supervisor.json's lanes as everyone outside the supervisor reads them. Slots mode writes
// lanes (keyed: <N>, prep-<N>, annotate); checkout mode keeps v0.3's single lane (D1), shown here in the same shape.
export const JOBS = Object.freeze(['phase', 'prep', 'annotate']);
// D3: the run-record statuses that end a lane of each job, once its session's turn has ended
export const DONE_STATUSES = Object.freeze({ phase: Object.freeze(['ready', 'done']), prep: Object.freeze(['prepped']), annotate: Object.freeze(['annotated']) });

export function laneKey({ job, phase }) {
  if (job === 'annotate') return 'annotate';
  return job === 'prep' ? `prep-${phase}` : String(phase);
}
// The run record (run/p<key>.json) a lane writes with lane-status: its phase's for a phase and its prep (never at
// once), annotate's own for the annotation.
export const recordKey = (lane) => (lane?.job === 'annotate' ? 'annotate' : String(lane.phase));
export const laneCwd = (root, lane) => (lane?.slotPath ? path.resolve(lane.slotPath) : root);

const JOB_ORDER = { phase: 0, prep: 1, annotate: 2 };
export function compareLanes(a, b) {
  const ja = JOB_ORDER[a.job || 'phase'] ?? 3;
  const jb = JOB_ORDER[b.job || 'phase'] ?? 3;
  return ja - jb || comparePhase(a.phase ?? '', b.phase ?? '');
}

export function laneLabel(lane, lang = 'en') {
  const ru = lang === 'ru';
  if (lane.job === 'prep') return ru ? `подготовка фазы ${lane.phase}` : `prep of phase ${lane.phase}`;
  if (lane.job === 'annotate') return ru ? 'разметка' : 'annotation';
  return ru ? `фаза ${lane.phase}` : `phase ${lane.phase}`;
}

export function supervisorLanes(sup, root = null) {
  if (sup?.lanes && typeof sup.lanes === 'object' && !Array.isArray(sup.lanes)) {
    return Object.entries(sup.lanes)
      .filter(([, l]) => l && typeof l === 'object')
      .map(([key, l]) => ({ ...l, key: l.key ?? key, job: JOBS.includes(l.job) ? l.job : 'phase', phase: l.phase == null ? null : String(l.phase) }))
      .sort(compareLanes);
  }
  if (sup?.lane && typeof sup.lane === 'object' && sup.lane.phase != null) {
    const phase = String(sup.lane.phase);
    return [{ ...sup.lane, phase, key: phase, job: 'phase', slot: 0, slotPath: root ? path.resolve(root) : null, branch: null }];
  }
  return [];
}

export const laneForPhase = (sup, root, phase) => supervisorLanes(sup, root).find((l) => l.job === 'phase' && l.phase === String(phase)) || null;

export function laneAt(sup, root, dir) {
  const here = dirKey(dir);
  return supervisorLanes(sup, root).find((l) => l.slotPath && dirKey(l.slotPath) === here) || null;
}

const W = {
  en: { phase: (n) => `phase ${n}`, list: (l) => (l.length > 1 ? `phases ${l.join(', ')}` : `phase ${l[0]}`), waits: 'waits for', same: 'same files', held: (who) => `held by ${who}`, slot: 'a free slot', annotation: 'the lane annotation', lanes: 'lanes', questions: 'questions', next: 'next' },
  ru: { phase: (n) => `фаза ${n}`, list: (l) => (l.length > 1 ? `фазы ${l.join(', ')}` : `фазу ${l[0]}`), waits: 'ждёт', same: 'общие файлы', held: (who) => `держит ${who}`, slot: 'свободный слот', annotation: 'разметку', lanes: 'полосы', questions: 'вопросы', next: 'следующая' },
};

// spec §8: what the next phase waits for (supervisor.json next), in the owner's language; null when nothing waits.
export function nextLine(next, lang = 'en') {
  if (!next?.phase) return null;
  const w = lang === 'ru' ? W.ru : W.en;
  const who = w.phase(next.phase);
  const on = Array.isArray(next.waitsFor) ? next.waitsFor.map(String) : [];
  switch (next.why) {
    case 'deps': return on.length ? `${who} ${w.waits} ${w.list(on)}` : null;
    case 'areas': return on.length ? `${who} ${w.waits} ${w.list(on)} (${w.same})` : null;
    case 'gates': return `${who} ${w.waits} ${next.gate}${on.length ? ` (${w.held(W[lang === 'ru' ? 'ru' : 'en'].phase(on[0]))})` : ''}`;
    case 'slots': return `${who} ${w.waits} ${w.slot}`;
    case 'annotation': return `${who} ${w.waits} ${w.annotation}`;
    default: return null;
  }
}

// spec §8: the status summary line, e.g. lanes: 3 · questions: 1 · next: phase 36 waits for phase 34.
export function lanesSummary({ lanes, questions, next }, lang = 'en') {
  const w = lang === 'ru' ? W.ru : W.en;
  const n = nextLine(next, lang);
  return [`${w.lanes}: ${lanes}`, `${w.questions}: ${questions}`, ...(n ? [`${w.next}: ${n}`] : [])].join(' · ');
}

// The lines start prints after L0's setupSlots: each slot's action and trust (L0's lanes setup contract), the backup.
export function setupLines(result) {
  const lines = [];
  for (const s of result?.slots || []) {
    lines.push(s.action === 'refused' ? `lane-${s.k}: refused: ${s.why}` : `lane-${s.k}: ${s.action} ${s.path}`);
    const t = s.trust;
    if (!t) continue;
    if (t.status === 'already') lines.push(`lane-${s.k}: trusted (already)`);
    else if (t.status === 'trusted') lines.push(`lane-${s.k}: trusted`);
    else lines.push(`lane-${s.k}: ${t.line}${t.why ? ` (${t.why})` : ''}`);
  }
  if (result?.backup) lines.push(`backup: ${result.backup}`);
  return lines;
}
```

`lib/run-status.mjs` — replace `export const LANE_STATUSES = ['running', 'paused-context', 'needs-owner', 'done', 'failed'];` with:

```js
// Stage 4 L1 (D3): ready (a phase lane integrated, L2 merges it), prepped and annotated (a job ended, L3 merges it).
// Checkout mode never writes them; inferStatus reads them like any status it does not trust (lanes-state DONE_STATUSES).
export const LANE_STATUSES = ['running', 'paused-context', 'needs-owner', 'done', 'failed', 'ready', 'prepped', 'annotated'];
```

`lib/context.mjs` — add `import { laneForPhase } from './lanes-state.mjs';` after the other imports; in `measureContext` replace the two lines

```js
  const rec = phase ? readJson(path.join(runDir(root), 'supervisor.json'), null)?.lane : null;
  const lane = rec && String(rec.phase) === String(phase) && typeof rec.sessionId === 'string' ? rec.sessionId : '';
  const t = findTranscript({ home, root, env, lane });
```

with:

```js
  // the phase's lane: v0.3's in this checkout, or a slot lane (Stage 4), whose transcripts live under its slot
  const rec = phase ? laneForPhase(readJson(path.join(runDir(root), 'supervisor.json'), null), root, phase) : null;
  const lane = rec && typeof rec.sessionId === 'string' ? rec.sessionId : '';
  const t = findTranscript({ home, root: rec?.slotPath || root, env, lane });
```

`lib/agent-tail.mjs` — add `import { supervisorLanes } from './lanes-state.mjs';`; in `agentTail` replace

```js
  const jobId = readJson(path.join(runDir(root), 'supervisor.json'), null)?.lane?.sessionId;
  const main = typeof jobId === 'string' && jobId ? laneTranscript({ home, root, jobId }) : null;
  const found = findAgentTranscript([...projectDirs(home, root), ...(main ? [path.dirname(main.file)] : [])], agentId);
```

with:

```js
  // every lane's transcript directory, each lane read in its own directory (its slot in Stage 4)
  const sup = readJson(path.join(runDir(root), 'supervisor.json'), null);
  const mains = supervisorLanes(sup, root)
    .filter((l) => typeof l.sessionId === 'string' && l.sessionId)
    .map((l) => laneTranscript({ home, root: l.slotPath || root, jobId: l.sessionId }))
    .filter(Boolean);
  const found = findAgentTranscript([...projectDirs(home, root), ...mains.map((m) => path.dirname(m.file))], agentId);
```

`lib/phase-progress.mjs` — add `import { laneAt } from './lanes-state.mjs';`; in `activePhase` replace

```js
  const sup = readJson(path.join(runDir(root), 'supervisor.json'), null);
  if (sup?.lane?.phase != null && String(sup.lane.phase)) return String(sup.lane.phase);
```

with:

```js
  const sup = readJson(path.join(runDir(root), 'supervisor.json'), null);
  // the lane that works in this directory: v0.3's lane in this checkout, or the slot lane whose slot this is
  const here = laneAt(sup, root, root);
  if (here?.job === 'phase' && here.phase) return here.phase;
  // slots mode (Stage 4): while lanes run, none of them works in the main checkout
  if (sup?.lanes && Object.keys(sup.lanes).length) return null;
```

`lib/phase-progress.mjs` must not import `lib/lanes-state.mjs` in a cycle: `lanes-state` imports only `scheduler` and `paths`, so it does not.

`lib/cli-phase.mjs` — replace `function laneRuns(root, deps) {` with `export function laneRuns(root, deps) {`, and add this line to the comment above it:

```js
// Stage 4 (L0 D14): slots-mode lanes (supervisor.json lanes) work in their own clones, never here: false for them.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/lanes-state.test.mjs test/context.test.mjs test/agent-tail.test.mjs test/phase-progress.test.mjs test/cli-questions.test.mjs test/run-status.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/lanes-state.mjs lib/run-status.mjs lib/context.mjs lib/agent-tail.mjs lib/phase-progress.mjs lib/cli-phase.mjs test/lanes-state.test.mjs test/context.test.mjs test/agent-tail.test.mjs test/phase-progress.test.mjs test/cli-questions.test.mjs
git commit -q -m "feat(lanes): one reader of supervisor.json lanes; ready, prepped and annotated statuses"
```

---
### Task 5: Gate locks — `turbo-run lock|unlock`, the lane rule, `gateWait`

**Files:**
- Create: `lib/gate-locks.mjs`, `test/gate-locks.test.mjs`
- Modify: `bin/turbo-run.mjs` (imports, `USAGE`, `VALUE_FLAGS`, `case 'lock'` / `case 'unlock'`), `lib/lane-prompt.mjs` (`lockRule`, `laneSystemPrompt`), `lib/messages.mjs` (`gateWait`, en and ru)
- Test: `test/lane-prompt.test.mjs`, `test/notify.test.mjs` (append)

**Interfaces:**
- Consumes: `locksDir` (`lib/paths.mjs`; L0 resolves it to the control root from a slot), `readJson`, `ensureDir` (`lib/fsx.mjs`), `GATE_RE`, `laneGates` (Task 1), `notify`, `msg`.
- Produces (`lib/gate-locks.mjs`): `gateFile(root, gate) → <locks>/gates/<gate>.json`; `readGate(root, gate) → { gate, phase, at } | null` (null for a missing or broken file); `heldGates(root) → Array<{ gate, phase: string|null, at: string|null }>` (sorted by gate; a broken file has `phase: null`); `gateDeclaredBy(sup, gate, phase) → string | null` (another running phase lane of `sup.lanes` whose `gates` holds it); `acquireGate(root, gate, phase, { waitMs = 0, stepMs = 2000, declaredBy = () => null, now, sleep, stamp }) → Promise<{ acquired: true, already: boolean } | { acquired: false, holder: { phase, at, by: 'lock'|'lane' } }>`; `releaseGate(root, gate, phase) → { released: true } | { released: false, why: 'not-held' } | { released: false, why: 'other', holder }`; `releaseGatesOf(root, phase) → string[]`.
- Produces (`lib/lane-prompt.mjs`): `lockRule({ phase, turboRun }) → string`; `laneSystemPrompt({ …, slots = false })` appends it when `slots`.
- Produces (CLI): D13, Contracts.

- [ ] **Step 1: Write the failing tests**

Create `test/gate-locks.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { acquireGate, gateDeclaredBy, gateFile, heldGates, readGate, releaseGate, releaseGatesOf } from '../lib/gate-locks.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const cli = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, TURBO_CONTROL_ROOT: '' } });
const T0 = '2026-01-01T00:00:00.000Z';
function project(config = null) {
  const root = tmpDir('gates');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  if (config) fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify(config));
  return root;
}

test('acquireGate / releaseGate: one phase holds a gate; another waits, polling, then gets it once released; another phase never unlocks it', async () => {
  const root = project();
  assert.deepEqual(await acquireGate(root, 'prod-deploy', '3', { stamp: () => T0 }), { acquired: true, already: false });
  assert.deepEqual(readGate(root, 'prod-deploy'), { gate: 'prod-deploy', phase: '3', at: T0 });
  assert.deepEqual(await acquireGate(root, 'prod-deploy', '3'), { acquired: true, already: true });
  let clock = 0;
  const sleeps = [];
  const r = await acquireGate(root, 'prod-deploy', '4', { waitMs: 5000, stepMs: 2000, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  assert.deepEqual(r, { acquired: false, holder: { phase: '3', at: T0, by: 'lock' } });
  assert.deepEqual(sleeps, [2000, 2000, 1000]);
  assert.deepEqual(releaseGate(root, 'prod-deploy', '4'), { released: false, why: 'other', holder: '3' });
  clock = 0;
  const got = await acquireGate(root, 'prod-deploy', '4', { waitMs: 10000, now: () => clock, sleep: async (ms) => { clock += ms; releaseGate(root, 'prod-deploy', '3'); } });
  assert.deepEqual(got, { acquired: true, already: false });
  assert.equal(readGate(root, 'prod-deploy').phase, '4');
  assert.deepEqual(releaseGate(root, 'prod-deploy', '4'), { released: true });
  assert.deepEqual(releaseGate(root, 'prod-deploy', '4'), { released: false, why: 'not-held' });
  await assert.rejects(acquireGate(root, '../x', '4'), /invalid gate name/);
});

test('a gate another running phase declares is held by its lane; heldGates lists the locks, a broken one held by nobody known; releaseGatesOf frees one phase\'s', async () => {
  const root = project();
  const sup = { lanes: { 3: { job: 'phase', phase: '3', gates: ['prod-deploy'] }, 'prep-5': { job: 'prep', phase: '5', gates: ['owner-live'] } } };
  assert.equal(gateDeclaredBy(sup, 'prod-deploy', '4'), '3');
  assert.equal(gateDeclaredBy(sup, 'prod-deploy', '3'), null, 'its own declaration');
  assert.equal(gateDeclaredBy(sup, 'owner-live', '4'), null, 'a job declares no gates');
  assert.equal(gateDeclaredBy(null, 'prod-deploy', '4'), null);
  assert.deepEqual(await acquireGate(root, 'prod-deploy', '4', { declaredBy: (g) => gateDeclaredBy(sup, g, '4') }), { acquired: false, holder: { phase: '3', at: null, by: 'lane' } });
  assert.equal(fs.existsSync(gateFile(root, 'prod-deploy')), false, 'no lock file is written while a lane holds the gate');
  await acquireGate(root, 'owner-live', '3', { stamp: () => T0 });
  await acquireGate(root, 'packaged-build', '4', { stamp: () => T0 });
  fs.writeFileSync(gateFile(root, 'owner-signature'), '{"gate":');
  assert.deepEqual(heldGates(root), [
    { gate: 'owner-live', phase: '3', at: T0 },
    { gate: 'owner-signature', phase: null, at: null },
    { gate: 'packaged-build', phase: '4', at: T0 },
  ]);
  assert.deepEqual(releaseGatesOf(root, '3'), ['owner-live']);
  assert.deepEqual(releaseGate(root, 'owner-signature', '9'), { released: true }, 'a broken lock file goes for anyone');
  assert.deepEqual(heldGates(root).map((g) => g.gate), ['packaged-build']);
  assert.deepEqual(heldGates(project()), []);
});

test('turbo-run lock / unlock: lines and exit codes (0 taken, 3 timed out, 1 another phase\'s, 2 usage or unknown gate)', () => {
  const root = project({ notify: { desktop: false, telegram: false }, lanes: { mode: 'checkout', gates: ['db-migrate'] } });
  let r = cli(['lock', 'db-migrate', '3'], root);
  assert.deepEqual([r.status, r.stdout.trim()], [0, 'locked db-migrate for phase 3'], r.stderr);
  r = cli(['lock', 'db-migrate', '03'], root);
  assert.deepEqual([r.status, r.stdout.trim()], [0, 'db-migrate is already held by phase 3']);
  r = cli(['lock', 'db-migrate', '4', '--wait-seconds', '0'], root);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /^gate db-migrate is held by phase 3 since \S+ \(lock\); waited 0 s$/m);
  r = cli(['unlock', 'db-migrate', '4'], root);
  assert.deepEqual([r.status, r.stderr.trim()], [1, 'gate db-migrate is held by phase 3, not 4; nothing changed']);
  r = cli(['unlock', 'db-migrate', '3'], root);
  assert.deepEqual([r.status, r.stdout.trim()], [0, 'unlocked db-migrate']);
  r = cli(['unlock', 'db-migrate', '3'], root);
  assert.deepEqual([r.status, r.stdout.trim()], [0, 'db-migrate is not locked']);
  writeJsonAtomic(path.join(root, '.planning', 'turbo', 'run', 'supervisor.json'), { lanesMode: 'slots', lanes: { 5: { key: '5', job: 'phase', phase: '5', gates: ['prod-deploy'] } } });
  r = cli(['lock', 'prod-deploy', '4', '--wait-seconds', '0'], root);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /^gate prod-deploy is held by phase 5 since unknown \(declared by its lane\); waited 0 s$/m);
  for (const args of [['lock', 'nope', '3'], ['lock', 'prod-deploy'], ['lock', 'prod-deploy', '3', '--wait-seconds', 'x'], ['unlock']]) {
    assert.equal(cli(args, root).status, 2, args.join(' '));
  }
  assert.match(cli(['lock', 'nope', '3'], root).stderr, /^unknown gate nope \(known: prod-deploy, owner-live, owner-signature, packaged-build, db-migrate; add your own in lanes\.gates\)$/m);
});
```

Append to `test/lane-prompt.test.mjs` (add `lockRule` to its import from `../lib/lane-prompt.mjs`):

```js
test('slot lanes get the lock rule for one-off actions on shared resources; checkout lanes do not (Stage 4 L1)', () => {
  const rule = lockRule({ phase: '34', turboRun: 'node x' });
  assert.match(rule, /run node x lock <gate> 34 with the Bash timeout at 600000 ms, do the action, then run node x unlock <gate> 34 at once, also when the action failed\./);
  assert.match(rule, /Exit 3 means another phase holds it and the owner was told: run the lock once more; a second exit 3 stops you for the owner/);
  assert.ok(!rule.includes('"') && !rule.includes('%') && !rule.startsWith('-'));
  const base = { phase: '34', turboRun: 'node x', contextPct: 55, autonomy: 'standard', mode: 'full' };
  assert.ok(laneSystemPrompt({ ...base, slots: true }).endsWith(rule));
  assert.ok(!laneSystemPrompt(base).includes('lock <gate>'));
});
```

Append to `test/notify.test.mjs`:

```js
test('msg renders gateWait in en and ru (Stage 4 L1)', () => {
  const v = { phase: '4', gate: 'prod-deploy', holder: '3', minutes: 9 };
  assert.deepEqual(msg('en', 'gateWait', v), { title: 'Phase 4 waits for prod-deploy', body: 'Phase 3 holds the shared resource prod-deploy; phase 4 waited 9 min for it. Its lane tries once more, then asks you. To free it by hand: turbo-run unlock prod-deploy 3' });
  assert.deepEqual(msg('ru', 'gateWait', v), { title: 'Фаза 4 ждёт prod-deploy', body: 'Общий ресурс prod-deploy занят фазой 3; фаза 4 ждала его 9 мин. Её полоса попробует ещё раз, затем спросит вас. Освободить вручную: turbo-run unlock prod-deploy 3' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/gate-locks.test.mjs test/lane-prompt.test.mjs test/notify.test.mjs`
Expected: FAIL — `Cannot find module '…/lib/gate-locks.mjs'`; `lockRule` not exported.

- [ ] **Step 3: Implement**

Create `lib/gate-locks.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { locksDir } from './paths.mjs';
import { ensureDir, readJson } from './fsx.mjs';
import { GATE_RE } from './config.mjs';

// spec §5 (Stage 4 L1, D13): file mutexes for one-off actions on shared resources (a deploy, a packaged build). One
// file per gate in the control root's locks/gates/, created with wx so two lanes never both take it. A phase's Gates
// line holds its gates for the whole phase without a file (gateDeclaredBy reads them from supervisor.json lanes).
export const gateFile = (root, gate) => path.join(locksDir(root), 'gates', `${gate}.json`);

function checked(gate) {
  if (!GATE_RE.test(String(gate))) throw new Error(`invalid gate name ${JSON.stringify(String(gate))}`);
  return String(gate);
}

export function readGate(root, gate) {
  const rec = readJson(gateFile(root, checked(gate)), null);
  return rec && typeof rec === 'object' && typeof rec.phase === 'string' && rec.phase ? { gate: String(gate), phase: rec.phase, at: typeof rec.at === 'string' ? rec.at : null } : null;
}

// Every lock file; one that cannot be read is held by nobody known (phase null): it still holds its gate.
export function heldGates(root) {
  let names;
  try {
    names = fs.readdirSync(path.join(locksDir(root), 'gates'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.map((n) => /^(.+)\.json$/.exec(n)?.[1]).filter((g) => g && GATE_RE.test(g)).sort()
    .map((gate) => readGate(root, gate) || { gate, phase: null, at: null });
}

// Another running phase lane whose annotation declares the gate (spec §5: a phase's Gates are taken for the whole phase).
export function gateDeclaredBy(sup, gate, phase) {
  for (const l of Object.values(sup?.lanes || {})) {
    if (l && (l.job ?? 'phase') === 'phase' && String(l.phase) !== String(phase) && Array.isArray(l.gates) && l.gates.includes(gate)) return String(l.phase);
  }
  return null;
}

function take(root, gate, phase, at) {
  const file = gateFile(root, gate);
  ensureDir(path.dirname(file));
  try {
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeSync(fd, `${JSON.stringify({ gate, phase, at })}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return { acquired: true, already: false };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const cur = readGate(root, gate);
  if (cur?.phase === phase) return { acquired: true, already: true };
  return { acquired: false, holder: { phase: cur?.phase ?? null, at: cur?.at ?? null, by: 'lock' } };
}

// Takes the gate for the phase, waiting up to waitMs (polled every stepMs) while a lock file or another running lane
// holds it. The phase's own earlier lock counts as taken.
export async function acquireGate(root, gate, phase, {
  waitMs = 0, stepMs = 2000, declaredBy = () => null,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), stamp = () => new Date().toISOString(),
} = {}) {
  const g = checked(gate);
  const id = String(phase);
  const end = now() + Math.max(0, Number(waitMs) || 0);
  for (;;) {
    const lane = declaredBy(g);
    const r = lane ? { acquired: false, holder: { phase: lane, at: null, by: 'lane' } } : take(root, g, id, stamp());
    if (r.acquired) return r;
    const left = end - now();
    if (left <= 0) return r;
    await sleep(Math.min(stepMs, left));
  }
}

// Only the holder releases its lock; a lock file nobody can name (broken) goes for anyone.
export function releaseGate(root, gate, phase) {
  const file = gateFile(root, checked(gate));
  if (!fs.existsSync(file)) return { released: false, why: 'not-held' };
  const cur = readGate(root, gate);
  if (cur && cur.phase !== String(phase)) return { released: false, why: 'other', holder: cur.phase };
  fs.rmSync(file, { force: true });
  return { released: true };
}

// The supervisor, when a lane ends: every lock its phase still holds.
export function releaseGatesOf(root, phase) {
  const freed = [];
  for (const g of heldGates(root)) {
    if (g.phase !== String(phase)) continue;
    fs.rmSync(gateFile(root, g.gate), { force: true });
    freed.push(g.gate);
  }
  return freed;
}
```

`lib/lane-prompt.mjs` — right before `// Both prompts go to claude --bg as plain argv values`, add:

```js
// spec §5 (Stage 4 L1, D13): lanes in slots run next to each other; a one-off action on a shared resource takes its lock.
// A plain argv value: no double quotes, no percent signs, never a leading dash.
export function lockRule({ phase, turboRun }) {
  const t = turboRun;
  return `Shared resources: other phases run at the same time in their own clones. Before a one-off action on a shared resource (a deploy, a packaged build, a live check with the owner: the gates prod-deploy, owner-live, owner-signature, packaged-build and the project's lanes.gates) run ${t} lock <gate> ${phase} with the Bash timeout at 600000 ms, do the action, then run ${t} unlock <gate> ${phase} at once, also when the action failed. Exit 3 means another phase holds it and the owner was told: run the lock once more; a second exit 3 stops you for the owner (${t} ask ${phase} --action <the owner's one step>).`;
}
```

In `laneSystemPrompt`, change its parameter list to `{ phase, turboRun, contextPct, autonomy, mode = 'safe', tmpDir = '', pushMode = 'off', slots = false }` and replace its last array element `    ...pushRule({ phase, turboRun, pushMode }),` with:

```js
    ...pushRule({ phase, turboRun, pushMode }),
    ...(slots ? [lockRule({ phase, turboRun })] : []),
```

`lib/messages.mjs` — in `M.en`, after the `ciUnavailable` entry, add:

```js
    gateWait: ['Phase {phase} waits for {gate}', 'Phase {holder} holds the shared resource {gate}; phase {phase} waited {minutes} min for it. Its lane tries once more, then asks you. To free it by hand: turbo-run unlock {gate} {holder}'],
```

In `M.ru`, after its `ciUnavailable` entry, add:

```js
    gateWait: ['Фаза {phase} ждёт {gate}', 'Общий ресурс {gate} занят фазой {holder}; фаза {phase} ждала его {minutes} мин. Её полоса попробует ещё раз, затем спросит вас. Освободить вручную: turbo-run unlock {gate} {holder}'],
```

`bin/turbo-run.mjs`:
- Replace the config import line with `import { DEFAULTS, loadConfig, initConfig, deepMerge, fullEntries, laneGates, pushSettings } from '../lib/config.mjs';` (Task 11 extends it).
- Add `import { acquireGate, gateDeclaredBy, releaseGate } from '../lib/gate-locks.mjs';`.
- In `USAGE`, after `attend|`, insert `lock|unlock|`.
- In `VALUE_FLAGS`, add `'--wait-seconds'` (its value never names a project).
- Right before `case 'context': {`, add:

```js
    case 'lock':
    case 'unlock': {
      // spec §5 (Stage 4 L1, D13): one-off locks on shared resources; a lane runs them from its slot, and the lock
      // files live in the control root (locksDir)
      const LOCK_USAGE = 'usage: turbo-run lock <gate> <phase> [--wait-seconds <s>] | turbo-run unlock <gate> <phase>';
      if (!root) die('no .planning directory found');
      const [gate, phase] = pos;
      if (!gate || !phase || !PHASE_ID.test(phase)) die(LOCK_USAGE, 2);
      const config = runtimeConfig(loadConfig(root));
      const known = laneGates(config);
      if (!known.includes(gate)) die(`unknown gate ${gate} (known: ${known.join(', ')}; add your own in lanes.gates)\n${LOCK_USAGE}`, 2);
      const id = normalizePhaseId(phase);
      if (cmd === 'unlock') {
        const r = releaseGate(root, gate, id);
        if (r.released) out(`unlocked ${gate}`);
        else if (r.why === 'not-held') out(`${gate} is not locked`);
        else {
          process.stderr.write(`gate ${gate} is held by phase ${r.holder}, not ${id}; nothing changed\n`);
          return 1;
        }
        return 0;
      }
      const raw = flag(args, '--wait-seconds', '540');
      const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!(seconds >= 0 && seconds <= 86400)) die(`--wait-seconds takes a whole number of seconds from 0 to 86400\n${LOCK_USAGE}`, 2);
      const r = await acquireGate(root, gate, id, { waitMs: seconds * 1000, declaredBy: (g) => gateDeclaredBy(readJson(supPath(root), null), g, id) });
      if (r.acquired) {
        out(r.already ? `${gate} is already held by phase ${id}` : `locked ${gate} for phase ${id}`);
        return 0;
      }
      const h = r.holder;
      process.stderr.write(`gate ${gate} is held by phase ${h.phase ?? 'unknown'} since ${h.at ?? 'unknown'} (${h.by === 'lane' ? 'declared by its lane' : 'lock'}); waited ${seconds} s\n`);
      try {
        await notify(config, msg(config.lang, 'gateWait', { phase: id, gate, holder: h.phase ?? '?', minutes: Math.round(seconds / 60) }));
      } catch { /* best-effort: the lane sees exit 3 */ }
      return 3;
    }
```

(`die(text, code)` exits with `code`; `flag`, `pos`, `PHASE_ID`, `normalizePhaseId`, `supPath`, `readJson`, `notify`, `msg` exist in `bin/turbo-run.mjs`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/gate-locks.test.mjs test/lane-prompt.test.mjs test/notify.test.mjs test/lane-mode.test.mjs`
Expected: PASS (`lane-mode` pins the v0.3 prompts: unchanged without `slots`).

- [ ] **Step 5: Commit**

```bash
git add lib/gate-locks.mjs lib/lane-prompt.mjs lib/messages.mjs bin/turbo-run.mjs test/gate-locks.test.mjs test/lane-prompt.test.mjs test/notify.test.mjs
git commit -q -m "feat(lanes): turbo-run lock and unlock for shared resources, and the lanes' lock rule"
```

---

### Task 6: Loading L2's and L3's modules (`lib/lane-plugins.mjs`)

**Files:**
- Create: `lib/lane-plugins.mjs`, `test/lane-plugins.test.mjs`

**Interfaces:**
- Consumes: nothing of turbo.
- Produces: `PLUGIN_FILES = { merge: 'merge.mjs', prep: 'prep.mjs', lanesFile: 'lanes-file.mjs' }`; `loadLanePlugins({ importer, base } = {}) → Promise<{ mergeReady, pendingJobs, jobPrompts, finishJob, readLanesFile }>` — each the module's function or `null` when its file does not exist; a module that fails to load for any other reason (including a missing file **it** imports), or that lacks one of the pinned exports, rejects.

- [ ] **Step 1: Write the failing test**

Create `test/lane-plugins.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PLUGIN_FILES, loadLanePlugins } from '../lib/lane-plugins.mjs';

const notFound = (file) => Object.assign(new Error(`Cannot find module '${file}' imported from ${fileURLToPath(import.meta.url)}`), { code: 'ERR_MODULE_NOT_FOUND' });
const absent = async (href) => { throw notFound(fileURLToPath(href)); };
const FNS = {
  mergeReady: async () => ({ outcome: 'wait' }),
  pendingJobs: () => [],
  jobPrompts: () => ({ prompt: 'p', systemPrompt: 's' }),
  finishJob: async () => ({ outcome: 'wait' }),
  readLanesFile: () => null,
};

test('loadLanePlugins: a module that does not exist yet is null; one that exists gives its functions (D14)', async () => {
  assert.deepEqual(PLUGIN_FILES, { merge: 'merge.mjs', prep: 'prep.mjs', lanesFile: 'lanes-file.mjs' });
  assert.deepEqual(await loadLanePlugins({ importer: absent }), { mergeReady: null, pendingJobs: null, jobPrompts: null, finishJob: null, readLanesFile: null });
  const all = await loadLanePlugins({ importer: async () => FNS });
  for (const [name, fn] of Object.entries(FNS)) assert.equal(all[name], fn, name);
  const seen = [];
  await loadLanePlugins({ importer: async (href) => { seen.push(href.split('/').pop()); return FNS; } });
  assert.deepEqual(seen, ['merge.mjs', 'prep.mjs', 'lanes-file.mjs']);
  const onlyMerge = await loadLanePlugins({ importer: async (href) => (href.endsWith('/merge.mjs') ? FNS : absent(href)) });
  assert.deepEqual([onlyMerge.mergeReady === FNS.mergeReady, onlyMerge.pendingJobs, onlyMerge.readLanesFile], [true, null, null]);
});

test('loadLanePlugins: a module that fails inside, or lacks a pinned export, is an error, never silently off', async () => {
  // merge.mjs exists but imports a file that does not: the message names that file, not merge.mjs
  const inner = async (href) => {
    if (href.endsWith('/merge.mjs')) throw Object.assign(new Error(`Cannot find module '${fileURLToPath(new URL('./git-merge.mjs', href))}' imported from ${fileURLToPath(href)}`), { code: 'ERR_MODULE_NOT_FOUND' });
    return absent(href);
  };
  await assert.rejects(loadLanePlugins({ importer: inner }), /git-merge\.mjs/);
  await assert.rejects(loadLanePlugins({ importer: async (href) => (href.endsWith('/prep.mjs') ? { pendingJobs: () => [] } : absent(href)) }), /^Error: lib\/prep\.mjs does not export the function jobPrompts \(Stage 4 L1 interface\)$/);
  await assert.rejects(loadLanePlugins({ importer: async () => { throw new SyntaxError('Unexpected token'); } }), /Unexpected token/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/lane-plugins.test.mjs`
Expected: FAIL — `Cannot find module '…/lib/lane-plugins.mjs'`.

- [ ] **Step 3: Implement**

Create `lib/lane-plugins.mjs`:

```js
import path from 'node:path';

// spec §11 (Stage 4 L1, D14): the modules of the sibling sub-projects, loaded when they exist: L2's merge
// (lib/merge.mjs mergeReady), L3's jobs (lib/prep.mjs pendingJobs, jobPrompts, finishJob) and lane annotation
// (lib/lanes-file.mjs readLanesFile). Without L2 a ready lane waits; without L3 there are no jobs and no annotation
// (one phase lane at a time). Only "this very file does not exist" is null: a file it imports that is missing, any
// other load error, or a missing export this plan pins is an error.
export const PLUGIN_FILES = Object.freeze({ merge: 'merge.mjs', prep: 'prep.mjs', lanesFile: 'lanes-file.mjs' });
const EXPORTS = Object.freeze({ merge: ['mergeReady'], prep: ['pendingJobs', 'jobPrompts', 'finishJob'], lanesFile: ['readLanesFile'] });
const NOT_FOUND = /Cannot find (?:module|package) '([^']+)'/;

function missingItself(err, file) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') return false;
  const m = NOT_FOUND.exec(String(err.message ?? ''));
  return Boolean(m) && path.basename(m[1].replace(/^file:\/\//, '')) === file;
}

export async function loadLanePlugins({ importer = (href) => import(href), base = import.meta.url } = {}) {
  const out = { mergeReady: null, pendingJobs: null, jobPrompts: null, finishJob: null, readLanesFile: null };
  for (const [part, file] of Object.entries(PLUGIN_FILES)) {
    let mod;
    try {
      mod = await importer(new URL(`./${file}`, base).href);
    } catch (err) {
      if (missingItself(err, file)) continue;
      throw err;
    }
    for (const name of EXPORTS[part]) {
      if (typeof mod?.[name] !== 'function') throw new Error(`lib/${file} does not export the function ${name} (Stage 4 L1 interface)`);
      out[name] = mod[name];
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/lane-plugins.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/lane-plugins.mjs test/lane-plugins.test.mjs
git commit -q -m "feat(lanes): load the merge and job modules of the sibling sub-projects when they exist"
```

---

### Task 7: Supervisor helpers learn where a lane runs (checkout unchanged)

**Files:**
- Modify: `lib/supervisor.mjs` (imports; `laneAgents`, `startLane`, `wakeSession`, `relaunchAfterFailedWake`, `currentAsk`, `wakeForAnswers`, `replied`, `checkStall`; new `placeOf`, `lname`, `notePhase`, `jobPromptsOf`, `wakePrompt`, `sharedStatus`; `step`'s status branches)
- Test: `test/supervisor.test.mjs` (import line, then append)

**Interfaces:**
- Consumes: `laneCwd`, `recordKey` (Task 4), `laneSystemPrompt({ …, slots })` (Task 5), `answerWakePrompt`, `stallWakePrompt`.
- Produces: `placeOf(ctx, lane) → { key, job, phase, cwd, controlRoot }` (exported); `wakePrompt(ctx, lane, wake) → string` (exported; `wake = { kind: 'answers', ids, lane } | { kind: 'stall', minutes }`); `startLane(phase, agents, ctx, { resume, exclude, at, place })` (private; `place` defaults to v0.3's lane of `phase.number`); `sharedStatus(ctx, lane, phase, record, status, agent, now, at) → Promise<boolean>` (private: running, blocked, stall and needs-owner, both modes). Every v0.3 log line and notification stays byte-identical for a lane without `job`/`slotPath`.

- [ ] **Step 1: Write the failing test**

In `test/supervisor.test.mjs`, replace `import { tick, runDaemon, resumableLane } from '../lib/supervisor.mjs';` with:

```js
import { tick, runDaemon, resumableLane, placeOf, wakePrompt } from '../lib/supervisor.mjs';
import { answerWakePrompt, stallWakePrompt } from '../lib/wake.mjs';
```

Append:

```js
test('placeOf: v0.3\'s lane runs in this checkout as phase <N>; a slot lane in its slot, with the control root for its session (Stage 4 L1)', () => {
  const ctx = { root: path.resolve('/home/dev/app') };
  const slot = path.resolve('/home/dev/app.turbo/lane-2');
  assert.deepEqual(placeOf(ctx, { phase: '3' }), { key: '3', job: 'phase', phase: '3', cwd: ctx.root, controlRoot: null });
  assert.deepEqual(placeOf(ctx, { key: '34', job: 'phase', phase: '34', slotPath: slot }), { key: '34', job: 'phase', phase: '34', cwd: slot, controlRoot: ctx.root });
  assert.deepEqual(placeOf(ctx, { key: 'prep-4', job: 'prep', phase: '4', slotPath: slot }), { key: 'prep-4', job: 'prep', phase: '4', cwd: slot, controlRoot: ctx.root });
  assert.deepEqual(placeOf(ctx, { key: 'annotate', job: 'annotate', phase: null, slotPath: slot }), { key: 'annotate', job: 'annotate', phase: null, cwd: slot, controlRoot: ctx.root });
});

test('wakePrompt: a phase lane gets v0.3\'s wake prompts; a job lane asks the job module, with the wake (Stage 4 L1)', () => {
  const ctx = { root: path.resolve('/home/dev/app'), turboRun: 'node x', deps: { jobPrompts: ({ lane, resume, wake }) => ({ prompt: `${lane.key} ${resume} ${wake.kind}`, systemPrompt: 's' }) } };
  assert.equal(wakePrompt(ctx, { phase: '3', mode: 'full' }, { kind: 'stall', minutes: 16 }), stallWakePrompt({ phase: '3', turboRun: 'node x', mode: 'full', minutes: 16 }));
  assert.equal(wakePrompt(ctx, { phase: '3' }, { kind: 'stall', minutes: 16 }), stallWakePrompt({ phase: '3', turboRun: 'node x', mode: undefined, minutes: 16 }));
  assert.equal(wakePrompt(ctx, { phase: '3', mode: 'full' }, { kind: 'answers', ids: ['03-01-t2'], lane: [] }), answerWakePrompt({ phase: '3', turboRun: 'node x', ids: ['03-01-t2'], lane: [], mode: 'full' }));
  const prep = { key: 'prep-4', job: 'prep', phase: '4', slotPath: path.resolve('/home/dev/app.turbo/lane-1') };
  assert.equal(wakePrompt(ctx, prep, { kind: 'stall', minutes: 16 }), 'prep-4 true stall');
  assert.throws(() => wakePrompt({ ...ctx, deps: {} }, prep, { kind: 'stall', minutes: 1 }), /^Error: no prep\/annotate support \(lib\/prep\.mjs\) for lane prep-4$/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/supervisor.test.mjs`
Expected: FAIL — `does not provide an export named 'placeOf'`.

- [ ] **Step 3: Implement**

`lib/supervisor.mjs`:

1. Imports. Replace `import { answerWakePrompt, stallWakePrompt } from './wake.mjs';` with the same line and add right after it:

```js
import { laneCwd, recordKey } from './lanes-state.mjs';
```

2. Replace the whole `laneAgents` function (with its comment) by:

```js
// Sessions of a lane: its name AND started in its directory (this checkout, or its slot). An empty cwd never matches
// (it would resolve to the supervisor's own working directory).
function laneAgents(agents, name, cwd, exclude) {
  const home = dirKey(cwd);
  return agents.filter((a) => a.id !== exclude && a.name === name && Boolean(a.cwd) && dirKey(a.cwd) === home);
}

// Where a lane runs (Stage 4 L1): v0.3's lane (no slotPath) in this checkout under its phase; a slot lane in its slot,
// under its own key and job, with the control root in its session env (L0 D16).
export function placeOf(ctx, lane) {
  return {
    key: lane?.key ?? String(lane.phase),
    job: lane?.job || 'phase',
    phase: lane?.phase == null ? null : String(lane.phase),
    cwd: laneCwd(ctx.root, lane),
    controlRoot: lane?.slotPath ? ctx.root : null,
  };
}

// How logs and notifications name a lane: v0.3's words for a phase lane; a job by its key, its phase with its kind.
const lname = (lane) => (!lane.job || lane.job === 'phase' ? `phase ${lane.phase}` : `lane ${lane.key}`);
const notePhase = (lane) => (!lane.job || lane.job === 'phase' ? lane.phase : `${lane.phase ?? '-'} (${lane.job})`);

// A job lane's prompts come from L3's job module (lib/prep.mjs jobPrompts, Interfaces for L2–L4).
function jobPromptsOf(ctx, place, { resume, wake }) {
  if (!ctx.deps.jobPrompts) throw new Error(`no prep/annotate support (lib/prep.mjs) for lane ${place.key}`);
  return ctx.deps.jobPrompts({ ctx, lane: { key: place.key, job: place.job, phase: place.phase, slotPath: place.cwd }, resume, wake });
}

// The prompt that wakes a lane's own conversation: v0.3's for a phase lane, the job module's for prep and annotate.
export function wakePrompt(ctx, lane, wake) {
  if (!lane.job || lane.job === 'phase') {
    return wake.kind === 'answers'
      ? answerWakePrompt({ phase: lane.phase, turboRun: ctx.turboRun, ids: wake.ids, lane: wake.lane, mode: lane.mode === 'full' ? 'full' : 'safe' })
      : stallWakePrompt({ phase: lane.phase, turboRun: ctx.turboRun, mode: lane.mode, minutes: wake.minutes });
  }
  return jobPromptsOf(ctx, placeOf(ctx, lane), { resume: true, wake }).prompt;
}
```

3. Replace the whole `startLane` function (keep the comment block above it) by:

```js
function startLane(phase, agents, ctx, { resume, exclude, at, place = placeOf(ctx, { phase: phase.number }) }) {
  const { root, config, turboRun, deps } = ctx;
  const name = laneSessionName(root, place.key);
  const what = place.job === 'phase' ? `phase ${place.phase}` : `lane ${place.key}`;
  const mine = laneAgents(agents, name, place.cwd, exclude);
  const alive = mine.find(isAgentAlive);
  if (alive) {
    deps.log(`adopt ${what} session ${alive.id}`);
    return { sessionId: alive.id, name, launchedAt: startedAtIso(alive, at) || at, adopted: true };
  }
  for (const dead of mine.filter((a) => !isAgentAlive(a)).slice(0, MAX_DEAD_REMOVED)) removeSession(ctx, dead.id);
  // A daemon whose lease was revoked mid-tick (stop, resume, another start) launches nothing: the
  // lease check after this tick ends it. Not a launch failure.
  if (deps.leaseHeld && !deps.leaseHeld()) throw Object.assign(new Error(`launch ${what} skipped: lease lost`), { leaseLost: true });
  // review 1: a fresh lane drops the phase's stale lane questions (its steps ask again)
  if (!resume && place.job === 'phase') {
    try {
      const dropped = dropLaneQuestions(root, place.phase);
      if (dropped.length) deps.log(`phase ${place.phase}: dropped its questions ${dropped.join(', ')} (the restarted step asks again)`);
    } catch (err) {
      deps.log(`phase ${place.phase}: its lane questions were not dropped: ${errLine(err)}`);
    }
  }
  let sessionId = null;
  try {
    // the session's TMP, TEMP and TMPDIR, emptied of what an earlier session of the lane left
    const tmpDir = prepareLaneTmp(root, place.key, deps.log);
    const prompts = place.job === 'phase'
      ? {
        prompt: laneUserPrompt({ phase: place.phase, resume, mode: ctx.mode, turboRun, ...(resume ? undelivered(root, place.phase) : {}) }),
        systemPrompt: laneSystemPrompt({ phase: place.phase, turboRun, contextPct: config.context_stop_pct, autonomy: config.autonomy, mode: ctx.mode, tmpDir, pushMode: config.push?.mode, slots: Boolean(place.controlRoot) }),
      }
      : jobPromptsOf(ctx, place, { resume, wake: null });
    sessionId = deps.claude.launchBg({
      name,
      prompt: prompts.prompt,
      systemPrompt: prompts.systemPrompt,
      permissionMode: config.lane_permission_mode,
      model: config.lane_model,
      tmpDir,
      ...(place.controlRoot ? { controlRoot: place.controlRoot } : {}),
    }, place.cwd);
    // Written only after a successful launch: a failed launch leaves the lane record
    // (paused-context, needs-owner) as it was, so the next tick reaches the same decision.
    writeLaneStatus(root, recordKey(place), 'running', { sessionId, at });
    deps.log(`launch ${what} session ${sessionId}${resume ? ' (resume)' : ''}`);
  } catch (err) {
    // Any error from the launch on counts toward MAX_LAUNCH_FAILURES: a session that starts but whose
    // lane record cannot be written would otherwise be launched again on every tick, unbounded.
    const fail = sessionId ? `session ${sessionId} started, then ${err.message}` : err.message;
    throw Object.assign(new Error(`launch ${what} failed: ${fail}`, { cause: err }), { launchFailed: true, phase: place.key });
  }
  return { sessionId, name, launchedAt: at, adopted: false };
}
```

4. Replace the whole `wakeSession` function body (keep its comment) by:

```js
function wakeSession(ctx, lane, prompt) {
  const { deps } = ctx;
  const cwd = laneCwd(ctx.root, lane);
  // the transcript's session id from the job state, read while the lane is idle (§5.5.1 step 5); else the job id
  const target = deps.lanes?.session(lane.sessionId, cwd) || lane.sessionId;
  let why = '';
  for (let attempt = 1; attempt <= WAKE_ATTEMPTS; attempt++) {
    try {
      deps.claude.stop(lane.sessionId);
    } catch (err) {
      deps.log(`wake ${lname(lane)}: stop ${lane.sessionId}: ${errLine(err)}`);
      if (mayRun(deps, lane.sessionId)) {
        why = errLine(err);
        deps.log(`wake ${lname(lane)} attempt ${attempt}: session ${lane.sessionId} may still run; not resumed (that would only start a copy)`);
        continue;
      }
    }
    let r;
    try {
      r = parseResume(deps.claude.resume(target, prompt, cwd), { jobId: lane.sessionId, sessionId: target });
    } catch (err) {
      why = errLine(err);
      deps.log(`wake ${lname(lane)} attempt ${attempt}: ${why}`);
      continue;
    }
    if (r.woke) {
      deps.log(`wake ${lname(lane)}: woke session ${lane.sessionId}`);
      return { woke: true, why: '' };
    }
    if (!r.copyId) {
      why = 'claude reported neither a wake nor a copy';
      deps.log(`wake ${lname(lane)} attempt ${attempt}: ${why}`);
      continue;
    }
    why = `claude started a copy ${r.copyId}`;
    deps.log(`wake ${lname(lane)} attempt ${attempt}: started a copy ${r.copyId}; stopped and removed`);
    for (const f of ['stop', 'rm']) {
      try {
        deps.claude[f](r.copyId);
      } catch (err) {
        deps.log(`${f} copy ${r.copyId}: ${errLine(err)}`);
      }
    }
  }
  return { woke: false, why };
}
```

5. Replace the whole `relaunchAfterFailedWake` function body (keep its comment) by:

```js
async function relaunchAfterFailedWake(ctx, lane, phase, at) {
  const { deps, root } = ctx;
  if (await holdDowngradedLane(lane, ctx, phase, readLaneStatus(root, recordKey(lane)))) return 'held';
  deps.log(`wake ${lname(lane)}: the session did not wake; starting a new session (continuation path)`);
  // a session still listed, in any state (claude agents may report a live one as ended), goes first and its rm must
  // succeed; an unlisted one is gone already; an unreadable list counts as listed
  let listed = true;
  try {
    listed = deps.claude.list().some((a) => a.id === lane.sessionId);
  } catch { /* unknown: remove it */ }
  if (listed) {
    try {
      deps.claude.rm(lane.sessionId);
    } catch (err) {
      deps.log(`wake ${lname(lane)}: session ${lane.sessionId} was not removed (${errLine(err)}) and may still run; no new session next to it`);
      return 'kept';
    }
  }
  // listed again: the copies just removed must not be adopted
  const { adopted, ...started } = startLane(phase, deps.claude.list(), ctx, { resume: true, exclude: lane.sessionId, at, place: placeOf(ctx, lane) });
  Object.assign(lane, started, { notified: {}, blockedSince: null, mode: relaunchMode(lane, adopted, ctx) });
  return 'relaunched';
}
```

6. In `currentAsk`, replace `readLaneStatus(root, lane.phase)` with `readLaneStatus(root, recordKey(lane))`.

7. Replace the whole `wakeForAnswers` function body (keep its comment) by:

```js
async function wakeForAnswers(ctx, lane, phase, at) {
  const { deps, root } = ctx;
  if (!deps.claude.resume) return false;
  const { waiting, ready } = deliveryState(root, recordKey(lane), { ask: currentAsk(root, lane) });
  if (waiting.length || !ready.length) return false;
  const ids = ready.map((q) => q.id);
  // the same answers: each question's revision and the time of its answer (a checkpoint that stopped again and got a
  // new answer is a new set, D13)
  const key = ready.map((q) => `${q.id}:${q.rev || 1}:${q.answer?.at ?? ''}`).join(',');
  const count = lane.woken?.key === key ? lane.woken.count : 0;
  if (count >= ANSWER_WAKES) {
    if (lane.woken.failed && !lane.woken.told) {
      deps.log(`${lname(lane)}: the answers to ${ids.join(', ')} did not reach session ${lane.sessionId} in ${count} tries; waiting for the owner`);
      await deps.notify('laneNeedsOwner', { phase: notePhase(lane), reason: `the answers to ${ids.join(', ')} did not reach session ${lane.sessionId} (${lane.woken.failed})` });
      lane.woken.told = true;
    }
    return false;
  }
  deps.log(`${lname(lane)}: the owner answered ${ids.join(', ')}; waking session ${lane.sessionId}`);
  lane.woken = { key, count: count + 1, at };
  // v0.3.3 (D4): a question the lane asked itself goes to the lane, named with the chosen option
  const own = ready.filter((q) => q.source === 'lane').map((q) => ({ id: q.id, option: q.answer?.option ?? null, label: q.answer?.label ?? null }));
  const cps = ready.filter((q) => q.source !== 'lane').map((q) => q.id);
  const w = wakeSession(ctx, lane, wakePrompt(ctx, lane, { kind: 'answers', ids: cps, lane: own }));
  if (w.woke) {
    // its needs-owner record is older than this: it no longer counts
    Object.assign(lane, { launchedAt: at, notified: {}, blockedSince: null });
    return true;
  }
  const outcome = await relaunchCounted(ctx, lane, phase, at, (why) => ({ woken: { ...lane.woken, failed: why } }));
  if (outcome === 'kept') lane.woken.failed = w.why || 'the session could not be stopped or removed';
  return true;
}
```

8. Replace the whole `replied` function (keep its comment) by:

```js
function replied(ctx, lane, sinceMs) {
  try {
    return Boolean(ctx.deps.lanes.replied?.(lane.sessionId, sinceMs, laneCwd(ctx.root, lane)));
  } catch (err) {
    ctx.deps.log(`${lname(lane)}: reply check failed: ${errLine(err)}`);
    return false;
  }
}
```

9. Replace the whole `checkStall` function body (keep its comment) by:

```js
async function checkStall(ctx, lane, phase, now, at) {
  const { deps } = ctx;
  // a full lane under a safe-mode supervisor waits for the owner (holdDowngradedLane), never for a wake
  if (!deps.lanes || !deps.claude.resume || (lane.mode === 'full' && laneMode(ctx) !== 'full')) return null;
  const stall = stallMs(ctx.config);
  let live;
  try {
    live = deps.lanes.activity(lane.sessionId, now, stall, laneCwd(ctx.root, lane));
  } catch (err) {
    deps.log(`${lname(lane)}: activity check failed: ${errLine(err)}`);
    return null;
  }
  if (!live || live.lastMs === null) return live;
  const wokenAt = Date.parse(lane.stall?.at);
  // D13: progress after a wake is what the woken session did itself, an answer of its own; the wake prompt it records
  // (and what claude stop writes) moves the transcript's time too, so a write alone is no progress
  if (Number.isFinite(wokenAt) && live.lastMs > wokenAt && replied(ctx, lane, wokenAt)) {
    lane.stall = null;
    lane.notified.stalled = false;
  }
  const since = Math.max(live.lastMs, Date.parse(lane.launchedAt) || 0, lane.stall && Number.isFinite(wokenAt) ? wokenAt : 0);
  if (live.active || now - since < stall) return live;
  const minutes = Math.floor((now - live.lastMs) / 60000);
  const count = lane.stall?.count || 0;
  if (count >= MAX_STALL_WAKES) {
    if (!lane.notified.stalled) {
      deps.log(`${lname(lane)}: no transcript write for ${minutes} min, also after ${count} wakes`);
      await deps.notify('laneStalled', { phase: notePhase(lane), minutes, wakes: count, id: lane.sessionId });
      lane.notified.stalled = true;
    }
    return live;
  }
  deps.log(`${lname(lane)}: no transcript write for ${minutes} min; waking session ${lane.sessionId}`);
  lane.stall = { count: count + 1, at };
  const w = wakeSession(ctx, lane, wakePrompt(ctx, lane, { kind: 'stall', minutes }));
  if (w.woke) Object.assign(lane, { notified: {}, blockedSince: null });
  else await relaunchCounted(ctx, lane, phase, at, () => ({ stall: lane.stall }));
  return 'woken';
}
```

10. Right before `// One supervisor step; mutates s.`, add:

```js
// The part of a lane's step both modes share (spec §5.5): stall wakes, a blocked lane's wait, the owner's answers.
// true when it handled the status (running, blocked, needs-owner); done, paused-context and failed are the caller's.
async function sharedStatus(ctx, lane, phase, record, status, agent, now, at) {
  const { config, deps } = ctx;
  // spec §5.5.6: alive but silent for stall_minutes → woken; a turn that ended while subagents still work waits for
  // them. A blocked lane under a safe-mode supervisor, or one that runs gsd-autonomous, waits for the owner as before
  // (laneBlocked) and is never stall-woken: there a turn that ended is gsd-autonomous asking in its text.
  const ownersBlock = status === 'blocked' && (laneMode(ctx) !== 'full' || lane.mode !== 'full');
  if ((status === 'running' || status === 'blocked') && !ownersBlock) {
    const live = await checkStall(ctx, lane, phase, now, at);
    if (live === 'woken') return true;
    if (status === 'blocked' && live?.active) {
      lane.blockedSince = null;
      lane.notified.blocked = false;
      return true;
    }
  }
  if (status === 'running') {
    lane.blockedSince = null;
    lane.notified.blocked = false;
    return true;
  }
  if (status === 'blocked') {
    // a full lane that finished its turn on a phase GSD completed waits for full mode, never as a generic block
    if (turnEnded(agent) && await holdDowngradedLane(lane, ctx, phase, record)) return true;
    lane.blockedSince ||= at;
    const waited = (now - Date.parse(lane.blockedSince)) / 60000;
    if (waited >= config.blocked_minutes_before_notify && !lane.notified.blocked) {
      deps.log(`${lname(lane)} blocked for ${Math.floor(waited)} min`);
      await deps.notify('laneBlocked', { phase: notePhase(lane), id: lane.sessionId });
      lane.notified.blocked = true;
    }
    return true;
  }
  if (status === 'needs-owner') {
    // spec §5.5.1: the owner's answers are in → the same conversation goes on
    if (await wakeForAnswers(ctx, lane, phase, at)) return true;
    if (!lane.notified.owner) {
      // v0.3.3 (D3): a question the lane asked (turbo-run ask) reaches the owner as its plain question (owner-tick's
      // questionsReady, the pane's card, Telegram): no second notification with the lane's reason
      const asked = deliveryState(ctx.root, recordKey(lane), { ask: currentAsk(ctx.root, lane) }).waiting.filter((q) => q.source === 'lane').map((q) => q.id);
      if (asked.length) deps.log(`${lname(lane)} needs the owner: question ${asked.join(', ')} waits for the answer`);
      else {
        deps.log(`${lname(lane)} needs the owner`);
        const own = record?.status === 'needs-owner' && record.reason && isFresh(record, lane.launchedAt);
        await deps.notify('laneNeedsOwner', { phase: notePhase(lane), reason: own ? record.reason : 'human verification' });
      }
      lane.notified.owner = true;
    }
    return true;
  }
  return false;
}
```

11. In `step`, delete everything from the comment line `  // spec §5.5.6: alive but silent for stall_minutes → woken; a turn that ended while subagents still work waits for` through the closing brace of the `if (status === 'blocked') {` block (the line `    return;\n  }` right before `  if (status === 'done') return finishLane(s, ctx, agent);`), and put in its place:

```js
  if (await sharedStatus(ctx, lane, phase, record, status, agent, now, at)) return;
```

Then delete the whole `  if (status === 'needs-owner') {` block of `step` (through its closing `  }`, right before `  deps.log(\`phase ${lane.phase} failed: session ${lane.sessionId}\`);`). The order of `step` is then: forced relaunch, missing phase, `inferStatus`, unknown state, `sharedStatus`, `done`, `paused-context`, failed — the statuses are exclusive, so v0.3's behaviour is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/supervisor.test.mjs test/supervisor-wake.test.mjs test/e2e-supervisor.test.mjs test/lane-mode.test.mjs`
Expected: PASS — the two new tests, and every v0.3 test unchanged (their logs, prompts, cwd and notifications are byte-identical for a lane without `job`/`slotPath`).

- [ ] **Step 5: Commit**

```bash
git add lib/supervisor.mjs test/supervisor.test.mjs
git commit -q -m "refactor(supervisor): lane helpers take the lane's place (slot, key, job); checkout lanes unchanged"
```

---
### Task 8: Slots mode — several phase lanes, each stepped and stopped on its own

**Files:**
- Create: `test/helpers/lanes.mjs`, `test/supervisor-lanes.test.mjs`
- Modify: `lib/supervisor.mjs` (imports; `runEnd` extracted from `step`; new `haltLane`, `stopLane`, `holdAttended`, `laneStep`, `guarded`, `laneError`, `freeSlotFor`, `tellUntrusted`, `openLane`, `readAnnotation`, `schedule`, `settle`, `stepSlots`; `step` dispatches), `lib/messages.mjs` (`laneStopped`, `slotUntrusted`, `slotRefused`; `W.*.stopWhy`; `PREPARE.laneStopped`)

**Interfaces:**
- Consumes: `annotationOf`, `pickPhases` (Task 2); `laneKey`, `recordKey`, `laneCwd`, `compareLanes` (Task 4); `heldGates` (Task 5); `placeOf`, `startLane`, `sharedStatus`, `lname` (Task 7); L0's `maxLanes(config)`; `ctx.deps.slots` (Contracts).
- Produces: `ctx.lanes === 'slots'` makes `step` run `stepSlots` on `s.lanes`; every entry has the Contracts' shape; `s.next`, `s.slotRefused`, `s.slotNotes`; notifications `laneStopped { phase, why, slot, error }`, `slotUntrusted { k, line }`, `slotRefused { k, why, minutes }`. `stopLane(s, ctx, lane, agent, why, at, extra)` is the one place Task 9 routes jobs through. Test helper `test/helpers/lanes.mjs`: `P`, `A`, `annotated`, `freshLanes`, `lanesHarness({ phases, slots, maxLanes, lanes, merge, jobs, finish })` (fields below).

- [ ] **Step 1: Write the test helper and the failing tests**

Create `test/helpers/lanes.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './tmp.mjs';
import { DEFAULTS } from '../../lib/config.mjs';
import { laneSessionName } from '../../lib/claude.mjs';

// lane temp directories live under turbo's own directory: a throwaway Claude home for the whole test file
process.env.CLAUDE_CONFIG_DIR = tmpDir('lanes-home');

export const P = (number, deps = [], complete = false) => ({ number, deps, complete, verification: null });
export const A = (areas, gates = [], confidence = 'high') => ({ areas: Array.isArray(areas) ? areas : [areas], gates, confidence });
export const annotated = (phases) => ({ fresh: true, phases });
export const freshLanes = () => ({ lanesMode: 'slots', lanes: {}, finished: false, halted: false });

const branchOf = (job) => (job.kind === 'phase' ? `turbo/p${job.phase}` : job.kind === 'prep' ? `turbo/prep-${job.phase}` : 'turbo/annotate');

// A slots-mode supervisor context with every outside dependency faked: claude sessions, slots (in memory, with real
// empty directories), L2's merge, L3's jobs and annotation. Nothing reaches git, a real claude or the network.
// h.trust[k] = false: slot k is not trusted; h.refuse[k] = why: its preparation throws; h.launchFail(opts, cwd) → why.
// merge(lane, h), jobs(options, h), finish(lane, h): the fakes of mergeReady, pendingJobs and finishJob (null: absent).
export function lanesHarness({ phases, slots = 3, maxLanes = 3, lanes = null, merge = null, jobs = null, finish = null } = {}) {
  const base = tmpDir('lanes');
  const root = path.join(base, 'app');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  let clock = Date.parse('2026-01-01T00:00:00Z');
  let n = 0;
  const prefix = laneSessionName(root, '');
  const h = {
    root, phases, annotation: lanes,
    agents: [], launched: [], removed: [], stopped: [], resumed: [], notes: [], logs: [], events: [],
    merges: [], finishes: [], released: [], prepared: [],
    trust: {}, refuse: {}, fp: 'A', launchFail: () => null,
    advance(min) { clock += min * 60000; },
    at() { return new Date(clock).toISOString(); },
    slots: Array.from({ length: slots }, (_, i) => {
      const p = path.join(base, 'app.turbo', `lane-${i + 1}`);
      fs.mkdirSync(p, { recursive: true });
      return { k: i + 1, path: p, job: null };
    }),
  };
  const slotOf = (k) => h.slots.find((x) => x.k === k);
  const active = (x) => x.job?.state === 'active';
  h.release = (k, outcome) => {
    const x = slotOf(k);
    x.job = { ...x.job, state: 'done', outcome };
    h.released.push([k, outcome]);
  };
  h.agentOf = (key) => h.agents.find((a) => a.name === laneSessionName(root, key) && a.state !== 'gone');
  h.ctx = {
    root, lanes: 'slots', mode: 'full', turboRun: 'node x',
    config: { ...structuredClone(DEFAULTS), max_lanes: maxLanes },
    deps: {
      loadPhases: () => h.phases,
      claude: {
        launchBg: (opts, cwd) => {
          const why = h.launchFail(opts, cwd);
          if (why) throw new Error(why);
          const id = `s${++n}`;
          h.launched.push({ id, cwd, ...opts });
          h.events.push(`launch ${opts.name.slice(prefix.length)}`);
          h.agents.push({ id, name: opts.name, cwd, state: 'working' });
          return id;
        },
        list: () => h.agents,
        stop: (id) => {
          h.stopped.push(id);
          const a = h.agents.find((x) => x.id === id);
          if (a) a.state = 'stopped';
        },
        rm: (id) => {
          h.removed.push(id);
          if (!h.agents.some((a) => a.id === id)) throw new Error(`claude rm failed: no session ${id}`);
          h.agents = h.agents.filter((a) => a.id !== id);
        },
        resume: (id, prompt, cwd) => {
          h.resumed.push({ id, prompt, cwd });
          return `note: woke session ${id}`;
        },
      },
      lanes: { session: (id) => id, activity: () => ({ lastMs: clock, active: 0 }), replied: () => false },
      slots: {
        list: () => h.slots.map((x) => ({ k: x.k, path: x.path, state: active(x) ? 'busy' : 'free', record: { control: root, job: x.job }, dirty: [] })),
        free: ({ skip = [] } = {}) => {
          const x = h.slots.find((y) => !active(y) && !skip.includes(y.k) && h.trust[y.k] !== false);
          return x ? { k: x.k, path: x.path, state: 'free' } : null;
        },
        untrusted: () => h.slots.filter((y) => !active(y) && h.trust[y.k] === false).map((y) => ({ k: y.k, path: y.path, line: `open claude in ${y.path} once and accept the trust dialog` })),
        prepare: (slot, job) => {
          h.prepared.push([slot.k, job.kind, job.phase]);
          if (h.refuse[slot.k]) throw Object.assign(new Error(h.refuse[slot.k]), { name: 'SlotRefused', code: 'dirty' });
          const x = slotOf(slot.k);
          x.job = { kind: job.kind, phase: job.phase, branch: branchOf(job), state: 'active' };
          return { k: x.k, path: x.path, branch: x.job.branch, base: { branch: 'main', sha: 'a'.repeat(40) } };
        },
        release: (k, outcome) => h.release(k, outcome),
        forJob: (phase, kind) => {
          const x = h.slots.find((y) => active(y) && y.job.kind === kind && (y.job.phase ?? null) === (phase ?? null));
          return x ? { k: x.k, path: x.path } : null;
        },
      },
      mergeReady: merge ? async (ctx, lane) => { h.merges.push(lane.key); h.events.push(`merge ${lane.key}`); return merge(lane, h); } : null,
      pendingJobs: jobs ? async (ctx, phases2, options) => jobs(options, h) : null,
      jobPrompts: ({ lane, resume, wake }) => ({ prompt: `${wake ? `Wake ${wake.kind}` : resume ? 'Resume' : 'Run'} ${lane.job} ${lane.phase ?? ''}`.trim(), systemPrompt: `job ${lane.key}` }),
      finishJob: finish ? async (ctx, lane) => { h.finishes.push(lane.key); return finish(lane, h); } : null,
      lanesFile: () => h.annotation,
      fingerprint: () => h.fp,
      notify: async (key, vars) => { h.notes.push({ key, vars }); },
      now: () => new Date(clock),
      log: (line) => { h.logs.push(line); },
    },
  };
  return h;
}
```

Create `test/supervisor-lanes.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A, P, annotated, freshLanes, lanesHarness } from './helpers/lanes.mjs';
import { tick } from '../lib/supervisor.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';
import { laneSessionName } from '../lib/claude.mjs';
import { writeAttend } from '../lib/attend.mjs';
import { acquireGate, releaseGate } from '../lib/gate-locks.mjs';
import { msg } from '../lib/messages.mjs';

test('two independent phases start together, each in its own slot, with the control root in its session; the dependent one waits (spec §5, §13)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2'), P('3', ['1'])], lanes: annotated({ 1: A('src/a/**'), 2: A('src/b/**'), 3: A('src/a/**') }) });
  const s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1', '2']);
  const l1 = s.lanes['1'];
  assert.deepEqual(
    [l1.key, l1.job, l1.phase, l1.slot, l1.slotPath, l1.branch, l1.sessionId, l1.launchedAt, l1.restarts, l1.mode, l1.areas, l1.gates, l1.launch],
    ['1', 'phase', '1', 1, h.slots[0].path, 'turbo/p1', 's1', h.at(), 0, 'full', ['src/a/**'], [], undefined],
  );
  assert.deepEqual(h.launched.map((l) => [l.cwd, l.controlRoot, l.name]), [
    [h.slots[0].path, h.root, laneSessionName(h.root, '1')],
    [h.slots[1].path, h.root, laneSessionName(h.root, '2')],
  ]);
  assert.equal(h.launched[0].prompt, 'Run the turbo-phase skill with arguments: 1');
  assert.match(h.launched[0].systemPrompt, /lock <gate> 1 /, 'slot lanes get the lock rule');
  assert.equal(readLaneStatus(h.root, '1').status, 'running');
  assert.deepEqual(s.next, { phase: '3', why: 'deps', waitsFor: ['1'] });
  assert.equal(s.lane, undefined, 'slots mode never writes v0.3\'s lane');
  assert.ok(h.logs.includes(`phase 1: slot 1 prepared on turbo/p1`), h.logs.join('\n'));
});

test('without a fresh annotation only one phase lane runs (spec §5)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2')] });
  let s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1']);
  assert.deepEqual(s.next, { phase: '2', why: 'annotation', waitsFor: ['1'] });
  h.annotation = { fresh: false, phases: { 1: A('a/**'), 2: A('b/**') } };
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1'], 'a stale annotation counts as none');
});

test('an error in one lane rolls back only that lane; ten failed launches stop it alone; an untrusted folder stops it at once (D6, D7; Review Focus 2)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2'), P('3')], lanes: annotated({ 1: A('a/**'), 2: A('b/**'), 3: A('c/**') }) });
  h.launchFail = (opts) => (opts.name === laneSessionName(h.root, '2') ? 'claude --bg failed: boom' : null);
  let s = await tick(freshLanes(), h.ctx);
  assert.deepEqual([s.lanes['1'].sessionId, s.lanes['2'].sessionId, s.lanes['3'].sessionId], ['s1', null, 's2']);
  assert.deepEqual([s.lanes['2'].launchFailures, s.lanes['2'].slot, s.lanes['2'].launch], [1, 2, 'new']);
  assert.equal(s.failingSince, undefined, 'a lane error never fails the tick');
  for (let i = 0; i < 9; i++) {
    h.advance(1);
    s = await tick(s, h.ctx);
  }
  assert.equal(s.lanes['2'].halted.why, 'launch');
  assert.match(s.lanes['2'].halted.error, /^launch phase 2 failed: claude --bg failed: boom$/);
  assert.deepEqual(h.notes.filter((x) => x.key === 'laneStopped').map((x) => [x.vars.phase, x.vars.why]), [['2', 'launch']]);
  assert.deepEqual(h.prepared.map((p) => p[2]), ['1', '2', '3'], 'the same slot is retried, never a second one');
  assert.equal(h.slots[1].job.state, 'active', 'its slot keeps the job');
  assert.equal(h.launched.length, 2);
  assert.equal(s.halted, false);
  const u = lanesHarness({ phases: [P('1')] });
  u.launchFail = () => 'claude --bg failed: Workspace not trusted';
  s = await tick(freshLanes(), u.ctx);
  assert.equal(s.lanes['1'].halted.why, 'untrusted');
  assert.equal(s.halted, true, 'every lane stopped and nothing can start');
});

test('a failed session or no progress stops only its lane; the run halts once every lane is stopped (spec §9)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2')], lanes: annotated({ 1: A('a/**'), 2: A('b/**') }) });
  h.ctx.config.max_restarts_without_progress = 0;
  let s = await tick(freshLanes(), h.ctx);
  h.agentOf('1').state = 'failed';
  h.agentOf('2').state = 'done'; // ended without a record and without a new commit: paused-context without progress
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual([s.lanes['1'].halted?.why, s.lanes['2'].halted?.why], ['failed', 'noProgress']);
  assert.equal(s.halted, true);
  assert.deepEqual(h.notes.map((x) => x.key), ['laneStopped', 'laneStopped']);
  assert.equal(msg('en', 'laneStopped', h.notes[0].vars).body, `The other lanes go on. To look inside: cd "${h.slots[0].path}" && claude. To try again: /turbo-autonomous resume 1`);
});

test('a slot Claude Code does not trust is never used (the owner is told once); a slot that refuses its preparation is skipped for a while (D10)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2')], slots: 2, lanes: annotated({ 1: A('a/**'), 2: A('b/**') }) });
  h.trust[1] = false;
  h.refuse[2] = 'uncommitted changes: M src/x.ts';
  let s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(s.lanes, {});
  assert.deepEqual(h.notes.map((x) => x.key), ['slotRefused', 'slotUntrusted']);
  assert.deepEqual(h.notes[0].vars, { k: 2, why: 'uncommitted changes: M src/x.ts', minutes: 10 });
  assert.deepEqual(h.notes[1].vars, { k: 1, line: `open claude in ${h.slots[0].path} once and accept the trust dialog` });
  assert.deepEqual(s.next, { phase: '1', why: 'slots', waitsFor: [] });
  assert.equal(s.halted, false);
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(h.notes.length, 2, 'each told once');
  assert.equal(h.prepared.length, 1, 'the refused slot is skipped for blocked_minutes_before_notify');
  h.trust[1] = true;
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual([Object.keys(s.lanes), s.lanes['1'].slot], [['1'], 1]);
  delete h.refuse[2];
  h.advance(10);
  s = await tick(s, h.ctx);
  assert.deepEqual([Object.keys(s.lanes), s.lanes['2'].slot], [['1', '2'], 2]);
  assert.equal(s.slotRefused?.[2], undefined);
});

test('an attended lane is held alone: a late session of it is stopped, nothing relaunches or wakes it; the other lanes go on (D11; Review Focus 3)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2')], lanes: annotated({ 1: A('a/**'), 2: A('b/**') }) });
  let s = await tick(freshLanes(), h.ctx);
  writeAttend(h.root, '1', { sessionId: 's1' });
  // a launch or wake of an earlier tick that registered after attend stopped the listed sessions
  h.agents.push({ id: 'late', name: laneSessionName(h.root, '1'), cwd: h.slots[0].path, state: 'working' });
  h.agentOf('2').state = 'done'; // lane 2 ended its turn without a record: relaunched as usual
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual([...h.stopped].sort(), ['late', 's1']);
  assert.deepEqual(h.launched.map((l) => l.name), [laneSessionName(h.root, '1'), laneSessionName(h.root, '2'), laneSessionName(h.root, '2')]);
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual([...h.stopped].sort(), ['late', 's1'], 'a stopped session is not stopped again');
  assert.equal(h.logs.filter((l) => l.startsWith('phase 1 is attended in the owner\'s session')).length, 1);
  assert.equal(s.lanes['1'].sessionId, 's1');
});

test('Gates: a phase whose gate a running phase declares waits; one whose gate a lock holds waits until it is unlocked (spec §5)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2'), P('3')], lanes: annotated({ 1: A('a/**', ['prod-deploy']), 2: A('b/**', ['prod-deploy']), 3: A('c/**', ['packaged-build']) }) });
  await acquireGate(h.root, 'packaged-build', '9'); // the owner's own lock: only unlock frees it (D13)
  let s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1']);
  assert.deepEqual(s.lanes['1'].gates, ['prod-deploy']);
  assert.deepEqual(s.next, { phase: '2', why: 'gates', waitsFor: ['1'], gate: 'prod-deploy' });
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1']);
  releaseGate(h.root, 'packaged-build', '9');
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1', '3']);
});

test('laneStopped, slotUntrusted and slotRefused in en and ru', () => {
  const slot = 'C:\\Users\\dev\\app.turbo\\lane-2';
  assert.deepEqual(msg('en', 'laneStopped', { phase: '2', why: 'launch', slot, error: 'launch phase 2 failed: boom' }), {
    title: 'Phase 2 stopped: its session could not start',
    body: `Error: launch phase 2 failed: boom. The other lanes go on. To look inside: cd "${slot}" && claude. To try again: /turbo-autonomous resume 2`,
  });
  assert.equal(msg('ru', 'laneStopped', { phase: '2', why: 'failed', slot, error: '' }).title, 'Фаза 2 остановлена: её сессия завершилась сбоем');
  assert.equal(msg('ru', 'laneStopped', { phase: '2', why: 'failed', slot, error: '' }).body, `Остальные полосы продолжают работу. Посмотреть: cd "${slot}" && claude. Попробовать снова: /turbo-autonomous resume 2`);
  assert.deepEqual(msg('en', 'slotUntrusted', { k: 1, line: 'open claude in C:\\Users\\dev\\app.turbo\\lane-1 once and accept the trust dialog' }), {
    title: 'Lane slot 1 is not trusted yet',
    body: 'open claude in C:\\Users\\dev\\app.turbo\\lane-1 once and accept the trust dialog. Phases wait for a trusted slot meanwhile.',
  });
  assert.deepEqual(msg('ru', 'slotRefused', { k: 2, why: 'uncommitted changes', minutes: 10 }), {
    title: 'Слот полосы 2 нельзя использовать',
    body: 'uncommitted changes. В нём ничего не изменено; turbo попробует снова через 10 мин, а пока использует другие слоты.',
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/supervisor-lanes.test.mjs`
Expected: FAIL — the first test's `Object.keys(s.lanes)` throws (`s.lanes` undefined: v0.3's `step` ran and launched one lane into `s.lane`).

- [ ] **Step 3: Implement the messages**

`lib/messages.mjs` — in `M.en`, after `gateWait`, add:

```js
    laneStopped: [(v) => `Phase ${v('phase')} stopped: ${v('why')}`, (v) => [v('error') && `Error: ${v('error')}.`, 'The other lanes go on.', `To look inside: cd "${v('slot')}" && claude.`, `To try again: /turbo-autonomous resume ${v('phase')}`].filter(Boolean).join(' ')],
    slotUntrusted: ['Lane slot {k} is not trusted yet', '{line}. Phases wait for a trusted slot meanwhile.'],
    slotRefused: ['Lane slot {k} cannot be used', '{why}. Nothing in it was changed; turbo tries it again in {minutes} min and uses the other slots meanwhile.'],
```

In `M.ru`, after `gateWait`, add:

```js
    laneStopped: [(v) => `Фаза ${v('phase')} остановлена: ${v('why')}`, (v) => [v('error') && `Ошибка: ${v('error')}.`, 'Остальные полосы продолжают работу.', `Посмотреть: cd "${v('slot')}" && claude.`, `Попробовать снова: /turbo-autonomous resume ${v('phase')}`].filter(Boolean).join(' ')],
    slotUntrusted: ['Слоту полосы {k} пока нет доверия', '{line}. Пока его нет, фазы ждут доверенный слот.'],
    slotRefused: ['Слот полосы {k} нельзя использовать', '{why}. В нём ничего не изменено; turbo попробует снова через {minutes} мин, а пока использует другие слоты.'],
```

In `W.en`, after `ghError`, add:

```js
    stopWhy: { failed: 'its session failed', noProgress: 'no progress after restarts', launch: 'its session could not start', missing: 'it is no longer in the roadmap', untrusted: 'its slot is not trusted (open claude there once and accept the trust dialog)' },
```

In `W.ru`, after `ghError`, add:

```js
    stopWhy: { failed: 'её сессия завершилась сбоем', noProgress: 'нет продвижения после перезапусков', launch: 'её сессия не запускается', missing: 'её больше нет в ROADMAP.md', untrusted: 'слоту нет доверия (откройте там claude один раз и подтвердите доверие)' },
```

In `PREPARE`, add:

```js
  laneStopped: { why: (w, why) => w.stopWhy?.[why] ?? why },
```

- [ ] **Step 4: Implement slots mode in the supervisor**

`lib/supervisor.mjs`:

1. Imports. Replace `import { comparePhase, inRange, isFinished, nextPhase, rangeBlocker, rangeLabel, relaunchDecision } from './scheduler.mjs';` with:

```js
import { annotationOf, comparePhase, inRange, isFinished, nextPhase, pickPhases, rangeBlocker, rangeLabel, relaunchDecision } from './scheduler.mjs';
```

Replace `import { laneCwd, recordKey } from './lanes-state.mjs';` (Task 7) with:

```js
import { compareLanes, laneCwd, laneKey, recordKey } from './lanes-state.mjs';
import { heldGates } from './gate-locks.mjs';
import { maxLanes } from './slots.mjs';
```

2. In `step`, replace the block inside `if (!s.lane) {` from `    if (!p) {` through its closing `    }` (the block that ends with `      return;\n    }` right before `    delete s.noReady;`) with:

```js
    if (!p) {
      await runEnd(s, phases, scoped, range, deps);
      return;
    }
```

and right before `// One supervisor step; mutates s.` add `runEnd`, which holds that block's body unchanged:

```js
// No lane runs and none can start: an empty roadmap or range, a finished run, a dependency outside the range, or a
// dependency cycle. Shared by both modes.
async function runEnd(s, phases, scoped, range, deps) {
  if (!scoped.length) {
    // an empty list is a broken or empty roadmap, never a finished milestone; nor is an empty range a finished run
    if (!s.noPhases) deps.log(phases.length ? `no phase of the milestone is in the range ${rangeLabel(range)}; waiting` : 'no phases in the current milestone; waiting');
    s.noPhases = true;
  } else if (scoped.every(isFinished)) {
    if (range) {
      deps.log(`phases ${rangeLabel(range)} done`);
      await deps.notify('rangeDone', { range: rangeLabel(range) });
    } else {
      deps.log('milestone done');
      await deps.notify('milestoneDone', {});
    }
    s.finished = true;
  } else if (rangeBlocker(phases, range)) {
    // only the owner can change the range or finish the phase outside it
    const { phase, dep } = rangeBlocker(phases, range);
    deps.log(`phases ${rangeLabel(range)} wait: phase ${phase} depends on phase ${dep} outside the range, which is not finished; halted`);
    await deps.notify('rangeBlocked', { range: rangeLabel(range), phase, dep });
    s.halted = true;
  } else if (!s.noReady) {
    // every unfinished phase waits on another unfinished one: a dependency cycle
    const waiting = scoped.filter((x) => !isFinished(x)).map((x) => x.number);
    deps.log(`no ready phase: ${waiting.join(', ')} wait on each other; waiting for the roadmap to change`);
    await deps.notify('noReadyPhase', { phases: waiting.slice(0, 10).join(', ') });
    s.noReady = true;
  }
}
```

3. In `step`, add as its first statement (before `const { root, config, deps } = ctx;`):

```js
  // Stage 4 L1 (D1): slots mode runs several lanes from supervisor.json lanes; checkout mode is v0.3, below
  if (ctx.lanes === 'slots') return stepSlots(s, ctx, now);
```

4. Right before `// A failing tick (launch, agents list, GSD phases) keeps the previous state` (above `failedTick`), add:

```js
// ---- Stage 4 L1: slots mode (spec §5, §8, §9) ----

// spec §9 (D6): a phase lane that cannot go on stops alone; its slot keeps the work (the job stays active), its phase,
// areas and gates stay taken until the owner's resume N (or a new start) tries it again. The other lanes go on.
async function haltLane(ctx, lane, why, at, extra = {}) {
  if (lane.halted) return;
  lane.halted = { why, at, ...extra };
  ctx.deps.log(`${lname(lane)} stopped (${why}${extra.error ? `: ${extra.error}` : ''}); the other lanes go on`);
  await ctx.deps.notify('laneStopped', { phase: lane.phase, why, slot: lane.slotPath, error: extra.error || '' });
}

// The one way a slot lane that cannot go on stops.
async function stopLane(s, ctx, lane, agent, why, at, extra = {}) {
  return haltLane(ctx, lane, why, at, extra);
}

// spec §8 (D11): the owner runs this phase in its slot. A session of its lane that still runs (a launch or a wake of an
// earlier tick that registered after attend stopped the listed ones) is stopped; nothing starts, relaunches or wakes it.
function holdAttended(ctx, lane, agents) {
  const { deps, root } = ctx;
  for (const a of laneAgents(agents, laneSessionName(root, lane.key), laneCwd(root, lane), null).filter(isAgentAlive)) {
    try {
      deps.claude.stop(a.id);
      deps.log(`phase ${lane.phase} is attended: stopped its session ${a.id}`);
    } catch (err) {
      deps.log(`phase ${lane.phase} is attended: session ${a.id} not stopped: ${errLine(err)}`);
    }
  }
  if (!lane.notified.attended) {
    deps.log(`phase ${lane.phase} is attended in the owner's session; its lane waits until turbo-run attend ${lane.phase} --done`);
    lane.notified.attended = true;
  }
}

// One slot lane's step (spec §5): what step does for v0.3's lane, per entry, with per-lane halts (D6).
async function laneStep(s, key, ctx, view, now) {
  const { root, config, deps } = ctx;
  const at = now.toISOString();
  const lane = s.lanes[key];
  lane.notified ??= {};
  const isPhase = lane.job === 'phase';
  const agent = lane.sessionId ? view.agents.find((a) => a.id === lane.sessionId) : undefined;
  const listed = isPhase ? view.phases.find((x) => x.number === lane.phase) : null;
  // a slot lane's phase is never complete for its own status: main records it only after L2's merge
  const phase = { number: isPhase ? lane.phase : recordKey(lane), complete: false, verification: listed?.verification ?? null };
  const cwd = laneCwd(root, lane);
  if (isPhase && view.attended.has(lane.phase)) return holdAttended(ctx, lane, view.agents);
  if (lane.halted) return;
  if (!lane.sessionId || lane.forceRelaunch) {
    // D8: a new lane (its slot just prepared), one whose launch failed, one a restarted supervisor found in its slot,
    // or the owner's resume
    const resume = Boolean(lane.forceRelaunch) || lane.launch === 'resume';
    if (lane.sessionId) {
      // a still-listed old session must be gone first; a failed rm fails this lane's step and keeps the resume
      if (isAgentAlive(agent)) deps.claude.rm(lane.sessionId);
      else removeSession(ctx, lane.sessionId);
    }
    const { adopted, ...started } = startLane(phase, view.agents, ctx, { resume, exclude: lane.sessionId, at, place: placeOf(ctx, lane) });
    const restarts = lane.forceRelaunch ? 0 : Number(lane.restarts) || 0;
    Object.assign(lane, started, { restarts, fingerprint: deps.fingerprint(phase, cwd), notified: {}, blockedSince: null, forceRelaunch: false, mode: relaunchMode(lane, adopted, ctx) });
    delete lane.launch;
    return;
  }
  if (isPhase && !listed && turnEnded(agent)) {
    deps.log(`phase ${lane.phase} is no longer in the roadmap and session ${lane.sessionId} has ended`);
    return haltLane(ctx, lane, 'missing', at, { id: lane.sessionId });
  }
  const record = readLaneStatus(root, recordKey(lane));
  const status = inferStatus({ agent, laneRecord: record, launchedAt: lane.launchedAt, phase, mode: 'full' });
  const unknown = unknownAgentState(agent);
  if (unknown && lane.notified.unknownState !== unknown) {
    deps.log(`${lname(lane)} session ${lane.sessionId} reports unknown state ${JSON.stringify(unknown.slice(0, 40))}; waiting`);
    lane.notified.unknownState = unknown;
  }
  if (await sharedStatus(ctx, lane, phase, record, status, agent, now, at)) return;
  if (status === 'paused-context') {
    const fp = deps.fingerprint(phase, cwd);
    const d = relaunchDecision({ restarts: lane.restarts, progressed: fp !== lane.fingerprint, maxRestarts: config.max_restarts_without_progress });
    if (d.action === 'halt') return stopLane(s, ctx, lane, agent, 'noProgress', at, { restarts: lane.restarts });
    // two sessions never work in one slot: a still-listed one goes first and its rm must succeed
    if (isAgentAlive(agent)) deps.claude.rm(lane.sessionId);
    else removeSession(ctx, lane.sessionId);
    const { adopted, ...started } = startLane(phase, view.agents, ctx, { resume: true, exclude: lane.sessionId, at, place: placeOf(ctx, lane) });
    Object.assign(lane, started, { restarts: d.restarts, fingerprint: fp, notified: {}, blockedSince: null, mode: relaunchMode(lane, adopted, ctx) });
    return;
  }
  // complete is false here, so done is never inferred: anything left is a failure
  return stopLane(s, ctx, lane, agent, 'failed', at, { id: lane.sessionId });
}

// D7: an error in one lane's step restores only that lane (plus what must survive a failure, laneKeep) and counts on it.
async function guarded(s, key, ctx, view, now) {
  if (!s.lanes[key]) return;
  const before = structuredClone(s.lanes[key]);
  try {
    await laneStep(s, key, ctx, view, now);
    const lane = s.lanes[key];
    if (lane) {
      delete lane.launchFailures;
      delete lane.failingSince;
      delete lane.failingNotified;
    }
  } catch (err) {
    const lane = { ...before, ...(err?.laneKeep || {}) };
    s.lanes[key] = lane;
    try {
      await laneError(s, ctx, lane, err, now);
    } catch (again) {
      ctx.deps.log(`${lname(lane)}: ${errLine(again)}`);
    }
  }
}

async function laneError(s, ctx, lane, err, now) {
  const { config, deps } = ctx;
  const at = now.toISOString();
  const text = errLine(err);
  deps.log(`${lname(lane)}: tick error: ${String(err?.message ?? err).replace(/\s*\r?\n\s*/g, ' ')}`);
  // the lease check after this tick ends the daemon: nothing to count
  if (err?.leaseLost) return;
  if (err?.launchFailed && UNTRUSTED_RE.test(String(err.message))) return stopLane(s, ctx, lane, undefined, 'untrusted', at, { error: text });
  if (err?.launchFailed) {
    lane.launchFailures = (Number(lane.launchFailures) || 0) + 1;
    if (lane.launchFailures >= MAX_LAUNCH_FAILURES) await stopLane(s, ctx, lane, undefined, 'launch', at, { error: text });
    return;
  }
  lane.failingSince ||= at;
  if (!lane.failingNotified && (now - Date.parse(lane.failingSince)) / 60000 >= config.blocked_minutes_before_notify) {
    await deps.notify('supervisorFailing', { error: `${lname(lane)}: ${text}`.slice(0, 200) });
    lane.failingNotified = true;
  }
}

// D10: a free slot Claude Code trusts, leaving out the slots that refused their preparation lately.
function freeSlotFor(s, ctx, now) {
  const window = ctx.config.blocked_minutes_before_notify * 60000;
  const skip = Object.entries(s.slotRefused || {}).filter(([, r]) => now - Date.parse(r.at) < window).map(([k]) => Number(k));
  return ctx.deps.slots.free({ skip });
}

// D10, spec §9: the owner is told once per free slot that Claude Code does not trust, with L0's line for it.
async function tellUntrusted(s, ctx) {
  for (const u of ctx.deps.slots.untrusted()) {
    const note = `trust-${u.k}`;
    if ((s.slotNotes ??= {})[note]) continue;
    ctx.deps.log(`slot ${u.k}: ${u.line}`);
    await ctx.deps.notify('slotUntrusted', { k: u.k, line: u.line });
    s.slotNotes[note] = true;
  }
}

// D8: prepares the slot for the job (L0 prepareSlot) and records the lane without a session; its own step launches it.
// A refusal changes nothing in the slot: it is skipped for a while and the owner told once per reason.
async function openLane(s, ctx, slot, job, now) {
  const { config, deps } = ctx;
  const key = laneKey({ job: job.kind, phase: job.phase });
  let prepared;
  try {
    prepared = deps.slots.prepare(slot, job);
  } catch (err) {
    const why = errLine(err);
    const was = s.slotRefused?.[slot.k];
    (s.slotRefused ??= {})[slot.k] = { why, at: now.toISOString() };
    deps.log(`slot ${slot.k} refused ${key}: ${why}`);
    if (was?.why !== why) await deps.notify('slotRefused', { k: slot.k, why, minutes: config.blocked_minutes_before_notify });
    return null;
  }
  if (s.slotRefused) delete s.slotRefused[slot.k];
  if (s.slotNotes) delete s.slotNotes[`trust-${slot.k}`];
  s.lanes[key] = { key, job: job.kind, phase: job.phase, slot: prepared.k, slotPath: prepared.path, branch: prepared.branch, sessionId: null, launch: 'new', launchedAt: null, restarts: 0, notified: {}, mode: 'full', blockedSince: null };
  deps.log(`${job.kind === 'phase' ? `phase ${job.phase}` : `lane ${key}`}: slot ${prepared.k} prepared on ${prepared.branch}`);
  return key;
}

// D5: L3's lane annotation; an unreadable one is none (one phase lane at a time), logged once per reason.
function readAnnotation(s, ctx) {
  try {
    const f = ctx.deps.lanesFile ? ctx.deps.lanesFile() : null;
    delete s.lanesFileError;
    return f && typeof f === 'object' ? f : null;
  } catch (err) {
    const why = errLine(err);
    if (s.lanesFileError !== why) ctx.deps.log(`lanes.json unreadable (${why}); one phase lane at a time`);
    s.lanesFileError = why;
    return null;
  }
}

// spec §5: the ready phases get slots first (pickPhases); returns the keys of the lanes opened in this tick.
async function schedule(s, ctx, view, now) {
  const { root, config, deps } = ctx;
  const limit = maxLanes(config);
  const lanesFile = readAnnotation(s, ctx);
  const annotation = (n) => annotationOf(lanesFile, n);
  const lanes = () => Object.values(s.lanes);
  // the areas and gates of every phase lane, refreshed: the scheduler and turbo-run lock read them
  for (const l of lanes()) if (l.job === 'phase') Object.assign(l, annotation(l.phase));
  const busy = () => new Set([...lanes().map((l) => l.phase).filter((p) => p != null), ...view.attended]);
  const running = lanes().filter((l) => l.job === 'phase').map((l) => ({ phase: l.phase, areas: l.areas, gates: l.gates }));
  const { picked, next } = pickPhases(view.phases, {
    range: s.range || null, running, exclude: [...busy()], annotation, heldGates: heldGates(root),
    slots: Math.max(0, limit - lanes().length), oneLane: !lanesFile?.fresh,
  });
  s.next = next;
  const started = [];
  let waiting = null;
  for (const p of picked) {
    const slot = freeSlotFor(s, ctx, now);
    if (!slot) {
      await tellUntrusted(s, ctx);
      waiting ??= p.number;
      break;
    }
    const key = await openLane(s, ctx, slot, { kind: 'phase', phase: p.number }, now);
    if (key) {
      Object.assign(s.lanes[key], annotation(p.number));
      started.push(key);
    } else waiting ??= p.number;
  }
  if (waiting) s.next = { phase: waiting, why: 'slots', waitsFor: [] };
  return started;
}

// After the lanes and the scheduler: the run halts when every lane waits for the owner (D6), or ends as in v0.3 when
// no lane runs and no phase can start.
async function settle(s, ctx, view, started) {
  const { deps } = ctx;
  const range = s.range || null;
  const scoped = view.phases.filter((x) => inRange(x.number, range));
  if (scoped.length) delete s.noPhases;
  logSkipped(s, scoped, deps);
  const lanes = Object.values(s.lanes);
  if (lanes.length) {
    delete s.noReady;
    if (lanes.every((l) => l.halted) && s.next?.why !== 'slots') {
      deps.log(`every lane is stopped (${lanes.map((l) => `${l.key}: ${l.halted.why}`).join(', ')}) and no phase can start; halted until the owner's resume`);
      s.halted = true;
    }
    return;
  }
  // a ready phase waits for a slot or for the annotation: not the end of anything
  if (started.length || (s.next && s.next.why !== 'deps')) return;
  await runEnd(s, view.phases, scoped, range, deps);
}

// One slots-mode tick (spec §5): every lane on its own, then the scheduler, then the lanes it opened, then the run's end.
// GSD's phase list and claude's session list are read once; their failure fails the tick (failedTick), as in v0.3.
async function stepSlots(s, ctx, now) {
  const { root, deps } = ctx;
  s.lanes ??= {};
  const view = { phases: deps.loadPhases(), agents: deps.claude.list(), attended: new Set(attendedPhases(root).map((a) => a.phase)) };
  for (const key of Object.keys(s.lanes).sort((a, b) => compareLanes(s.lanes[a], s.lanes[b]))) await guarded(s, key, ctx, view, now);
  let started = [];
  try {
    started = await schedule(s, ctx, view, now);
    delete s.scheduleError;
  } catch (err) {
    // the lanes keep what this tick did for them; scheduling is tried again at the next tick
    const why = errLine(err);
    if (s.scheduleError !== why) deps.log(`schedule: ${why}`);
    s.scheduleError = why;
  }
  for (const key of started) await guarded(s, key, ctx, view, now);
  await settle(s, ctx, view, started);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/supervisor-lanes.test.mjs test/supervisor.test.mjs test/supervisor-wake.test.mjs test/e2e-supervisor.test.mjs test/notify.test.mjs`
Expected: PASS (the new file; v0.3's suites unchanged: their `ctx` has no `lanes`).

- [ ] **Step 6: Commit**

```bash
git add lib/supervisor.mjs lib/messages.mjs test/helpers/lanes.mjs test/supervisor-lanes.test.mjs
git commit -q -m "feat(lanes): slots-mode supervisor runs several phase lanes, each stepped and stopped on its own"
```

---

### Task 9: A lane's end — L2's merge, L3's jobs, gate locks released

**Files:**
- Create: `test/supervisor-jobs.test.mjs`
- Modify: `lib/supervisor.mjs` (imports; new `dropLane`, `failJob`, `mergeStep`, `finishJobStep`; `stopLane`; `laneStep`; `schedule`)

**Interfaces:**
- Consumes: `DONE_STATUSES` (Task 4), `releaseGatesOf` (Task 5), `maxPrep` (Task 1), `wakeSession`, `relaunchCounted` (Task 7); L2's `mergeReady(ctx, lane)` and L3's `pendingJobs(ctx, phases, { lanes, lanesFile, failed })`, `finishJob(ctx, lane)` through `ctx.deps` (Interfaces for L2–L4).
- Produces: a lane whose fresh record has a done status of its job (`DONE_STATUSES`) and whose turn has ended goes to `mergeStep` (phase) or `finishJobStep` (prep, annotate); outcomes `merged` → `dropLane` (session removed, `phaseDone` for a phase, temp directory and gate locks released, entry deleted; L2/L3 released the slot), `reintegrate` → the lane's session is woken with L2's prompt (or resumed in a new session), `needs-owner` → `laneNeedsOwner` once, `wait` → logged once per reason, `failed` (jobs) → `s.jobsFailed[key]`; a job that cannot go on (failed session, no progress, launch) → `failJob` (slot released with `failed` through `deps.slots.release`, `s.jobsFailed[key]`); jobs scheduled after the phases, at most `maxPrep(config, maxLanes(config))`, never while a ready phase waits for a slot (D9).

- [ ] **Step 1: Write the failing tests**

Create `test/supervisor-jobs.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A, P, annotated, freshLanes, lanesHarness } from './helpers/lanes.mjs';
import { tick } from '../lib/supervisor.mjs';
import { writeLaneStatus } from '../lib/run-status.mjs';
import { acquireGate, heldGates } from '../lib/gate-locks.mjs';

// L2's fake: each call takes the next outcome; merged marks the phase complete and releases its slot, as L2 does
function mergeFrom(outcomes) {
  return (lane, h) => {
    const r = outcomes.shift();
    if (r.outcome === 'merged') {
      h.phases.find((p) => p.number === lane.phase).complete = true;
      h.release(lane.slot, 'merged');
    }
    return r;
  };
}

test('a ready lane goes to L2\'s merge only once its turn ended; wait, reintegrate, needs-owner and merged (spec §7.2 through mergeReady)', async () => {
  const h = lanesHarness({
    phases: [P('1')],
    merge: mergeFrom([
      { outcome: 'wait', reason: 'main is dirty' },
      { outcome: 'wait', reason: 'main is dirty' },
      { outcome: 'reintegrate', prompt: 'Main moved: integrate phase 1 again.', reason: 'main moved' },
      { outcome: 'needs-owner', reason: 'phase 1 cannot catch up with main' },
      { outcome: 'needs-owner', reason: 'phase 1 cannot catch up with main' },
      { outcome: 'merged' },
    ]),
  });
  let s = await tick(freshLanes(), h.ctx);
  writeLaneStatus(h.root, '1', 'ready', { at: h.at() });
  s = await tick(s, h.ctx);
  assert.deepEqual(h.merges, [], 'the session still works: its last words may be on their way');
  h.agentOf('1').state = 'blocked';
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  assert.deepEqual(h.merges, ['1', '1']);
  assert.equal(h.logs.filter((l) => l === 'phase 1: merge waits: main is dirty').length, 1);
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(h.resumed.map((r) => [r.id, r.prompt, r.cwd]), [['s1', 'Main moved: integrate phase 1 again.', h.slots[0].path]]);
  assert.equal(s.lanes['1'].launchedAt, h.at(), 'its ready record is older than the wake now');
  h.advance(1);
  writeLaneStatus(h.root, '1', 'ready', { at: h.at() });
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  assert.deepEqual(h.notes.filter((x) => x.key === 'laneNeedsOwner').map((x) => x.vars), [{ phase: '1', reason: 'phase 1 cannot catch up with main' }]);
  s = await tick(s, h.ctx);
  assert.deepEqual(s.lanes, {});
  assert.deepEqual(h.removed, ['s1']);
  assert.deepEqual(h.notes.map((x) => x.key), ['laneNeedsOwner', 'phaseDone', 'milestoneDone']);
  assert.equal(s.finished, true);
});

test('without L2\'s merge a ready lane waits, logged once (D14)', async () => {
  const h = lanesHarness({ phases: [P('1')] });
  let s = await tick(freshLanes(), h.ctx);
  writeLaneStatus(h.root, '1', 'ready', { at: h.at() });
  h.agentOf('1').state = 'blocked';
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  assert.equal(h.logs.filter((l) => l.startsWith('phase 1 is ready, but this turbo has no merge')).length, 1);
  assert.ok(s.lanes['1']);
  assert.equal(s.finished, false);
});

test('prep and annotate jobs take the slots the phases leave, at most max_prep; finished, failed and refused jobs (spec §6.1, D6, D9)', async () => {
  const outcomes = { annotate: [{ outcome: 'merged' }], 'prep-3': [{ outcome: 'wait', reason: 'main is busy' }, { outcome: 'wait', reason: 'main is busy' }, { outcome: 'failed', reason: 'it touched src/x.ts' }] };
  const h = lanesHarness({
    phases: [P('1'), P('2'), P('3')],
    jobs: (options, hh) => hh.jobList,
    finish: (lane, hh) => {
      const r = outcomes[lane.key].shift();
      if (r.outcome === 'merged' || r.outcome === 'failed') hh.release(lane.slot, r.outcome);
      return r;
    },
  });
  h.jobList = [{ job: 'annotate', phase: null }, { job: 'prep', phase: '1' }, { job: 'prep', phase: '2' }, { job: 'prep', phase: '3' }];
  h.ctx.config.max_prep = 1;
  let s = await tick(freshLanes(), h.ctx);
  // no annotation: one phase lane; one job (max_prep 1) in the slots left
  assert.deepEqual(Object.keys(s.lanes), ['1', 'annotate']);
  assert.deepEqual([s.lanes.annotate.slot, s.lanes.annotate.branch, s.lanes.annotate.phase], [2, 'turbo/annotate', null]);
  assert.deepEqual(h.launched.map((l) => [l.prompt, l.systemPrompt.startsWith('job ') ? l.systemPrompt : 'phase']), [['Run the turbo-phase skill with arguments: 1', 'phase'], ['Run annotate', 'job annotate']]);
  // annotate is merged by L3; the next job starts in its slot
  writeLaneStatus(h.root, 'annotate', 'annotated', { at: h.at() });
  h.agentOf('annotate').state = 'blocked';
  h.jobList = h.jobList.slice(1);
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1', 'prep-2'], 'prep of a phase that has a lane (prep-1) is never started');
  assert.ok(h.logs.includes('lane annotate merged'));
  // the prep session fails: its slot is released as failed and the job is not proposed again this run
  h.agentOf('prep-2').state = 'failed';
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1', 'prep-3']);
  assert.equal(s.jobsFailed['prep-2'].why, 'failed');
  assert.deepEqual(h.released, [[2, 'merged'], [2, 'failed']]);
  // L3 refuses the merge of prep-3 (it touched code): failed with L3's reason; a wait is logged once
  writeLaneStatus(h.root, '3', 'prepped', { at: h.at() });
  h.agentOf('prep-3').state = 'blocked';
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  assert.equal(h.logs.filter((l) => l === 'lane prep-3 waits: main is busy').length, 1);
  s = await tick(s, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1']);
  assert.equal(s.jobsFailed['prep-3'].why, 'it touched src/x.ts');
  assert.deepEqual(h.notes, [], 'jobs never notify the owner on their own end');
});

test('phases come first: while a ready phase waits for a slot no job starts (D9)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2')], slots: 1, lanes: annotated({ 1: A('a/**'), 2: A('b/**') }), jobs: () => [{ job: 'prep', phase: '3' }] });
  const s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1']);
  assert.deepEqual(s.next, { phase: '2', why: 'slots', waitsFor: [] });
  assert.equal(h.launched.length, 1);
});

test('a lane\'s gate locks are released when it ends; the phase that waited for its declared gate starts then (spec §5)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2')], lanes: annotated({ 1: A('a/**', ['prod-deploy']), 2: A('b/**', ['prod-deploy']) }), merge: mergeFrom([{ outcome: 'merged' }]) });
  let s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1']);
  await acquireGate(h.root, 'owner-live', '1'); // lane 1 took a lock on one of its steps and never unlocked it
  writeLaneStatus(h.root, '1', 'ready', { at: h.at() });
  h.agentOf('1').state = 'blocked';
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(heldGates(h.root), []);
  assert.ok(h.logs.includes('phase 1: released owner-live'), h.logs.join('\n'));
  assert.deepEqual(Object.keys(s.lanes), ['2']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/supervisor-jobs.test.mjs`
Expected: FAIL — the first test's `h.merges` stays `[]` after the turn ended (a `ready` record is read as `paused-context` and the lane is relaunched).

- [ ] **Step 3: Implement**

`lib/supervisor.mjs`:

1. Imports: replace `import { compareLanes, laneCwd, laneKey, recordKey } from './lanes-state.mjs';` with `import { compareLanes, DONE_STATUSES, laneCwd, laneKey, recordKey } from './lanes-state.mjs';`, replace `import { heldGates } from './gate-locks.mjs';` with `import { heldGates, releaseGatesOf } from './gate-locks.mjs';`, and add `import { maxPrep } from './config.mjs';`.

2. Replace `stopLane` (Task 8) with:

```js
// The one way a slot lane that cannot go on stops: a phase lane halts alone (D6); a job fails, its slot released.
async function stopLane(s, ctx, lane, agent, why, at, extra = {}) {
  if (lane.job !== 'phase') return failJob(s, ctx, lane, agent, why, at);
  return haltLane(ctx, lane, why, at, extra);
}

// A slot lane that ended (merged by L2 or L3, or a job that failed): its session goes (the rm of a live one must
// succeed), then its temp directory and its gate locks; the entry goes last. Its slot was released by whoever merged.
async function dropLane(s, ctx, lane, agent, { done = false } = {}) {
  const { deps, root } = ctx;
  if (lane.sessionId) {
    if (isAgentAlive(agent)) deps.claude.rm(lane.sessionId);
    else removeSession(ctx, lane.sessionId);
  }
  if (done) {
    deps.log(`phase ${lane.phase} done`);
    await deps.notify('phaseDone', { phase: lane.phase });
  }
  try {
    removeLaneTmp(root, lane.key);
  } catch (err) {
    deps.log(`${lname(lane)}: temp directory not removed: ${errLine(err)}`);
  }
  if (lane.job === 'phase') {
    try {
      const freed = releaseGatesOf(root, lane.phase);
      if (freed.length) deps.log(`phase ${lane.phase}: released ${freed.join(', ')}`);
    } catch (err) {
      deps.log(`phase ${lane.phase}: gate locks not released: ${errLine(err)}`);
    }
  }
  delete s.lanes[lane.key];
}

// D6: a prep or annotate job that cannot go on: its slot is released as failed (L0 releaseSlot), and the job waits
// for the next start (pendingJobs gets it in failed).
async function failJob(s, ctx, lane, agent, why, at) {
  ctx.deps.log(`lane ${lane.key} failed (${why}); slot ${lane.slot} released, the job waits for the next start`);
  (s.jobsFailed ??= {})[lane.key] = { why, at };
  ctx.deps.slots.release(lane.slot, 'failed');
  await dropLane(s, ctx, lane, agent);
}

// spec §7.2 through L2 (mergeReady): the phase lane recorded ready (or done) and its turn ended.
async function mergeStep(s, ctx, lane, agent, at) {
  const { deps } = ctx;
  if (!deps.mergeReady) {
    if (lane.mergeWait !== 'unavailable') deps.log(`phase ${lane.phase} is ready, but this turbo has no merge (lib/merge.mjs); waiting`);
    lane.mergeWait = 'unavailable';
    return;
  }
  const r = await deps.mergeReady(ctx, lane);
  if (r?.outcome === 'merged') return dropLane(s, ctx, lane, agent, { done: true });
  if (r?.outcome === 'reintegrate') {
    const prompt = String(r.prompt || '');
    if (!prompt) throw new Error(`the merge of phase ${lane.phase} asked for a new integration without a prompt`);
    deps.log(`phase ${lane.phase}: integrate again${r.reason ? ` (${r.reason})` : ''}; waking session ${lane.sessionId}`);
    delete lane.mergeWait;
    const w = wakeSession(ctx, lane, prompt);
    if (w.woke) {
      // its ready record is older than this wake: it no longer counts
      Object.assign(lane, { launchedAt: at, notified: {}, blockedSince: null });
      return;
    }
    // a new session resumes turbo-phase; L2's request waits in the lane's inbox
    await relaunchCounted(ctx, lane, { number: lane.phase, complete: false, verification: null }, at, () => ({}));
    return;
  }
  if (r?.outcome === 'needs-owner') {
    if (!lane.notified.merge) {
      deps.log(`phase ${lane.phase}: the merge waits for the owner: ${r.reason || ''}`);
      await deps.notify('laneNeedsOwner', { phase: lane.phase, reason: r.reason || 'the merge needs you' });
      lane.notified.merge = true;
    }
    return;
  }
  if (r?.outcome === 'wait') {
    const why = r.reason || 'waiting';
    if (lane.mergeWait !== why) deps.log(`phase ${lane.phase}: merge waits: ${why}`);
    lane.mergeWait = why;
    return;
  }
  throw new Error(`the merge of phase ${lane.phase} returned an unknown outcome ${JSON.stringify(r?.outcome)}`);
}

// spec §6.1, §6.2 through L3 (finishJob): a prep or annotate job recorded its end and its turn ended.
async function finishJobStep(s, ctx, lane, agent, at) {
  const { deps } = ctx;
  if (!deps.finishJob) {
    if (lane.jobWait !== 'unavailable') deps.log(`lane ${lane.key} is done, but this turbo has no job module (lib/prep.mjs); waiting`);
    lane.jobWait = 'unavailable';
    return;
  }
  const r = await deps.finishJob(ctx, lane);
  if (r?.outcome === 'merged') {
    deps.log(`lane ${lane.key} merged`);
    return dropLane(s, ctx, lane, agent);
  }
  if (r?.outcome === 'failed') {
    const why = r.reason || 'refused';
    deps.log(`lane ${lane.key} failed: ${why}`);
    (s.jobsFailed ??= {})[lane.key] = { why, at };
    return dropLane(s, ctx, lane, agent);
  }
  if (r?.outcome === 'needs-owner') {
    if (!lane.notified.job) {
      deps.log(`lane ${lane.key} waits for the owner: ${r.reason || ''}`);
      await deps.notify('laneNeedsOwner', { phase: notePhase(lane), reason: r.reason || 'the job needs you' });
      lane.notified.job = true;
    }
    return;
  }
  if (r?.outcome === 'wait') {
    const why = r.reason || 'waiting';
    if (lane.jobWait !== why) deps.log(`lane ${lane.key} waits: ${why}`);
    lane.jobWait = why;
    return;
  }
  throw new Error(`the job module returned an unknown outcome ${JSON.stringify(r?.outcome)} for lane ${lane.key}`);
}
```

3. In `laneStep`, right after the line `  const record = readLaneStatus(root, recordKey(lane));`, add:

```js
  // D3: the lane's end, once its turn has ended (its last words may still be on their way): L2's merge, L3's job
  if (isFresh(record, lane.launchedAt) && DONE_STATUSES[lane.job].includes(record.status)) {
    if (!turnEnded(agent)) return;
    return isPhase ? mergeStep(s, ctx, lane, agent, at) : finishJobStep(s, ctx, lane, agent, at);
  }
```

4. In `schedule`, replace its last two lines

```js
  if (waiting) s.next = { phase: waiting, why: 'slots', waitsFor: [] };
  return started;
```

with:

```js
  if (waiting) s.next = { phase: waiting, why: 'slots', waitsFor: [] };
  // D9: jobs only in the slots the ready phases leave, at most max_prep at once
  if (waiting || next?.why === 'slots' || !deps.pendingJobs) return started;
  const failed = Object.keys(s.jobsFailed || {});
  let jobs;
  try {
    jobs = await deps.pendingJobs(ctx, view.phases, { lanes: s.lanes, lanesFile, failed });
  } catch (err) {
    const why = errLine(err);
    if (s.jobsError !== why) deps.log(`jobs: ${why}`);
    s.jobsError = why;
    return started;
  }
  delete s.jobsError;
  const cap = maxPrep(config, limit);
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (limit - lanes().length <= 0 || lanes().filter((l) => l.job !== 'phase').length >= cap) break;
    if (!j || (j.job !== 'prep' && j.job !== 'annotate')) continue;
    const phase = j.job === 'annotate' ? null : String(j.phase);
    const key = laneKey({ job: j.job, phase });
    // never two lanes of one phase (D3): not the prep of a phase that runs, is attended or is prepped already
    if (s.lanes[key] || failed.includes(key) || (phase !== null && busy().has(phase))) continue;
    const slot = freeSlotFor(s, ctx, now);
    if (!slot) {
      await tellUntrusted(s, ctx);
      break;
    }
    const opened = await openLane(s, ctx, slot, { kind: j.job, phase }, now);
    if (opened) started.push(opened);
  }
  return started;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/supervisor-jobs.test.mjs test/supervisor-lanes.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/supervisor.mjs test/supervisor-jobs.test.mjs
git commit -q -m "feat(lanes): a lane's end goes to the merge or the job module; prep and annotate jobs scheduled after phases"
```

---
### Task 10: Restart — `resumableLanes`; the supervisor e2e with a fake `claude`

**Files:**
- Create: `test/e2e-lanes.test.mjs`
- Modify: `lib/supervisor.mjs` (new export `resumableLanes` after `resumableLane`)

**Interfaces:**
- Consumes: `ctx.deps.slots.forJob`, `ctx.deps.slots.list` (Contracts), `laneKey`, `inRange`, `rangeLabel`, the local `dirKey`.
- Produces: `resumableLanes(prev, range, ctx) → { [key]: LaneEntry }` — D8 and spec §9: the recorded lanes whose job a slot still holds (L0's record wins: a lane found in another slot moves there), inside the range, a halted one armed for a new try (`forceRelaunch: true`, `restarts: 0`, `halted` removed), launch-failure counts cleared; plus an entry `{ …, sessionId: null, launch: 'resume' }` for every slot of this control root whose job is active but that no entry names. `bin/turbo-run.mjs`'s `daemon` uses it in Task 11.

- [ ] **Step 1: Write the failing tests**

Create `test/e2e-lanes.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { A, P, annotated, freshLanes, lanesHarness } from './helpers/lanes.mjs';
import { resumableLanes, runDaemon, tick } from '../lib/supervisor.mjs';
import { writeLaneStatus } from '../lib/run-status.mjs';
import { readJson } from '../lib/fsx.mjs';
import { laneSessionName } from '../lib/claude.mjs';

const mergeAndRelease = (lane, h) => {
  h.phases.find((p) => p.number === lane.phase).complete = true;
  h.release(lane.slot, 'merged');
  return { outcome: 'merged' };
};

test('e2e (spec §13): two independent phases run together, the third waits for its dependency; a failed lane stops alone', async () => {
  const h = lanesHarness({
    phases: [P('1'), P('2'), P('3', ['1'])],
    lanes: annotated({ 1: A('src/a/**'), 2: A('src/b/**'), 3: A('src/a/**') }),
    merge: mergeAndRelease,
  });
  let ticks = 0;
  // one step per tick, run inside GSD's phase list (the tick's first read); then the clock moves a minute
  const script = [
    () => {},
    () => { h.agentOf('2').state = 'failed'; },
    () => { writeLaneStatus(h.root, '1', 'ready', { at: h.at() }); h.agentOf('1').state = 'blocked'; },
    () => { writeLaneStatus(h.root, '3', 'ready', { at: h.at() }); h.agentOf('3').state = 'blocked'; },
  ];
  const load = h.ctx.deps.loadPhases;
  h.ctx.deps.loadPhases = () => {
    script[ticks]?.();
    ticks++;
    h.advance(1);
    return load();
  };
  const statePath = path.join(h.root, '.planning', 'turbo', 'run', 'supervisor.json');
  let sleeps = 0;
  // every fake resolves as a microtask: a daemon that never stops would hang the suite
  const sleep = async () => { if (++sleeps > 20) throw new Error(`runaway daemon after ${sleeps} iterations; last log ${h.logs.slice(-5).join(' | ')}`); };
  const final = await runDaemon({ ctx: h.ctx, statePath, initial: freshLanes(), intervalMs: 0, sleep });
  assert.deepEqual([final.halted, final.finished], [true, false]);
  assert.deepEqual(h.events, ['launch 1', 'launch 2', 'merge 1', 'launch 3', 'merge 3']);
  assert.deepEqual(h.launched.map((l) => l.cwd), [h.slots[0].path, h.slots[1].path, h.slots[0].path], 'phase 3 reuses the slot phase 1 freed');
  assert.deepEqual(h.notes.map((x) => [x.key, x.vars.phase]), [['laneStopped', '2'], ['phaseDone', '1'], ['phaseDone', '3']]);
  assert.deepEqual(Object.keys(final.lanes), ['2']);
  assert.equal(final.lanes['2'].halted.why, 'failed');
  assert.deepEqual(h.released, [[1, 'merged'], [1, 'merged']]);
  assert.equal(h.slots[1].job.state, 'active', 'the failed lane keeps its slot and its work');
  const saved = readJson(statePath);
  assert.equal(saved.lanesMode, 'slots');
  assert.equal(Object.hasOwn(saved, 'lane'), false);
});

test('e2e (spec §9, §13): a restart keeps the recorded lanes, adopts their sessions, and resumes an orphan slot job in its slot; nothing launches twice (Review Focus 1)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2'), P('4')], maxLanes: 2, lanes: annotated({ 1: A('a/**'), 2: A('b/**'), 4: A('c/**') }) });
  let s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1', '2']);
  // the supervisor dies right after preparing slot 3 for phase 4 and launching its session, before its state write
  h.ctx.config.max_lanes = 3;
  h.ctx.deps.slots.prepare(h.slots[2], { kind: 'phase', phase: '4' });
  h.agents.push({ id: 'orphan', name: laneSessionName(h.root, '4'), cwd: h.slots[2].path, state: 'working' });
  const lanes = resumableLanes(s, null, h.ctx);
  assert.deepEqual(Object.keys(lanes), ['1', '2', '4']);
  assert.deepEqual([lanes['4'].slot, lanes['4'].sessionId, lanes['4'].launch, lanes['4'].branch], [3, null, 'resume', 'turbo/p4']);
  h.advance(1);
  s = await tick({ ...s, lanes }, h.ctx);
  assert.equal(h.launched.length, 2, 'no new session: 1 and 2 keep theirs, 4 adopts the one in its slot');
  assert.equal(s.lanes['4'].sessionId, 'orphan');
  assert.ok(h.logs.includes('adopt phase 4 session orphan'), h.logs.join('\n'));
  assert.deepEqual(h.prepared.map((p) => p[2]), ['1', '2', '4'], 'no second slot for phase 4');
  // a lane outside the new range, and a lane whose slot no longer holds its job, are not resumed
  h.release(2, 'abandoned');
  assert.deepEqual(Object.keys(resumableLanes(s, { from: '4', to: null }, h.ctx)), ['4']);
  assert.ok(h.logs.some((l) => l === 'lane 1 is outside the range 4–end; not resumed (session s1 and slot 1 kept)'));
  assert.deepEqual(Object.keys(resumableLanes(s, null, h.ctx)), ['1', '4']);
  assert.ok(h.logs.includes('lane 2: no slot holds its job any more; not resumed'));
  // a lane that was stopped is tried again by a new start
  s.lanes['1'].halted = { why: 'failed', at: h.at() };
  s.lanes['1'].launchFailures = 4;
  const retried = resumableLanes(s, null, h.ctx)['1'];
  assert.deepEqual([retried.halted, retried.forceRelaunch, retried.restarts, retried.launchFailures], [undefined, true, 0, undefined]);
  // a checkout-mode lane is never resumed in slots mode; a finished run resumes nothing
  const other = lanesHarness({ phases: [P('7')] });
  assert.deepEqual(resumableLanes({ lane: { phase: '7', sessionId: 'x' }, finished: false }, null, other.ctx), {});
  assert.ok(other.logs.some((l) => l.startsWith('a checkout-mode lane of phase 7 is recorded; slots mode does not resume it')));
  assert.deepEqual(resumableLanes({ lanes: { 7: { key: '7', job: 'phase', phase: '7', slot: 1 } }, finished: true }, null, other.ctx), {});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/e2e-lanes.test.mjs`
Expected: FAIL — `does not provide an export named 'resumableLanes'`.

- [ ] **Step 3: Implement**

`lib/supervisor.mjs` — right after the closing brace of `export function resumableLane`, add:

```js
// spec §9 (D8): what a starting slots-mode daemon takes over. The recorded lanes whose job a slot still holds (L0's
// slot record wins: a lane found in another slot moves there), inside the run's range; a lane that was stopped is tried
// again, as a new start does in v0.3. Then every slot of this project whose job is active but that no entry names (the
// supervisor stopped between preparing it and writing its state): its lane resumes there, adopting an alive session.
export function resumableLanes(prev, range, ctx) {
  const { root, deps } = ctx;
  const log = deps.log;
  const lanes = {};
  const skipped = new Set();
  if (prev?.lane && !prev.finished) log(`a checkout-mode lane of phase ${prev.lane.phase} is recorded; slots mode does not resume it (session ${prev.lane.sessionId} kept)`);
  const recorded = prev && !prev.finished && prev.lanes && typeof prev.lanes === 'object' ? prev.lanes : {};
  for (const [key, lane] of Object.entries(recorded)) {
    if (!lane || typeof lane !== 'object') continue;
    if (lane.job === 'phase' && !inRange(lane.phase, range)) {
      log(`lane ${key} is outside the range ${rangeLabel(range)}; not resumed (session ${lane.sessionId} and slot ${lane.slot} kept)`);
      skipped.add(key);
      continue;
    }
    const held = deps.slots.forJob(lane.phase ?? null, lane.job);
    if (!held) {
      log(`lane ${key}: no slot holds its job any more; not resumed`);
      skipped.add(key);
      continue;
    }
    if (held.k !== lane.slot) log(`lane ${key}: its job is in slot ${held.k}, not ${lane.slot}; the slot record wins`);
    const entry = { ...lane, key, slot: held.k, slotPath: held.path };
    for (const f of ['launchFailures', 'failingSince', 'failingNotified']) delete entry[f];
    if (entry.halted) {
      log(`lane ${key} was stopped (${entry.halted.why}); this start tries it again`);
      delete entry.halted;
      Object.assign(entry, { forceRelaunch: true, restarts: 0 });
    }
    lanes[key] = entry;
  }
  if (prev?.finished) return lanes;
  let slots = [];
  try {
    slots = deps.slots.list();
  } catch (err) {
    log(`slots not listed (${errLine(err)}); a slot with a job and no record is not looked for`);
  }
  const home = dirKey(root);
  for (const slot of slots) {
    const job = slot.record?.job;
    if (!job || job.state !== 'active' || !slot.record.control || dirKey(slot.record.control) !== home) continue;
    const phase = job.phase == null ? null : String(job.phase);
    const key = laneKey({ job: job.kind, phase });
    if (lanes[key] || skipped.has(key) || (job.kind === 'phase' && !inRange(phase, range))) continue;
    lanes[key] = { key, job: job.kind, phase, slot: slot.k, slotPath: slot.path, branch: job.branch, sessionId: null, launch: 'resume', launchedAt: null, restarts: 0, notified: {}, mode: 'full', blockedSince: null };
    log(`lane ${key}: slot ${slot.k} holds its job without a record; its session is adopted or resumed there`);
  }
  return lanes;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/e2e-lanes.test.mjs test/supervisor-lanes.test.mjs test/supervisor-jobs.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/supervisor.mjs test/e2e-lanes.test.mjs
git commit -q -m "feat(lanes): a restarted supervisor takes over its lanes and the slot jobs it never recorded"
```

---

### Task 11: `turbo-run` — the daemon in slots mode; start, status, stop, resume and attend per lane

**Files:**
- Modify: `bin/turbo-run.mjs` (imports, `OWNER_COMMANDS`, `runtimeConfig`, `fingerprint`, `makeCtx`, new `slotDeps`, `daemon`, `start`, `statusOpts`, `printStatus`, new `printLanes`, new `laneWhere`, `projectLaneAgents`, `stopLanes`, `resumePhase`, `attend`, new `attendLane`, `main`)
- Test: `test/cli.test.mjs` (`fakeProject` defaults to checkout mode; append)

**Interfaces:**
- Consumes: L0's `listSlots`, `prepareSlot`, `releaseSlot`, `slotForPhase`, `setupSlots`, `slotsDir`, `maxLanes`, `trustState`, `trustLine`, `stateRoot`, `lanesSettings`; `loadLanePlugins` (Task 6); `resumableLanes` (Task 10); `supervisorLanes`, `laneForPhase`, `laneLabel`, `lanesSummary`, `setupLines` (Task 4); `laneGates`, `mergeRounds`, `maxPrep` (Task 1).
- Produces: the daemon runs `ctx.lanes = 'slots'` when `lanes.mode` is `slots` and doctor reports full mode (D2), with `ctx.deps.slots` and the plugin functions; `start` builds the slots first (D in §4 via L0) and refuses when none can be built; `status` per lane (D16); `stop` every lane and every lane session of the project's slots, slots kept; `resume N` re-arms lane N only; `attend N` per D11; owner commands on `stateRoot` (D12); `runtimeConfig` validates `merge_rounds`, `lanes.gates` and `max_prep`.

- [ ] **Step 1: Write the failing tests**

In `test/cli.test.mjs`, in `fakeProject`, replace the line

```js
  if (config) fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify(config));
```

with:

```js
  // Stage 4 L1: v0.3's tests run one lane in this checkout; a test that wants slots says lanes.mode itself
  if (config) fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify(config.lanes ? config : { ...config, lanes: { mode: 'checkout' } }));
```

Append:

```js
// Stage 4 L1: a slots-mode run with a live daemon (a sleeper) and three lanes: phase 4 working, phase 5 stopped
// (failed), prep of phase 6; slot directories next to the project, where slotsDir puts them by default.
function slotsProject(t, { lang = 'en' } = {}) {
  const p = fakeProject({ phases: [{ number: '4', name: 'four', phase_complete: false }, { number: '5', name: 'five', phase_complete: false }], config: { lang, notify: { desktop: false, telegram: false }, lanes: { mode: 'slots' } } });
  const base = path.join(path.dirname(p.root), `${path.basename(p.root)}.turbo`);
  const slot = (k) => {
    const d = path.join(base, `lane-${k}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const child = sleeper(t);
  const lane = (key, job, phase, k, sessionId, extra = {}) => ({ key, job, phase, slot: k, slotPath: slot(k), branch: job === 'phase' ? `turbo/p${phase}` : `turbo/prep-${phase}`, sessionId, launchedAt: ago(5), restarts: 0, notified: {}, mode: 'full', ...extra });
  writeSup(p.root, {
    lanesMode: 'slots', pid: child.pid, updatedAt: ago(0), finished: false, halted: false, poll_seconds: 20,
    next: { phase: '6', why: 'deps', waitsFor: ['4'] },
    lanes: {
      4: lane('4', 'phase', '4', 1, 'abc111'),
      5: lane('5', 'phase', '5', 2, 'abc222', { restarts: 1, halted: { why: 'failed', at: ago(1) } }),
      'prep-6': lane('prep-6', 'prep', '6', 3, 'abc333'),
    },
  });
  return { p, child, slot, env: { ...p.env, TURBO_LANE: '', TURBO_ATTEND_SETTLE_MS: '0' } };
}

test('status in slots mode: the summary line and one block per lane, in the owner\'s language (spec §8, D16)', (t) => {
  const { p, slot, env } = slotsProject(t);
  const text = run(['status'], p.root, env);
  assert.match(text, /^supervisor: running pid \d+$/m);
  assert.match(text, /^lanes: 3 · questions: 0 · next: phase 6 waits for phase 4$/m);
  assert.ok(text.includes(`lane 4: phase 4 · slot 1 ${slot(1)} · session abc111 · restarts 0 · since `), text);
  assert.match(text, /^ {2}watch: claude attach abc111$/m);
  assert.match(text, /^ {2}stopped \(failed\): try again with turbo-run resume 5$/m);
  assert.ok(text.includes(`lane prep-6: prep of phase 6 · slot 3 ${slot(3)} · session abc333`), text);
  assert.ok(!/^lane: /m.test(text), 'no v0.3 lane line');
  assert.equal(JSON.parse(run(['status', '--json'], p.root, env)).lanes['4'].slot, 1);
  const ru = slotsProject(t, { lang: 'ru' });
  assert.match(run(['status'], ru.p.root, ru.env), /^полосы: 3 · вопросы: 0 · следующая: фаза 6 ждёт фазу 4$/m);
});

test('stop in slots mode stops every lane, prep and annotate, and a lane session the daemon never recorded; slots stay (spec §8)', async (t) => {
  const { p, child, slot, env } = slotsProject(t);
  const name = (k) => laneSessionName(p.root, k);
  p.setClaude({ agents: [
    { id: 'abc111', name: name('4'), cwd: slot(1), state: 'working' },
    { id: 'abc333', name: name('prep-6'), cwd: slot(3), state: 'working' },
    { id: 'abc444', name: name('7'), cwd: slot(4), state: 'working' },
    { id: 'other', name: 'someone-else', cwd: slot(1), state: 'working' },
  ] });
  const r = await runAsync(['stop'], p.root, env);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(await exited(child), 'the supervisor is stopped');
  assert.deepEqual(p.claudeCalls().filter((a) => a[0] === 'stop').map((a) => a[1]).sort(), ['abc111', 'abc222', 'abc333', 'abc444']);
  assert.match(r.stdout, /^stopped$/m);
  assert.match(r.stdout, /^their slots and branches stay for review$/m);
  assert.ok(fs.existsSync(slot(1)));
});

test('attend N in slots mode stops only lane N, keeps the supervisor and the other lanes, and prints the slot to open (spec §8, D11)', async (t) => {
  const { p, child, slot, env } = slotsProject(t);
  const dir = path.join(slot(1), '.planning', 'phases', '04-four');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['04-01-PLAN.md', '04-01-SUMMARY.md', '04-02-PLAN.md']) fs.writeFileSync(path.join(dir, f), '# plan\n');
  fs.writeFileSync(path.join(runDirOf(p.root), 'phase-p4.json'), JSON.stringify({ phase: '4', done: STEPS.slice(0, STEPS.indexOf('execute')), attempts: {} }));
  p.setClaude({ agents: [
    { id: 'abc111', name: laneSessionName(p.root, '4'), cwd: slot(1), state: 'working' },
    { id: 'late', name: laneSessionName(p.root, '4'), cwd: slot(1), state: 'working' },
    { id: 'abc333', name: laneSessionName(p.root, 'prep-6'), cwd: slot(3), state: 'working' },
  ] });
  let r = await runAsync(['attend', '4'], p.root, env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(p.claudeCalls().filter((a) => a[0] === 'stop').map((a) => a[1]).sort(), ['abc111', 'late']);
  assert.equal(await exited(child, 300), false, 'the supervisor keeps the other lanes');
  assert.equal(readSup(p.root).pid, child.pid);
  assert.match(r.stdout, /^phase 4: attended in the owner's session; the other lanes keep running; nothing starts, relaunches or wakes phase 4 until turbo-run attend 4 --done$/m);
  assert.ok(r.stdout.includes(`open: cd "${slot(1)}" && claude`), r.stdout);
  assert.match(r.stdout, /^open plans: 04-02$/m);
  assert.match(r.stdout, /^gates: turn off \(/m);
  assert.ok(fs.existsSync(path.join(runDirOf(p.root), 'p4-attend.json')));
  assert.match(run(['status'], p.root, env), new RegExp(`^ {2}attended in the owner's session: cd "${slot(1).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}" && claude \\(hand it back: turbo-run attend 4 --done\\)$`, 'm'));
  r = await runAsync(['attend', '6'], p.root, env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /phase 6 has no lane in this run \(lanes: 4, 5, prep-6\)/);
});

test('resume N in slots mode clears its stop and arms a relaunch of that lane only (spec §9)', async (t) => {
  const { p, env } = slotsProject(t);
  const r = await runAsync(['resume', '5'], p.root, env);
  assert.equal(r.code, 0, r.stderr);
  const sup = readSup(p.root);
  assert.deepEqual([sup.lanes['5'].halted, sup.lanes['5'].forceRelaunch, sup.lanes['5'].restarts], [undefined, true, 0]);
  assert.equal(sup.lanes['4'].forceRelaunch, undefined);
  assert.deepEqual([sup.pid, sup.halted, sup.lanesMode], [null, false, 'slots']);
  assert.match(run(['status'], p.root, env), /^ {2}relaunch pending \(resume\)$/m);
});

test('start in slots mode builds the slots before any supervisor; when none can be built it starts nothing (Stage 4 L1)', async () => {
  const p = fakeProject({ config: { notify: { desktop: false, telegram: false }, lanes: { mode: 'slots' } } }); // not a git repository
  const r = await runAsync(['start'], p.root, p.env);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /^slots: .*nothing was started$/m);
  assert.equal(readSup(p.root), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/cli.test.mjs`
Expected: FAIL — the new tests (no `lanes:` summary line, v0.3's attend refuses `phase 4 is not the supervisor's lane`, `start` spawns a daemon); the existing tests pass (they now run in checkout mode).

- [ ] **Step 3: Implement**

`bin/turbo-run.mjs`:

1. Imports. Replace the `lib/paths.mjs`, `lib/config.mjs` and `lib/supervisor.mjs` import lines with:

```js
import { findProjectRoot, gsdCoreDir, runDir, logsDir, locksDir, dirKey, stateRoot } from '../lib/paths.mjs';
import { DEFAULTS, loadConfig, initConfig, deepMerge, fullEntries, laneGates, lanesSettings, maxPrep, mergeRounds, pushSettings } from '../lib/config.mjs';
import { runDaemon, resumableLane, resumableLanes } from '../lib/supervisor.mjs';
```

and add:

```js
import { listSlots, maxLanes, prepareSlot, releaseSlot, setupSlots, slotForPhase, slotsDir } from '../lib/slots.mjs';
import { trustLine, trustState } from '../lib/trust.mjs';
import { laneForPhase, laneLabel, lanesSummary, setupLines, supervisorLanes } from '../lib/lanes-state.mjs';
import { loadLanePlugins } from '../lib/lane-plugins.mjs';
```

2. After `const VALUE_FLAGS = …;`, add:

```js
// D12: commands of the owner's that act on the run; typed in a slot (an attend sitting) they act on the control root
const OWNER_COMMANDS = new Set(['start', 'daemon', 'status', 'view', 'stop', 'resume', 'attend']);
```

3. Replace `runtimeConfig` by:

```js
function runtimeConfig(config) {
  const c = {
    ...config,
    poll_seconds: clampPoll(config.poll_seconds),
    max_restarts_without_progress: clampInt(config.max_restarts_without_progress, 1, DEFAULTS.max_restarts_without_progress),
    blocked_minutes_before_notify: clampInt(config.blocked_minutes_before_notify, 1, DEFAULTS.blocked_minutes_before_notify),
    // push.* checked where start, status and the daemon load the config: a typo stops them with one line
    push: pushSettings(config.push),
    // Stage 4 L1: merge_rounds, lanes.gates and max_prep the same way
    merge_rounds: mergeRounds(config),
  };
  laneGates(c);
  maxPrep(c, maxLanes(c));
  return c;
}
```

4. In `fingerprint(root)`, replace `return (phase) => {` with `return (phase, cwd = root) => {`, and inside it use `cwd` instead of `root` in `execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, …` and in `const dir = path.join(root, '.planning', 'phases');` (a slot lane's progress is in its slot).

5. Replace the whole `makeCtx` function by:

```js
// D2: slots mode needs lanes.mode slots and doctor's full mode; anything else is v0.3's single lane in this checkout.
async function makeCtx(root, mode = 'safe') {
  const config = runtimeConfig(loadConfig(root));
  const core = gsdCoreDir(root);
  const claude = createClaude({ bin: resolveBin() });
  ensureDir(logsDir(root));
  const logFile = path.join(logsDir(root), 'supervisor.log');
  const slots = lanesSettings(config.lanes).mode === 'slots' && mode === 'full';
  const plugins = slots ? await loadLanePlugins() : null;
  const ctx = {
    root, config, mode: mode === 'full' ? 'full' : 'safe', turboRun: `node ${shQuote(SELF.replace(/\\/g, '/'))}`,
    ...(slots ? { lanes: 'slots' } : {}),
    deps: {
      loadPhases: () => {
        if (!core) throw new Error('gsd-core not found');
        return loadPhases(root, core).phases;
      },
      claude,
      // the supervisor's push and CI work (spec §6, S2); unused while push.mode is off
      git: createGit(root),
      gh: createGh(root),
      // the lanes' transcripts, read-only: the session id a wake resumes, and a lane's activity (spec §5.5)
      lanes: createLaneProbe(root),
      fingerprint: fingerprint(root),
      notify: (key, vars) => notify(config, msg(config.lang, key, vars)),
      now: () => new Date(),
      log: (line) => {
        try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch { /* logging is best-effort */ }
      },
      // probed right before a launch: a lease revoked mid-tick (stop, resume, another start) launches nothing
      leaseHeld: () => !lostLease(root),
    },
  };
  if (plugins) {
    Object.assign(ctx.deps, {
      slots: slotDeps(root, config),
      mergeReady: plugins.mergeReady,
      pendingJobs: plugins.pendingJobs,
      jobPrompts: plugins.jobPrompts,
      finishJob: plugins.finishJob,
      lanesFile: () => (plugins.readLanesFile ? plugins.readLanesFile(root) : null),
    });
  }
  return ctx;
}

// The supervisor's view of L0's slots (Contracts: ctx.deps.slots). free: the first free slot Claude Code trusts,
// leaving out the ones the supervisor skips for a while (D10).
function slotDeps(root, config) {
  const trusted = (slot) => trustState(slot.path) === 'trusted';
  return {
    list: () => listSlots(root, config),
    free: ({ skip = [] } = {}) => listSlots(root, config).find((x) => x.state === 'free' && !skip.includes(x.k) && trusted(x)) || null,
    untrusted: () => listSlots(root, config).filter((x) => x.state === 'free' && !trusted(x)).map((x) => ({ k: x.k, path: x.path, line: trustLine(x.path, config.lang) })),
    prepare: (slot, job) => prepareSlot(root, slot, job),
    release: (k, outcome) => releaseSlot(root, k, { outcome, config }),
    forJob: (phase, kind) => slotForPhase(root, config, phase, { kind }),
  };
}
```

6. In `daemon`, replace `const ctx = makeCtx(root, mode);` with `const ctx = await makeCtx(root, mode);`, and replace the line `const initial = { lane: resumableLane(prev, range, ctx.deps.log), finished: false, halted: false, poll_seconds: poll, ...(range ? { range } : {}) };` with:

```js
    const base = { finished: false, halted: false, poll_seconds: poll, ...(range ? { range } : {}) };
    let initial;
    if (ctx.lanes === 'slots') initial = { lanesMode: 'slots', lanes: resumableLanes(prev, range, ctx), ...base };
    else {
      if (lanesSettings(ctx.config.lanes).mode === 'slots') ctx.deps.log(`lanes.mode slots needs full mode (doctor: ${mode}); one lane runs in this checkout`);
      if (prev?.lanes && Object.keys(prev.lanes).length && !prev.finished) ctx.deps.log(`slots-mode lanes are recorded (${Object.keys(prev.lanes).join(', ')}); checkout mode does not resume them (their sessions and slots kept)`);
      initial = { lane: resumableLane(prev, range, ctx.deps.log), ...base };
    }
```

7. Add, right before `function printStatus`:

```js
// What status prints next to the lanes: the attended phases, the open questions, the owner's language.
function statusOpts(root, config) {
  return { attended: attendedPhases(root), questions: openQuestions(root).length, lang: config?.lang === 'ru' ? 'ru' : 'en' };
}
```

Replace the signature line of `printStatus` with `function printStatus(sup, running, { rangeLine = true, attended = [], questions = 0, lang = 'en' } = {}) {` and, right after its `if (sup.failingSince) …` line, add:

```js
  if (sup.lanes) return printLanes(sup, { attended, questions, lang });
```

After `printStatus`, add:

```js
// spec §8 (D16): the summary line, then one block per lane: what it runs, where, and what to do next.
function printLanes(sup, { attended, questions, lang }) {
  const held = new Set(attended.map((a) => a.phase));
  const lanes = supervisorLanes(sup);
  out(lanesSummary({ lanes: lanes.length, questions, next: sup.next || null }, lang));
  for (const l of lanes) {
    out(`lane ${l.key}: ${laneLabel(l)} · slot ${l.slot} ${l.slotPath} · session ${l.sessionId || 'none yet'} · restarts ${l.restarts ?? 0} · since ${l.launchedAt || '-'}`);
    if (l.job === 'phase' && held.has(l.phase)) out(`  attended in the owner's session: cd "${l.slotPath}" && claude (hand it back: turbo-run attend ${l.phase} --done)`);
    else if (l.halted) out(`  stopped (${l.halted.why}): try again with turbo-run resume ${l.phase}`);
    else if (l.forceRelaunch) out('  relaunch pending (resume)');
    else if (!l.sessionId) out('  launch pending');
    else out(`  watch: claude attach ${l.sessionId}`);
  }
}
```

8. In `start`: in `already`, replace `const attended = attendedPhases(root);` / `printStatus(sup, true, { attended });` / `printAttended(attended);` with:

```js
    const opts = statusOpts(root, config);
    printStatus(sup, true, opts);
    printAttended(opts.attended);
```

Replace `printStatus(last, true, { rangeLine: false, attended: attendedPhases(root) });` with `printStatus(last, true, { ...statusOpts(root, config), rangeLine: false });` and `printStatus(last, false, { rangeLine: !range, attended: attendedPhases(root) });` with `printStatus(last, false, { ...statusOpts(root, config), rangeLine: !range });`. Right after `for (const w of r.warnings ?? []) out(\`warn ${w}\`);`, add:

```js
  // spec §4 (Stage 4 L1): slots mode builds the missing slots and their trust before the daemon starts (L0 setupSlots)
  if (lanesSettings(config.lanes).mode === 'slots') {
    if (r.mode !== 'full') out('warn lanes.mode slots needs full mode (doctor: safe): one lane runs in this checkout');
    else {
      let res;
      try {
        res = setupSlots(root, config);
      } catch (e) {
        die(`slots: ${String(e?.message ?? e).split(/\r?\n/)[0]}; nothing was started`);
      }
      for (const line of setupLines(res)) out(line);
      if (!res.slots.some((x) => x.action !== 'refused')) die('slots: no slot could be built (see the lines above); nothing was started');
    }
  }
```

9. Replace `projectLaneAgents` (with its comment) by:

```js
// Where this project's lane sessions run: this checkout, every recorded lane's slot, and the slots directory (a lane the
// stopped daemon never recorded). A broken config leaves the recorded slots only.
function laneWhere(root, sups) {
  const dirs = new Set([dirKey(root)]);
  for (const sup of sups) for (const l of supervisorLanes(sup, root)) if (l.slotPath) dirs.add(dirKey(l.slotPath));
  let base = null;
  try { base = dirKey(slotsDir(root, loadConfig(root))); } catch { /* broken config */ }
  return { dirs, base };
}

// Lane sessions of this project: a lane name of this project (any key) started in one of its lane directories.
function projectLaneAgents(agents, root, where = { dirs: new Set([dirKey(root)]), base: null }) {
  const prefix = laneSessionName(root, '');
  return agents.filter((a) => String(a.name).startsWith(prefix) && Boolean(a.cwd) && (where.dirs.has(dirKey(a.cwd)) || (where.base !== null && dirKey(a.cwd).startsWith(`${where.base}/`))));
}
```

In `stopLanes`, replace `const ids = new Set([before?.lane?.sessionId, after?.lane?.sessionId].filter(Boolean));` with:

```js
  const ids = new Set([...supervisorLanes(before, root), ...supervisorLanes(after, root)].map((l) => l.sessionId).filter(Boolean));
```

replace `for (const a of projectLaneAgents(agents, root)) if (isAgentAlive(a)) ids.add(a.id);` with:

```js
    for (const a of projectLaneAgents(agents, root, laneWhere(root, [before, after]))) if (isAgentAlive(a)) ids.add(a.id);
```

and replace its last two lines `out('stopped');` / `return 0;` with:

```js
  out('stopped');
  // spec §8: stop never touches the slots: their work and their branches stay for review
  if ([before, after].some((x) => x?.lanes && Object.keys(x.lanes).length)) out('their slots and branches stay for review');
  return 0;
```

10. In `resumePhase`, right after `stopDaemon(root, readJson(supPath(root), null));`, add:

```js
  // the phase's own files: in its lane's slot (Stage 4), else in this checkout
  const phaseRoot = laneForPhase(readJson(supPath(root), null), root, id)?.slotPath || root;
```

replace `if (openPlans(root, id) !== null) {` with `if (openPlans(phaseRoot, id) !== null) {` and `refreshQuestions(root, id, {` with `refreshQuestions(phaseRoot, id, {`. Replace

```js
  if (sup) {
    const lane = sup.lane && String(sup.lane.phase) === id ? { ...sup.lane, notified: {}, restarts: 0, forceRelaunch: true } : sup.lane || null;
    writeJsonAtomic(supPath(root), { ...sup, pid: null, finished: false, halted: false, lane });
  }
```

with:

```js
  if (sup?.lanes) {
    // spec §9: only lane N is armed again (its stop cleared); the other lanes keep their state
    const lanes = { ...sup.lanes };
    if (lanes[id]) {
      const lane = { ...lanes[id], notified: {}, restarts: 0, forceRelaunch: true };
      delete lane.halted;
      lanes[id] = lane;
    }
    writeJsonAtomic(supPath(root), { ...sup, pid: null, finished: false, halted: false, lanes });
  } else if (sup) {
    const lane = sup.lane && String(sup.lane.phase) === id ? { ...sup.lane, notified: {}, restarts: 0, forceRelaunch: true } : sup.lane || null;
    writeJsonAtomic(supPath(root), { ...sup, pid: null, finished: false, halted: false, lane });
  }
```

11. In `attend`, add as its first two statements:

```js
  const current = readJson(supPath(root), null);
  // spec §8 (D11): in slots mode only lane N stops; the supervisor and the other lanes go on
  if (current?.lanes) return attendLane(root, id, current);
```

and after `attend`, add:

```js
// spec §8 (D11): the owner takes phase N's remaining plans into a session in its slot. The mark goes first: from its next
// tick the daemon holds lane N and stops any session of it that still appears; then lane N's sessions stop (claude stop
// keeps the conversation). The daemon and the other lanes are left alone. Refusals change nothing.
async function attendLane(root, id, sup) {
  const lane = laneForPhase(sup, root, id);
  const keys = supervisorLanes(sup, root).map((l) => l.key).join(', ');
  if (!lane) die(`phase ${id} has no lane in this run${keys ? ` (lanes: ${keys})` : ''}: attend takes over a running lane (turbo-run status names them); nothing was stopped`);
  const plans = openPlans(lane.slotPath, id);
  if (plans === null) die(`no single phase directory for phase ${id} under ${path.join(lane.slotPath, '.planning', 'phases')}: nothing to attend`);
  if (!plans.length) die(`phase ${id} has no plan without a summary: nothing to attend. For owner-only UAT items run /gsd-verify-work ${id} in ${lane.slotPath}, then /turbo-autonomous resume ${id}`);
  const gates = attendGates({ mode: lane.mode, next: nextStep(readProgress(root, id)) });
  if (gates.refuse) die(`phase ${id} is not ready to attend: ${gates.refuse}; nothing was stopped`);
  writeAttend(root, id, { sessionId: lane.sessionId || null });
  const claude = createClaude();
  const warn = (line) => process.stderr.write(`warn: ${line}\n`);
  let code = 0;
  const ids = new Set([lane.sessionId].filter(Boolean));
  const name = laneSessionName(root, lane.key);
  try {
    for (const a of claude.list()) if (a.name === name && a.cwd && dirKey(a.cwd) === dirKey(lane.slotPath) && isAgentAlive(a)) ids.add(a.id);
  } catch (e) {
    warn(`cannot list sessions (${e.message}); only the recorded session of phase ${id} was stopped`);
    code = 1;
  }
  for (const x of ids) {
    try {
      claude.stop(x);
    } catch (e) {
      let alive = true;
      try { alive = isAgentAlive(claude.list().find((a) => a.id === x)); } catch { /* unknown: alive */ }
      if (alive) {
        warn(`lane session ${x} not stopped: ${e.message}`);
        code = 1;
      }
    }
  }
  const released = releaseStops(root, id);
  out(`phase ${id}: attended in the owner's session; the other lanes keep running; nothing starts, relaunches or wakes phase ${id} until turbo-run attend ${id} --done`);
  out(`open: cd "${lane.slotPath}" && claude`);
  out(`open plans: ${plans.join(', ')}`);
  out(`gates: ${gates.gates === 'off' ? 'turn off' : 'keep on'} (${gates.why})`);
  if (released.length) out(`released stops: ${released.join(', ')} (asked ahead again)`);
  const delivered = readQuestions(root, id).filter((q) => q.stopped && q.state === 'delivered').map((q) => q.id);
  if (delivered.length) out(`already delivered: ${delivered.join(', ')} (the stopped session took these answers; a checkpoint reached again is asked in this session)`);
  if (code !== 0) process.stderr.write(`a lane session did not stop (see the warnings above): stop it with claude stop <id> before anything runs in ${lane.slotPath}\n`);
  return code;
}
```

12. In `main`, replace

```js
  const root = projectArg(cmd === 'attend' ? args.filter((a) => a !== '--done') : args);
```

with:

```js
  const found = projectArg(cmd === 'attend' ? args.filter((a) => a !== '--done') : args);
  const root = found && OWNER_COMMANDS.has(cmd) ? stateRoot(found) : found;
```

In `case 'status':` replace `else printStatus(sup, running, { attended });` with `else printStatus(sup, running, { ...statusOpts(root, config), attended });`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/cli.test.mjs test/push-cli.test.mjs test/cli-project-arg.test.mjs`
Expected: PASS (the six new tests; v0.3's CLI tests in checkout mode unchanged).

- [ ] **Step 5: Commit**

```bash
git add bin/turbo-run.mjs test/cli.test.mjs
git commit -q -m "feat(lanes): turbo-run runs several lanes in slots: start, status, stop, resume and attend per lane"
```

---

### Task 12: Reference and the attend skill

**Files:**
- Modify: `docs/reference.md` (new section `## Several lanes` before `## Owner questions`; Config rows), `skills/turbo-autonomous/SKILL.md` (section `## If the arguments are \`attend <phase>\``)

**Interfaces:**
- Consumes: the behaviour of Tasks 1–11.
- Produces: user-facing text only.

- [ ] **Step 1: Write the reference section**

In `docs/reference.md`, right before the line `## Owner questions`, insert:

```markdown
## Several lanes

With `lanes.mode: "slots"` (the default) and doctor's full mode, the supervisor runs up to `max_lanes` phases at once, each in its own slot (see [Lane slots](#lane-slots)), and prep and annotate jobs in the slots the phases leave (at most `max_prep`).

- **Which phases run together.** A phase starts when every phase it depends on is finished, its `Areas` (the ROADMAP annotation) do not overlap the `Areas` of a running phase, none of its `Gates` is held by a running phase or a lock, and a free slot that Claude Code trusts exists. A phase without annotation, or with low confidence, may touch any path, so it runs alone. Without a fresh annotation (`.planning/turbo/lanes.json`) only one phase lane runs. Among the ready phases, the one with the longest chain of phases waiting on it goes first.
- **Shared resources.** Before a deploy, a packaged build or a live check, a lane takes a lock: `turbo-run lock <gate> <N> [--wait-seconds <s>]` (default 540; exit 0 taken, 3 still held after the wait and you are notified, 2 usage or an unknown gate) and `turbo-run unlock <gate> <N>`. The gates are `prod-deploy`, `owner-live`, `owner-signature`, `packaged-build` and your `lanes.gates`. A lane's locks are released when it ends; a lock nobody holds a lane for stays until you unlock it.
- **When a lane fails.** Only that lane stops: you get one notification with the reason and `cd "<slot>" && claude` to look inside. Its slot keeps the work, and the phases that depend on it wait; the other lanes go on. `/turbo-autonomous resume <N>` tries it again in the same slot, and so does a new start. When every lane has stopped and nothing else can start, the supervisor halts. A slot Claude Code does not trust is never used: you get its trust line once.
- **attend.** `turbo-run attend <N>` stops only lane N and prints `open: cd "<slot>" && claude`: the sitting runs there. The supervisor and the other lanes keep running. `turbo-run attend <N> --done` gives the phase back.
- **stop and status.** `stop` stops every lane, prep and annotate session; the slots and their branches stay for review. `status` prints `lanes: <n> · questions: <n> · next: <what the next phase waits for>` and one block per lane.
- `lanes.mode: "checkout"` runs one lane in this checkout, exactly as v0.3 (also what a safe-mode supervisor does).
```

In the Config table, replace the `max_lanes` row with:

```markdown
| `max_lanes` | `3` | Phases (and prep and annotate jobs) that run at once, each in its own slot (`lanes.mode: "slots"`). |
```

and add right after it (after any rows L0 added there):

```markdown
| `max_prep` | `null` | Prep and annotate jobs at once; `null` is `max_lanes`, `0` none. Ready phases always get the slots first. |
| `merge_rounds` | `3` | Times a ready phase integrates again while `main` keeps moving, before you are asked. |
| `lanes.gates` | `[]` | Your own shared resources (lower-case letters, digits and `-`), next to `prod-deploy`, `owner-live`, `owner-signature`, `packaged-build`. |
```

- [ ] **Step 2: Update the attend skill**

In `skills/turbo-autonomous/SKILL.md`, section `## If the arguments are \`attend <phase>\``, replace `Run every command from the project root.` with:

```markdown
Run every command from the project root; in slots mode, from the lane's slot (point 1).
```

In point 1, right after the bullet that starts `   - It stopped the supervisor and the lane's session`, add:

```markdown
   - In slots mode it stopped only that lane's session (the supervisor and the other lanes keep running) and printed `open: cd "<slot>" && claude`. If this session's working directory is not `<slot>`, tell the user to run that line in a terminal and to call `/turbo-autonomous attend <N>` in the new session, then stop: the sitting runs in the lane's slot, which Claude Code already trusts. Running `attend <N>` again there is safe: the mark stays and nothing else stops.
```

- [ ] **Step 3: Run the tests that read these files**

Run: `node --test test/skill.test.mjs test/install.test.mjs`
Expected: PASS (the skill's pinned sections are unchanged; the text is additive).

- [ ] **Step 4: Commit**

```bash
git add docs/reference.md skills/turbo-autonomous/SKILL.md
git commit -q -m "docs(lanes): several lanes in the reference; attend in a lane's slot"
```

---

## After the last task

The controller runs the full suite once (`npm test`) before merging into `stage-4`, as the Global Constraints require. Nothing in this plan pushes, merges, tags or installs.

Live check outside CI (spec §13 "живой прогон", with the journal), on the reference project after L0–L3 are merged: `turbo-run start` in slots mode with two independent annotated phases → two background sessions, each with cwd = its slot, `turbo-run status` shows both lanes and the next line; `turbo-run attend <N>` stops only that lane and prints its slot; `turbo-run stop` stops both and keeps the slots; a restart (`start`) adopts the sessions without a second launch.

## Spec coverage

| Spec | Task |
|---|---|
| §5 `supervisor.json.lanes` instead of `lane`; everything for `s.lane` per entry (launch, context relaunch, stall wake, answers, attend, restart limit) | 7, 8, 9 (D1: checkout keeps `lane`) |
| §5 readiness: deps + range; Areas disjoint (`**` without annotation); Gates free; free trusted slot; < `max_lanes` | 2, 8 |
| §5 order: comparePhase / critical path (D4); one lane without or with a stale `lanes.json` | 2, 8 |
| §5 Gates for the whole phase; `turbo-run lock/unlock` with timeout and notification | 5, 8, 9 |
| §5 merge lock order (one `locks/merge`) | Interfaces (L2/L3 take `withMergeLock`; the supervisor calls them one at a time) |
| §5 `lanes.mode: "checkout"` = v0.3 | 7, 8 (dispatch), 11 (`makeCtx`, `fakeProject`) |
| §6.1 prep jobs, `max_prep`, phases first | 1, 9 |
| §6.3 Areas overlap | 2 |
| §6.4 stale annotation → one lane / `**` | 2 (D5) |
| §8 attend N stops only lane N, prints `cd <slot> && claude`; the others go on | 8 (supervisor hold), 11 (CLI), 12 (skill) |
| §8 stop: every lane, prep, annotate; slots and branches stay | 11 |
| §8 status per lane + summary line | 4, 11 |
| §9 a lane fails alone; dependents wait; restart picks lanes up; dirty slot not used; lost trust → line | 8, 9, 10 (dirty slots: L0's `listSlots`/`prepareSlot` refuse; D10) |
| §10 `max_prep`, `lanes.gates`, `merge_rounds` | 1, 11 (validated by `runtimeConfig`), 12 |
| §13 unit (overlap, readiness) + e2e with a fake `claude` (three phases, two together, failure isolation, restart) | 2, 8, 9, 10 |
| Journal defect: stall ignored nested subagents | 3 |

## Interfaces for L2–L4

Everything below is exported (or called) exactly as written; L2–L4 use these names and never re-implement them. `root` is the control root; `ctx` is the supervisor's context (`ctx.root`, `ctx.config`, `ctx.deps`, `ctx.turboRun`, `ctx.mode`; `ctx.lanes === 'slots'` in slots mode).

**State (`supervisor.json`, slots mode)** — written only by the supervisor:
- Top level: `{ lanesMode: 'slots', lanes: { [key]: LaneEntry }, finished, halted, poll_seconds, range?, next: Next | null, jobsFailed?: { [key]: { why, at } }, pid, updatedAt }`; never `lane`. Checkout mode keeps v0.3's `{ lane, … }` unchanged.
- `LaneEntry = { key, job: 'phase'|'prep'|'annotate', phase: string|null, slot: number, slotPath: string, branch: string, sessionId: string|null, launchedAt: string|null, restarts: number, notified: object, mode: 'full', name?, fingerprint?, blockedSince?, forceRelaunch?, launch?: 'new'|'resume', halted?: { why: 'failed'|'noProgress'|'launch'|'missing'|'untrusted', at, error?, id?, restarts? }, launchFailures?, areas?: string[], gates?: string[], mergeWait?, jobWait?, stall?, woken?, merge?: object }`. `key` = `<N>` | `prep-<N>` | `annotate`. `merge` is L2's (opaque to L1, persisted as written). L0's invariant holds: an entry exists only while `slotForPhase(root, config, phase, { kind: job })` names its `slot`.
- `Next = { phase: string, why: 'deps'|'areas'|'gates'|'slots'|'annotation', waitsFor: string[], gate?: string }`.
- Readers (L4 and every module outside the supervisor) go through `lib/lanes-state.mjs`: `supervisorLanes(sup, root) → LaneEntry[]` (v0.3's `lane` shown as `{ …lane, key: N, job: 'phase', slot: 0, slotPath: root, branch: null }`), `laneForPhase(sup, root, phase)`, `laneAt(sup, root, dir)`, `laneLabel(lane, lang)`, `nextLine(next, lang)`, `lanesSummary({ lanes, questions, next }, lang)`, `compareLanes(a, b)`, `laneKey({ job, phase })`, `recordKey(lane)`, `laneCwd(root, lane)`, `JOBS`, `DONE_STATUSES`, `setupLines(result)`.

**Run records (`lib/run-status.mjs`)**: `LANE_STATUSES` = `running`, `paused-context`, `needs-owner`, `done`, `failed`, `ready`, `prepped`, `annotated`. A lane's record is `readLaneStatus(root, recordKey(lane))`: `run/p<N>.json` for a phase and for its prep, `run/pannotate.json` for annotate. A lane ends when its record is fresh (`at >= lane.launchedAt`), its status is in `DONE_STATUSES[lane.job]` (phase `ready`, `done`; prep `prepped`; annotate `annotated`) and its session's turn has ended. L2 writes `ready` (with its own `--base`), L3 writes `prepped` (`lane-status <N> prepped`) and `annotated` (`lane-status annotate annotated`); L1 only reads them.

**L2 → L1: the merge — `lib/merge.mjs` (L2 implements)**
- `mergeReady(ctx, lane: LaneEntry) → Promise<{ outcome: 'merged'|'reintegrate'|'needs-owner'|'wait', reason?: string, prompt?: string }>`.
- The supervisor calls it once per tick for a phase lane in the end state above, never at the same time as another `mergeReady` or `finishJob`; L2 takes `withMergeLock(root, …)` itself (one merge lock for merges, answer commits, prep and annotation merges).
- `merged`: merged into main, `phase.complete` committed, push/CI done (green, or `push.mode: off`), and the slot released by L2 (`releaseSlot(root, lane.slot, { outcome: 'merged' })`). L1 then removes the session, notifies `phaseDone`, removes the lane's temp directory and its gate locks (`releaseGatesOf`), and deletes the entry. L1 never releases a phase lane's slot.
- `reintegrate`: `prompt` is required (a plain argv value: no `"`, no `%`, never a leading `-`). L1 wakes the lane's own session with it (`claude --bg --resume`, cwd = the slot) and moves `launchedAt` (the old `ready` record no longer counts), or starts a new resumed session when the wake fails. L2 counts the rounds against `mergeRounds(ctx.config)` in `lane.merge` and returns `needs-owner` past them.
- `needs-owner`: L1 notifies `laneNeedsOwner { phase, reason }` once (`lane.notified.merge`) and keeps calling `mergeReady` each tick.
- `wait` (CI pending, main dirty, lock busy, …): logged once per distinct `reason`; called again next tick.
- Any other value, or a throw: that lane's error (D7), retried next tick.

**L3 → L1: jobs and annotation**
- `lib/prep.mjs` (L3 implements):
  - `pendingJobs(ctx, phases, { lanes, lanesFile, failed }) → Job[] | Promise<Job[]>`, `Job = { job: 'prep'|'annotate', phase: string|null }` in priority order (`phase` null for annotate). `lanes` = `supervisor.json.lanes`, `lanesFile` = this tick's `readLanesFile(root)`, `failed` = the keys in `jobsFailed`. L1 skips keys already running or failed and prep of a phase that has a lane or is attended, caps jobs at `maxPrep(config, maxLanes(config))` and all lanes at `max_lanes`, and gives ready phases the slots first (D9). L1 prepares the slot itself (`prepareSlot(root, slot, { kind: job, phase })`, branch `turbo/prep-<N>` / `turbo/annotate`) and launches the session (cwd = slot, `controlRoot` = root, name `laneSessionName(root, key)`).
  - `jobPrompts({ ctx, lane: { key, job, phase, slotPath }, resume: boolean, wake: null | { kind: 'answers', ids: string[], lane: Array<{ id, option, label }> } | { kind: 'stall', minutes: number } }) → { prompt: string, systemPrompt: string }` — launch prompts (`wake: null`) and wake prompts (`.prompt` only); plain argv values.
  - `finishJob(ctx, lane: LaneEntry) → Promise<{ outcome: 'merged'|'failed'|'needs-owner'|'wait', reason?: string }>` — called like `mergeReady` once the job's record is `prepped`/`annotated` and its turn ended. `merged` / `failed`: L3 merged (or refused, §6.1) under `withMergeLock` and released the slot (`releaseSlot`, `merged` or `failed`); L1 removes the session and the entry, and `failed` adds `jobsFailed[key]`. `needs-owner`: notified once; `wait`: logged once per reason.
  - A job session that fails, makes no progress or cannot launch: L1 releases its slot (`releaseSlot(root, k, { outcome: 'failed' })`), records `jobsFailed[key]`, and the job is not proposed again until the next `start`.
- `lib/lanes-file.mjs` (L3 implements): `readLanesFile(root) → null | { fresh: boolean, phases: { [N: string]: { areas: string[], gates: string[], confidence: 'high'|'medium'|'low' } } }`. `null` or `fresh: false` → at most one phase lane; a phase missing from `phases` or with `confidence: 'low'` → areas `**` (its gates still count); a throw is logged and counts as `null`. §6.4's partial staleness: leave the changed phases out of `phases` and keep `fresh: true`.
- `lib/scheduler.mjs` (L1 implements): `areasOverlap(a: string[], b: string[]) → boolean` (spec §6.3; a non-array is `**`, `[]` overlaps nothing), `maskPrefix(mask) → { segs, partial }`, `annotationOf(lanesFile, N) → { areas, gates }`, `criticalPath(phases) → Map`, `pickPhases(phases, { range, running, exclude, annotation, heldGates, slots, oneLane }) → { picked, next }`, `ANY_AREA`. L3's analyst may call `areasOverlap` for `pairs`.
- Loading: `loadLanePlugins()` (`lib/lane-plugins.mjs`) imports `lib/merge.mjs`, `lib/prep.mjs`, `lib/lanes-file.mjs` by exactly these names; each must export the functions above (a missing export is an error; a missing file means "not there yet": no merge, or no jobs and no annotation).

**Config (`lib/config.mjs`)**: `DEFAULTS.max_prep = null`, `DEFAULTS.merge_rounds = 3`, `DEFAULTS.lanes.gates = []`; `GATE_NAMES`, `GATE_RE`, `laneGates(config) → string[]`, `mergeRounds(config) → number`, `maxPrep(config, lanes) → number`; `runtimeConfig` in `bin/turbo-run.mjs` validates all three.

**Gates (`lib/gate-locks.mjs`)**: `gateFile(root, gate)`, `readGate(root, gate)`, `heldGates(root) → Array<{ gate, phase, at }>`, `gateDeclaredBy(sup, gate, phase)`, `acquireGate(root, gate, phase, opts)`, `releaseGate(root, gate, phase)`, `releaseGatesOf(root, phase)`; CLI `turbo-run lock <gate> <N> [--wait-seconds <s>]` (exit 0 / 3 / 2 / 1) and `turbo-run unlock <gate> <N>`; `lockRule({ phase, turboRun })` in every slot lane's system prompt (`laneSystemPrompt({ …, slots: true })`).

**Supervisor**: `tick`, `runDaemon`, `resumableLane` (checkout), `resumableLanes(prev, range, ctx)` (slots), `placeOf(ctx, lane)`, `wakePrompt(ctx, lane, wake)`. `ctx.deps.slots = { list, free({ skip }), untrusted, prepare(slot, job), release(k, outcome), forJob(phase, kind) }` wraps L0 for the supervisor only; L2 and L3 call L0 directly. Owner commands (`start`, `daemon`, `status`, `view`, `stop`, `resume`, `attend`) run on `stateRoot(root)`. New notifications: `laneStopped { phase, why, slot, error }`, `slotUntrusted { k, line }`, `slotRefused { k, why, minutes }`, `gateWait { phase, gate, holder, minutes }`.

**L4 (view)**: reads `supervisor.json` through `supervisorLanes(sup, root)`. Per lane: transcripts from `lane.slotPath` (`createLaneProbe(root).activity(jobId, now, stallMs, lane.slotPath)`, `laneTranscript({ home, root: lane.slotPath, jobId })`, `projectDirs(home, lane.slotPath)`); run files from the control root (`readProgress(root, lane.phase)`, `readLaneStatus(root, recordKey(lane))`); plans from `lane.slotPath`; the summary from `lanesSummary` / `nextLine` and `sup.next`; `halted`, `forceRelaunch`, `launch`, and the attended marks (`attendedPhases(root)`). L1 leaves `lib/view.mjs` as it is (it still reads `sup.lane`); L4 switches it to `supervisorLanes`.

