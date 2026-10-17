# gsd-turbo Stage 6 E2 — targeted tests per merge, owner cards that hold only dependents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Build only after the go/no-go of the spec §5 says yes or weak yes.**

**Goal:** Three small changes the exec engine (plan E1) calls, each useful and testable on its own: (1) `turbo-run test-changed --merge <sha>` runs the targeted tests of one merge commit without counting toward `test.max_targeted`; (2) `turbo-run questions N --stop … --keep-running` opens an owner card for a checkpoint without telling the lane to stop; (3) the supervisor puts the owner's answer to such a card into the lane's inbox (`owner-answer`) instead of waking the lane, and wakes it only when the lane has no subagent at work (a wake stops the session and its background executors: spec T7).

**Architecture:** `lib/test-changed.mjs` gets a `merge` option in `runTestChanged` (the changed set is `<sha>^1..<sha>`, the marker's targeted count is left alone, every reason for a full run it already has still applies); bin passes `--merge`. `lib/questions.mjs` `stopQuestion` gets `held: true` (recorded on the question) and `lib/cli-phase.mjs`'s `questions --stop` prints a `held:` line for it. `lib/supervisor.mjs` (`sharedStatus` for `running`/`blocked` lanes) appends an `owner-answer` inbox message once per answer set of held questions and wakes the lane only when its activity shows no running subagent; `lib/inbox.mjs` formats the message; `lib/wake.mjs` gets the wake prompt for it.

**Tech Stack:** Node ≥ 20 (ESM `.mjs`, `node:test`), git (`diff --name-only <sha>^1 <sha>`).

**Spec:** `docs/specs/2026-10-15-stage-6-design.md` — §2 decision 4, §3 T4, T5, T7, §6.5 point 4, §6.6, §8 (last two rows), §12 (E2 row), §13 item 7.

**Base:** branch `web` with the spec merged. Topic branch `web-stage6-e2-hooks`. Independent of E1 (E1 calls these as subprocesses and fakes them in its tests).

What this plan consumes, by exact name: `lib/test-changed.mjs` (`runTestChanged`, `planRun`, `planEntries`, the marker read/write and `targetedSince`), `lib/questions.mjs` (`stopQuestion`, `deliveryState`, `readQuestions`), `lib/cli-phase.mjs` (the `questions` handler, `QUESTIONS_USAGE`), `lib/supervisor.mjs` (`sharedStatus`, `checkStall`'s `live` activity `{ lastMs, active, calls }`, `wakeSession`, `wakePrompt`, `recordKey`, `currentAsk`), `lib/inbox.mjs` (`appendInbox`, `unreadInbox`, `formatInboxMessage`), `lib/wake.mjs` (`inboxWakePrompt`). Tests: `test/helpers/tmp.mjs`, `test/helpers/slots.mjs`, the existing supervisor test harness (`test/supervisor*.test.mjs` fakes for `deps.claude`, `deps.lanes`).

## Decisions this plan makes where the spec is open

- **H1 `--merge` refuses a non-merge.** `<sha>` must be a commit with two parents reachable from HEAD; otherwise `test-changed: --merge needs a merge commit on this branch` and exit 2. Its changed set is `git diff --name-only <sha>^1 <sha>` (what the merge brought in), plus the working tree's dirty files (as a normal run counts them).
- **H2 The marker.** A green `--merge` run never resets `targetedSince` and never counts in it; a red one changes nothing either. A full run it falls back to (its own rules: config change, unknown runner, `TURBO_FULL=1`, the phase-end rule) records as a full run does today. Its log line starts `[turbo-test] merge <short sha>:`.
- **H3 `held` is per question revision.** `--keep-running` sets `held: true` on the question revision `--stop` writes; a later `--stop` without the flag (the lane stops after all) clears it. `turbo-run questions --open --json` shows `held`.
- **H4 One inbox message per answer set.** The key is the one `wakeForAnswers` uses (`id:rev:answer.at`); the lane record keeps `heldAnswered: { key, at }` so a supervisor restart does not send it twice. The message: `{ kind: 'owner-answer', ids: [...] }`; `formatInboxMessage` prints `owner-answer · answered: <ids> · deliver them: turbo-run questions N --deliver`.
- **H5 Wake only when idle.** After appending, the supervisor wakes the lane with `inboxWakePrompt(kind 'owner-answer')` only when its status is `blocked` (the turn ended) and the activity probe says no subagent is active and no call is in flight; otherwise it waits for the lane to read its inbox. `needs-owner` lanes keep today's `wakeForAnswers` path unchanged (a held question whose lane then stopped is answered the old way).

## Global Constraints

- Node ≥ 20, ESM `.mjs`, zero runtime dependencies; Windows and Linux (no shell, `windowsHide`, timeouts).
- Without `--merge` and without `--keep-running`, everything behaves byte for byte as now (existing tests unchanged and green).
- Never a `claude stop` of a lane while one of its subagents is active (pinned).
- TDD; targeted test files per task; full `npm test` once before hand-back; one commit per task. Never push, merge, tag or install.

## Review Focus

1. A held answer never wakes a lane with an active subagent (Task 3).
2. `--merge` never makes a later normal run skip a full run it owes (Task 1).
3. No behaviour change without the new flags (Tasks 1–3).

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/test-changed.mjs` | modify | `merge` option: changed set, marker untouched, log prefix |
| `bin/turbo-run.mjs` | modify | `case 'test-changed'` passes `--merge`; bin `VALUE_FLAGS` + `--merge` |
| `lib/questions.mjs` | modify | `held` on `stopQuestion`, cleared by a plain `--stop` |
| `lib/cli-phase.mjs` | modify | `questions --stop … --keep-running`: the `held:` line; usage text |
| `lib/supervisor.mjs` | modify | held answers → inbox once; wake only when idle |
| `lib/inbox.mjs`, `lib/wake.mjs` | modify | `owner-answer` text and wake prompt |
| `docs/reference.md` | modify | `test-changed --merge` (Test runner section), `--keep-running` (Owner questions), the inbox kind |
| `test/test-changed-merge.test.mjs`, `test/questions-held.test.mjs`, `test/supervisor-held.test.mjs` | create | tests |

## Contracts

- `turbo-run test-changed --merge <sha>` — exit code of the test command(s); first log line `[turbo-test] merge <short>: targeted (<n> files changed by the merge)` or `… : full (<reason>)`.
- `turbo-run questions <N> --stop <id> --agent <a> --keep-running […]` — `held: <qid> waits for the owner; only the plans that need <plan> wait` (or `answered: …` as today). Exit 0.
- Inbox message `owner-answer` (H4) and its wake prompt (H5): "turbo: the owner answered questions of phase N. Run turbo-run inbox N, then deliver them (turbo-run questions N --deliver) and go on." (fixed text, as the other wake prompts).

---

### Task 1: `test-changed --merge`

**Files:** modify `lib/test-changed.mjs`, `bin/turbo-run.mjs`; create `test/test-changed-merge.test.mjs`.

- [ ] **Step 1: Tests first** (temp repo with a `node --test` root script and two test files): a merge commit that changes `lib/a.mjs` → only `test/a.test.mjs` runs; the marker's `targetedSince` unchanged after a green and after a red run; four `--merge` runs in a row never turn full by count; a merge that changes `package.json` → full (its own reason); `TURBO_FULL=1` → full; a non-merge sha or an unknown sha → exit 2 with the H1 line; a normal run after `--merge` runs still owes its full run by count as before.
- [ ] **Step 2–4:** fail, implement, green (`node --test test/test-changed-merge.test.mjs test/test-changed.test.mjs`).
- [ ] **Step 5:** Commit `feat(tests): test-changed --merge runs the targeted tests of one merge`.

### Task 2: `questions --stop --keep-running`

**Files:** modify `lib/questions.mjs`, `lib/cli-phase.mjs`; create `test/questions-held.test.mjs`.

- [ ] **Step 1: Tests first.** A checkpoint plan with a decision task: `--stop 3-02-t2 --agent a1 --keep-running` → `held: …`, the question `held: true`, no lane-status written, the owner card exists (`questions --open --json` lists it with `held`); the same without the flag → `stopped: …` as today and `held` false; an already answered checkpoint → `answered: …` either way.
- [ ] **Step 2–4:** fail, implement, green (`node --test test/questions-held.test.mjs test/questions.test.mjs`).
- [ ] **Step 5:** Commit `feat(questions): an owner card that holds only the plans that need it`.

### Task 3: the answer to a held card reaches a busy lane

**Files:** modify `lib/supervisor.mjs`, `lib/inbox.mjs`, `lib/wake.mjs`; create `test/supervisor-held.test.mjs`.

- [ ] **Step 1: Tests first** (the supervisor harness with fake `claude` and `lanes`): a `running` lane with a held answered question → one `owner-answer` message in its inbox, no `claude stop`/resume; a second tick → no second message (H4), also after the daemon restarts (state from `supervisor.json`); a `blocked` lane with an active subagent → message, no wake; a `blocked` lane with nothing active → message and one wake with the H5 prompt; a `needs-owner` lane → today's `wakeForAnswers` exactly; `formatInboxMessage` prints the H4 line.
- [ ] **Step 2–4:** fail, implement, green (`node --test test/supervisor-held.test.mjs test/supervisor-wake.test.mjs test/supervisor.test.mjs test/inbox.test.mjs test/wake.test.mjs`).
- [ ] **Step 5:** Commit `feat(supervisor): answers to held cards go to the lane's inbox; wake only an idle lane`.

### Task 4: docs

**Files:** modify `docs/reference.md`.

- [ ] **Step 1:** `test-changed --merge` in the test runner text (what it runs, that it never counts toward `test.max_targeted`); `--keep-running` and the `owner-answer` inbox message in `## Owner questions`.
- [ ] **Step 2:** Commit `docs: targeted tests per merge, held owner cards`.

## Acceptance

- `npm test` green (Linux) and CI green (Ubuntu + Windows); Review Focus 1–3 pinned by named tests; scan clean.
- Live check of spec §13 item 7 written into the journal as `re-check after install`.
