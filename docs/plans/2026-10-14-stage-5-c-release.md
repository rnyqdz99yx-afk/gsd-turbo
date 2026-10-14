# Stage 5 — integration and release v0.5.0 (binding for the controller)

The plans `2026-10-14-stage-5-a-adopt.md` (A) and `2026-10-14-stage-5-b-plan-drafts.md` (B) are written to run in
parallel against the spec `docs/specs/2026-10-14-stage-5-design.md`. This file fixes the order, the expected
overlaps, the merge checks and the release steps. Where A or B disagree with this file, this file wins.

## Order of implementation

1. The spec and the three plans merged into `web` (docs only).
2. **A and B in parallel**, each on its own topic branch cut from `web`: `web-stage5-a-adopt`, `web-stage5-b-drafts`
   (a branch name with `/` under `web` is impossible here: `web` is itself a branch). Each: an Opus implementer, then a
   fresh independent Opus reviewer, then fix rounds; CI green on the branch.
3. Merge back into `web` with `--no-ff`: **B first** (smaller surface in shared files), then **A**. After each merge:
   the targeted tests of the overlap files below, then the full `npm test` once after the second merge, then CI.
4. The owner's home session replays the code-only commits onto public `stage-5` (cut from `main` after v0.4.0 is
   released), CI, then the live checks (below), then the release.

v0.5.0 is released only after v0.4.0 is released and installed (journal RESUME POINT step 4).

## Expected overlaps (resolve by keeping both sides)

| File | A | B |
|---|---|---|
| `bin/turbo-run.mjs` | `case 'init'` → `initProject`; `case 'adopt'`; `staleClosedLine` in `start` and `printStatus`; `USAGE`; `VALUE_FLAGS` (`--answers`, `--plan`, `--lang`) | `USAGE` (`plan-drafts`) |
| `docs/reference.md` | `## Adopting a running milestone`; `## Use` | `## Plan drafts`; `## Config` keys; lane command list |
| `README.md`, `README.ru.md` | Use list, Roadmap item 5 | — |

`VALUE_FLAGS` exists twice (bin's and `lib/cli-phase.mjs`'s) and bin's `projectArg` skips the value of a flag from
either set in every command. So a flag name must mean the same in both: A's value flags are `--answers`,
`--plan-sha`, `--lang`; B's are `--drafting`, `--drafted`, `--reconcile`, `--reconciled`, `--verdict`, `--promote`,
`--replan`, `--reason`; B's `--plan` and `--status` take no value and are **not** value flags (A must not add
`--plan`). After the second merge run `test/cli-project-arg.test.mjs`: `plan-drafts N --plan --project <dir>` and
`adopt apply --plan-sha <sha> --project <dir>` both resolve the project.

## Merge checks

- After B: `node --test test/outline-rows.test.mjs test/plan-drafts.test.mjs test/plan-drafts-git.test.mjs test/cli-plan-drafts.test.mjs test/phase-progress.test.mjs test/phase-files.test.mjs test/skill-turbo-phase.test.mjs test/view.test.mjs test/view-model.test.mjs test/config.test.mjs`.
- After A: `node --test test/project-init.test.mjs test/adopt-scan.test.mjs test/adopt-forecast.test.mjs test/adopt-plan.test.mjs test/adopt-apply.test.mjs test/cli-adopt.test.mjs test/skill-turbo-adopt.test.mjs test/annotate.test.mjs test/lanes-file.test.mjs test/prep.test.mjs test/cli.test.mjs test/cli-project-arg.test.mjs`, then `npm test`.
- Scan before each push: `node .superpowers/tools/scan.mjs . <base>..HEAD .superpowers/tools/private-terms --quiet && git push` (never piped).

## Release v0.5.0 (owner's PC, home session)

1. Version 0.5.0 in `package.json`, `mod/.claude-plugin/plugin.json`, `test/install-stage2.test.mjs` (its pinned
   version), the README version line and Roadmap (item 5 done; item 4 `turbo-exec` next).
2. `node install.mjs` (dry run first), then the live checks of spec §12, items 1–6, with the journal open:
   - adopt on a project with closed stale phases (one commit, `git revert` clean, repeat without a commit);
   - re-verification on two or three closed phases (time per phase);
   - the closed-phases line in `start`/`status` before adopt and not after;
   - drafts on a phase with ≥ 3 waves in a slot: the planner writes the draft path and nothing in the phase
     directory; how many drafts ran at once; reconcile time; `replanned` count; the measurement line against a phase
     with `plan_drafts.enabled: false` (or phase 33's ~3.5–4 h);
   - owner questions after each promoted plan (pane, Telegram).
3. Drafts failed the live check (agents write into the phase directory, a reconcile takes longer than a plan, more
   than half of the drafts `replanned`) → set `DEFAULTS.plan_drafts.enabled` to `false`, note it in the README and
   reference, release anyway (spec D4).
4. Merge `stage-5` → `main`, tag `v0.5.0`, GitHub Release, CI on the tag.
5. Journal: a `## v0.5.0` entry with the measurements (planning wall clock with and without drafts, adopt timings).
