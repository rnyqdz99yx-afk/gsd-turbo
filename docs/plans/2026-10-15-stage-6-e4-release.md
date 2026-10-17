# Stage 6 — measure, integrate, release v0.6.0 (binding for the controller)

The calculator (A) is built on `web-stage6` (commit `628c8cc`, spec `docs/specs/2026-10-15-stage-6-design.md`). The plans
`2026-10-15-stage-6-e1-engine.md` (E1), `2026-10-15-stage-6-e2-hooks.md` (E2) and `2026-10-15-stage-6-e3-skill-view.md`
(E3) are written to run in parallel. This file fixes the order, the expected overlaps, the merge checks and the release
steps. Where E1–E3 disagree with this file, this file wins.

## 0. Measure first (owner's PC, home session) — decides everything below

1. Fetch `web-stage6` into a separate checkout (spec §4.1) and run, for phases 32 and 33 (first project) and 43 (second
   project): `node <checkout>/bin/turbo-run.mjs exec-whatif <N> --project <project>`, then the same with `--json`
   (saved for the journal). Read the `timings:` line: plans marked `start estimated` or `no timing` → correct them from
   the journal with `--minutes` and run again.
2. Check the model (spec §5): `GSD waves` against the `measured:` span minus the owner waits the journal records.
3. Decide by spec §5: **yes**, **weak yes** or **no**. Write the numbers (`GSD waves`, best row, `gain`, half-merge
   value, depends-only value, the three costliest edges) and the decision into the journal.
4. **No** → stop here: merge `web-stage6` (calculator, spec, plans) into `web` as documentation and a tool; Stage 6 waits.

## 1. Order of implementation (yes / weak yes)

1. `web-stage6` merged into `web` (calculator + spec + plans).
2. **E1, E2 and E3 in parallel**, each on its own topic branch cut from `web`: `web-stage6-e1-engine`,
   `web-stage6-e2-hooks`, `web-stage6-e3-skill-view`. Each: an Opus implementer, then a fresh independent Opus reviewer,
   then fix rounds.
3. Merge back into `web` with `--no-ff`: **E2 first** (smallest), then **E3**, then **E1**. After each merge the targeted
   tests below; after the third the full `npm test`, then CI.
4. The owner's home session replays the code-only commits onto public `stage-6` (cut from `main` after v0.5.0), CI, then
   section 3.

## 2. Expected overlaps (resolve by keeping both sides)

| File | E1 | E2 | E3 |
|---|---|---|---|
| `bin/turbo-run.mjs` | `USAGE` (`exec`); `attendLane` (release first) | `case 'test-changed'` (`--merge`); bin `VALUE_FLAGS` (`--merge`) | — |
| `lib/cli-phase.mjs` | `PHASE_COMMANDS` (`exec`), `VALUE_FLAGS` (`--running`, `--returned`, `--checkpoint`, `--continue`, `--failed`, `--retry`, `--task`, `--worktree`, `--branch`), `--done execute` | `questions --stop --keep-running` | — |
| `docs/reference.md` | `## Execution graph`, `## Config` keys, lane command list | test runner text, `## Owner questions` | — |
| `skills/turbo-phase/SKILL.md` | — | — | all |

`VALUE_FLAGS` exists in bin and in `lib/cli-phase.mjs`, and bin's `projectArg` skips the value of a flag from either set
in every command, so a flag name must mean the same everywhere: `--merge` (E2) takes a sha; E1's flags above take a
value; `--keep-running`, `--plan`, `--next`, `--status`, `--release`, `--done`, `--retest` take none. After the third
merge run `test/cli-project-arg.test.mjs`.

## 3. Merge checks

- After E2: `node --test test/test-changed-merge.test.mjs test/test-changed.test.mjs test/questions-held.test.mjs test/questions.test.mjs test/supervisor-held.test.mjs test/supervisor-wake.test.mjs test/inbox.test.mjs test/wake.test.mjs`.
- After E3: `node --test test/skill-exec-loop.test.mjs test/skill-turbo-phase.test.mjs test/view.test.mjs test/view-model.test.mjs`.
- After E1: `node --test test/config.test.mjs test/exec-state.test.mjs test/exec-merge.test.mjs test/cli-exec.test.mjs test/exec-resume.test.mjs test/attend.test.mjs test/phase-progress.test.mjs test/exec-graph.test.mjs test/exec-whatif.test.mjs test/cli-exec-whatif.test.mjs test/cli-project-arg.test.mjs`, then `npm test`.
- Scan before each push: `node .superpowers/tools/scan.mjs . <base>..HEAD .superpowers/tools/private-terms --quiet && git push` (never piped).

## 4. Release v0.6.0 (owner's PC, home session)

1. Version 0.6.0 in `package.json`, `mod/.claude-plugin/plugin.json`, `test/install-stage2.test.mjs` (its pinned
   version), the README version line and Roadmap (item 6 done).
2. `node install.mjs` (dry run first); in ONE project set `exec.enabled: true` (and `max_executors` from the what-if
   table, at most 4 at first); run the live checks of spec §13 items 1–12 with the journal open.
3. Items 2, 3 or 4 fail → release with `exec.enabled: false` (the default anyway, D5) and a README note; items 5, 6, 8 →
   tune `max_executors` and the retries; the rest → fixes on a topic branch before turning exec on by default.
4. Turning exec on by default (`DEFAULTS.exec.enabled = true`) only after two live phases passed (one wide, one with an
   owner question held while others ran) and the measurement line beat the what-if's wave time on the wide one.
5. Merge `stage-6` → `main`, tag `v0.6.0`, GitHub Release, CI on the tag.
6. Journal: a `## v0.6.0` entry with the measurements (`phase N execute:` lines with and without exec, against the
   what-if forecasts).
