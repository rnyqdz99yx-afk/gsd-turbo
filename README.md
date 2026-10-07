# gsd-turbo

## What it is

gsd-turbo is an overlay for [GSD](https://github.com/open-gsd/gsd-core) on Claude Code that runs a milestone faster with background Claude Code sessions. A small supervisor process (no LLM of its own) starts each remaining phase of the current milestone as an unattended background session, starts a fresh one when a session stops at its context limit, replaces full test runs with targeted ones where that is safe, and notifies you when a phase finishes or needs you. It does not modify GSD: it talks to GSD only through `gsd-tools` and writes one documented GSD setting, `workflow.test_command`.

This is v0.1 (stage 1 of the [roadmap](#roadmap)): one phase runs at a time.

## Requirements

- Node.js ≥ 20 and git.
- Claude Code ≥ 2.1.234 (background sessions: `claude --bg`, `claude agents --json --all`).
- GSD core 1.16.x, installed with `npx @opengsd/gsd-core@latest` (or `npx @opengsd/gsd-core@1.16` to stay inside the tested range). `turbo-run doctor` is tested against `>=1.16.0 <1.17.0`. A different GSD version, including newer minor and major releases, runs in safe mode if the other checks pass: doctor prints `FAIL gsd-version …` and then `mode: safe`. If `gsd-tools init manager` changed incompatibly, doctor reports `mode: unsupported` and the run does not start.
- Windows, macOS or Linux.
- Claude Code must trust the project folder: run `claude` in it once and accept the trust prompt. In a folder it does not trust, every background session fails to start; the supervisor then stops at the first attempt and notifies you.

## Install

```sh
git clone https://github.com/rnyqdz99yx-afk/gsd-turbo && cd gsd-turbo && node install.mjs
```

The installer copies files into your Claude Code config directory (`~/.claude`, or `$CLAUDE_CONFIG_DIR` when it is set):

- `turbo/`: the `turbo-run` CLI, its library and an install manifest;
- `skills/turbo-autonomous/`: the `/turbo-autonomous` skill.

It never writes `gsd-*` paths. `node install.mjs --dry-run` shows only how many files would be installed and where, without writing anything.

To upgrade, first stop the supervisor in every project where one runs (`/turbo-autonomous stop` there): a running supervisor keeps the old code in memory, and its background sessions call the files the upgrade replaces. Then run `git pull && node install.mjs` in the gsd-turbo clone (a new install first removes the previous one) and start again with `/turbo-autonomous`.

## Uninstall

First stop the supervisor in every project where one runs (`/turbo-autonomous stop` there). Otherwise it keeps running from memory, its background sessions call a `turbo-run` that no longer exists, and GSD's test gates fail with `Cannot find module`. Then run, from the gsd-turbo clone (the installer itself is not copied into your config directory):

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

- Otherwise (you set `test.full` yourself), set it to the value of `test.full` with the first command.

If GSD is installed inside the project, use `.claude/gsd-core/bin/gsd-tools.cjs` instead.

## Use

Inside a GSD project (a directory with `.planning/`), open Claude Code and run:

```text
/turbo-autonomous
```

If a run is already going, the skill shows its status and changes nothing. Otherwise it checks compatibility (`turbo-run doctor`), creates `.planning/turbo/config.json` on the first run (`turbo-run init`), commits only the setup files (`.planning/turbo/config.json`, `.planning/turbo/.gitignore`, `.planning/config.json`) and asks you what to do with any other uncommitted changes, so that the working tree is clean, and starts the supervisor. You can then close the session: the supervisor and the background sessions keep running. (Checked on Windows: the supervisor outlives the Claude Code process that started it.)

```text
/turbo-autonomous status          # supervisor state, current phase, session id
/turbo-autonomous stop            # stop the supervisor and this project's turbo background sessions
/turbo-autonomous resume <phase>  # after you handled an owner-only step or a halt: clear the phase and start again
```

To watch a phase live, run `claude attach <session id>` (the id is in the status output); detaching leaves the session running. The supervisor log is `.planning/turbo/logs/supervisor.log`.

The same commands work without the skill, in a bash-compatible shell (Git Bash on Windows):

```sh
node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" doctor   # also: init, start, status, stop, resume <phase> [--start]
```

The background sessions work in your checkout. Do not run GSD phase commands in the same checkout while the supervisor is running.

## What happens

- **One background session per phase.** The supervisor picks the next phase whose dependencies are complete and starts it with `claude --bg`, running GSD's `gsd-autonomous` skill for that phase only. When GSD marks the phase complete, the next phase starts. Phases run one at a time.
- **Automatic continuation after context limits.** Each session is told (in its prompt) to commit, run `gsd-pause-work` and end when its context usage reaches about `context_stop_pct` percent; the supervisor then starts a fresh session that resumes from the state on disk. A session that ends before the phase is complete without failing is resumed the same way; a failed session stops the run and notifies you. After `max_restarts_without_progress` restarts in a row with no new commit and no new plan summary, the supervisor stops and notifies you.
- **When a session cannot start or looks unfamiliar.** A failed `claude --bg` launch is retried at the next check; after 10 failed launches in a row the supervisor stops and notifies you. The count starts again with every supervisor start (`start`, `resume <phase> --start`). A session in a state the supervisor does not recognize counts as waiting: it is neither replaced nor relaunched, and you are notified after `blocked_minutes_before_notify`. If the running phase disappears from the roadmap, the supervisor stops once its session has ended; if no remaining phase can start because they all wait on each other (a dependency cycle), it notifies you once and keeps checking. A folder Claude Code does not trust stops the run at the first attempt.
- **Targeted tests.** `turbo-run init` points GSD's `workflow.test_command` to `turbo-run test-changed` only when a full test command is known: your previous `workflow.test_command` (kept as `test.full`), a `test.full` you set yourself (other than the default `npm test`), or `npm test` where GSD would pick it itself (a root `package.json` with a `test` script, and no Xcode project, no Makefile with a `test:` target and no Justfile, which GSD prefers). Otherwise init leaves `workflow.test_command` alone, GSD keeps detecting the test runner, and init prints how to enable targeted tests. Wherever GSD runs its test command (after each wave and in the phase's regression gate), turbo runs only the tests related to the files changed since the last full green run. With `test.import_graph: true`, a targeted run also includes the tests that loaded a changed JavaScript module in the last full green run, through other modules or import aliases; the graph never turns a full run into a targeted one. It falls back to the full suite whenever the selection could be unsafe, for example: not a git repository or no commit yet, no full green run yet, uncommitted or untracked files, changed dependency or config files, changes in a nested package or outside the project root, a test command it cannot mirror exactly (`test.full` must be the root package's test script, and that script a plain `node --test`, `jest` or `vitest` call without `pretest`/`posttest` hooks; pytest projects always run in full), a selected test outside the runner's default test match, a changed file with no related test, or `test.max_targeted` targeted runs since the last full run. `TURBO_FULL=1` forces a full run. To enable targeted tests where init did not, set `test.full` to your full test command (see [Config](#config)) and run `turbo-run init` again. Running `turbo-run init` again is safe: it keeps `.planning/turbo/config.json`, including `test.full`, unless `workflow.test_command` was changed to another command: that command becomes `test.full`. If `workflow.test_command` already calls `turbo-run`, init keeps it: it sets it again when a full command is known and, when none is, warns instead of changing it.
- **Notifications.** A desktop notification (and optionally Telegram) when a phase is done, the milestone is complete, a phase needs you, a session waits for input or fails, a phase stops making progress, a session cannot be started (10 failed launches in a row), the running phase is no longer in the roadmap, no phase can start because the remaining ones wait on each other, the project folder is not trusted by Claude Code, or the supervisor itself keeps failing or stops on an error. When the run stops for a phase, the notification ends with the command that continues it: `/turbo-autonomous resume <phase>`.

## Config

`.planning/turbo/config.json`, created by `turbo-run init`. Every key is optional; missing keys take the default. A config file that cannot be parsed stops turbo instead of falling back to defaults.

| Key | Default | Meaning |
|---|---|---|
| `lang` | `"en"` | Language of notifications: `en` or `ru` (`init --lang`). |
| `max_lanes` | `3` | Reserved for stage 3 (parallel phases). Not used in v0.1, which runs one phase at a time. |
| `max_executors` | `20` | Reserved for stage 4 (execution graph). Not used in v0.1. |
| `lane_permission_mode` | `"bypassPermissions"` | `--permission-mode` of every background session. |
| `lane_model` | `""` | `--model` of every background session; empty uses your Claude Code default. |
| `context_stop_pct` | `55` | Context usage, in percent, at which a session is told to save its state and hand over to a fresh one (an instruction in the session prompt; the supervisor does not measure context). |
| `autonomy` | `"standard"` | `standard` or `max` (`init --autonomy`). With `max`, sessions are also told to deploy using the project's deploy procedure: snapshot or backup first, health check after, automatic rollback on failure. |
| `poll_seconds` | `20` | Supervisor check interval in seconds (5–3600). |
| `max_restarts_without_progress` | `3` | Restarts in a row without a new commit or plan summary before the supervisor halts and notifies you (at least 1). |
| `blocked_minutes_before_notify` | `10` | Minutes a session may wait for input, or the supervisor may keep failing, before you are notified (at least 1). |
| `notify.desktop` | `true` | Desktop notifications (Windows toast, `osascript` on macOS, `notify-send` on Linux). |
| `notify.telegram` | `false` | Telegram notifications; see [Telegram](#telegram-optional). |
| `test.full` | `"npm test"` | The full test command, run through `bash -c` like GSD does. `init` sets it to your previous `workflow.test_command` when there was one; otherwise, unless GSD itself would run `npm test` in your project, set it to your full test command and run `turbo-run init` again. |
| `test.max_targeted` | `3` | Targeted green runs allowed after the last full green run; the next run is full. |
| `test.import_graph` | `false` | Record, during full green runs, which project files each test loads, and add the tests that loaded a changed module, through other modules or import aliases, to targeted runs (Node ≥ 22.15 and a plain `node --test` root script; otherwise ignored). The graph only adds tests to a run the file-mention rule already targets: it never turns a full run into a targeted one. It puts a turbo loader hook into your test processes through `NODE_OPTIONS` during full runs. |
| `uat.boot` | `""` | Reserved for stage 2 (`turbo-uat`): command that starts the app for automated checks. Not used in v0.1. |
| `uat.base_url` | `""` | Reserved for stage 2: loopback URL of that app. |
| `uat.seed` | `""` | Reserved for stage 2: command that seeds test data. |
| `uat.forbidden_hosts` | `[]` | Reserved for stage 2: hosts the automated checks must never reach. |
| `deploy.command` | `""` | Reserved for a later stage: deploy command. Not used in v0.1. |
| `deploy.snapshot` | `""` | Reserved: snapshot or backup command run before a deploy. |
| `deploy.health` | `""` | Reserved: health check run after a deploy. |
| `deploy.rollback` | `""` | Reserved: rollback command run when the health check fails. |

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

  Verification items GSD marks `human_needed` are checked by the session itself where possible (browser checks with Playwright against a locally started app, HTTP and socket checks, test accounts in the app under test); only owner-only items are left to you. Only with `autonomy: "max"` are sessions told to deploy themselves.
- **Git and data.** Sessions are told never to force-push, never to rewrite published history and never to delete data without a dry run first.
- **GSD stays untouched.** turbo never modifies GSD files and writes only `workflow.test_command` to the GSD config, through `gsd-tools config-set`.
- **Supervisor files.** State, logs and locks live in `.planning/turbo/run/`, `logs/` and `locks/`, which `init` adds to a `.gitignore` there. The targeted-test runner keeps its last-green marker outside the working tree, in the git directory (`git rev-parse --git-path turbo-last-green`, usually `.git/turbo-last-green`).

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

1. **Core and safe mode** (this release): installer, `turbo-run doctor`, the supervisor (one phase at a time, automatic continuation, status, notifications), targeted tests, `/turbo-autonomous`.
2. **Faster phases:** `/turbo-phase` with a parallel prologue, gates fanned out in parallel, and `turbo-uat` for automated verification of `human_needed` items.
3. **Planning ahead and parallel phases:** `/turbo-plan-milestone`, `/turbo-new-milestone`, ROADMAP annotations, `lanes.json`, several phases at once, shared-resource locks, merging.
4. **Execution graph:** `turbo-exec` starts each plan as soon as its dependencies are done, instead of waiting for whole waves.
5. **Adoption:** `/turbo-adopt` for milestones already in progress, a full trial on a reference project, and an upstream PR.

## License

MIT, see [LICENSE](LICENSE).

gsd-turbo is an overlay for GSD (https://github.com/open-gsd/gsd-core, MIT). It does not copy or modify GSD files.
