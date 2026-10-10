# gsd-turbo

## What it is

gsd-turbo is an overlay for [GSD](https://github.com/open-gsd/gsd-core) on Claude Code that runs a milestone faster with background Claude Code sessions. A small supervisor process (no LLM of its own) starts each remaining phase of the current milestone as an unattended background session, starts a fresh one when a session stops at its context limit, replaces full test runs with targeted ones where that is safe, and notifies you when a phase finishes or needs you. It does not modify GSD: it talks to GSD only through `gsd-tools` and GSD's own skills, agents and workflows, and it writes only a few documented GSD settings (see [GSD settings turbo writes](#gsd-settings-turbo-writes)).

This is v0.2.2 (stage 2 of the [roadmap](#roadmap)). Each phase now runs as `/turbo-phase`: a freshness check, discuss in assumptions mode, a parallel planning prologue, GSD planning and execution, gates in parallel, fixes, a full test run, automated UAT and a done record. One phase still runs at a time.

## Requirements

- Node.js ≥ 20 and git.
- Claude Code ≥ 2.1.234 (background sessions: `claude --bg`, `claude agents --json --all`).
- GSD core 1.16.x, installed with `npx @opengsd/gsd-core@latest` (or `npx @opengsd/gsd-core@1.16` to stay inside the tested range). `turbo-run doctor` is tested against `>=1.16.0 <1.17.0`. A different GSD version, including newer minor and major releases, runs in safe mode if the other checks pass: doctor prints `FAIL gsd-version …` and then `mode: safe`. If `gsd-tools init manager` changed incompatibly, doctor reports `mode: unsupported` and the run does not start. `/turbo-phase` (whether the supervisor or you start it) needs full mode, which also needs the tested GSD range (see [Full and safe mode](#full-and-safe-mode)).
- Windows, macOS or Linux.
- Claude Code must trust the project folder: run `claude` in it once and accept the trust prompt. In a folder it does not trust, every background session fails to start; the supervisor then stops at the first attempt and notifies you.
- For automated browser checks (`turbo-uat`): Playwright (`playwright` or `@playwright/test`) installed in the project, with its Chromium browser. turbo never installs packages or browsers; without them, the items that need a browser go on your checklist.

## Install

```sh
git clone https://github.com/rnyqdz99yx-afk/gsd-turbo && cd gsd-turbo && node install.mjs
```

The installer copies files into your Claude Code config directory (`~/.claude`, or `$CLAUDE_CONFIG_DIR` when it is set):

- `turbo/`: the `turbo-run` CLI, its library and an install manifest;
- `skills/turbo-autonomous/`: the `/turbo-autonomous` skill;
- `skills/turbo-phase/`: the `/turbo-phase` skill, which a full-mode background session runs for its phase;
- `agents/turbo-uat.md`: the `turbo-uat` agent, which `/turbo-phase` starts for automated UAT.

It never writes `gsd-*` paths. `node install.mjs --dry-run` shows only how many files would be installed and where, without writing anything.

To upgrade, first stop the supervisor in every project where one runs (`/turbo-autonomous stop` there): a running supervisor keeps the old code in memory, and its background sessions call the files the upgrade replaces. Then run `git pull && node install.mjs` in the gsd-turbo clone (a new install first removes the previous one) and start again with `/turbo-autonomous`.

## Uninstall

First stop the supervisor in every project where one runs (`/turbo-autonomous stop` there). Otherwise it keeps running from memory, its background sessions call a `turbo-run` that no longer exists, and GSD's test gates fail with `Cannot find module`.

Next, while `turbo-run` is still installed, put GSD's gates back in any project where a phase was interrupted with them off: run, from the project root, for each `p<N>.json` in `.planning/turbo/gates/` (nothing to do when that directory is empty or absent):

```sh
node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" gates restore <N>
```

and `gates docs-restore <N>` the same way for each `docs-p<N>.json` in `.planning/turbo/run/`.

Then run, from the gsd-turbo clone (the installer itself is not copied into your config directory):

```sh
node install.mjs --uninstall
```

`node install.mjs --uninstall --dry-run` shows how many files would be removed. Only files listed in the install manifest are removed. Without a manifest in the config directory, the uninstaller prints `no gsd-turbo install manifest in <directory>` and exits with code 1 (check `CLAUDE_CONFIG_DIR`).

Projects keep their turbo files: `.planning/turbo/`, the last-green marker of the targeted tests (`turbo-last-green` in the git directory, usually `.git/turbo-last-green`; you can delete it) and, where `init` set it, the GSD setting `workflow.test_command`. In each project, from the project root, in a bash-compatible shell (Git Bash on Windows), check the setting:

```sh
node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/gsd-tools.cjs" config-get workflow.test_command
```

If it still calls `turbo-run`, restore it:

- If `turbo-run init` printed `kept previous workflow.test_command as test.full: <command>`, set it back to that command:

  ```sh
  node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/gsd-tools.cjs" config-set workflow.test_command "<command>"
  ```

- Otherwise, if `test.full` in `.planning/turbo/config.json` is the default `npm test`, clear the setting, so that GSD detects the test runner itself again instead of being pinned to `npm test`:

  ```sh
  node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/gsd-tools.cjs" config-set workflow.test_command ""
  ```

- Otherwise (you set `test.full` yourself), set it to the value of `test.full` with the first command. When `test.full` is a list, `workflow.test_command` takes one command: join the entries, for example `npm test && (cd server && npm test)`.

If GSD is installed inside the project, use `.claude/gsd-core/bin/gsd-tools.cjs` instead.

`planning.chunked_parallel: true`, which turbo sets when the key is absent, stays as well. It only affects GSD's chunked planning (`--chunked`); to remove it, run `config-set planning.chunked_parallel null` with the same `gsd-tools` call.

## Use

Inside a GSD project (a directory with `.planning/`), open Claude Code and run:

```text
/turbo-autonomous
```

If a run is already going, the skill shows its status and changes nothing. Otherwise it checks compatibility (`turbo-run doctor`), creates `.planning/turbo/config.json` on the first run (`turbo-run init`), commits only the setup files (`.planning/turbo/config.json`, `.planning/turbo/.gitignore`, `.planning/config.json`) and asks you what to do with any other uncommitted changes, so that the working tree is clean, and starts the supervisor. You can then close the session: the supervisor and the background sessions keep running. (Checked on Windows: the supervisor outlives the Claude Code process that started it.)

```text
/turbo-autonomous status          # supervisor state, current phase, session id, lane mode, range, owner requests
/turbo-autonomous stop            # stop the supervisor and this project's turbo background sessions
/turbo-autonomous resume <phase>  # after you handled an owner-only step or a halt: clear the phase and start again
```

To run only part of the milestone, give a phase range when you start:

```text
/turbo-autonomous --only <N>           # phase N only
/turbo-autonomous --from <N> --to <M>  # phases N to M; either flag alone leaves that end open
/turbo-autonomous --all                # every remaining phase again, clearing a kept range
```

The range is inclusive and ordered the way GSD orders phases (`2` < `2.1` < `2A` < `3`), so `--only 2` does not include `2.1`. Only phases inside it are started. A dependency on a phase outside the range counts as met only when that phase is complete or closed; a dependency on a phase outside the milestone always counts as met. When nothing in the range can start because a phase waits on an unfinished phase outside it, the supervisor stops, logs one line and notifies you ("Phases 4–6 are waiting": phase 4 depends on phase 3 outside the range); run that phase first (`--only 3`) or widen the range. `--only` together with `--from` or `--to`, `--all` together with any of them, or `--from` after `--to` is a usage error, and nothing starts. `start` prints the range it uses once (`range: phases 3–5`, with `(kept from the previous run)` when it carried over), and status shows it. A run that was stopped or halted keeps its range for the next start (`resume <phase> --start` included); the range of a finished run is dropped. When every phase of the range is finished, the supervisor stops and notifies you. If the recorded running phase lies outside a new range, it is not resumed and its session is left alone. If no phase of the milestone falls in the range, the supervisor waits and says so in its log.

Range changes never touch a run that is going:

- `start` with `--from`, `--to`, `--only` or `--all` while the supervisor runs exits with code 1, names the running range (`a run of phases 4–5 is going (supervisor pid …)`, or `the whole milestone`) and changes nothing: run `turbo-run stop` first. `start` without range flags still just reports the running supervisor.
- `resume <N> --start` for a phase outside the range the next start would keep exits with code 1, names that range and how to change it (`turbo-run start --only <N>`, or `--from`, or `--all`; with `turbo-run stop` first when the supervisor runs). Nothing is stopped, removed or started.
- Two starts at the same moment: the one that loses says which supervisor runs and its range (`another start launched supervisor pid … first (phases 4–5)`); it exits with code 1 only when it was given range flags for a different range.

To watch a phase live, run `claude attach <session id>` (the id is in the status output); detaching leaves the session running. The supervisor log is `.planning/turbo/logs/supervisor.log`.

The same commands work without the skill, in a bash-compatible shell (Git Bash on Windows):

```sh
node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" doctor   # also: init, start [--from <N>] [--to <N>], start --only <N>, start --all, status, stop, resume <phase> [--start], context [<phase>] [--json]
```

Below, `turbo-run` stands for this `node …/turbo-run.mjs` call; the installer does not put it on your PATH. Its other subcommands, such as `phase-step`, `staleness`, `gates`, `jobs`, `uat`, `lane-status`, `state-sync`, `context` and `test-changed`, are the deterministic steps the supervisor and the sessions call. You need them only for recovery: `turbo-run gates restore <N>` ([GSD settings turbo writes](#gsd-settings-turbo-writes)), `turbo-run lane-status <N> done` ([Full and safe mode](#full-and-safe-mode)) and `turbo-run state-sync <N>` ([Context and the resume position](#context-and-the-resume-position)).

To run a single phase without the supervisor, run `/turbo-phase <N>` in Claude Code, in a clean checkout. It needs `turbo-run doctor` to report `mode: full`; otherwise it stops at once.

The background sessions work in your checkout. Each lane runs with `worktree.bgIsolation: "none"` passed to its session, so it edits the project folder directly, as GSD expects; your own settings are not changed. Do not run GSD phase commands in the same checkout while the supervisor is running.

Each lane also gets its own temporary directory in the git directory, outside the working tree: `turbo/tmp/<project key>/p<N>/` under `git rev-parse --git-path` (usually `.git/turbo/tmp/<project key>/p<N>/`, where the key is the 6-hex hash of the project root that the lane session names carry too, so two GSD projects in one repository never share it; outside a repository `.planning/turbo/run/tmp/p<N>/`), so linters and type checkers that glob the tree never see it and nothing in it can be committed. The supervisor creates it before the launch, after removing what an earlier session of the phase left there; the same `--settings` set `TMP`, `TEMP` and `TMPDIR` of the session to it, and the lane's rules say that temporary files, stands and copies of data go there, never to `/tmp` or the system temp directory (in Git Bash on Windows `/tmp` stays the system temp directory whatever `TMP` says). The supervisor removes it once it has finished the phase and removed the session; `lane-status <N> done` does not, because the session may still use it (Claude Code's own scratch files and GSD's hook files can live there). Only that one directory is ever removed: a `p<N>` that is a link or resolves elsewhere, and a `turbo/tmp` (or a folder between it and the git directory or project root) that is a link, are refused and logged.

## What happens

- **One background session per phase.** The supervisor picks the next phase (inside the range, when one is set) whose dependencies are complete and starts it with `claude --bg`. A phase checked off in the ROADMAP and fully implemented counts as complete here even when GSD reports it unfinished, for example because a later phase changed files its verification covers and GSD now marks that verification stale: it is never started again, and the phases that depend on it can start. The supervisor log names such phases once per set (`skipped phases 3, 4: checked off in the roadmap, GSD reports them unfinished (verification stale); …`); you are not notified. A phase that GSD checks off while its session runs keeps running to its usual end. In full mode the session runs `/turbo-phase` for that phase (see [Inside a phase](#inside-a-phase-turbo-phase)); in safe mode it runs GSD's `gsd-autonomous` skill for that phase only, as in v0.1 (see [Full and safe mode](#full-and-safe-mode)). In safe mode the next phase starts when GSD marks the phase complete; in full mode, when the session has also written its own done record at the end of `/turbo-phase`. Phases run one at a time.
- **Automatic continuation after context limits.** Each session runs `turbo-run context <N>` before each step and, when it reports `context_stop_pct` percent or more, commits, runs `gsd-pause-work`, records its position in STATE.md (`turbo-run state-sync <N>`) and ends; the supervisor then starts a fresh session that resumes from the state on disk. Sessions never estimate their context by hand (see [Context and the resume position](#context-and-the-resume-position)). In full mode `/turbo-phase` checks this before each of its steps, and the fresh session resumes at the next unfinished step, recorded in `.planning/turbo/run/phase-p<N>.json`. A session that has finished its turn counts as ended, also while Claude Code still lists it as `blocked`. If it ended its turn without recording what comes next (no lane record of its own, and GSD shows the phase neither complete nor, in safe mode, waiting for human verification), it waits, and you are notified after `blocked_minutes_before_notify`. A session that is gone, or that Claude Code lists as ended (`done`, `idle`, `stopped`), before the phase is complete and without failing is resumed the same way. A failed session stops the run and notifies you. After `max_restarts_without_progress` restarts in a row with no new commit and no new plan summary, the supervisor stops and notifies you.
- **When a session cannot start or looks unfamiliar.** A failed `claude --bg` launch is retried at the next check; after 10 failed launches in a row the supervisor stops and notifies you. The count starts again with every supervisor start (`start`, `resume <phase> --start`). A session in a state the supervisor does not recognize counts as waiting: it is neither replaced nor relaunched, and you are notified after `blocked_minutes_before_notify`. If the running phase disappears from the roadmap, the supervisor stops once its session has ended or finished its turn, and keeps that session for inspection; if no remaining phase can start because they all wait on each other (a dependency cycle), it notifies you once and keeps checking; if no phase of the run's range can start because one waits on an unfinished phase outside the range, it stops and notifies you. A folder Claude Code does not trust stops the run at the first attempt.
- **Targeted tests.** `turbo-run init` points GSD's `workflow.test_command` to `turbo-run test-changed` only when a full test command is known: your previous `workflow.test_command` (kept as `test.full`), a `test.full` you set yourself (other than the default `npm test`), or `npm test` where GSD would pick it itself (a root `package.json` with a `test` script, and no Xcode project, no Makefile with a `test:` target and no Justfile, which GSD prefers). Otherwise init leaves `workflow.test_command` alone, GSD keeps detecting the test runner, and init prints how to enable targeted tests. Wherever GSD runs its test command (after each wave and in the phase's regression gate), turbo runs only the tests related to the files changed since the last full green run. With `test.import_graph: true`, a targeted run also includes the tests that loaded a changed JavaScript module in the last full green run, through other modules or import aliases; the graph never turns a full run into a targeted one. It falls back to the full suite whenever the selection could be unsafe, for example: not a git repository or no commit yet, no full green run yet, uncommitted or untracked files, changed dependency or config files, changes in a nested package that no `test.full` entry runs or outside the project root, a test command it cannot mirror exactly (`test.full`, or each entry of a `test.full` list, must be its package's test script, and that script a plain `node --test`, `jest` or `vitest` call without `pretest`/`posttest` hooks; pytest projects always run in full), a selected test outside the runner's default test match, a changed file with no related test, or `test.max_targeted` targeted runs since the last full run. `TURBO_FULL=1` forces a full run. When nested packages have their own test scripts, list them in `test.full`, so that the full run covers them too; each is then planned on its own (see [Several packages in `test.full`](#several-packages-in-testfull)). Every full-mode phase also ends with a full run (see [Inside a phase](#inside-a-phase-turbo-phase)). To enable targeted tests where init did not, set `test.full` to your full test command (see [Config](#config)) and run `turbo-run init` again. Running `turbo-run init` again is safe: it keeps `.planning/turbo/config.json`, including `test.full`, unless `workflow.test_command` was changed to another command: that command becomes `test.full`. If `workflow.test_command` already calls `turbo-run`, init keeps it: it sets it again when a full command is known and, when none is, warns instead of changing it.
- **Notifications.** A desktop notification (and optionally Telegram) when a phase is done, the milestone is complete, every phase of the range is done ("Phases N–M done", when the run has a range), a phase needs you, a phase leaves you a checklist of live checks (once per phase, and again only when the checklist changes), a full-mode phase waits because doctor now reports safe mode, a session waits for input or fails, a phase stops making progress, a session cannot be started (10 failed launches in a row), the running phase is no longer in the roadmap, no phase can start because the remaining ones wait on each other, no phase of the range can start because one waits on an unfinished phase outside it ("Phases N–M are waiting"), the project folder is not trusted by Claude Code, or the supervisor itself keeps failing or stops on an error. When the run stops for a phase, the notification ends with the command that continues it: `/turbo-autonomous resume <phase>`.

### Context and the resume position

`turbo-run context [<N>] [--json]` measures a session's context from its Claude Code transcript (`projects/<folder>/<session id>.jsonl` under `${CLAUDE_CONFIG_DIR:-~/.claude}`): the prompt side of the last main-session assistant message, `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, against `context_window` from `.planning/turbo/config.json` (default 1000000). It measures the calling session: the transcript named by `CLAUDE_CODE_SESSION_ID` (set in a Claude Code session's Bash tool); else the one the calling background job writes now (`CLAUDE_JOB_DIR`'s `state.json`: a job woken again writes into a transcript with a new id); else, with a phase whose lane `supervisor.json` records, that lane's job; else the most recently modified transcript whose entries carry a `cwd` inside this project's root (subfolders and Git Bash's `/c/…` form included). Only the end of the file is read. It prints `context: 270000 of 1000000 tokens (27%)`, or `context: unknown (<why>)`, and exits 0 either way; `--json` gives `used`, `window`, `pct`, `sessionId`, `transcript` and `source` (`session`, `job`, `lane` or `newest`), or `unknown`. A session stops at `context_stop_pct` by this number only, never by its own estimate and never by GSD's `context_window`; `unknown` means go on. Wherever GSD's execute-phase runs inside a step (`execute`, and its re-runs in `final-gate` and the `uat` gap round) it checks before each wave or plan as well, and at the stop percentage finishes the current plan or wave and pauses without marking the step done. The output names the window it assumed: when `lane_model` (or your default model) has a smaller context window than 1000000 tokens, set `context_window` to it.

GSD sizes some prompts by its own `context_window` (at 500000 or more its executors also get the phase's context, research and earlier summaries), 200000 when `.planning/config.json` sets none. `turbo-run init` sets it to turbo's `context_window` when it is absent and says so; a value you set stays. `turbo-run doctor` prints a `warn context-window` line when the two differ.

GSD's execute-phase starts with `state.begin-phase`, which on a phase already in progress resets STATE.md's plan to 1 unless STATE.md reads `Executing Phase <N>`; plan-phase's `planned-phase` turns the phase line into `READY TO EXECUTE`. Every lane resume runs execute-phase again, so after every stop (the context pause, `needs-owner`, `failed`) and at the end of the `execute` step, a session runs `turbo-run state-sync <N>`. It writes the real position with GSD's own commands (`phase-plan-index`, `state patch`, `state record-session`, `commit`, which follows `commit_docs`): the phase line `<N> (<name>) — EXECUTING`, `Plan: <next> of <total>` (and `Current Plan` / `Total Plans in Phase` where STATE.md has them), `Status: Executing Phase <N>`, `Last activity`, `Stopped at`, and `Resume file` (the `.continue-here.md` that `gsd-pause-work` wrote when it is newer than the phase's newest SUMMARY, by commit time or else modification time; otherwise the next plan). The next plan is the first plan without a SUMMARY.

- GSD's `state patch` rewrites the first bold `**Field:**` line anywhere in STATE.md, else the first `Field:` line, else a two-cell table row. state-sync sends a field only when that first match lies inside the Current Position section, and names the fields it left out (an archive's `**Phase:**`, for example).
- It changes nothing with no plans yet, with every plan summarized, or before execution started (no SUMMARY yet and step `gates-off` not done): then `begin-phase` must take its first-run branch.
- It is best effort: a failing GSD command or commit (a held `index.lock`, for example) prints a `warn:` line, puts STATE.md back to the bytes it had before (a clean STATE.md stays clean; one that already had uncommitted changes keeps them, so it stays dirty), and exits 0. The callers never stop on it.

turbo never calls `begin-phase` or `planned-phase` itself.

### Full and safe mode

`turbo-run doctor` prints one line per check, a `warn` line per warning (see [Several packages in `test.full`](#several-packages-in-testfull); warnings do not change the mode), then the mode. `start` runs the supervisor in that mode, and the `lane:` line of `/turbo-autonomous status` shows the mode of the running phase.

- `mode: full`: GSD core in the tested range (`>=1.16.0 <1.17.0`), the installed `turbo-phase` skill (check `turbo-phase-skill`) and `turbo-uat` agent (`turbo-uat-agent`), and a working `gsd-tools loop render-hooks` (`gsd-render-hooks`). Each phase runs as `/turbo-phase`.
- `mode: safe`: one or more of those checks prints `FAIL`, and every other check passes. Each phase runs `gsd-autonomous --only <N>` as in v0.1. Before that, the session runs `turbo-run gates restore <N>` and `turbo-run gates docs-restore <N>`, which put back what an interrupted `/turbo-phase` run left switched off (they do nothing otherwise).
- `mode: unsupported`: node, git, Claude Code, the project, GSD core or `gsd-tools init manager` fails; the run does not start.

If doctor (which runs when the supervisor starts) drops from full to safe while a phase that GSD already marked complete has not finished turbo's gates and UAT, the supervisor does not relaunch that phase: `gsd-autonomous` would end at once on the completed phase and skip them. You get one notification ("Phase N waits for full mode") with two ways out: fix what `turbo-run doctor` reports, then run `/turbo-autonomous resume <N>`; or do the remaining `/turbo-phase` steps (restore, fanout, fix, final-gate, uat) by hand (the skill itself stops in safe mode), then `turbo-run lane-status <N> done`. A session the supervisor adopts (one that is already running for the phase) keeps the stricter mode: a full-mode phase stays full.

### Inside a phase (`/turbo-phase`)

A full-mode session runs these steps in order. `turbo-run phase-step <N>` shows the next one, and each step is safe to run again from its start:

1. `freshness`: `turbo-run staleness <N>` checks the phase's existing planning artifacts (CONTEXT.md, RESEARCH.md, PATTERNS.md, plans) against the files they reference, since the commit each was recorded at; only the stale ones are rebuilt or re-grounded.
2. `discuss`: when the phase has no CONTEXT.md yet, GSD's discuss workflow in assumptions mode, with the recommended answers and no questions.
3. `prologue`: research, the UI and AI design contracts and codebase intel run in parallel, where GSD's planning would run them (`turbo-run jobs <N> prologue`); GSD's per-plan planners are set to run in parallel (`planning.chunked_parallel`).
4. `plan`: `gsd-plan-phase <N> --chunked`, which reuses the prologue's artifacts.
5. `gates-off`: `turbo-run gates off <N>` switches GSD's four built-in gates off for its execution only.
6. `execute`: `turbo-run gates off <N>` again first (a stop inside this step restores the gates, so a resumed step would otherwise run GSD's gates serially and then the fan-out again), then `gsd-execute-phase <N> --no-transition`, with GSD's waves, test gates and verifier, and one gap-closure round when the verifier finds gaps; it ends with `turbo-run state-sync <N>`.
7. `restore`: `turbo-run gates restore <N>` switches the gates back on.
8. `fanout`: the gates that were on (security, UI review, code review, Nyquist validation) run in parallel; Nyquist validation writes its tests in its own git worktree, merged afterwards. `turbo-run jobs <N> outcome` reads their reports; a report that cannot be read counts as a finding.
9. `fix`: code-review findings are fixed one per commit (at most 3 review rounds) and open security threats are mitigated, with targeted tests after every iteration; a fix that turns the tests red is fixed forward or reverted.
10. `final-gate`: re-verification first (GSD's verifier runs again when the fixes changed covered code, with one gap-closure round when it finds gaps), and the phase's full test run last: `TURBO_FULL=1 turbo-run test-changed`, with at most 2 rounds of fixes when it is red.
11. `uat`: when GSD's verification is `human_needed`, the `turbo-uat` agent checks the items (see [Automated UAT](#automated-uat-turbo-uat)); then GSD's `gsd-verify-work` completes the UAT session and marks the phase complete.
12. `close`: writes the lane's done record only when verification passed, GSD marked the phase complete, no security threat is open, and, when the phase has a UAT file, GSD's own `phase uat-passed` check passes; otherwise it stops for you.

When only you can continue (for example verification gaps left after one gap-closure round, tests still red after the fixes, or UAT items that need your signature), the session stops the phase as `needs-owner`; on an error it stops it as `failed`. Either way it first switches GSD's gates back on and records the position in STATE.md (`turbo-run state-sync <N>`). `/turbo-autonomous resume <N>` runs the stopped step again.

The bounded rounds (one gap-closure round in `execute`, 3 code-review fix iterations, 2 red rounds in `final-gate`, one UAT repeat) are counted across sessions: a session that restarts a step after a context pause or a crash goes on from the earlier count, and the phase stops for you when a budget is used up. Your `/turbo-autonomous resume <N>` starts a fresh budget.

turbo keeps a phase's progress (the steps done, their notes and those counts) in `.planning/turbo/run/phase-p<N>.json`. When a new milestone reuses phase numbers (`/gsd-new-milestone --reset-phase-numbers`), run `turbo-run phase-step <N> --reset` for each reused number before that phase starts; otherwise the new phase N inherits the old phase N's finished steps.

GSD may mark a phase complete before turbo's gates and UAT finish: its execute-phase does that as soon as its verifier passes. The supervisor therefore waits for the lane's own done record (`turbo-run lane-status <N> done`, written by the close step), and `human_needed` alone never stops a full-mode phase.

A full test run ends every phase. From the moment every plan of the phase has a summary until the `execute` step is marked done, `turbo-run test-changed` runs the full suite (the phase-end rule, unless only Markdown, `docs/` or `.planning/` files changed since the last full green run), so GSD's regression gate sees all of it. The fan-out and the fixes in between run targeted tests, and the final gate runs the full suite again with `TURBO_FULL=1`.

## GSD settings turbo writes

turbo writes only these documented keys to `.planning/config.json`, always through `gsd-tools config-set` (a restore may then check out the file's committed bytes when they mean the same configuration):

| Setting | When | What |
|---|---|---|
| `workflow.test_command` | `turbo-run init` | `turbo-run test-changed`, only when a full test command is known (see Targeted tests above). It stays after an uninstall; see [Uninstall](#uninstall). |
| `context_window` | `turbo-run init` | turbo's `context_window`, only when `.planning/config.json` sets none (GSD's default is 200000). A value already there stays; `doctor` warns when it differs from turbo's. |
| `planning.chunked_parallel` | the prologue (`turbo-run gates chunked`) | Set to `true` once, only when the key is absent; an explicit `false` is kept. Committed when git tracks `.planning/config.json`. |
| `workflow.nyquist_validation`, `workflow.security_enforcement`, `workflow.ui_review`, `workflow.code_review` | only while GSD's execute-phase runs (`turbo-run gates off <N>`, then `gates restore <N>`) | Set to `false`. The old values are saved in `.planning/turbo/gates/p<N>.json`, and both files are committed when git tracks `.planning/config.json`. They are restored right after execute, before turbo runs these gates itself in parallel, because GSD's gate skills do nothing while their key is off. The four keys always get their old values back; when git tracks `.planning/config.json` and nothing else in it changed meanwhile (GSD's own `workflow._auto_chain_active: false` counts as no change), the file also gets back the exact bytes it had before `gates off`. |
| `phase_commit_docs.<N>` | only while the parallel workers of the prologue and the fan-out run (`turbo-run gates docs-off <N>`, then `gates docs-restore <N>`) | Set to `false` and put back right after; never committed. For a decimal phase such as `3.1` GSD cannot key this setting: `gates docs-off` answers `not done`, and that phase's workers run one at a time. |

Safeguards:

- `turbo-run gates off <N>` refuses while another phase's gates state is left over in `.planning/turbo/gates/`, and names `turbo-run gates restore <that phase>`.
- `turbo-run jobs <N> fanout` and `jobs <N> outcome` refuse while phase N's gates are still off.
- Every early stop of a phase (`needs-owner`, `failed`) restores the gates first.

If a phase was interrupted with its gates off (`.planning/turbo/gates/p<N>.json` exists), `turbo-run gates restore <N>` puts them back, and `turbo-run gates docs-restore <N>` does the same for `phase_commit_docs.<N>` (left over as `.planning/turbo/run/docs-p<N>.json`). Both print `nothing to do` when nothing is off. A safe-mode lane runs both by itself. `turbo-run status` and `turbo-run stop` list every such leftover with its command (`status --json`: `gatesOff`, the phases whose gates are off); neither restores anything.

## Automated UAT (`turbo-uat`)

When GSD's verifier ends with `human_needed`, GSD writes the phase's UAT file with pending items. The `uat` step of `/turbo-phase` then starts the `turbo-uat` agent, which checks what it can on a local stand and leaves the rest to you.

`turbo-run uat plan <N>` gives each pending item a class floor from a fixed rule list; the first match wins, from D down to A. The agent may raise a class (C to D included), never lower it, and `turbo-run uat record` refuses a lowered class. An item with a hermetic and a live part is split in two: the hermetic part is checked, and the live part becomes a new row.

| Class | Items | What happens |
|---|---|---|
| D (owner) | signatures, legal review, owner decisions, private or offline keys, 2FA, money; with `autonomy: "standard"` also deploys | Left `[pending]`, marked `class: D`. The phase stops before GSD's verify-work and waits for you. |
| C (live) | third-party platforms, physical devices, desktop or mobile apps, production (read-only checks included; deploys with `autonomy: "max"`), live accounts, email, SMS and push delivery | Recorded as a deferred follow-up (`result: skipped`, `reason: "Deferred follow-up: …"`), which does not block the phase, and put on your checklist. |
| B (seeded) | needs a signed-in or seeded state: logins, sessions, roles, admin, accounts | Checked on the local stand with a one-time test account. |
| A (observable) | visible in a browser, over HTTP or a socket | Checked on the local stand. |

An A or B check is recorded `pass` with evidence, or `issue` with what was seen and a severity; GSD's verify-work turns issues into a gap closure, which the phase runs once. The agent classes an item no rule matches itself, C when unsure. Without a usable local stand, A and B items are deferred to you as C, never recorded `pass`. Every row turbo-uat writes carries `source: turbo-uat`, `class` and `head`, plus `checks`, `harness` and the evidence hashes where it has them.

Stand rules:

- **Loopback only.** `uat.base_url` must be a loopback URL without credentials and not one of `uat.forbidden_hosts`; otherwise the stand is refused. Every URL a check requests is logged and checked with `turbo-run uat net-check`: a request that leaves loopback or reaches a host in `uat.forbidden_hosts` fails the item closed (it is deferred to you).
- **Temporary data.** `turbo-run uat stand <N> prepare` creates a temporary `DATA_DIR` under `.planning/turbo/run/uat-p<N>/`. A stand boots only when the app takes its data directory from `DATA_DIR`; otherwise its A and B items go on your checklist.
- **One-time credentials.** `prepare` also writes a random test account to a credentials file, which the agent reads only inside its scripts. The values are never printed and never written to evidence or the UAT file.
- **Isolated browser.** Browser checks run only from a Node script in a fresh Playwright context, never through a browser MCP tool or your browser profile. The project must have Playwright installed; turbo never installs packages or browsers. Items that cannot run that way go on your checklist.
- **Secret-scan.** `turbo-run uat record` scans the text evidence and the new UAT lines for the one-time password and common token formats. A finding refuses the whole record and names file, line and rule, never the value.
- **Cleanup.** `turbo-run uat stand <N> cleanup` removes the data directory, the credentials and the results file after every run, once the results are recorded.

Evidence: screenshots (PNG) and text logs go to `.planning/turbo/run/evidence/p<N>/`, which is git-ignored; the UAT file gets only their sha256 hashes.

What is left for you goes into one file per phase, `.planning/turbo/run/p<N>-owner.md`, in the `lang` language: what passed, what failed, your checklist and what needs your signature. `/turbo-autonomous status` lists these files (`turbo-run status --json`: `ownerRequests`).

- **C items only:** a checklist; it does not block the phase. You are notified once per phase, and again only when the checklist changes.
- **Anything else open:** the phase waits for you on every open UAT row, whoever wrote it: pending, missing, blocked, or skipped without a deferral reason (GSD's own rule). These include D items, the live part of a split item that turbo-uat left pending, and rows it could not record. The phase stops before GSD's verify-work as `needs-owner`. Sign the items with `/gsd-verify-work <N>`, then run `/turbo-autonomous resume <N>`.
- Delete the file once you have handled it. A later `uat` step also removes it when nothing is left for you.

## Config

`.planning/turbo/config.json`, created by `turbo-run init`. Every key is optional; missing keys take the default. A config file that cannot be parsed stops turbo instead of falling back to defaults.

| Key | Default | Meaning |
|---|---|---|
| `lang` | `"en"` | Language of notifications and of the UAT owner request: `en` or `ru` (`init --lang`). |
| `max_lanes` | `3` | Reserved for stage 3 (parallel phases). Not used in v0.2, which runs one phase at a time. |
| `max_executors` | `20` | Reserved for stage 4 (execution graph). Not used in v0.2. |
| `lane_permission_mode` | `"bypassPermissions"` | `--permission-mode` of every background session. turbo reads a session that Claude Code lists as `blocked` as one that finished its turn, which assumes this default: with another mode, a session waiting on a permission prompt looks the same. |
| `lane_model` | `""` | `--model` of every background session; empty uses your Claude Code default. |
| `context_stop_pct` | `55` | Context usage, in percent, at which a session saves its state and hands over to a fresh one. The session measures it with `turbo-run context <N>` before each step (an instruction in the session prompt; the supervisor itself does not measure context). |
| `context_window` | `1000000` | The context window, in tokens, that `turbo-run context` measures against; set it lower when `lane_model` (or your default model) has a smaller window. `init` also gives it to GSD when GSD's config sets none (see [Context and the resume position](#context-and-the-resume-position)). |
| `autonomy` | `"standard"` | `standard` or `max` (`init --autonomy`). With `max`, sessions are also told to deploy using the project's deploy procedure: snapshot or backup first, health check after, automatic rollback on failure; `turbo-uat` then classes deploy items C (live) instead of D (owner). Production checks, read-only ones included, are not automated yet: such items are class C and go on your checklist. |
| `poll_seconds` | `20` | Supervisor check interval in seconds (5–3600). |
| `max_restarts_without_progress` | `3` | Restarts in a row without a new commit or plan summary before the supervisor halts and notifies you (at least 1). |
| `blocked_minutes_before_notify` | `10` | Minutes a session may wait for input, or the supervisor may keep failing, before you are notified (at least 1). |
| `notify.desktop` | `true` | Desktop notifications (Windows toast, `osascript` on macOS, `notify-send` on Linux). |
| `notify.telegram` | `false` | Telegram notifications; see [Telegram](#telegram-optional). |
| `test.full` | `"npm test"` | The full test command, run through `bash -c` like GSD does. `init` sets it to your previous `workflow.test_command` when there was one; otherwise, unless GSD itself would run `npm test` in your project, set it to your full test command and run `turbo-run init` again. A list runs several packages; see [Several packages in `test.full`](#several-packages-in-testfull). |
| `test.max_targeted` | `3` | Targeted green runs allowed after the last full green run; the next run is full. |
| `test.import_graph` | `false` | Record, during full green runs, which project files each test loads, and add the tests that loaded a changed module, through other modules or import aliases, to targeted runs (Node ≥ 22.15 and a plain `node --test` root script; otherwise ignored). The graph only adds tests to a run the file-mention rule already targets: it never turns a full run into a targeted one. It puts a turbo loader hook into your test processes through `NODE_OPTIONS` during full runs. |
| `uat.boot` | `""` | Command that starts the app for `turbo-uat`'s local stand; it runs in the background with `DATA_DIR` set to the stand's temporary data directory. Empty: `turbo-uat` infers the start command from the project (its own test helpers that start the app, then its dev script, for example `npm run dev`). |
| `uat.base_url` | `""` | Loopback URL of that app (`localhost`, `127.x.x.x`, `[::1]` or a `*.localhost` name), without `user:password@`. Empty: the URL the boot command prints, which must be loopback too. Any other value refuses the stand: its A and B items go on your checklist. |
| `uat.seed` | `""` | Command that seeds the test data for B items. It runs with `DATA_DIR` and `TURBO_UAT_CREDS` (the path of the one-time credentials file) and creates the test account from that file. Empty: `turbo-uat` creates the account through the app's own sign-up page or API on the stand. |
| `uat.forbidden_hosts` | `[]` | Host names no check may reach, subdomains included (an entry written as a URL counts by its host). A request to one fails the item closed. A value that is not a list of host names refuses the stand. |
| `deploy.command` | `""` | Reserved for a later stage: deploy command. Not used in v0.2. |
| `deploy.snapshot` | `""` | Reserved: snapshot or backup command run before a deploy. |
| `deploy.health` | `""` | Reserved: health check run after a deploy. |
| `deploy.rollback` | `""` | Reserved: rollback command run when the health check fails. |
| `push.mode` | `"off"` | When the supervisor pushes the lanes' commits: `off`, `after-wave` (after each wave of GSD's execution and at the end of each phase) or `after-phase` (at the end of each phase). See [Push and CI](#push-and-ci-optional). |
| `push.remote` | `"origin"` | The git remote to push to: a remote name (letters, digits, `.`, `_`, `-`), not a URL. |
| `push.ci` | `"github"` | `github`: watch the GitHub Actions runs of each pushed commit through the `gh` CLI; `none`: push only. |
| `push.ci_timeout_minutes` | `30` | Minutes to wait for the runs of a push to finish before you are notified (at least 1). |
| `push.ci_fix_rounds` | `2` | Red-CI fix rounds a lane may spend in one phase before it stops for you (0 or more). |

### Several packages in `test.full`

A project with nested packages that have their own test scripts (and CI that runs each of them) needs all of them in the full run. A nested package is a tracked `package.json` below the project root, outside `node_modules/` and outside `fixtures/` or `__fixtures__/` directories (test data), whose `test` script is not npm's default `echo "Error: no test specified" && exit 1`. List them in `test.full`:

```json
{
  "test": {
    "full": [
      "npm test",
      { "dir": "server", "command": "npm test" },
      { "dir": "app", "command": "pnpm test" }
    ]
  }
}
```

- A string entry runs at the project root; `{ "dir", "command" }` runs in `dir`. `dir` is relative to the project root, an existing directory, without `..`, and each directory appears once (the root, `""` or `"."`, included). Directories are compared by their real path: a link that leads outside the project root is refused, and another spelling of a listed directory (a link inside the project, other letter case on a case-insensitive file system such as Windows') counts as listed twice. A list that breaks these rules stops `turbo-run test-changed`, `turbo-run init` and `turbo-run start` with a config error; `turbo-run doctor` prints it as a warning.
- A full run runs every entry in order, through `bash -c`, in its own directory. A red entry does not stop the others: each red one is named (`server: failed (exit code 1)`, or `server: failed (its directory server is missing)` when the directory disappeared during the run), and the run exits with the first red entry's code. The last-green marker is written only when every entry is green.
- A targeted run plans each entry on its own. A changed file belongs to the entry with the deepest matching `dir`; the root entry takes the rest. The rules of [Targeted tests](#what-happens) apply inside the entry's directory: its own `package.json` test script and `pretest`/`posttest` hooks, its runner config, the packages nested below it. An entry's tests that reach its changed file through files of other entries are selected too. Each entry counts its changes and its targeted runs from its own last full green run; an entry with no change that concerns it is skipped. Each entry logs its own line, for example `server: targeted: 2 related test file(s)`.
- A dependency or config file changed anywhere (a `package.json`, a lockfile, a `tsconfig*.json`, a `*.config.js`, `.planning/turbo/config.json`) runs every entry in full: another entry may load that package's code.
- Any other change outside an entry makes that entry run in full when the entry may depend on it:
  - a file in another entry that the entry's command may also run: `node --test` without path arguments, or with a path or glob that covers that directory; `jest` and `vitest` search nested directories too. So a root script `node --test` (node's default patterns) also runs the nested entries' tests, and a change in a nested entry runs the root entry in full as well. Give the root script explicit paths or globs (`node --test "test/**/*.test.mjs"`) to avoid that;
  - a file the entry's files mention or import, directly or through other files of the project. A relative import of a package directory (`'../server'`) reaches every file of that package;
  - a package the entry's files import by name (`'@scope/server'`) that contains the file or reaches it.
- Across entries, an import is seen only through a relative path, a file name in a quoted string, a package directory or a package name. An alias that names none of them (for example a tsconfig `paths` alias `'@core'` for another package's `src/index.ts`) is not: a change behind such an alias does not make the importing entry run in full. Run with `TURBO_FULL=1`, or import through the package name.
- `TURBO_FULL=1` runs every entry in full. At the phase end (see [Inside a phase](#inside-a-phase-turbo-phase)) every entry with a code change since its own last full green run runs in full.
- The import graph (`test.import_graph`) is recorded and used for the root entry only; nested entries use the mention rule.
- `turbo-run init` writes the list when it creates `.planning/turbo/config.json` and nested packages exist, and prints it: the root command first (none when the root has no `package.json` or its `package.json` has no real test script, such as a workspaces root), then one entry per package, with `npm test`, `pnpm test` or `yarn test` from the package's lockfile or the nearest one above it. With an existing config, init changes nothing: it prints `warn: nested package <dir> has its own test script that test.full does not run` for each package and the entries to add.
- `turbo-run doctor` prints `warn nested package <dir> has its own test script that test.full does not run` for each nested package no entry runs. When such a package changes, `test-changed` logs a warning and runs as with a single command (the entry that contains the package runs in full).
- Each record of the last-green marker names the command of its full run; when an entry's command changes (also in a config git does not track), that entry runs in full. After an upgrade, an older last-green marker counts as the root entry's until its next full run; a nested entry without a record of its own runs in full once.

## Safety

- **Permissions.** Background sessions run with `--permission-mode bypassPermissions` by default, so nobody has to approve tool calls. Set `lane_permission_mode` to another Claude Code permission mode to change that. Your existing Claude Code hooks still apply in every session.
- **No questions.** `AskUserQuestion` is disabled in background sessions (`--disallowedTools AskUserQuestion`). At each decision point a session takes the recommended option and records the decision where GSD records it.
- **Owner-only steps.** A session does everything else in the phase first, then stops and you are notified for steps only you can do:
  - signatures and decisions reserved for the project owner;
  - live sessions with your own third-party accounts;
  - physical devices;
  - offline keys;
  - your 2FA;
  - money.

  Verification items GSD marks `human_needed` are checked without you where possible: in full mode by the `turbo-uat` agent (see [Automated UAT](#automated-uat-turbo-uat)), in safe mode by the session itself (browser checks with Playwright against a locally started app, HTTP and socket checks, test accounts in the app under test); only owner-only items are left to you. Only with `autonomy: "max"` are sessions told to deploy themselves.
- **Closed phases stay closed.** A phase checked off in the ROADMAP and fully implemented is never rescheduled, even if GSD later reports its verification stale. Re-verifying it is up to you: `/gsd-execute-phase <N>`.
- **Git and data.** Sessions are told never to force-push, never to rewrite published history and never to delete data without a dry run first. They never push either: with `push.mode` set, the supervisor does (see [Push and CI](#push-and-ci-optional)).
- **GSD stays untouched.** turbo never modifies GSD files and writes to the GSD config only the keys in [GSD settings turbo writes](#gsd-settings-turbo-writes), through `gsd-tools config-set` (a restore may then check out the file's committed bytes when they mean the same configuration). It changes STATE.md only through GSD's own state commands (`turbo-run state-sync`, see [Context and the resume position](#context-and-the-resume-position)).
- **Supervisor files.** State, logs and locks live in `.planning/turbo/run/`, `logs/` and `locks/`, which `init` adds to a `.gitignore` there. `run/` also holds the `/turbo-phase` progress, the owner requests, the UAT stand and its evidence, and the push requests, push results and lane inboxes. Each lane's temporary directory lives in the git directory (`turbo/tmp/<project key>/p<N>/`, see [Use](#use)). `.planning/turbo/gates/` holds a file only while a phase has GSD's gates off, committed when git tracks `.planning/config.json`. The targeted-test runner keeps its last-green marker (one record per `test.full` entry) outside the working tree, in the git directory (`git rev-parse --git-path turbo-last-green`, usually `.git/turbo-last-green`).

## Push and CI (optional)

Off by default (`push.mode: "off"`). Lanes never push. With `push.mode` set, a lane asks for a push, and the supervisor, the only process that pushes, makes it at its next check:

- **When.** `after-wave`: after each wave of GSD's execution, and once at the end of the phase. `after-phase`: once at the end of the phase. A lane also asks after each CI fix, and for a plan of the phase whose task pushes or waits for CI (the lane runs that task itself after the plan's wave).
- **Checks before a push.** The supervisor fetches the remote branch, which must already exist and be an ancestor of HEAD; otherwise nothing is pushed and you are notified. It then scans every commit it would push, merges included: each added line against the secret patterns turbo also uses for UAT records, and each added or changed file name against `.env*`, `*.session`, `*.db`, `*.sqlite`, `*.log`, `accounts.json`, `*.pem` and `*.key`. Files git treats as binary are scanned as text. A range that adds or changes a Git LFS pointer is refused (`lfs-content-not-scanned`): the content it stands for is not in the commits, so turbo cannot scan it; push such a range yourself. A finding stops the push; the notification names the file and the kind of finding, never the value. The patterns also match ordinary code now and then (an assignment to a variable named `token` or `password`, a test fixture). Check the named files; when they are clean, push that range once yourself (`git push <remote> <branch>`), and turbo goes on from there. The same findings are not notified twice.
- **The push.** `git push <remote> <sha>:refs/heads/<branch>` for exactly the commit the lane asked for and the branch it asked from, and only while the checkout is still on that branch and the commit still on it (otherwise the request fails and you are notified): never forced, never with `--no-verify`, so your pre-push hooks run (one that takes longer than 5 minutes fails the push). git runs with credential prompts off, so its credentials must work without a prompt.
- **CI.** With `push.ci: "github"`, the supervisor watches the runs of the pushed commit with `gh run list --commit` in the GitHub repository of `push.remote` (install the GitHub CLI and log in with `gh auth login`). The repository comes from the remote's push URL: `owner/repo` on github.com, `host/owner/repo` on a GitHub Enterprise host. Without gh, without a login for that host, or with a remote that is not a GitHub repository, pushes go on without CI results and you are told once. A run that ends in `failure`, `timed_out` or `startup_failure` is red: the last 200 lines of its failed log, secrets masked, go into the lane's inbox (`turbo-run inbox <N>`) and you are notified. The lane finds the cause, fixes it in one commit and asks for a new push, at most `push.ci_fix_rounds` times in a phase; after that it stops for you. A commit with no run after 5 minutes counts as having no CI. Runs that do not finish within `push.ci_timeout_minutes` notify you; the lane goes on.
- **End of a phase.** The lane waits for its last push and that CI result before it records the phase done.

The requests, results and inboxes live in `.planning/turbo/run/` (`p<N>-push-request.json`, `p<N>-push.json`, `p<N>-inbox.jsonl`). The supervisor reads the push settings when it starts: after changing them, stop it and start it again.

## Telegram (optional)

1. Set two environment variables where Claude Code starts, before `/turbo-autonomous` (the supervisor inherits them):
   - `TURBO_TELEGRAM_TOKEN`: your bot token;
   - `TURBO_TELEGRAM_CHAT`: the chat id to send to.
2. Enable it in `.planning/turbo/config.json`:

   ```json
   { "notify": { "telegram": true } }
   ```

The messages are the same short texts as the desktop notifications: phase number, status and what to do next.

## Roadmap

Each stage is a separate release.

1. **Core and safe mode:** installer, `turbo-run doctor`, the supervisor (one phase at a time, automatic continuation, status, notifications), targeted tests, `/turbo-autonomous`.
2. **Faster phases** (this release): `/turbo-phase` with a freshness check, a parallel prologue, gates fanned out in parallel, and `turbo-uat` for automated verification of `human_needed` items; the recorded import graph for targeted tests (`test.import_graph`).
3. **Planning ahead and parallel phases:** `/turbo-plan-milestone`, `/turbo-new-milestone`, ROADMAP annotations, `lanes.json`, several phases at once, shared-resource locks, merging, and optional messaging between sessions (off by default).
4. **Execution graph:** `turbo-exec` starts each plan as soon as its dependencies are done, instead of waiting for whole waves.
5. **Adoption:** `/turbo-adopt` for milestones already in progress, a full trial on a reference project, and an upstream PR.

## License

MIT, see [LICENSE](LICENSE).

gsd-turbo is an overlay for GSD (https://github.com/open-gsd/gsd-core, MIT). It does not copy or modify GSD files.
