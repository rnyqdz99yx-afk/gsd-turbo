# gsd-turbo Stage 3 S3 — live view (the `turbo-view` mod) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a turbo run live inside the owner's Claude Code session — a pane (lane → `/turbo-phase` step → subagents, owner questions with answer buttons, recent commits), a band above the prompt, toasts — through a Claude Code mod installed as `turbo-view@skills-dir`, with `turbo-run status --watch` as the fallback for terminals without mods.

**Architecture:** All drawing decisions live in one pure module, `mod/hooks/view-model.mjs` (`render`, `bandLine`, `toastsFor`, `answerArgv`, path and timing helpers), with no imports and no host APIs, so the mod imports it and `node --test` runs it in CI. The mod's hooks module `mod/hooks/register.mjs` is a thin shell: it finds the project's `.planning/turbo/`, runs `turbo-run view --json` on `$.clock.every`, maps the view model to `Box`/`Text`/`Button`/`Input` elements, shows toasts, and sends pane answers to `turbo-run answer … --by pane`. `turbo-run view --json` gains two additive keys the mod needs (`ui` with `lang` and `refreshSeconds`; `lanes[].push` from S2's push record). `install.mjs` copies the mod to `<claude-home>/skills/turbo-view/` only on Claude Code ≥ 2.1.290, `doctor` reports it, `turbo-run status --watch` redraws `turbo-run view` every `view.refresh_seconds`, and `scripts/turbo-view-demo.mjs` gives the owner a scripted run to check the pane by eye.

**Tech Stack:** Node ≥ 20 (ESM `.mjs`, `node:test`, zero npm dependencies); Claude Code mods (≥ 2.1.290: `claude plugin validate`, `claude plugin test` with `claude-code/testing`).

**Spec:** `docs/specs/2026-10-10-stage-3-design.md` — §7 (S3) is the scope; plus `view.refresh_seconds` in §10, the mod test in §11, and the §9 spike results for mods (spike 4). §1–3 for context.

**Base:** `main` with S0 (`docs/plans/2026-10-10-stage-3-s0-transcripts.md`) merged: `lib/view.mjs` (`buildView`, `formatView`), the `view` case in `bin/turbo-run.mjs`, `test/view.test.mjs` with its helpers (`laneProject`, `runDirOf`, `at`, `NOW`, `COMMITS`), `DEFAULTS.stall_minutes`. S2 and S1 may or may not be merged: S3 reads S2's push record by file name only and calls S1's `turbo-run answer` only as a command. Existing code is referenced by function name and anchor text, never by line number. If an anchor moved, apply the same change next to the named code.

The code was dry-run on Windows / Node 24 / Claude Code 2.1.296:
- `main` at `7e00aa8` (0.2.2) with S0's Tasks 1–8 applied from its plan, then Tasks 1–7 here: the 79 tests of the files these tasks touch passed, and so did the unchanged `test/cli.test.mjs` (50), `test/install.test.mjs`, `test/install-stage2.test.mjs` and `test/config.test.mjs`. `node install.mjs --dry-run` against a temporary `CLAUDE_CONFIG_DIR` listed the four mod files.
- The mod in a throwaway directory: `claude plugin validate` passed without warnings; `claude plugin test` passed 12 tests. Removing the double-press guard, the background period, the kept draft of the **Other…** field, the stdout reply of the answer toast, closing the field on exit 4, or keeping the submitted text each made exactly the test that pins it fail.

No Linux runner was available, so CI (Linux / Node 22) is the first Linux check.

## Mod facts this plan relies on

Verified on Claude Code 2.1.296 (spike of 2026-10-10 and the dry run above) and in the mods docs (`code.claude.com/docs/en/plugins/mods/{interface,reference,api,create,test}`).

- **M1 Layout.** A mod is a plugin directory: `.claude-plugin/plugin.json` and `hooks/hooks.json` with `{ "modules": ["./register.mjs"] }`. The hooks module may be `.js`/`.mjs`/`.ts`/`.tsx`, an ES module exporting `register(on)`. `claude plugin validate` warns when `version` or `author` is missing.
- **M2 Loading.** A mod in `<claude-home>/skills/<name>/` loads in every session as `<name>@skills-dir`, without a marketplace or a settings edit; `"<name>@skills-dir": false` in `enabledPlugins` turns it off; `--plugin-dir` wins over both copies (spike §9.4).
- **M3 Static rules.** The hooks module has no Node.js APIs and no timers of its own. It may import files inside the plugin directory with top-level `import` declarations (relative paths only; the one bare import is `claude-code`). `$` may be passed to functions declared at the top level of the same file, never to imported functions. Every `$` call is written in full (`$.process.run(…)`), event names and `$.env.get` names are string literals. A matcher value that is an imported constant shows as `?` in `validate`, so the pane matcher spells `'turbo-view'`.
- **M4 API used.**
  - `$.session.cwd()`, `$.session.surfaces()` (empty: no terminal or app attached), `$.fs.exists(path)`, `$.env.get('NAME')`;
  - `$.process.run(argv, { cwd, timeoutMs })` → `{ exitCode, stdout, stderr }`, no shell, rejects when the program cannot start or outlives the timeout;
  - `$.clock.every(ms, fn)` → a timer with `cancel()`; timers stop when the module reloads;
  - `$.ui.open({ id, title, focus? })` (`focus` accepts only `true`), `$.ui.toast(text, { timeoutMs })`, `$.ui.log(text)`, `$.ui.invalidate('ui.render')`, `$.ui.resolve(e)` → `{ Box, Text, Button, Input }`;
  - `$.command.register({ name, description, immediate: true })`;
  - events: `session.start` (`e.isInteractive` is false in a `-p` run; fires again after a module reload), `command.run` with `{ command }` (return `{ text }` or `{}`), `ui.render` with `{ component: 'Pane', requestId }` or `{ component: 'AbovePrompt' }` (return `next(e)` to draw nothing; a band keeps other mods' drawing by putting `await next(e)` into a `Box`).
- **M5 Pane width.** Claude Code places a pane the mod opens by itself only from 144 terminal columns, 110 once the person opened it; a pane opened from a command appears at any width. The mod only calls `$.ui.open`.
- **M6 Tests.** `claude plugin test <dir>` runs `*.test.ts` and `*.test.tsx` under the plugin with `claude-code/testing` (`test`, `expect`, `mock.clock(on)`, `mock.env(on, {…})`, stubs `on('<namespace>.<method>', () => ({ value }))`, `$.ui.mount(…)` → `find`, `press`, `input`). The kit hands `fs.*` paths over absolute, in the platform's form (`C:\work\.planning` on Windows). `node --test` without arguments picks up `*.test.ts` on Node 24 (and Node 22 with type stripping) but not `*.test.tsx` (checked on Node 24.13): the harness test is a `.tsx` file.
- **M7 Elements.** `Text` takes `wrap: 'truncate-end'`, `dimColor`, `bold`, `color` (`'yellow'`, `'red'`); `Box` takes `flexDirection`, `columnGap`, `flexWrap`. The kit's tree check accepted all of them.
- **M8 Side files.** In an interactive session started with `--plugin-dir`, Claude Code writes `.claude-plugin/types/` and, without a `tsconfig.json` of the mod's own, a `tsconfig.json` into the mod. `validate` and `plugin test` write nothing.

## Decisions this plan makes where the spec is open

- **D1 Foreground and background** (spec §7 "раз в 3 с …; в фоне — раз в 15 с"). Foreground: `$.session.surfaces()` lists a surface; the period is `view.refresh_seconds`. Background: no surface is attached (a `claude --bg` session nobody attached to, which includes turbo's own lanes, since the mod is user-level); the period is 15 s, or `view.refresh_seconds` when that is longer. A `-p` run (`isInteractive: false`) starts nothing at all. Outside a turbo project no process runs: the mod only looks for `.planning/turbo/` again every 15 s with `$.fs.exists`.
- **D2 Where the mod looks.** Like `findProjectRoot`: the first directory up from the session's cwd that has `.planning/`; the mod is active when that one has `turbo/`. `turbo-run view --json` runs with that directory as cwd.
- **D3 CI state.** S0's contract has no CI field (S0 left it to S2; S2's plan does not add it to the view). S3 adds `lanes[].push = { outcome, sha, at, ci } | null`, read from S2's supervisor record `run/p<N>-push.json` (`outcome`, `sha`, `at`, `ci.state`) by file name, without importing S2's code.
- **D4 Settings the mod needs.** The mod reads nothing but the view, so `buildView` adds `ui: { lang, refreshSeconds }` (`lang` from the turbo config, `en` unless `ru`; `refreshSeconds` from `view.refresh_seconds`, a whole number 1–60, anything else 3). Both D3 and D4 are additive keys: `v` stays `1`.
- **D5 `--option <k>` and `--rev <n>`** (spec §5.3; S1's final CLI). `k` is the 1-based number of the option in the question's `options[]` (Telegram's "номер варианта"). The pane always passes `--rev` with the revision it drew (`rev` from `run/p<N>-questions.json`, which S0's `openQuestions` passes through unchanged; a question without one is drawn as rev 1, where S1 starts). `answerArgv` is the only place that builds the argv.
- **D6 The band** ("видна всегда") shows in every interactive session of a project where turbo has state: `supervisor.json` exists or a question is open. It is absent where turbo never ran. When the last read failed it shows `turbo · ⚠ <first line of the error>`.
- **D7 Auto-open.** The mod opens the pane by itself once per module life, and only while the supervisor runs or a question is open; Claude Code applies the 144/110-column rule (M5). A pane the owner closed is not reopened by the clock. `/turbo-view` (registered with `immediate: true`) opens it with focus at any width.
- **D8 Toasts** fire on changes between two reads, never on the first read of a session: a new question (one toast for several), lane status turning `done` ("фаза готова"), `needs-owner` or `failed`, or the supervisor turning `halted` ("лейн встал"), and CI turning red for a new sha. `paused-context` (turbo continues by itself) and `quiet` (a mark only) do not toast.
- **D9 Which subagents.** Active ones (`running`, `quiet`), then at most the 3 newest finished ones dimmed, then `+ N more`.
- **D10 Fallback text.** `turbo-run status --watch` redraws S0's `formatView` text (English), not the mod's pane: the mod may import only files inside its own directory (M3), so the two surfaces keep separate renderers. It clears the screen only on a TTY, and a failing read becomes one `error: …` line of the frame.
- **D11 Plain JavaScript.** The mod is `.mjs`, not TSX: `validate` and `plugin test` accept it (dry run), CI's `node --test` imports the same pure module without a TypeScript step, and elements are plain function calls. Only the harness test is `.tsx`, because `claude plugin test` runs only `.test.ts`/`.test.tsx` and `node --test` would pick up a `.test.ts` (M6).
- **D12 Finding turbo-run.** `TURBO_VIEW_BIN` (development and the visual check) → `${CLAUDE_CONFIG_DIR}/turbo/bin/turbo-run.mjs` → `${USERPROFILE || HOME}/.claude/turbo/bin/turbo-run.mjs` (USERPROFILE first, as `os.homedir()` does on Windows), run as `node <path>`.
- **D13 Install gating.** `node install.mjs` runs `claude --version` and copies the mod only for ≥ 2.1.290; otherwise, or when the version is unknown, it prints `turbo-view mod not installed: …`. The library default `install({ claudeVersion = null })` installs no mod, so existing install tests stay hermetic. Tests, `.claude-plugin/types/` and `tsconfig.json` are never copied. Uninstall needs no change: the mod files are manifest entries under `skills/turbo-*`. `doctor` adds a `turbo-view-mod` check that never changes the mode.
- **D14 No persistent mod state.** The mod keeps its state in module variables only: no `$.store`, no `$.state` (so no `types/index.d.ts`), no file writes. A reload rebuilds everything at the next read.
- **D15 Mod version.** `mod/.claude-plugin/plugin.json` carries `version` (a clean `validate`), pinned equal to `package.json` by a test, so a release bump touches both.
- **D16 Visual check.** One script, `scripts/turbo-view-demo.mjs`, builds a demo project and a test-free copy of the mod in a new temp folder and prints the exact command; the mod then runs the same script as its turbo-run (`TURBO_VIEW_BIN`), which plays a 16-read scripted run and records answers. The copy keeps Claude Code's side files (M8) out of the repository; `.gitignore` covers them in `mod/` too.
- **D17 The "Other…" field keeps its text.** Every read redraws the pane (every 3 s), and an `Input` is drawn with its `value`; drawn with `''` it would wipe what the owner is typing. The shell keeps `{ inputFor, draft, draftFor }` in module state (`onInput`, and the submitted text on Enter) and draws the draft back. The pure `openField`, `afterAnswer` and `keepDraft` (CI-tested) decide what an answer's exit does: 0 answered and 3 already answered close the field and drop the draft; 4 (changed since drawn) closes the field and keeps the draft, which reopens with **Other…** while the question is still open; 1 refused and 2 usage leave the field open with the text to rephrase. After any answer the pane reads the run again at once (a read already running is followed by another).

## Interfaces with the other Stage 3 plans

- **S0 (consumed by exact names, `v: 1`):** `at`; `supervisor.{running, finished, halted}` (or `null`); `range.{from, to}` (or `null`); `lanes[].{phase, step, status, reason, quiet, elapsedMs, agents}`; `agents[].{type, plan, task, state, action.{tool, detail}, lastAt, elapsedMs, tokens}`; `questions[]`; `commits[].{sha, subject}`. S3 adds `ui` and `lanes[].push` (D3, D4).
- **S1 (a command, not code):** `turbo-run answer N <id> (--option <k> | --text <t>) --by pane --rev <n>` as S1's plan publishes it (`docs/plans/2026-10-11-stage-3-s1-owner-channel.md`, Contracts): `--option` and `--text` exclusive, `k` 1-based, `--rev` the revision the pane drew (D5). One line on stdout for each exit: 0 `answered <id>: …`; 3 `already answered: <answer>, <channel>, <time>` (checked before `--rev`); 4 `changed: question <id> changed since it was shown (now rev N, shown rev M); …` (nothing recorded); 1 `refused: …`; 2 usage. The pane toasts the first line of stdout (stderr when stdout is empty), handles the field as D17 says, and reads the run again at once. Question fields used: `id`, `phase`, `plan`, `task`, `question`, `header`, `options[].label`, `allowOther`, `rev` (S1's `defer`, `class` pass through unread). S1 adds no view keys. Until S1 merges, a press shows turbo-run's usage error as a toast.
- **S2 (a file, not code):** `run/p<N>-push.json` fields `outcome` (`pushed | refused | diverged | failed`), `sha`, `at`, `ci.state` (`pending | green | red | none | timeout | superseded`).

## Global Constraints

- Node ≥ 20, ESM `.mjs` only, **zero runtime npm dependencies**; tests use `node:test` and `node:assert/strict`.
- Claude Code ≥ 2.1.290 for the mod (spec §7); older versions get no mod and use `turbo-run status --watch`.
- Spec values:
  - the mod lives in `mod/` of the repository and is installed to `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/turbo-view/`, loaded as `turbo-view@skills-dir`, turned off with `"turbo-view@skills-dir": false` in `enabledPlugins`;
  - turbo-run is `${CLAUDE_CONFIG_DIR:-~/.claude}/turbo/bin/turbo-run.mjs`;
  - data: `$.process.run(node turbo-run.mjs view --json)` through `$.clock.every`, every `view.refresh_seconds` (default 3) in the foreground and every 15 s in the background;
  - active only in a project with `.planning/turbo/`; the pane opens from 144 columns (110 once opened); `/turbo-view` opens it in a narrow terminal; the band is always shown;
  - answers: `turbo-run answer N <id> (--option <k> | --text <t>) --by pane` (spec §5.3), plus `--rev <n>` from S1's final CLI; "Другое…" opens an `Input`;
  - band: `turbo p32 execute · 3 агента · ? 2 вопроса · CI ✓`;
  - toasts: new question, phase done, red CI, lane stopped;
  - `turbo-run status --watch`: the same view, redrawn every 3 s (`view.refresh_seconds`), for terminals without mods;
  - config key `"view": { "refresh_seconds": 3 }`.
- Mod code rules (M3): no Node APIs and no imports other than `./view-model.mjs` in `mod/hooks/*.mjs`; `$` only in `register.mjs`, passed only to its own top-level functions; literal event and env names.
- The mod runs only `turbo-run view --json` and `turbo-run answer …`, always as an argv (`$.process.run`, no shell), and writes no files.
- The view contract only grows: `ui` and `lanes[].push` are added, nothing is renamed or removed, `v` stays `1`.
- Windows and Linux: paths built with `path.join` in `lib/` and with `/` in the mod; child processes through `execFileSync`/`spawn` with argument arrays, `windowsHide: true`, never a shell.
- Public repository: no personal names, private paths, hosts or real transcript content in code, tests, fixtures, the demo or commits; all fixture data is synthetic.
- Testing discipline: each task runs only the test files it names, never the full suite (`npm test`); the controller runs it once at merge. `claude plugin validate` and `claude plugin test` run locally only, never in CI. When the executor's machine has no Claude Code ≥ 2.1.290, that step is reported as "not run: <reason>", never as passed.
- Never push, merge, tag or install for real: install tests use temporary directories; nobody runs `node install.mjs` without `--dry-run`, copies the mod into a real `~/.claude/skills/`, or edits Claude Code settings. Interactive `claude --plugin-dir` sessions are the owner's (Task 7), not the executor's.
- Commits: one commit per task, conventional style (`feat:`, `test:`, `docs:`), the repository's configured identity.

## Review Focus

1. **`turbo-run view` fails or is unusable inside the mod** (a broken `.planning/turbo/config.json`, an older turbo-run without `view`, `node` missing, non-JSON output, a `v: 2` view). Expected: the band shows `turbo · ⚠ <first line>`, the pane shows the error above the last good view, no stack trace, and the clock keeps reading and recovers once the cause is fixed. Pinned in Task 1 (`bandLine`, `render`, `parseView`) and Task 3 (harness: "a failing turbo-run view …").
2. **A free-text answer typed while the pane redraws every 3 s, with shell-hostile, flag-like or non-ASCII content** (`--by telegram "x"; $(rm -rf /)`, `-x`, Russian, emoji) **or only spaces.** Expected: what is typed stays in the field across redraws; the text reaches `turbo-run answer` as exactly one argument, never through a shell; a blank field sends nothing. Pinned in Task 1 (`answerArgv`) and Task 3 (harness: "what is typed into the Other… field survives …", "Other… opens a field …").
3. **A double press, a question already answered in the session or in Telegram, or one that changed after the pane drew it** (a stop reopened it with new options, a re-plan). Expected: at most one `turbo-run answer` per question is on its way and it carries the drawn `--rev`; the arbiter's one-line reply is the toast (`answered …`; `already answered: …` exit 3; `changed: …` exit 4, nothing recorded; `refused: …` exit 1); the pane reads the run again at once; the field closes on 0, 3 and 4, keeps the typed text after 4 (while the question is open) and after 1. Pinned in Task 1 (`answerArgv`, `afterAnswer`, `keepDraft`), Task 2 (`rev` reaches the view), Task 3 (harness: "a double press …", "an answer already given elsewhere …", "a question that changed …", "a refused answer …") and Task 7 (demo: exits 3, 4 and 1).
4. **Long or multi-code-point text in a narrow pane** (a 500-character question, a 90-character option label, emoji in commit subjects). Expected: rows are cut by code points with `…`, never leaving half an emoji, and `Text` truncates at the pane edge. Pinned in Task 1 ("long and multi-code-point text …").
5. **Sessions nobody looks at** (turbo's own `claude --bg` lanes load the user-level mod too, `claude -p` runs, every non-turbo project). Expected: a `-p` run starts nothing; a session without a surface reads every 15 s; outside a turbo project no process runs at all. Pinned in Task 1 (`refreshMs`) and Task 3 (harness: "a -p run …", "a session no surface …", "outside a turbo project …").

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `mod/hooks/view-model.mjs` | create | Pure view model: `render`, `bandLine`, `toastsFor`, `parseView`, `refreshMs`, `shouldAutoOpen`, `answerArgv`, `NO_FIELD`, `openField`, `afterAnswer`, `keepDraft`, `cut`, `firstLine`, `joinPath`, `ancestorDirs`, `turboRunPath`, `PANE_ID`, `PANE_TITLE`, `BACKGROUND_MS`, `DEFAULT_REFRESH_SECONDS` |
| `mod/hooks/register.mjs` | create | The mod shell: locate the project, read the view on a clock, draw pane and band, toasts, answers |
| `mod/hooks/hooks.json`, `mod/.claude-plugin/plugin.json` | create | Mod manifest and entry point |
| `mod/hooks/register.test.tsx` | create | Harness tests for `claude plugin test` (local only) |
| `lib/config.mjs` | modify | `DEFAULTS.view.refresh_seconds`, `viewRefreshSeconds` |
| `lib/view.mjs` | modify | `pushOf`; `lanes[].push`; `ui` |
| `lib/watch.mjs` | create | `watch` loop and `CLEAR` for `status --watch` |
| `bin/turbo-run.mjs` | modify | `readView` helper; `status --watch`; `view` uses `readView` |
| `lib/doctor.mjs` | modify | `MIN_CLAUDE_MODS`, `supportsMods`, `claudeVersionText`; check `turbo-view-mod` |
| `install.mjs` | modify | Copy `mod/` to `skills/turbo-view/` on ≥ 2.1.290; `modNote` |
| `scripts/turbo-view-demo.mjs` | create | The owner's visual check: demo setup, fake turbo-run, instructions |
| `package.json` | modify | `files` gains `mod` |
| `.gitignore` | modify | Claude Code's side files in `mod/` |
| `README.md` | modify | Requirements, Install, Uninstall, Use (`status [--watch]`, Live view), Config (`lang`, `view.refresh_seconds`) |
| `test/view-model.test.mjs`, `test/watch.test.mjs`, `test/cli-watch.test.mjs`, `test/install-mod.test.mjs`, `test/turbo-view-demo.test.mjs` | create | Tests |
| `test/view.test.mjs`, `test/doctor.test.mjs` | modify | Tests |

### Files other Stage 3 plans also change (merge-conflict risk)

- `lib/view.mjs`, `test/view.test.mjs` — S0 creates them; S3 edits the import line, `laneView`'s returned object (`push`), `buildView`'s returned object (`ui`) and S0's first test's expected object; S1 may add keys to the same objects.
- `lib/config.mjs` `DEFAULTS` — S0 (`stall_minutes`), S2 (`push` after `deploy`, `pushSettings` at the end), S1 (`answer`), S4 (`gap_rounds`); S3 inserts after `stall_minutes` and adds `viewRefreshSeconds` before `const isObj`.
- `bin/turbo-run.mjs` — S0 (the `view` case, its import, `USAGE`), S2 (`runtimeConfig`, daemon deps), S1/S4 (new commands); S3 adds an import, `readView` before `main`, a branch at the top of `case 'status'` and replaces three lines of the `view` case.
- `lib/doctor.mjs`, `test/doctor.test.mjs` — S3 only in Stage 3, but both changed in `fix-0.2.2` (already on `main`).
- `README.md` — S0 (Use paragraph, `sh` line, `stall_minutes` row), S2 (Config rows, Push and CI, Safety), S1 (answers, Telegram), S4; S3 edits the `sh` line S0 edits, and the `lang` row.
- `package.json` — the v0.3.0 release bump must also bump `mod/.claude-plugin/plugin.json` (Task 3's test fails otherwise).

---

### Task 1: The view model — pane rows, band line, toasts (pure)

**Files:**
- Create: `mod/hooks/view-model.mjs`
- Test: `test/view-model.test.mjs` (create)

**Interfaces:**
- Consumes: the S0 `view --json` contract plus the keys Task 2 adds (`ui`, `lanes[].push`); every key is optional to this module (an S0-only view renders).
- Produces (all exported from `mod/hooks/view-model.mjs`):
  - `PANE_ID = 'turbo-view'`, `PANE_TITLE = 'turbo'`, `BACKGROUND_MS = 15000`, `DEFAULT_REFRESH_SECONDS = 3`;
  - `render(view | null, { error = null } = {}) → { rows }`, each row `{ kind: 'text', text, tone }` with `tone ∈ 'title' | 'normal' | 'dim' | 'warn' | 'error'`, or `{ kind: 'question', id, phase, rev, text, options: [{ key, label, option }], other, otherKey, inputKey, otherLabel, inputLabel, inputHint, submitLabel }` (`rev` the question's positive whole `rev`, else 1; `option` 1-based; keys `q:<id>:<n>`, `q:<id>:other`, `q:<id>:text`);
  - `bandLine(view | null, { error = null } = {}) → string | null`;
  - `toastsFor(prev | null, next | null) → string[]`;
  - `parseView(stdout) → view` (throws a one-line `Error`);
  - `refreshMs(view | null, foreground: boolean) → number`;
  - `shouldAutoOpen(view | null) → boolean`;
  - `answerArgv({ turboRun, question: { phase, id, rev }, option = null, text = null }) → string[]` (ends with `--by pane --rev <rev>`);
  - `NO_FIELD = { inputFor: null, draft: '', draftFor: null }`; `openField(field, id) → field`; `afterAnswer(field, id, exitCode) → field`; `keepDraft(field, view) → field` (D17);
  - `cut(text, max) → string`, `firstLine(text) → string`, `joinPath(dir, ...parts) → string`, `ancestorDirs(dir) → string[]`, `turboRunPath({ bin, configDir, home }) → string | null`.

- [ ] **Step 1: Write the failing tests**

Create `test/view-model.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_MS, NO_FIELD, PANE_ID, afterAnswer, ancestorDirs, answerArgv, bandLine, cut, firstLine, joinPath, keepDraft, openField, parseView, refreshMs, render, shouldAutoOpen, toastsFor, turboRunPath } from '../mod/hooks/view-model.mjs';

const AT = '2026-01-01T11:00:00.000Z';
const agent = (over) => ({ agentId: 'a1', type: 'gsd-executor', description: '', plan: '32-07', task: '2', model: 'opus', worktreeBranch: null, state: 'running', action: { tool: 'Edit', detail: 'lib/x.mjs' }, startedAt: '2026-01-01T10:54:00.000Z', lastAt: '2026-01-01T10:59:50.000Z', elapsedMs: 360000, tokens: 166000, sessionId: 's', transcript: 't', ...over });
// The S0 contract's example (docs/plans/2026-10-10-stage-3-s0-transcripts.md) plus the keys S3 adds: lane push, ui.
function view(over = {}, lane = {}) {
  return {
    v: 1,
    at: AT,
    supervisor: { running: true, pid: 4242, finished: false, halted: false, failingSince: null, updatedAt: '2026-01-01T10:59:40.000Z' },
    range: { from: '32', to: '34' },
    lanes: [{
      phase: '32', step: 'execute', done: [], notes: {}, status: 'running', reason: '', sessionId: '1a2b3c4d', mode: 'full', launchedAt: '2026-01-01T09:48:00.000Z', elapsedMs: 72 * 60000, transcript: null, lastAt: AT, quiet: false,
      agents: [
        agent(),
        agent({ agentId: 'a2', plan: '32-08', task: null, action: { tool: 'Bash', detail: 'node --test test/view-model.test.mjs' }, elapsedMs: 120000, tokens: 41000 }),
        agent({ agentId: 'a3', type: 'gsd-verifier', plan: null, task: null, state: 'quiet', lastAt: '2026-01-01T10:44:00.000Z', tokens: null }),
        agent({ agentId: 'a4', plan: '32-06', task: null, state: 'completed', elapsedMs: 45000, tokens: 950 }),
      ],
      push: { outcome: 'pushed', sha: 'a1b2c3d', at: AT, ci: 'green' },
      ...lane,
    }],
    questions: [{ id: 'q1', phase: '32', plan: '32-09', task: '3', kind: 'decision', header: 'Deploy', question: 'Deploy after green CI?', options: [{ label: 'Yes, by the gate' }, { label: 'Stop' }], allowOther: true, state: 'open', rev: 1 }],
    commits: [{ sha: 'a1b2c3d', subject: 'fix: lane record keeps the reason' }, { sha: 'd4e5f6a', subject: 'test: quiet agents' }],
    ui: { lang: 'en', refreshSeconds: 3 },
    ...over,
  };
}
const texts = (model) => model.rows.map((r) => (r.kind === 'text' ? r.text : `${r.text} [${r.options.map((o) => o.label).join('] [')}]${r.other ? ` [${r.otherLabel}]` : ''}`));

test('render draws the spec §7 tree: supervisor, lane → step → subagents, questions with their buttons, commits', () => {
  assert.deepEqual(texts(render(view())), [
    'turbo · phases 32–34 · supervisor running',
    '▸ p32  execute  · 1h 12m · lane running',
    '    gsd-executor  32-07 Task 2  Edit lib/x.mjs        6m · 166k',
    '    gsd-executor  32-08         Bash node --test tes… 2m · 41k',
    '    gsd-verifier  —             quiet 16m             ⚠',
    '    gsd-executor  32-06         completed             45s · 950',
    '? 1 question',
    '    32-09 Task 3 · Deploy after green CI? [Yes, by the gate] [Stop] [Other…]',
    'commits:',
    '  a1b2c3d fix: lane record keeps the reason',
    '  d4e5f6a test: quiet agents',
  ]);
  const tones = render(view()).rows.filter((r) => r.kind === 'text').map((r) => r.tone);
  assert.deepEqual(tones, ['title', 'normal', 'normal', 'normal', 'warn', 'dim', 'warn', 'dim', 'dim', 'dim']);
});

test('render in Russian follows lang: durations, quiet, plurals and the Other button', () => {
  const lines = texts(render(view({ ui: { lang: 'ru', refreshSeconds: 3 } })));
  assert.equal(lines[0], 'turbo · фазы 32–34 · супервизор работает');
  assert.equal(lines[1], '▸ p32  execute  · 1 ч 12 мин · лейн running');
  assert.equal(lines[4], '    gsd-verifier  —             тихо 16 мин           ⚠');
  assert.equal(lines[5], '    gsd-executor  32-06         готов                 45 с · 950');
  assert.equal(lines[6], '? 1 вопрос');
  assert.match(lines[7], /\[Другое…\]$/);
  assert.equal(lines[8], 'коммиты:');
});

test('question rows carry the phase, the id, the rev drawn, 1-based option numbers and unique control keys', () => {
  const [q] = render(view()).rows.filter((r) => r.kind === 'question');
  assert.deepEqual([q.phase, q.id, q.rev, q.other], ['32', 'q1', 1, true]);
  assert.equal(render(view({ questions: [{ ...view().questions[0], rev: 3 }] })).rows.find((r) => r.kind === 'question').rev, 3);
  assert.deepEqual(q.options, [{ key: 'q:q1:1', label: 'Yes, by the gate', option: 1 }, { key: 'q:q1:2', label: 'Stop', option: 2 }]);
  assert.deepEqual([q.otherKey, q.inputKey, q.inputLabel, q.submitLabel], ['q:q1:other', 'q:q1:text', 'Answer', 'send']);
  const noOther = render(view({ questions: [{ id: 'q9', phase: '7', question: 'Plug in the device', options: [{ label: 'I will when asked' }], allowOther: false, state: 'open' }] })).rows.find((r) => r.kind === 'question');
  assert.equal(noOther.other, false);
  assert.equal(noOther.rev, 1, 'a question without a rev is drawn as rev 1, where S1 starts');
  assert.equal(noOther.text, '    — · Plug in the device');
});

test('render shows the lane reason, more than three finished agents as a count, and a stopped lane in the warn tone', () => {
  const done = Array.from({ length: 5 }, (_, i) => agent({ agentId: `d${i}`, plan: `32-0${i}`, state: 'completed' }));
  const rows = render(view({}, { status: 'needs-owner', reason: 'checkpoint 32-09 Task 3', agents: done })).rows;
  assert.deepEqual(rows.slice(1, 3).map((r) => [r.text, r.tone]), [['▸ p32  execute  · 1h 12m · lane needs-owner', 'warn'], ['    reason: checkpoint 32-09 Task 3', 'warn']]);
  assert.equal(rows.filter((r) => r.text?.includes('completed')).length, 3);
  assert.equal(rows[6].text, '    + 2 more');
});

test('render without a supervisor, without the S3 keys (an S0-only view), before the first read and after a failed read', () => {
  const bare = { v: 1, at: AT, supervisor: null, range: null, lanes: [], questions: [], commits: [] };
  assert.deepEqual(texts(render(bare)), ['turbo · supervisor never started']);
  assert.deepEqual(texts(render(null)), ['reading the run…']);
  const failed = render(view(), { error: 'invalid turbo config /p/.planning/turbo/config.json: Unexpected end of JSON input' });
  assert.deepEqual(failed.rows[0], { kind: 'text', text: '⚠ turbo-run view failed: invalid turbo config /p/.planning/turbo/config.json: Unexpected end of JSON input', tone: 'error' });
  assert.equal(failed.rows[1].text, 'turbo · phases 32–34 · supervisor running', 'the last good view stays below the error');
  assert.deepEqual(texts(render(null, { error: 'node: not found' })), ['⚠ turbo-run view failed: node: not found']);
});

test('long and multi-code-point text is cut by code points with an ellipsis, never splitting an emoji (Review Focus 4)', () => {
  assert.equal(cut('a'.repeat(10), 5), 'aaaa…');
  assert.equal(cut('👍'.repeat(10), 3), '👍👍…');
  assert.equal(cut('line one\n  line two', 100), 'line one line two');
  const long = render(view({ questions: [{ id: 'q1', phase: '32', plan: '32-09', task: '3', question: 'Ж'.repeat(500), options: [{ label: 'x'.repeat(90) }], state: 'open' }], commits: [{ sha: 'a1b2c3d', subject: `fix: ${'😀'.repeat(200)}` }] }));
  const q = long.rows.find((r) => r.kind === 'question');
  assert.equal(Array.from(q.text).length, '    32-09 Task 3 · '.length + 160);
  assert.equal(Array.from(q.options[0].label).length, 40);
  const subject = long.rows.at(-1).text;
  assert.ok(Array.from(subject).every((ch) => ch.codePointAt(0) < 0xd800 || ch.codePointAt(0) > 0xdfff), 'no lone surrogate');
});

test('bandLine is the spec §7 line, names a stopped supervisor or lane, and is absent where turbo never ran (Review Focus 1)', () => {
  assert.equal(bandLine(view()), 'turbo p32 execute · 3 agents · ? 1 question · CI ✓');
  assert.equal(bandLine(view({ ui: { lang: 'ru', refreshSeconds: 3 } })), 'turbo p32 execute · 3 агента · ? 1 вопрос · CI ✓');
  assert.equal(bandLine(view({ supervisor: { running: false, halted: true } }, { status: 'needs-owner', agents: [], push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' } })), 'turbo p32 execute (needs-owner) · supervisor halted · ? 1 question · CI ✗');
  assert.equal(bandLine(view({}, { push: { outcome: 'refused', sha: null, ci: null } })), 'turbo p32 execute · 3 agents · ? 1 question · push ✗');
  assert.equal(bandLine(view({}, { push: null })), 'turbo p32 execute · 3 agents · ? 1 question');
  assert.equal(bandLine({ v: 1, at: AT, supervisor: null, range: null, lanes: [], questions: [], commits: [] }), null);
  assert.equal(bandLine(null), null);
  assert.equal(bandLine(view(), { error: 'invalid turbo config x: y' }), 'turbo · ⚠ invalid turbo config x: y');
});

test('toastsFor: nothing on the first view; a new question, phase done, red CI, a stopped lane and a halt once each', () => {
  const v1 = view();
  assert.deepEqual(toastsFor(null, v1), []);
  assert.deepEqual(toastsFor(v1, view()), []);
  const q2 = { id: 'q2', phase: '32', plan: '32-10', task: '1', question: 'Looks right?', options: [], state: 'open' };
  assert.deepEqual(toastsFor(v1, view({ questions: [...v1.questions, q2] })), ['new question: 32-10 Task 1 — Looks right?']);
  assert.deepEqual(toastsFor(v1, view({ questions: [q2, { ...q2, id: 'q3' }] })), ['2 new questions']);
  assert.deepEqual(toastsFor(v1, view({}, { status: 'done' })), ['phase 32 done']);
  const red = view({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' } });
  assert.deepEqual(toastsFor(v1, red), ['CI red: phase 32, b2c3d4e']);
  assert.deepEqual(toastsFor(red, view({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' } })), [], 'the same red run toasts once');
  assert.deepEqual(toastsFor(v1, view({}, { status: 'needs-owner', reason: 'checkpoint 32-09' })), ['phase 32 stopped: needs-owner — checkpoint 32-09']);
  assert.deepEqual(toastsFor(v1, view({ supervisor: { ...v1.supervisor, running: false, halted: true } })), ['supervisor halted']);
  assert.deepEqual(toastsFor(view({ ui: { lang: 'ru', refreshSeconds: 3 } }), view({ ui: { lang: 'ru', refreshSeconds: 3 } }, { status: 'done' })), ['фаза 32 готова']);
});

test('parseView accepts v1 and rejects other output with one line (Review Focus 1)', () => {
  assert.deepEqual(parseView(JSON.stringify(view())), view());
  assert.throws(() => parseView('Error: boom\n    at x'), { message: 'turbo-run view --json printed no JSON' });
  assert.throws(() => parseView('{"v":1}'), { message: 'turbo-run view --json printed an object this mod cannot read' });
  assert.throws(() => parseView(JSON.stringify(view({ v: 2 }))), { message: 'turbo-run view --json is v2; this mod reads v1: run node install.mjs again' });
});

test('refreshMs: view.refresh_seconds in the foreground (1–60, else 3), at least 15 s in the background (Review Focus 5)', () => {
  assert.equal(refreshMs(view(), true), 3000);
  assert.equal(refreshMs(view({ ui: { lang: 'en', refreshSeconds: 10 } }), true), 10000);
  assert.equal(refreshMs(view({ ui: { lang: 'en', refreshSeconds: 0 } }), true), 3000);
  assert.equal(refreshMs(null, true), 3000);
  assert.equal(refreshMs(view(), false), BACKGROUND_MS);
  assert.equal(refreshMs(view({ ui: { lang: 'en', refreshSeconds: 30 } }), false), 30000);
});

test('the pane opens by itself only while the supervisor runs or a question is open', () => {
  assert.equal(shouldAutoOpen(view()), true);
  assert.equal(shouldAutoOpen(view({ supervisor: { running: false }, questions: [] })), false);
  assert.equal(shouldAutoOpen(view({ supervisor: null })), true);
  assert.equal(shouldAutoOpen(null), false);
  assert.equal(PANE_ID, 'turbo-view');
});

test('answerArgv passes the option number or the free text as one argument, whatever it holds, and always the drawn rev (Review Focus 2)', () => {
  const question = { phase: '32', id: 'q1', rev: 2 };
  assert.deepEqual(answerArgv({ turboRun: '/h/turbo-run.mjs', question, option: 2 }), ['node', '/h/turbo-run.mjs', 'answer', '32', 'q1', '--option', '2', '--by', 'pane', '--rev', '2']);
  const text = '--by telegram "x"; $(rm -rf /) да 👍';
  assert.deepEqual(answerArgv({ turboRun: '/h/turbo-run.mjs', question, text }), ['node', '/h/turbo-run.mjs', 'answer', '32', 'q1', '--text', text, '--by', 'pane', '--rev', '2']);
});

test('the Other… field after an answer: 0 and 3 close it and drop the draft, 4 closes it and keeps the draft, 1 and 2 leave both; a draft dies with its question (Review Focus 3)', () => {
  const typing = { inputFor: 'q1', draft: 'go on', draftFor: 'q1' };
  assert.deepEqual(openField(NO_FIELD, 'q1'), { inputFor: 'q1', draft: '', draftFor: 'q1' });
  for (const code of [0, 3]) assert.deepEqual(afterAnswer(typing, 'q1', code), NO_FIELD, String(code));
  const changed = afterAnswer(typing, 'q1', 4);
  assert.deepEqual(changed, { inputFor: null, draft: 'go on', draftFor: 'q1' });
  assert.deepEqual(openField(changed, 'q1'), typing, 'reopened with the kept text');
  assert.deepEqual(openField(changed, 'q2'), { inputFor: 'q2', draft: '', draftFor: 'q2' });
  for (const code of [1, 2]) assert.deepEqual(afterAnswer(typing, 'q1', code), typing, String(code));
  assert.deepEqual(afterAnswer(typing, 'q2', 0), typing, 'an answer to another question leaves the field alone');
  assert.equal(keepDraft(changed, view()), changed);
  assert.deepEqual(keepDraft(changed, view({ questions: [] })), NO_FIELD);
  assert.deepEqual(keepDraft(typing, view({ questions: [] })), NO_FIELD);
});

test('paths: ancestors on Windows and POSIX, the turbo-run location from CLAUDE_CONFIG_DIR or the home directory', () => {
  assert.deepEqual(ancestorDirs('C:\\Users\\dev\\app'), ['C:/Users/dev/app', 'C:/Users/dev', 'C:/Users', 'C:/']);
  assert.deepEqual(ancestorDirs('/home/dev/app/'), ['/home/dev/app', '/home/dev', '/home', '/']);
  assert.equal(joinPath('C:/', '.planning'), 'C:/.planning');
  assert.equal(joinPath('/', '.planning', 'turbo'), '/.planning/turbo');
  assert.equal(turboRunPath({ configDir: 'D:\\cfg\\' }), 'D:\\cfg/turbo/bin/turbo-run.mjs');
  assert.equal(turboRunPath({ home: '/home/dev' }), '/home/dev/.claude/turbo/bin/turbo-run.mjs');
  assert.equal(turboRunPath({ bin: '/tmp/fake.mjs', home: '/home/dev' }), '/tmp/fake.mjs');
  assert.equal(turboRunPath({}), null);
  assert.equal(firstLine('\n  invalid turbo config x\n    at y'), 'invalid turbo config x');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/view-model.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `mod/hooks/view-model.mjs`.

- [ ] **Step 3: Create `mod/hooks/view-model.mjs`**

```js
// The turbo-view mod's view model (spec §7): what the pane, the band above the prompt and the toasts show for one
// `turbo-run view --json` object (S0's contract, v 1). Pure functions without imports or host APIs: the mod's hooks
// module imports this file, and node --test runs it in CI (test/view-model.test.mjs).

export const PANE_ID = 'turbo-view';
export const PANE_TITLE = 'turbo';
// How often a session nobody looks at (no surface attached) reads the view, and how often the mod looks for
// .planning/turbo/ again outside a turbo project.
export const BACKGROUND_MS = 15000;
export const DEFAULT_REFRESH_SECONDS = 3;
const FINISHED_SHOWN = 3;
const ACTIVE = new Set(['running', 'quiet']);
const STOPPED = new Set(['needs-owner', 'failed']);
const CI_MARK = { green: 'CI ✓', red: 'CI ✗', pending: 'CI …', timeout: 'CI ?' };

const ruPlural = (n, one, few, many) => {
  const a = n % 10;
  const b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};

const TEXT = {
  en: {
    phases: 'phases',
    sup: { running: 'supervisor running', stopped: 'supervisor not running', finished: 'supervisor finished', halted: 'supervisor halted', never: 'supervisor never started' },
    lane: 'lane',
    allDone: 'all steps done',
    quiet: 'quiet',
    reason: 'reason',
    commits: 'commits',
    state: { completed: 'completed', stopped: 'stopped', failed: 'failed' },
    more: (n) => `+ ${n} more`,
    agents: (n) => `${n} ${n === 1 ? 'agent' : 'agents'}`,
    questions: (n) => `${n} ${n === 1 ? 'question' : 'questions'}`,
    other: 'Other…',
    answer: 'Answer',
    answerHint: 'your answer',
    send: 'send',
    newQuestion: (label) => `new question: ${label}`,
    newQuestions: (n) => `${n} new questions`,
    phaseDone: (p) => `phase ${p} done`,
    ciRed: (p, sha) => `CI red: phase ${p}${sha ? `, ${sha}` : ''}`,
    laneStopped: (p, what) => `phase ${p} stopped: ${what}`,
    halted: 'supervisor halted',
    loading: 'reading the run…',
    failed: 'turbo-run view failed',
    duration: (h, m, s) => (h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`),
  },
  ru: {
    phases: 'фазы',
    sup: { running: 'супервизор работает', stopped: 'супервизор не работает', finished: 'супервизор закончил', halted: 'супервизор остановлен', never: 'супервизор не запускался' },
    lane: 'лейн',
    allDone: 'все шаги готовы',
    quiet: 'тихо',
    reason: 'причина',
    commits: 'коммиты',
    state: { completed: 'готов', stopped: 'остановлен', failed: 'сбой' },
    more: (n) => `+ ещё ${n}`,
    agents: (n) => `${n} ${ruPlural(n, 'агент', 'агента', 'агентов')}`,
    questions: (n) => `${n} ${ruPlural(n, 'вопрос', 'вопроса', 'вопросов')}`,
    other: 'Другое…',
    answer: 'Ответ',
    answerHint: 'свой ответ',
    send: 'отправить',
    newQuestion: (label) => `новый вопрос: ${label}`,
    newQuestions: (n) => `новых вопросов: ${n}`,
    phaseDone: (p) => `фаза ${p} готова`,
    ciRed: (p, sha) => `CI красный: фаза ${p}${sha ? `, ${sha}` : ''}`,
    laneStopped: (p, what) => `фаза ${p} встала: ${what}`,
    halted: 'супервизор остановлен',
    loading: 'читаю прогон…',
    failed: 'turbo-run view не сработал',
    duration: (h, m, s) => (h ? `${h} ч ${m} мин` : m ? `${m} мин` : `${s} с`),
  },
};

const textOf = (view) => TEXT[view?.ui?.lang === 'ru' ? 'ru' : 'en'];
const list = (v) => (Array.isArray(v) ? v : []);

// One line of at most max characters (code points, so an emoji is never split), whitespace collapsed, … when cut.
export function cut(text, max) {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

// A column of width w: the text cut to w - 1 and padded, so the next column starts one space after it at least.
const col = (text, w) => {
  const c = cut(text, w - 1);
  return c + ' '.repeat(w - Array.from(c).length);
};

export const firstLine = (text) => String(text ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? '';

function fmtDuration(t, ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return t.duration(Math.floor(m / 60), m % 60, s);
}

const fmtTokens = (n) => (!Number.isFinite(n) ? '-' : n < 1000 ? String(n) : `${Math.round(n / 1000)}k`);
const planLabel = (x) => (x?.plan ? `${x.plan}${x.task ? ` Task ${x.task}` : ''}` : '—');

function supWord(t, sup) {
  if (!sup) return t.sup.never;
  if (sup.running) return t.sup.running;
  if (sup.halted) return t.sup.halted;
  return sup.finished ? t.sup.finished : t.sup.stopped;
}

function agentRow(t, a, at) {
  const head = `    ${col(a.type || 'agent', 14)}${col(planLabel(a), 14)}`;
  if (a.state === 'quiet') {
    const since = fmtDuration(t, Date.parse(at) - Date.parse(a.lastAt));
    return `${head}${col(since === '-' ? t.quiet : `${t.quiet} ${since}`, 22)}⚠`;
  }
  const doing = a.state === 'running' ? (a.action ? `${a.action.tool} ${a.action.detail ?? ''}` : '—') : t.state[a.state] ?? String(a.state);
  return `${head}${col(doing, 22)}${fmtDuration(t, a.elapsedMs)} · ${fmtTokens(a.tokens)}`;
}

function questionRow(t, q) {
  const id = String(q.id);
  return {
    kind: 'question',
    id,
    phase: String(q.phase ?? ''),
    // the revision drawn (S1: every question starts at rev 1); turbo-run answer gets it as --rev
    rev: Number.isInteger(q.rev) && q.rev > 0 ? q.rev : 1,
    text: `    ${planLabel(q)} · ${cut(q.question || q.header || '', 160)}`,
    // option is the 1-based number turbo-run answer --option takes
    options: list(q.options).map((o, i) => ({ key: `q:${id}:${i + 1}`, label: cut(o?.label || String(i + 1), 40), option: i + 1 })),
    other: q.allowOther !== false,
    otherKey: `q:${id}:other`,
    inputKey: `q:${id}:text`,
    otherLabel: t.other,
    inputLabel: t.answer,
    inputHint: t.answerHint,
    submitLabel: t.send,
  };
}

// The pane: { rows }, each { kind: 'text', text, tone } (tone: title | normal | dim | warn | error) or a question
// row (see questionRow). error is why the last refresh failed; the last good view stays below it.
export function render(view, { error = null } = {}) {
  const t = textOf(view);
  const rows = [];
  const line = (text, tone = 'normal') => rows.push({ kind: 'text', text, tone });
  if (error) line(`⚠ ${t.failed}: ${cut(error, 200)}`, 'error');
  if (!view) {
    if (!error) line(t.loading, 'dim');
    return { rows };
  }
  const range = view.range ? `${t.phases} ${view.range.from ?? '…'}–${view.range.to ?? '…'}` : null;
  line(['turbo', range, supWord(t, view.supervisor)].filter(Boolean).join(' · '), 'title');
  for (const lane of list(view.lanes)) {
    line(`▸ p${lane.phase}  ${lane.step ?? t.allDone}  · ${fmtDuration(t, lane.elapsedMs)} · ${t.lane} ${lane.status}${lane.quiet ? ` · ${t.quiet}` : ''}`, STOPPED.has(lane.status) ? 'warn' : 'normal');
    if (lane.reason) line(`    ${t.reason}: ${cut(lane.reason, 200)}`, 'warn');
    const agents = list(lane.agents);
    const finished = agents.filter((a) => !ACTIVE.has(a.state));
    for (const a of agents.filter((x) => ACTIVE.has(x.state))) line(agentRow(t, a, view.at), a.state === 'quiet' ? 'warn' : 'normal');
    for (const a of finished.slice(0, FINISHED_SHOWN)) line(agentRow(t, a, view.at), 'dim');
    if (finished.length > FINISHED_SHOWN) line(`    ${t.more(finished.length - FINISHED_SHOWN)}`, 'dim');
  }
  const questions = list(view.questions);
  if (questions.length) {
    line(`? ${t.questions(questions.length)}`, 'warn');
    for (const q of questions) rows.push(questionRow(t, q));
  }
  const commits = list(view.commits);
  if (commits.length) {
    line(`${t.commits}:`, 'dim');
    for (const c of commits) line(`  ${c.sha} ${cut(c.subject, 100)}`, 'dim');
  }
  return { rows };
}

const ciMark = (push) => (!push ? null : push.outcome !== 'pushed' ? 'push ✗' : CI_MARK[push.ci] ?? null);

// The one line above the prompt (spec §7: `turbo p32 execute · 3 агента · ? 2 вопроса · CI ✓`), or null when the
// project has no turbo run and no open question.
export function bandLine(view, { error = null } = {}) {
  if (error) return `turbo · ⚠ ${cut(error, 100)}`;
  const questions = list(view?.questions);
  if (!view || (!view.supervisor && !questions.length)) return null;
  const t = textOf(view);
  const lanes = list(view.lanes);
  const parts = [lanes.length ? `turbo ${lanes.map((l) => `p${l.phase} ${l.step ?? t.allDone}${l.status === 'running' ? '' : ` (${l.status})`}`).join(', ')}` : 'turbo'];
  if (!view.supervisor?.running) parts.push(supWord(t, view.supervisor));
  const active = lanes.reduce((n, l) => n + list(l.agents).filter((a) => ACTIVE.has(a.state)).length, 0);
  if (active) parts.push(t.agents(active));
  if (questions.length) parts.push(`? ${t.questions(questions.length)}`);
  const ci = lanes.map((l) => ciMark(l.push)).find(Boolean);
  if (ci) parts.push(ci);
  return parts.join(' · ');
}

// Toasts for what changed between two views: a new question, a phase done, red CI, a lane that stopped (needs-owner,
// failed) or a halted supervisor. The first view of a session (prev null) shows none.
export function toastsFor(prev, next) {
  if (!prev || !next) return [];
  const t = textOf(next);
  const out = [];
  const seen = new Set(list(prev.questions).map((q) => q.id));
  const fresh = list(next.questions).filter((q) => !seen.has(q.id));
  if (fresh.length === 1) out.push(t.newQuestion(`${planLabel(fresh[0])} — ${cut(fresh[0].question || fresh[0].header || '', 80)}`));
  else if (fresh.length > 1) out.push(t.newQuestions(fresh.length));
  for (const p of list(prev.lanes)) {
    const n = list(next.lanes).find((l) => String(l.phase) === String(p.phase));
    if (!n) continue;
    if (n.status === 'done' && p.status !== 'done') out.push(t.phaseDone(n.phase));
    if (STOPPED.has(n.status) && n.status !== p.status) out.push(t.laneStopped(n.phase, n.reason ? `${n.status} — ${cut(n.reason, 80)}` : n.status));
    if (n.push?.ci === 'red' && !(p.push?.ci === 'red' && p.push?.sha === n.push.sha)) out.push(t.ciRed(n.phase, n.push.sha));
  }
  if (!prev.supervisor?.halted && next.supervisor?.halted) out.push(t.halted);
  return out;
}

// The view object from `turbo-run view --json` output; throws a one-line Error for anything else.
export function parseView(stdout) {
  let v;
  try {
    v = JSON.parse(String(stdout));
  } catch {
    throw new Error('turbo-run view --json printed no JSON');
  }
  if (!v || typeof v !== 'object' || !Array.isArray(v.lanes) || !Array.isArray(v.questions) || !Array.isArray(v.commits)) throw new Error('turbo-run view --json printed an object this mod cannot read');
  if (v.v !== 1) throw new Error(`turbo-run view --json is v${v.v}; this mod reads v1: run node install.mjs again`);
  return v;
}

// Milliseconds between two reads: view.refresh_seconds (ui.refreshSeconds in the view, 1–60, else 3) while a
// surface is attached, else at least BACKGROUND_MS.
export function refreshMs(view, foreground) {
  const n = Number(view?.ui?.refreshSeconds);
  const ms = (Number.isInteger(n) && n >= 1 && n <= 60 ? n : DEFAULT_REFRESH_SECONDS) * 1000;
  return foreground ? ms : Math.max(BACKGROUND_MS, ms);
}

// The mod opens the pane by itself only while there is something live to watch; Claude Code places such a pane
// from 144 columns (110 once the person opened it), and /turbo-view opens it at any width.
export const shouldAutoOpen = (view) => Boolean(view?.supervisor?.running || list(view?.questions).length);

// The argv of S1's single answer arbiter (spec §5.3) for a press in the pane: option is the 1-based option number,
// text a free answer, passed as one argument (no shell); --rev is always the revision the pane drew, so an answer to
// a question that changed since records nothing (exit 4).
export function answerArgv({ turboRun, question, option = null, text = null }) {
  const pick = text !== null ? ['--text', String(text)] : ['--option', String(option)];
  return ['node', turboRun, 'answer', String(question.phase), String(question.id), ...pick, '--by', 'pane', '--rev', String(question.rev)];
}

// The "Other…" field: { inputFor (the question whose field is open), draft (what is typed), draftFor (its question) }.
export const NO_FIELD = Object.freeze({ inputFor: null, draft: '', draftFor: null });

// Opens the field of question id, with the text typed for it before (kept after a changed question), else empty.
export const openField = (field, id) => ({ inputFor: id, draft: field.draftFor === id ? field.draft : '', draftFor: id });

// After `turbo-run answer` exits (S1's codes): 0 answered and 3 already answered close the field and drop its
// draft; 4 (the question changed since it was drawn) closes it and keeps the draft; 1 refused and 2 usage leave
// both, so the owner can rephrase.
export function afterAnswer(field, id, code) {
  const settled = code === 0 || code === 3;
  const drop = settled && field.draftFor === id;
  return {
    inputFor: field.inputFor === id && (settled || code === 4) ? null : field.inputFor,
    draft: drop ? '' : field.draft,
    draftFor: drop ? null : field.draftFor,
  };
}

// A draft lives as long as its question is open in the view.
export function keepDraft(field, view) {
  if (field.draftFor === null || list(view?.questions).some((q) => String(q.id) === field.draftFor)) return field;
  return { inputFor: field.inputFor === field.draftFor ? null : field.inputFor, draft: '', draftFor: null };
}

// Joins with "/", which Windows accepts too; a trailing separator of dir is dropped (C:\ → C:/x, / → /x).
export const joinPath = (dir, ...parts) => [String(dir).replace(/[\\/]+$/, ''), ...parts].join('/');

// dir and every directory above it, nearest first, with "/" separators (C:/a/b → C:/a/b, C:/a, C:/).
export function ancestorDirs(dir) {
  const parts = String(dir).replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  const out = [];
  for (let i = parts.length; i > 0; i--) {
    const d = parts.slice(0, i).join('/');
    const full = d === '' ? '/' : /^[A-Za-z]:$/.test(d) ? `${d}/` : d;
    if (!out.includes(full)) out.push(full);
  }
  return out;
}

// turbo-run.mjs as install.mjs places it: ${CLAUDE_CONFIG_DIR:-<home>/.claude}/turbo/bin/turbo-run.mjs. bin
// (TURBO_VIEW_BIN) overrides it for development and the visual check; null when no directory is known.
export function turboRunPath({ bin = null, configDir = null, home = null }) {
  if (bin) return bin;
  const base = configDir || (home ? joinPath(home, '.claude') : null);
  return base ? joinPath(base, 'turbo', 'bin', 'turbo-run.mjs') : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/view-model.test.mjs`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add mod/hooks/view-model.mjs test/view-model.test.mjs
git commit -q -m "feat: turbo-view view model — pane rows, band line and toasts from turbo-run view --json"
```

---

### Task 2: The view carries the live view's settings and the phase's last push

**Files:**
- Modify: `lib/config.mjs` (`DEFAULTS`; new `viewRefreshSeconds`)
- Modify: `lib/view.mjs` (import line; new `pushOf`; `laneView`'s object; `buildView`'s object)
- Test: `test/view.test.mjs` (modify S0's first test and the import line; append two tests)

**Interfaces:**
- Consumes: S0's `buildView`, `laneView`, `isObj`, `readJson`, `runDir` in `lib/view.mjs`; `DEFAULTS` in `lib/config.mjs`.
- Produces:
  - `DEFAULTS.view = { refresh_seconds: 3 }`; `viewRefreshSeconds(config) → number` (a whole number 1–60, else 3) in `lib/config.mjs`;
  - `pushOf(root, phase) → { outcome, sha, at, ci } | null` in `lib/view.mjs`;
  - `buildView(…).ui = { lang: 'en' | 'ru', refreshSeconds }` and `buildView(…).lanes[i].push = pushOf(root, phase)` (Task 1's `bandLine`, `toastsFor` and `refreshMs` read them; Task 4 reads `ui.refreshSeconds`);
  - a test that pins `buildView(…).questions` as S1's open question objects, unchanged, `rev` included (S0's `openQuestions` already passes them through; the pane's `--rev` depends on it).

- [ ] **Step 1: Write the failing tests**

In `test/view.test.mjs`:

1. Replace the import line from `../lib/view.mjs` (S0's Task 8 form) with these two lines:

```js
import { buildView, formatView, openQuestions, pushOf, recentCommits, stallMs } from '../lib/view.mjs';
import { DEFAULTS, viewRefreshSeconds } from '../lib/config.mjs';
```

2. In the test `'without supervisor.json the view has no supervisor and no lanes, and still lists questions and commits'`, replace

```js
  assert.deepEqual(v, { v: 1, at: NOW.toISOString(), supervisor: null, range: null, lanes: [], questions: [], commits: COMMITS() });
```

with

```js
  assert.deepEqual(v, { v: 1, at: NOW.toISOString(), supervisor: null, range: null, lanes: [], questions: [], commits: COMMITS(), ui: { lang: 'en', refreshSeconds: 3 } });
```

3. Append:

```js
test('the view carries the live view settings (ui) and each lane its last push as S2 recorded it', () => {
  const { root, sup, env } = laneProject();
  const v = buildView({ root, sup, config: { lang: 'ru', view: { refresh_seconds: 5 } }, env, now: NOW, commits: COMMITS });
  assert.deepEqual(v.ui, { lang: 'ru', refreshSeconds: 5 });
  assert.equal(v.lanes[0].push, null);
  const record = path.join(runDirOf(root), 'p32-push.json');
  writeJsonAtomic(record, { requestId: 'r1', phase: '32', remote: 'origin', branch: 'main', at: at('10:50'), outcome: 'pushed', sha: 'f'.repeat(40), ci: { state: 'red', since: at('10:50'), runs: [] } });
  assert.deepEqual(buildView({ root, sup, env, now: NOW, commits: COMMITS }).lanes[0].push, { outcome: 'pushed', sha: 'fffffff', at: at('10:50'), ci: 'red' });
  writeJsonAtomic(record, { outcome: 'refused', findings: [{ file: '.env', kind: 'forbidden name' }] });
  assert.deepEqual(pushOf(root, '32'), { outcome: 'refused', sha: null, at: null, ci: null });
  fs.writeFileSync(record, '{"outcome":');
  assert.equal(pushOf(root, '32'), null);
  writeJsonAtomic(record, { outcome: 'exploded' });
  assert.equal(pushOf(root, '32'), null);
});

test('view.refresh_seconds is a whole number of seconds from 1 to 60; anything else counts as 3', () => {
  assert.equal(DEFAULTS.view.refresh_seconds, 3);
  assert.equal(viewRefreshSeconds({ view: { refresh_seconds: 1 } }), 1);
  assert.equal(viewRefreshSeconds({ view: { refresh_seconds: 60 } }), 60);
  for (const bad of [0, 61, 2.5, null, 'x']) assert.equal(viewRefreshSeconds({ view: { refresh_seconds: bad } }), 3, String(bad));
  assert.equal(viewRefreshSeconds({}), 3);
});

test('open questions reach the view as S1 writes them, rev included: the pane answers with that rev', () => {
  const { root, sup, env } = laneProject();
  const q = { id: '32-09-t2', phase: '32', plan: '32-09', task: '2', kind: 'decision', header: '32-09 T2', question: 'Select the provider', context: '', options: [{ label: 'Clerk', description: '', recommended: true, signal: 'clerk', defer: false }], allowOther: true, condition: null, class: 'decision', agentId: null, stopped: false, state: 'open', answer: null, delivery: null, rev: 2, source: 'plan' };
  writeJsonAtomic(path.join(runDirOf(root), 'p32-questions.json'), [q, { ...q, id: '32-09-t3', state: 'answered', rev: 1 }]);
  assert.deepEqual(buildView({ root, sup, env, now: NOW, commits: COMMITS }).questions, [q]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/view.test.mjs`
Expected: FAIL with a `SyntaxError` that names a missing export (`pushOf` or `viewRefreshSeconds`).

- [ ] **Step 3: Implement**

In `lib/config.mjs`, inside `DEFAULTS`, right after the line `  stall_minutes: 15,` add:

```js
  // seconds between two reads of the live view: the turbo-view mod and turbo-run status --watch (1–60)
  view: { refresh_seconds: 3 },
```

In `lib/config.mjs`, right before the line `const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);` add:

```js
// view.refresh_seconds as the live view uses it: a whole number of seconds from 1 to 60, anything else the default.
export function viewRefreshSeconds(config) {
  const n = Number(config?.view?.refresh_seconds);
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : DEFAULTS.view.refresh_seconds;
}

```

In `lib/view.mjs`:

1. Replace `import { DEFAULTS } from './config.mjs';` with:

```js
import { DEFAULTS, viewRefreshSeconds } from './config.mjs';
```

2. Right before the line `function laneView({ root, lane, home, now, stall, cache, used }) {` add:

```js
// The phase's last push as the supervisor recorded it (S2: run/p<N>-push.json), reduced to what the live view shows:
// { outcome, sha (7 characters), at, ci (the CI state, or null) }; null without a readable record.
const PUSH_OUTCOMES = new Set(['pushed', 'refused', 'diverged', 'failed']);
export function pushOf(root, phase) {
  const rec = readJson(path.join(runDir(root), `p${phase}-push.json`), null);
  if (!isObj(rec) || !PUSH_OUTCOMES.has(rec.outcome)) return null;
  const text = (v) => (typeof v === 'string' && v ? v : null);
  return { outcome: rec.outcome, sha: text(rec.sha)?.slice(0, 7) ?? null, at: text(rec.at), ci: isObj(rec.ci) ? text(rec.ci.state) : null };
}

```

3. In the object `laneView` returns, right after the line `    agents: t.agents,` add:

```js
    push: pushOf(root, phase),
```

4. In the object `buildView` returns, right after the line `    commits: commits(root),` add:

```js
    // what the turbo-view mod (S3) reads from the owner's config: the language it draws in and how often it reads
    ui: { lang: config?.lang === 'ru' ? 'ru' : 'en', refreshSeconds: viewRefreshSeconds(config) },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/view.test.mjs test/cli-view.test.mjs test/config.test.mjs`
Expected: PASS — S0's 10 view tests plus the 3 new ones (the `rev` pass-through test passes already on S0's `openQuestions`; it pins it), the 3 CLI view tests, and every config test (`loadConfig` without a file still equals `DEFAULTS`, which now holds `view`).

- [ ] **Step 5: Commit**

```bash
git add lib/config.mjs lib/view.mjs test/view.test.mjs
git commit -q -m "feat: turbo-run view carries ui (lang, refresh seconds) and each lane's last push for the live view"
```

---

### Task 3: The mod — manifest, the thin shell, harness tests

**Files:**
- Create: `mod/.claude-plugin/plugin.json`, `mod/hooks/hooks.json`, `mod/hooks/register.mjs`, `mod/hooks/register.test.tsx`
- Modify: `test/view-model.test.mjs` (an import line; append one test), `.gitignore`

**Interfaces:**
- Consumes: everything Task 1 exports; the `ui` and `lanes[].push` keys of Task 2 (through the view); mod API M4.
- Produces:
  - the mod `turbo-view`: hooks `session.start`, `command.run{command=turbo-view}`, `ui.render{component=AbovePrompt}`, `ui.render{component=Pane, requestId=turbo-view}`; the command `/turbo-view`;
  - processes it runs: `node <turbo-run> view --json` (cwd = project root, 10 s timeout) and `answerArgv(…)` (30 s timeout);
  - env it reads: `TURBO_VIEW_BIN`, `CLAUDE_CONFIG_DIR`, `USERPROFILE`, `HOME` (Task 7 sets `TURBO_VIEW_BIN`).

- [ ] **Step 1: Write the failing CI test**

In `test/view-model.test.mjs`, add this line right after `import assert from 'node:assert/strict';`:

```js
import fs from 'node:fs';
```

and append:

```js
test('the mod is a plugin whose hooks module loads in plain Node and registers its four hooks; its version follows package.json', async () => {
  const plugin = JSON.parse(fs.readFileSync('mod/.claude-plugin/plugin.json', 'utf8'));
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.deepEqual([plugin.name, plugin.version], ['turbo-view', pkg.version]);
  assert.deepEqual(JSON.parse(fs.readFileSync('mod/hooks/hooks.json', 'utf8')), { modules: ['./register.mjs'] });
  const { register } = await import('../mod/hooks/register.mjs');
  const hooks = [];
  register((event, matcher) => {
    hooks.push([event, typeof matcher === 'function' ? null : matcher]);
    return { catch() {} };
  });
  assert.deepEqual(hooks, [['session.start', null], ['command.run', { command: 'turbo-view' }], ['ui.render', { component: 'AbovePrompt' }], ['ui.render', { component: 'Pane', requestId: PANE_ID }]]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/view-model.test.mjs`
Expected: FAIL in the new test with `ENOENT` for `mod/.claude-plugin/plugin.json`; the 14 other tests pass.

- [ ] **Step 3: Write the harness tests**

Create `mod/hooks/register.test.tsx` (run by `claude plugin test` only; `node --test` skips `.tsx`, M6):

```tsx
// Harness tests of the mod shell: run locally with `claude plugin test mod` (never in CI; node --test skips .tsx).
import { expect, mock, test } from 'claude-code/testing'

const VIEW = {
  v: 1,
  at: '2026-01-01T11:00:00.000Z',
  supervisor: { running: true, pid: 4242, finished: false, halted: false, failingSince: null, updatedAt: '2026-01-01T10:59:40.000Z' },
  range: { from: '32', to: '34' },
  lanes: [{
    phase: '32', step: 'execute', done: [], notes: {}, status: 'running', reason: '', sessionId: '1a2b3c4d', mode: 'full',
    launchedAt: '2026-01-01T09:48:00.000Z', elapsedMs: 4320000, transcript: null, lastAt: '2026-01-01T10:59:58.000Z', quiet: false,
    agents: [{ agentId: 'a1', type: 'gsd-executor', description: 'Execute plan 07 of phase 32', plan: '32-07', task: '2', model: 'opus', worktreeBranch: null, state: 'running', action: { tool: 'Edit', detail: 'lib/x.mjs' }, startedAt: '2026-01-01T10:54:00.000Z', lastAt: '2026-01-01T10:59:50.000Z', elapsedMs: 360000, tokens: 166000, sessionId: 's', transcript: 't' }],
    push: { outcome: 'pushed', sha: 'a1b2c3d', at: '2026-01-01T10:50:00.000Z', ci: 'green' },
  }],
  questions: [{ id: 'q1', phase: '32', plan: '32-09', task: '3', kind: 'decision', header: 'Deploy', question: 'Deploy after green CI?', options: [{ label: 'Yes, by the gate' }, { label: 'Stop' }], allowOther: true, state: 'open', rev: 1 }],
  commits: [{ sha: 'a1b2c3d', subject: 'fix: lane record keeps the reason' }],
  ui: { lang: 'en', refreshSeconds: 3 },
}
const BIN = '/home/dev/.claude/turbo/bin/turbo-run.mjs'
const BAND = { plugin: 'turbo-view', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
const PANE = { plugin: 'turbo-view', surface: 'terminal', component: 'Pane', requestId: 'turbo-view', props: { title: 'turbo', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

type Run = { exitCode: number; stdout: string; stderr: string }

// A session in /work: .planning/turbo/ exists unless turbo is false; views[i] answers the i-th view read; surfaces
// is what $.session.surfaces() reports (none: a background session nobody is attached to).
function stub(on, { turbo = true, views = [VIEW] as unknown[], answer = { exitCode: 0, stdout: 'answered q1 (pane)\n', stderr: '' } as Run, answerDelayMs = 0, surfaces = ['terminal'] } = {}) {
  const calls: string[][] = []
  const toasts: string[] = []
  let reads = 0
  const clock = mock.clock(on)
  mock.env(on, { CLAUDE_CONFIG_DIR: '/home/dev/.claude' })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.surfaces', () => ({ value: surfaces }))
  // the kit hands fs paths over absolute, in the platform's form (C:\work\.planning on Windows)
  on('fs.exists', (_$, e) => ({ value: turbo && /[\\/]work[\\/]\.planning([\\/]turbo)?$/.test(e.path) }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('process.run', async (_$, e) => {
    calls.push([...e.argv])
    if (e.argv[2] === 'answer') {
      if (answerDelayMs) await clock.sleep(answerDelayMs)
      return { value: answer }
    }
    const v = views[Math.min(reads++, views.length - 1)]
    return { value: typeof v === 'string' ? { exitCode: 1, stdout: '', stderr: v } : { exitCode: 0, stdout: JSON.stringify(v), stderr: '' } }
  })
  return { calls, toasts, clock }
}

const start = ($, isInteractive = true) => $.session.start({ cwd: '/work', surface: isInteractive ? 'terminal' : null, isInteractive })

test('in a turbo project the band and the pane show the view, and an option button answers through turbo-run', async ($, on) => {
  const { calls, clock } = stub(on)
  await start($)
  await clock.settle()
  expect(calls[0]).toEqual(['node', BIN, 'view', '--json'])
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: 'turbo p32 execute · 1 agent · ? 1 question · CI ✓' })).toBeDefined()
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: /gsd-executor +32-07 Task 2 +Edit lib\/x\.mjs +6m · 166k/ })).toBeDefined()
  await pane.press({ key: 'q:q1:1' })
  await clock.settle()
  expect(calls.find((c) => c[2] === 'answer')).toEqual(['node', BIN, 'answer', '32', 'q1', '--option', '1', '--by', 'pane', '--rev', '1'])
})

test('Other… opens a field whose text reaches turbo-run answer as one argument; an empty field sends nothing', async ($, on) => {
  const { calls, clock } = stub(on)
  await start($)
  await clock.settle()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'q:q1:other' })
  await pane.input({ key: 'q:q1:text', text: '   ' })
  expect(calls.some((c) => c[2] === 'answer')).toBe(false)
  await pane.press({ key: 'q:q1:other' })
  await pane.input({ key: 'q:q1:text', text: '-x "y"; да 👍' })
  await clock.settle()
  expect(calls.find((c) => c[2] === 'answer')).toEqual(['node', BIN, 'answer', '32', 'q1', '--text', '-x "y"; да 👍', '--by', 'pane', '--rev', '1'])
})

test('a double press sends one answer while the first is on its way', async ($, on) => {
  const { calls, clock } = stub(on, { answerDelayMs: 1000 })
  await start($)
  await clock.settle()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'q:q1:1' })
  await pane.press({ key: 'q:q1:2' })
  await clock.advance(1000)
  expect(calls.filter((c) => c[2] === 'answer')).toHaveLength(1)
})

test('a failing turbo-run view shows one line in the band, keeps reading, and recovers', async ($, on) => {
  const { calls, clock } = stub(on, { views: ['invalid turbo config /work/.planning/turbo/config.json: Unexpected end of JSON input\n    at loadConfig (x.mjs:1:1)\n', VIEW] })
  await start($)
  await clock.settle()
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: 'turbo · ⚠ invalid turbo config /work/.planning/turbo/config.json: Unexpected end of JSON input' })).toBeDefined()
  await band.unmount()
  await clock.advance(15000)
  expect(calls.filter((c) => c[2] === 'view').length).toBeGreaterThan(1)
  const again = await $.ui.mount(BAND)
  expect(await again.find({ type: 'Text', text: /^turbo p32 execute/ })).toBeDefined()
})

test('a new question between two reads raises a toast', async ($, on) => {
  const q2 = { id: 'q2', phase: '32', plan: '32-10', task: '1', kind: 'verify', header: 'Check', question: 'Looks right?', options: [], allowOther: true, state: 'open' }
  const { toasts, clock } = stub(on, { views: [VIEW, { ...VIEW, questions: [...VIEW.questions, q2] }] })
  await start($)
  await clock.settle()
  expect(toasts).toEqual([])
  await clock.advance(3000)
  expect(toasts).toEqual(['new question: 32-10 Task 1 — Looks right?'])
})

test('outside a turbo project nothing runs, and /turbo-view says why', async ($, on) => {
  const { calls, clock } = stub(on, { turbo: false })
  await start($)
  await clock.advance(30000)
  expect(calls).toEqual([])
  const answer = await $.command.run({ command: 'turbo-view', args: '' })
  expect(answer.text).toBe('turbo-view: no .planning/turbo/ in this directory or above it')
})

test('a -p run starts nothing', async ($, on) => {
  const { calls, clock } = stub(on)
  await start($, false)
  await clock.advance(30000)
  expect(calls).toEqual([])
})

test('a session no surface is attached to reads every 15 s, not every 3 s', async ($, on) => {
  const { calls, clock } = stub(on, { surfaces: [] })
  await start($)
  await clock.settle()
  await clock.advance(14000)
  expect(calls.filter((c) => c[2] === 'view')).toHaveLength(1)
  await clock.advance(1000)
  expect(calls.filter((c) => c[2] === 'view')).toHaveLength(2)
})

test('what is typed into the Other… field survives the next read, which redraws the pane', async ($, on) => {
  const { clock } = stub(on)
  await start($)
  await clock.settle()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'q:q1:other' })
  await pane.input({ key: 'q:q1:text', text: 'полу', kind: 'change' })
  await clock.advance(3000)
  expect((await pane.find({ key: 'q:q1:text' })).props.value).toBe('полу')
})

test('an answer already given elsewhere: the arbiter line from stdout (exit 3) is the toast, and the field closes', async ($, on) => {
  const { toasts, clock } = stub(on, { answer: { exitCode: 3, stdout: 'already answered: Stop, telegram, 2026-01-01T10:58:00.000Z\n', stderr: '' } })
  await start($)
  await clock.settle()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'q:q1:other' })
  await pane.input({ key: 'q:q1:text', text: 'go on' })
  await clock.settle()
  expect(toasts).toEqual(['already answered: Stop, telegram, 2026-01-01T10:58:00.000Z'])
  expect(await pane.find({ key: 'q:q1:text' })).toBeUndefined()
})

test('a question that changed since it was drawn (exit 4): the line is the toast, the pane reads again at once, the field closes and keeps the text', async ($, on) => {
  const line = 'changed: question q1 changed since it was shown (now rev 2, shown rev 1); read it again and answer the new version'
  const { calls, toasts, clock } = stub(on, { answer: { exitCode: 4, stdout: `${line}\n`, stderr: '' } })
  await start($)
  await clock.settle()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'q:q1:other' })
  await pane.input({ key: 'q:q1:text', text: 'go on' })
  await clock.settle()
  expect(toasts).toEqual([line])
  expect(calls.filter((c) => c[2] === 'view')).toHaveLength(2)
  expect(await pane.find({ key: 'q:q1:text' })).toBeUndefined()
  await pane.press({ key: 'q:q1:other' })
  expect((await pane.find({ key: 'q:q1:text' })).props.value).toBe('go on')
})

test('a refused answer (exit 1): the line is the toast, and the field stays open with the text to rephrase', async ($, on) => {
  const line = 'refused: the answer matches a secret pattern (GitHub token); say it without the value'
  const { toasts, clock } = stub(on, { answer: { exitCode: 1, stdout: `${line}\n`, stderr: '' } })
  await start($)
  await clock.settle()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'q:q1:other' })
  await pane.input({ key: 'q:q1:text', text: 'token is abc' })
  await clock.settle()
  expect(toasts).toEqual([line])
  expect((await pane.find({ key: 'q:q1:text' })).props.value).toBe('token is abc')
})
```

- [ ] **Step 4: Create the manifest, the entry point and the shell**

Create `mod/.claude-plugin/plugin.json` (`version` is `package.json`'s; the CI test pins them equal):

```json
{
  "name": "turbo-view",
  "version": "0.2.2",
  "description": "gsd-turbo live view: lanes, subagents, owner questions with answer buttons, recent commits",
  "author": {
    "name": "gsd-turbo"
  }
}
```

If `package.json` on the base has another `version`, use that value.

Create `mod/hooks/hooks.json`:

```json
{ "modules": ["./register.mjs"] }
```

Create `mod/hooks/register.mjs`:

```js
// turbo-view: the gsd-turbo live view (spec §7). A thin shell over view-model.mjs: it finds the project's
// .planning/turbo/, reads `turbo-run view --json` on a clock, draws the pane and the band above the prompt, shows
// toasts, and sends pane answers to `turbo-run answer … --by pane --rev <n>`. Module state is lost on a reload; the
// next read rebuilds it.
import { BACKGROUND_MS, NO_FIELD, PANE_ID, PANE_TITLE, afterAnswer, ancestorDirs, answerArgv, bandLine, firstLine, joinPath, keepDraft, openField, parseView, refreshMs, render, shouldAutoOpen, toastsFor, turboRunPath } from './view-model.mjs';

const VIEW_TIMEOUT_MS = 10000;
const ANSWER_TIMEOUT_MS = 30000;
const TOAST_MS = 8000;
const TONES = { title: { bold: true }, normal: {}, dim: { dimColor: true }, warn: { color: 'yellow' }, error: { color: 'red' } };

let root = null; // the project directory whose .planning/ holds turbo/, or null
let bin = null; // turbo-run.mjs
let view = null; // the last view read
let error = null; // why the last read failed
let busy = false; // a read is running
let again = false; // a forced read was asked for while one was running
let timer = null;
let period = 0;
let opened = false; // the pane was opened once in this module's life; the clock never reopens a closed pane
// The "Other…" field (view-model.mjs): every read redraws the pane, so what is typed is kept here and drawn back.
let field = NO_FIELD;
const sending = new Set(); // questions with an answer on its way

// The first directory up from the session's that has .planning/ (the project turbo-run finds), if it has turbo/.
async function locate($) {
  root = null;
  for (const dir of ancestorDirs(await $.session.cwd())) {
    if (!(await $.fs.exists(joinPath(dir, '.planning')))) continue;
    if (await $.fs.exists(joinPath(dir, '.planning', 'turbo'))) root = dir;
    return;
  }
}

async function findBin($) {
  return turboRunPath({ bin: await $.env.get('TURBO_VIEW_BIN'), configDir: await $.env.get('CLAUDE_CONFIG_DIR'), home: (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) });
}

// One clock for every read: view.refresh_seconds while a surface is attached, 15 s otherwise and outside turbo.
async function arm($) {
  const surfaces = await $.session.surfaces();
  const ms = root ? refreshMs(view, surfaces.length > 0) : BACKGROUND_MS;
  if (ms === period) return;
  if (timer) timer.cancel();
  period = ms;
  timer = $.clock.every(ms, () => {
    void refresh($, false);
  });
}

// Reads the view once: finds the project first, then runs turbo-run view --json in it.
async function read($) {
  if (!root) await locate($);
  if (!root) {
    view = null;
    error = null;
    return;
  }
  bin = bin || (await findBin($));
  if (!bin) throw new Error('cannot find turbo-run: neither CLAUDE_CONFIG_DIR nor a home directory is set');
  const r = await $.process.run(['node', bin, 'view', '--json'], { cwd: root, timeoutMs: VIEW_TIMEOUT_MS });
  if (r.exitCode !== 0) throw new Error(firstLine(r.stderr) || `turbo-run view exited with ${r.exitCode}`);
  const next = parseView(r.stdout);
  for (const text of toastsFor(view, next)) $.ui.toast(text, { timeoutMs: TOAST_MS });
  view = next;
  error = null;
  field = keepDraft(field, next);
}

// force: read again right after a read that is already running (after an answer), instead of skipping.
async function refresh($, force) {
  if (busy) {
    if (force) again = true;
    return;
  }
  busy = true;
  try {
    await read($);
  } catch (err) {
    error = firstLine(err?.message ?? err) || 'unknown error';
  } finally {
    busy = false;
  }
  if (!opened && shouldAutoOpen(view)) {
    opened = true;
    try {
      await $.ui.open({ id: PANE_ID, title: PANE_TITLE });
    } catch (err) {
      $.ui.log(`turbo-view: pane not opened: ${firstLine(err?.message ?? err)}`);
    }
  }
  try {
    await arm($);
  } catch (err) {
    $.ui.log(`turbo-view: clock not set: ${firstLine(err?.message ?? err)}`);
  }
  $.ui.invalidate('ui.render');
  if (again) {
    again = false;
    await refresh($, false);
  }
}

// One answer per question at a time. S1's arbiter prints one line on stdout for every outcome (answered, already
// answered, changed since it was shown, refused); that line is the toast. The pane reads the run again at once.
async function send($, q, choice) {
  if (sending.has(q.id) || !bin || !root) return;
  sending.add(q.id);
  try {
    const r = await $.process.run(answerArgv({ turboRun: bin, question: q, ...choice }), { cwd: root, timeoutMs: ANSWER_TIMEOUT_MS });
    $.ui.toast(firstLine(r.stdout) || firstLine(r.stderr) || `turbo-run answer exited with ${r.exitCode}`, { timeoutMs: TOAST_MS });
    field = afterAnswer(field, q.id, r.exitCode);
  } catch (err) {
    $.ui.toast(`turbo-run answer failed: ${firstLine(err?.message ?? err)}`, { timeoutMs: TOAST_MS });
  } finally {
    sending.delete(q.id);
  }
  await refresh($, true);
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    // a -p run draws nowhere and nobody answers there: the mod stays idle
    if (!e.isInteractive) return next(e);
    try {
      await $.command.register({ name: 'turbo-view', description: 'Open the gsd-turbo live view: lanes, subagents, questions, commits', immediate: true });
    } catch (err) {
      $.ui.log(`turbo-view: /turbo-view not registered: ${firstLine(err?.message ?? err)}`);
    }
    void refresh($, false);
    return next(e);
  });

  on('command.run', { command: 'turbo-view' }, async ($) => {
    if (!root) await locate($);
    if (!root) return { text: 'turbo-view: no .planning/turbo/ in this directory or above it' };
    opened = true;
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true });
    void refresh($, true);
    return {};
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const line = bandLine(view, { error });
    if (!line) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const mine = Text({ children: [line], wrap: 'truncate-end', dimColor: true });
    const theirs = await next(e);
    return theirs ? Box({ flexDirection: 'column', children: [mine, theirs] }) : mine;
  });

  on('ui.render', { component: 'Pane', requestId: 'turbo-view' }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e);
    const children = render(view, { error }).rows.map((row) => {
      if (row.kind === 'text') return Text({ children: [row.text], wrap: 'truncate-end', ...TONES[row.tone] });
      const controls = row.options.map((o) =>
        Button({
          key: o.key,
          label: o.label,
          onPress: () => {
            void send($, row, { option: o.option });
          },
        }),
      );
      if (row.other && field.inputFor === row.id) {
        controls.push(
          Input({
            key: row.inputKey,
            label: row.inputLabel,
            placeholder: row.inputHint,
            value: field.draft,
            submitLabel: row.submitLabel,
            autoFocus: true,
            onInput: (value) => {
              field = { ...field, draft: value, draftFor: row.id };
            },
            onSubmit: (value) => {
              const text = value.trim();
              if (text) {
                // kept if the answer is refused or the question changed meanwhile
                field = { ...field, draft: value, draftFor: row.id };
                void send($, row, { text });
                return;
              }
              field = NO_FIELD;
              $.ui.invalidate('ui.render');
            },
          }),
        );
      } else if (row.other) {
        controls.push(
          Button({
            key: row.otherKey,
            label: row.otherLabel,
            onPress: () => {
              field = openField(field, row.id);
              $.ui.invalidate('ui.render');
            },
          }),
        );
      }
      return Box({ flexDirection: 'column', children: [Text({ children: [row.text], wrap: 'truncate-end' }), Box({ flexDirection: 'row', columnGap: 1, flexWrap: 'wrap', children: controls })] });
    });
    return Box({ flexDirection: 'column', children });
  });
}
```

Append to `.gitignore` (M8: what Claude Code writes into a mod loaded with `--plugin-dir`):

```gitignore
mod/.claude-plugin/types/
mod/tsconfig.json
```

- [ ] **Step 5: Run the CI test to verify it passes**

Run: `node --test test/view-model.test.mjs`
Expected: PASS (15 tests).

- [ ] **Step 6: Validate and run the harness tests (local only)**

Run: `claude --version`
If it prints a version below 2.1.290, or `claude` is missing, report this step's two commands below as "not run: <the reason>" and go on to Step 7.

Run: `claude plugin validate ./mod`
Expected: the last line is `✔ Validation passed` (no warnings), and the output contains
`./register.mjs hooks: session.start, command.run{command=turbo-view}, ui.render{component=AbovePrompt}, ui.render{component=Pane, requestId=turbo-view}`
and `./register.mjs env reads: CLAUDE_CONFIG_DIR, HOME, TURBO_VIEW_BIN, USERPROFILE`.

Run: `claude plugin test mod`
Expected: `12 pass`, `0 fail`.

Never start an interactive `claude --plugin-dir ./mod` session here: it writes type files into `mod/` (M8); the owner's visual check uses a copy (Task 7).

- [ ] **Step 7: Commit**

```bash
git add mod/.claude-plugin/plugin.json mod/hooks/hooks.json mod/hooks/register.mjs mod/hooks/register.test.tsx test/view-model.test.mjs .gitignore
git commit -q -m "feat: turbo-view mod — pane, band above the prompt, toasts and pane answers over turbo-run"
```

---

### Task 4: `turbo-run status --watch`

**Files:**
- Create: `lib/watch.mjs`
- Modify: `bin/turbo-run.mjs` (an import; `readView` before `main`; the `view` case; the top of the `status` case)
- Test: `test/watch.test.mjs`, `test/cli-watch.test.mjs` (create)

**Interfaces:**
- Consumes: `buildView`, `formatView` (S0) and `buildView(…).ui.refreshSeconds` (Task 2); bin's `runtimeConfig`, `loadConfig`, `readJson`, `supPath`, `supAlive`.
- Produces: `CLEAR`, `watch({ frame, write, tty, sleep, now, rounds }) → Promise<void>` in `lib/watch.mjs` (`frame()` returns `{ text, seconds }`); `readView(root)` in bin; the command `turbo-run status --watch`.

- [ ] **Step 1: Write the failing tests**

Create `test/watch.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLEAR, watch } from '../lib/watch.mjs';

const NOW = () => new Date(2026, 0, 1, 10, 59, 58);

test('on a terminal every frame clears the screen, ends with the time and the period, and the next one waits that long', async () => {
  const writes = [];
  const sleeps = [];
  let n = 0;
  await watch({ frame: () => ({ text: `frame ${++n}`, seconds: n === 1 ? 3 : 5 }), write: (s) => writes.push(s), tty: true, sleep: async (ms) => sleeps.push(ms), now: NOW, rounds: 3 });
  assert.deepEqual(writes, [
    `${CLEAR}frame 1\nupdated 10:59:58 · every 3 s · Ctrl+C stops\n`,
    `${CLEAR}frame 2\nupdated 10:59:58 · every 5 s · Ctrl+C stops\n`,
    `${CLEAR}frame 3\nupdated 10:59:58 · every 5 s · Ctrl+C stops\n`,
  ]);
  assert.deepEqual(sleeps, [3000, 5000]);
});

test('into a pipe the frames follow one another without escape codes', async () => {
  const writes = [];
  await watch({ frame: () => ({ text: 'x', seconds: 3 }), write: (s) => writes.push(s), tty: false, sleep: async () => {}, now: NOW, rounds: 2 });
  assert.deepEqual(writes, ['x\nupdated 10:59:58 · every 3 s · Ctrl+C stops\n', '\nx\nupdated 10:59:58 · every 3 s · Ctrl+C stops\n']);
});

test('a frame that throws shows its error on one line and the watch goes on at the last period', async () => {
  const writes = [];
  const sleeps = [];
  const frames = [() => ({ text: 'ok', seconds: 7 }), () => { throw new Error('invalid turbo config /p/config.json: Unexpected end\n  at x'); }, () => ({ text: 'ok again', seconds: 7 })];
  let i = 0;
  await watch({ frame: () => frames[i++](), write: (s) => writes.push(s), tty: false, sleep: async (ms) => sleeps.push(ms), now: NOW, rounds: 3 });
  assert.equal(writes[1], '\nerror: invalid turbo config /p/config.json: Unexpected end at x\nupdated 10:59:58 · every 7 s · Ctrl+C stops\n');
  assert.deepEqual(sleeps, [7000, 7000]);
  assert.match(writes[2], /^\nok again\n/);
});
```

Create `test/cli-watch.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');

// Runs turbo-run status --watch until its output holds n frames, then stops it.
function watchFrames(cwd, n) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'status', '--watch'], { cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir('home') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const guard = setTimeout(() => { child.kill(); reject(new Error(`no ${n} frames in 15 s: ${JSON.stringify(out)}`)); }, 15000);
    child.stdout.on('data', (d) => {
      out += d;
      if ((out.match(/^updated /gm) || []).length >= n) {
        clearTimeout(guard);
        child.kill();
        resolve(out);
      }
    });
    child.on('error', reject);
  });
}

test('turbo-run status --watch redraws the view every view.refresh_seconds until stopped; a pipe gets no escape codes', async () => {
  const root = tmpGitRepo();
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify({ view: { refresh_seconds: 1 } }));
  const out = await watchFrames(root, 2);
  assert.equal((out.match(/^supervisor: not running \(never started\)$/gm) || []).length, 2);
  assert.match(out, /^updated \d\d:\d\d:\d\d · every 1 s · Ctrl\+C stops$/m);
  assert.equal(out.includes('\x1b['), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/watch.test.mjs test/cli-watch.test.mjs`
Expected: FAIL. `test/watch.test.mjs` fails with `ERR_MODULE_NOT_FOUND` for `lib/watch.mjs`. The CLI test fails with `no 2 frames in 15 s`: without `--watch`, `status` prints once and exits.

- [ ] **Step 3: Implement**

Create `lib/watch.mjs`:

```js
import { setTimeout as delay } from 'node:timers/promises';

// Clears a terminal and puts the cursor home before each frame.
export const CLEAR = '\x1b[2J\x1b[H';

// Redraws frame() every few seconds until the process is stopped (Ctrl+C): turbo-run status --watch, the live view
// for terminals without mods (spec §7). frame() returns { text, seconds }; when it throws, its message becomes the
// frame and the loop keeps the last period. A terminal is cleared before each frame; a pipe gets them one by one.
export async function watch({ frame, write, tty, sleep = (ms) => delay(ms), now = () => new Date(), rounds = Infinity }) {
  let seconds = 3;
  for (let i = 0; i < rounds; i++) {
    let text;
    try {
      ({ text, seconds } = frame());
    } catch (e) {
      text = `error: ${String(e?.message ?? e).replace(/\s*\r?\n\s*/g, ' ')}`;
    }
    write(`${tty ? CLEAR : i ? '\n' : ''}${text}\nupdated ${now().toTimeString().slice(0, 8)} · every ${seconds} s · Ctrl+C stops\n`);
    if (i + 1 < rounds) await sleep(seconds * 1000);
  }
}
```

In `bin/turbo-run.mjs`:

1. Right after the line `import { buildView, formatView } from '../lib/view.mjs';` add:

```js
import { watch } from '../lib/watch.mjs';
```

2. Right before the line `async function main() {` add:

```js
// The view of the project, read fresh: what view prints and status --watch redraws.
function readView(root) {
  const config = runtimeConfig(loadConfig(root));
  const sup = readJson(supPath(root), null);
  return buildView({ root, sup, running: supAlive(sup, config.poll_seconds), config });
}

```

3. In `case 'view':`, replace these three lines

```js
      const config = runtimeConfig(loadConfig(root));
      const sup = readJson(supPath(root), null);
      const view = buildView({ root, sup, running: supAlive(sup, config.poll_seconds), config });
```

with

```js
      const view = readView(root);
```

4. In `case 'status':`, right after its first line `      if (!root) die('no .planning directory found');` add:

```js
      if (args.includes('--watch')) {
        // the live view without the mod: view's text form, redrawn every view.refresh_seconds until Ctrl+C
        await watch({
          frame: () => {
            const view = readView(root);
            return { text: formatView(view), seconds: view.ui.refreshSeconds };
          },
          write: (s) => process.stdout.write(s),
          tty: Boolean(process.stdout.isTTY),
        });
        return 0;
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/watch.test.mjs test/cli-watch.test.mjs test/cli-view.test.mjs`
Expected: PASS (3 + 1 + 3 tests; the `view` command is unchanged in behaviour).

- [ ] **Step 5: Commit**

```bash
git add lib/watch.mjs bin/turbo-run.mjs test/watch.test.mjs test/cli-watch.test.mjs
git commit -q -m "feat: turbo-run status --watch redraws the view every view.refresh_seconds for terminals without mods"
```

---

### Task 5: `doctor` reports the mod

**Files:**
- Modify: `lib/doctor.mjs` (constants, two exports, the `claude --version` capture, a check after the stage-2 loop)
- Test: `test/doctor.test.mjs` (the import line; append two tests)

**Interfaces:**
- Consumes: `v`, `gte`, `CLAUDE_TIMEOUT_MS`, `resolveBin` already in `lib/doctor.mjs`.
- Produces (Task 6 imports them): `MIN_CLAUDE_MODS = '2.1.290'`; `supportsMods(text) → boolean`; `claudeVersionText({ claudeBin, exec }) → string | null`; a `doctor` check `{ name: 'turbo-view-mod', ok, detail }` that is in neither `hard` nor `stage2`, so it never changes the mode.

- [ ] **Step 1: Write the failing tests**

In `test/doctor.test.mjs`, replace `import { doctor } from '../lib/doctor.mjs';` with:

```js
import { doctor, supportsMods } from '../lib/doctor.mjs';
```

Append:

```js
test('supportsMods reads the version out of claude --version: 2.1.290 and newer load mods', () => {
  for (const [text, ok] of [['2.1.290 (Claude Code)', true], ['2.1.296', true], ['2.2.0', true], ['3.0.0 (Claude Code)', true], ['2.1.289 (Claude Code)', false], ['', false], [null, false], ['garbage', false]]) assert.equal(supportsMods(text), ok, String(text));
});

test('turbo-view-mod: the installed mod passes, a missing one says how to install it, an older Claude Code points to status --watch; never part of the mode', () => {
  const e = env();
  const check = (version) => {
    const r = doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec: execOk(version), claudeBin: BIN });
    assert.equal(r.mode, 'full', JSON.stringify(r.checks));
    const c = r.checks.find((x) => x.name === 'turbo-view-mod');
    return [c.ok, c.detail];
  };
  const hooks = path.join(e.home, 'skills', 'turbo-view', 'hooks', 'hooks.json');
  assert.deepEqual(check('2.1.291'), [false, `${hooks} missing (run node install.mjs)`]);
  fs.mkdirSync(path.dirname(hooks), { recursive: true });
  fs.writeFileSync(hooks, '{ "modules": ["./register.mjs"] }');
  assert.deepEqual(check('2.1.291'), [true, '']);
  assert.deepEqual(check('2.1.250'), [true, 'Claude Code 2.1.250 (Claude Code) has no mods (need >=2.1.290): turbo-run status --watch shows the run']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/doctor.test.mjs`
Expected: FAIL with `does not provide an export named 'supportsMods'`.

- [ ] **Step 3: Implement**

In `lib/doctor.mjs`:

1. Right after the line `const MIN_CLAUDE = '2.1.234';` add:

```js
// the first Claude Code that loads mods; the turbo-view live view (spec §7) needs it
export const MIN_CLAUDE_MODS = '2.1.290';
```

2. Right before the line that starts with `const oneLine = (s) =>` add:

```js
// Whether a `claude --version` output names a Claude Code that loads mods; false when it names no version.
export const supportsMods = (text) => v(text).length === 3 && gte(v(text), v(MIN_CLAUDE_MODS));

// `claude --version` output, trimmed; null when claude cannot be run.
export function claudeVersionText({ claudeBin = resolveBin(), exec = execFileSync } = {}) {
  if (claudeBin.unsupported) return null;
  try {
    return String(exec(claudeBin.cmd, [...(claudeBin.prefix || []), '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, timeout: CLAUDE_TIMEOUT_MS })).trim() || null;
  } catch {
    return null;
  }
}

```

3. In `doctor`, right after the line `  add('node', gte(v(process.versions.node), [20, 0, 0]), process.versions.node);` add:

```js
  let claudeOut = null; // claude --version output, for the turbo-view-mod check
```

4. Right after the line `      const out = claude(['--version']);` add:

```js
      claudeOut = out.trim();
```

5. Right before the block that starts with these three lines (the `gsd-render-hooks` check):

```js
  if (core && root && initOk) {
    try {
      const listed
```

add:

```js
  // Stage 3: the turbo-view mod (spec §7) loads on Claude Code >= 2.1.290 only; this check never changes the mode.
  const modFile = path.join(home, 'skills', 'turbo-view', 'hooks', 'hooks.json');
  if (!supportsMods(claudeOut)) add('turbo-view-mod', true, `${claudeOut ? `Claude Code ${claudeOut} has no mods (need >=${MIN_CLAUDE_MODS})` : 'Claude Code version unknown'}: turbo-run status --watch shows the run`);
  else if (fs.existsSync(modFile)) add('turbo-view-mod', true);
  else add('turbo-view-mod', false, `${modFile} missing (run node install.mjs)`);
```

(`home` is the `claudeHome(env)` the stage-2 skill and agent loop right above uses.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/doctor.test.mjs`
Expected: PASS — every existing doctor test unchanged, plus the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add lib/doctor.mjs test/doctor.test.mjs
git commit -q -m "feat: doctor reports the turbo-view mod; Claude Code below 2.1.290 points to status --watch"
```

---

### Task 6: `install.mjs` installs the mod on Claude Code ≥ 2.1.290

**Files:**
- Modify: `install.mjs` (an import; `MOD_DIR`, `modSkipped`; `plan`; `install`; new `modNote`; `main`)
- Modify: `package.json` (`files`)
- Test: `test/install-mod.test.mjs` (create)

**Interfaces:**
- Consumes: `MIN_CLAUDE_MODS`, `claudeVersionText`, `supportsMods` (Task 5); the mod files (Tasks 1, 3).
- Produces: `install({ repoDir, claudeHome, dryRun, claudeVersion = null })` (mod files under `skills/turbo-view/` only when `supportsMods(claudeVersion)`); `modNote(claudeVersion) → string | null`; `node install.mjs` prints `modNote` when it leaves the mod out. `uninstall` is unchanged: the mod files are manifest entries under `skills/turbo-*`.

- [ ] **Step 1: Write the failing tests**

Create `test/install-mod.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { install, modNote, uninstall } from '../install.mjs';

const MOD_FILES = ['skills/turbo-view/.claude-plugin/plugin.json', 'skills/turbo-view/hooks/hooks.json', 'skills/turbo-view/hooks/register.mjs', 'skills/turbo-view/hooks/view-model.mjs'];
const modFiles = (m) => m.files.filter((f) => f.startsWith('skills/turbo-view/')).sort();

test('on Claude Code 2.1.290 or newer the turbo-view mod goes to skills/turbo-view without its tests; uninstall removes it', () => {
  const home = tmpDir('home');
  const m = install({ repoDir: path.resolve('.'), claudeHome: home, claudeVersion: '2.1.296 (Claude Code)' });
  assert.deepEqual(modFiles(m), MOD_FILES);
  for (const f of MOD_FILES) assert.ok(fs.existsSync(path.join(home, f)), f);
  assert.equal(fs.existsSync(path.join(home, 'skills', 'turbo-view', 'hooks', 'register.test.tsx')), false);
  assert.equal(uninstall({ claudeHome: home }), m.files.length);
  assert.equal(fs.existsSync(path.join(home, 'skills', 'turbo-view')), false);
});

test('an older or unknown Claude Code gets no mod, and install says why', () => {
  for (const claudeVersion of ['2.1.289 (Claude Code)', null, 'garbage']) {
    const m = install({ repoDir: path.resolve('.'), claudeHome: tmpDir('home'), dryRun: true, claudeVersion });
    assert.deepEqual(modFiles(m), [], String(claudeVersion));
  }
  assert.equal(modNote('2.1.290 (Claude Code)'), null);
  assert.equal(modNote('2.1.289 (Claude Code)'), 'turbo-view mod not installed: Claude Code 2.1.289 (Claude Code) is older than 2.1.290; turbo-run status --watch shows the run instead');
  assert.equal(modNote(null), 'turbo-view mod not installed: the Claude Code version is unknown (claude --version failed); turbo-run status --watch shows the run instead');
});

test('files Claude Code writes into a mod loaded with --plugin-dir, and harness tests, are never installed', () => {
  const repo = tmpDir('repo');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/types/claude-code/index.d.ts', 'tsconfig.json', 'hooks/hooks.json', 'hooks/register.mjs', 'hooks/register.test.tsx', 'hooks/x.test.ts']) {
    fs.mkdirSync(path.dirname(path.join(repo, 'mod', f)), { recursive: true });
    fs.writeFileSync(path.join(repo, 'mod', f), 'x');
  }
  const m = install({ repoDir: repo, claudeHome: tmpDir('home'), dryRun: true, claudeVersion: '2.2.0' });
  assert.deepEqual(modFiles(m), ['skills/turbo-view/.claude-plugin/plugin.json', 'skills/turbo-view/hooks/hooks.json', 'skills/turbo-view/hooks/register.mjs']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/install-mod.test.mjs`
Expected: FAIL with `does not provide an export named 'modNote'`.

- [ ] **Step 3: Implement**

In `install.mjs`:

1. Right after the line `import { writeJsonAtomic } from './lib/fsx.mjs';` add:

```js
import { MIN_CLAUDE_MODS, claudeVersionText, supportsMods } from './lib/doctor.mjs';
```

2. Right after the line `const MANIFEST = 'turbo/install-manifest.json';` add:

```js
// The turbo-view mod (spec §7) goes where Claude Code loads it by itself, as turbo-view@skills-dir.
const MOD_DIR = path.join('skills', 'turbo-view');
// Never copied from mod/: its harness tests, and what Claude Code writes into a mod loaded with --plugin-dir.
const modSkipped = (rel) => /\.test\.[cm]?[jt]sx?$/.test(rel) || /^\.claude-plugin\/types(\/|$)/.test(rel) || rel === 'tsconfig.json';
```

3. Replace `function plan(repoDir) {` with:

```js
function plan(repoDir, { mod = false } = {}) {
```

4. In `plan`, replace the two lines

```js
  for (const f of walk(path.join(repoDir, 'agents'))) if (path.basename(f).startsWith('turbo-')) pairs.push([f, path.join('agents', path.basename(f))]);
  return pairs;
```

with

```js
  for (const f of walk(path.join(repoDir, 'agents'))) if (path.basename(f).startsWith('turbo-')) pairs.push([f, path.join('agents', path.basename(f))]);
  if (mod) {
    for (const f of walk(path.join(repoDir, 'mod'))) {
      const rel = path.relative(path.join(repoDir, 'mod'), f).split(path.sep).join('/');
      if (!modSkipped(rel)) pairs.push([f, path.join(MOD_DIR, rel)]);
    }
  }
  return pairs;
```

5. Replace the first three lines of `install`

```js
export function install({ repoDir = REPO, claudeHome = defaultHome(), dryRun = false } = {}) {
  const home = path.resolve(claudeHome);
  const pairs = plan(repoDir);
```

with

```js
// claudeVersion: `claude --version` output; the turbo-view mod goes in only when it names 2.1.290 or newer.
export function install({ repoDir = REPO, claudeHome = defaultHome(), dryRun = false, claudeVersion = null } = {}) {
  const home = path.resolve(claudeHome);
  const pairs = plan(repoDir, { mod: supportsMods(claudeVersion) });
```

6. Right before the line `function main(args) {` add:

```js
// What install says when it leaves the mod out; null when the mod goes in.
export function modNote(claudeVersion) {
  if (supportsMods(claudeVersion)) return null;
  const why = claudeVersion ? `Claude Code ${claudeVersion} is older than ${MIN_CLAUDE_MODS}` : 'the Claude Code version is unknown (claude --version failed)';
  return `turbo-view mod not installed: ${why}; turbo-run status --watch shows the run instead`;
}

```

7. In `main`, replace the line `  const m = install({ dryRun });` with:

```js
  const claudeVersion = claudeVersionText();
  const m = install({ dryRun, claudeVersion });
```

and right after the next line (the `process.stdout.write` that prints `would install` / `installed … files into …`) add:

```js
  const note = modNote(claudeVersion);
  if (note) process.stdout.write(`${note}\n`);
```

In `package.json`, replace the `files` line with:

```json
  "files": ["bin", "lib", "mod", "skills", "agents", "install.mjs", "README.md", "LICENSE"]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/install-mod.test.mjs test/install.test.mjs test/install-stage2.test.mjs`
Expected: PASS (3 new tests; the existing install tests pass unchanged, since `install()` without `claudeVersion` installs no mod).

- [ ] **Step 5: Commit**

```bash
git add install.mjs package.json test/install-mod.test.mjs
git commit -q -m "feat: install puts the turbo-view mod in skills/turbo-view on Claude Code 2.1.290 or newer"
```

---

### Task 7: The owner's visual check — `scripts/turbo-view-demo.mjs`

**Files:**
- Create: `scripts/turbo-view-demo.mjs`
- Test: `test/turbo-view-demo.test.mjs` (create)

**Interfaces:**
- Consumes: `bandLine`, `render` (Task 1), the mod files (Task 3), `TURBO_VIEW_BIN` (Task 3).
- Produces:
  - `demoView({ tick, lang, startedAt, now, answered }) → view` (a v1 view; read 4 adds `q2`, 7 turns CI red, 10 stops the lane for the owner, 13 marks it done; repeats every 16 reads);
  - `fakeTurboRun(args, cwd, now) → { code, stdout, stderr }` for `view --json` and `answer <phase> <id> (--option <k> | --text <t>) --by <by>`, replying as S1's arbiter does, one line on stdout (exit 0 `answered <id>: <answer>, <by>, <at>`; 3 `already answered: …`, checked before `--rev`; 4 `changed: …` when `--rev` is not the question's `rev` (always 1 in the demo); 1 `refused: …`; 2 usage); state in `<cwd>/.planning/turbo/demo-state.json`, answers appended to `demo-answers.jsonl` there;
  - `setupDemo({ dir, lang, repoDir, now }) → { project, mod }`; `instructions({ dir, project, mod, lang, self }) → string`;
  - the command for the owner: `node scripts/turbo-view-demo.mjs [--lang en|ru] [--dir <folder>]`.

- [ ] **Step 1: Write the failing tests**

Create `test/turbo-view-demo.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { fakeTurboRun, instructions, setupDemo } from '../scripts/turbo-view-demo.mjs';
import { bandLine, parseView, render, toastsFor } from '../mod/hooks/view-model.mjs';

const DEMO = path.resolve('scripts/turbo-view-demo.mjs');

test('the demo builds a project with .planning/turbo/ and a test-free copy of the mod, and prints the command that opens them', () => {
  const dir = tmpDir('demo');
  const { project, mod } = setupDemo({ dir, lang: 'ru' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, '.planning', 'turbo', 'config.json'), 'utf8')), { lang: 'ru', view: { refresh_seconds: 3 } });
  assert.ok(fs.existsSync(path.join(mod, 'hooks', 'register.mjs')));
  assert.ok(fs.existsSync(path.join(mod, '.claude-plugin', 'plugin.json')));
  assert.equal(fs.existsSync(path.join(mod, 'hooks', 'register.test.tsx')), false);
  const text = instructions({ dir, project, mod, lang: 'ru' });
  assert.ok(text.includes(`cd "${project}" && TURBO_VIEW_BIN="${DEMO}" claude --plugin-dir "${mod}"`), text);
  assert.ok(text.includes('$env:TURBO_VIEW_BIN'));
  assert.ok(text.includes('"turbo · фазы 32–34 · супервизор работает"'), text);
  assert.ok(text.includes('[Да, по гейту] [Стоп] [Другое…]'), text);
  assert.ok(text.includes('"turbo p32 execute · 3 агента · ? 1 вопрос · CI ✓"'), text);
});

test('the scripted run, read the way the mod reads it, raises the four toasts in order and keeps the band current', () => {
  const { project } = setupDemo({ dir: tmpDir('demo'), now: 0 });
  let prev = null;
  const toasts = [];
  const bands = [];
  for (let read = 1; read <= 13; read++) {
    const r = fakeTurboRun(['view', '--json'], project, read * 3000);
    assert.equal(r.code, 0);
    const v = parseView(r.stdout);
    assert.ok(render(v).rows.length > 3);
    for (const t of toastsFor(prev, v)) toasts.push(`${read}: ${t}`);
    bands.push(bandLine(v));
    prev = v;
  }
  assert.deepEqual(toasts, ['4: new question: 32-10 Task 1 — Does the export page look right?', '7: CI red: phase 32, b2c3d4e', '10: phase 32 stopped: needs-owner — checkpoint 32-09 Task 3: deploy needs your answer', '13: phase 32 done']);
  assert.equal(bands[0], 'turbo p32 execute · 3 agents · ? 1 question · CI ✓');
  assert.equal(bands[12], 'turbo p32 all steps done (done) · ? 2 questions · CI ✗');
});

test('answers from the pane are recorded once; the answered question leaves the next view; the real script speaks the same (Review Focus 3)', () => {
  const { project } = setupDemo({ dir: tmpDir('demo'), now: 0 });
  const run = (...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [DEMO, ...args], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      return { code: e.status, out: e.stdout || e.stderr };
    }
  };
  assert.deepEqual(parseView(run('view', '--json').out).questions.map((q) => [q.id, q.rev]), [['q1', 1]]);
  assert.deepEqual(run('answer', '32', 'q1', '--option', '2', '--by', 'pane', '--rev', '2'), { code: 4, out: 'changed: question q1 changed since it was shown (now rev 1, shown rev 2); read it again and answer the new version\n' });
  assert.deepEqual(run('answer', '32', 'q9', '--option', '1', '--by', 'pane', '--rev', '1'), { code: 1, out: 'refused: no question q9\n' });
  const first = run('answer', '32', 'q1', '--option', '2', '--by', 'pane', '--rev', '1');
  assert.equal(first.code, 0);
  assert.match(first.out, /^answered q1: Stop, pane, \d{4}-\d\d-\d\dT[\d:.]+Z\n$/);
  const again = run('answer', '32', 'q1', '--text', 'x', '--by', 'pane', '--rev', '2');
  assert.equal(again.code, 3, 'already answered is checked before the rev');
  assert.match(again.out, /^already answered: Stop, pane, \d{4}-/);
  assert.deepEqual(parseView(run('view', '--json').out).questions, []);
  const lines = fs.readFileSync(path.join(project, '.planning', 'turbo', 'demo-answers.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.id, l.option, l.text, l.by]), [['q1', '2', null, 'pane']]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/turbo-view-demo.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/turbo-view-demo.mjs`.

- [ ] **Step 3: Create `scripts/turbo-view-demo.mjs`**

```js
#!/usr/bin/env node
// The turbo-view visual check (spec §9.4: the pane can only be seen in a real terminal). Without arguments it builds
// a demo project and a copy of the mod in a new temporary directory and prints the command that opens them in
// Claude Code. The mod then runs this same file as its turbo-run (TURBO_VIEW_BIN): `view --json` plays a scripted
// run that changes every few reads, and `answer …` records what the pane sends. Nothing outside that directory is
// written; the demo project's state lives in its .planning/turbo/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bandLine, render } from '../mod/hooks/view-model.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.dirname(path.dirname(SELF));
const STATE = 'demo-state.json';
const ANSWERS = 'demo-answers.jsonl';
const CYCLE = 16;
const MIN = 60000;

const TEXT = {
  en: { q1: 'Deploy after green CI?', yes: 'Yes, by the gate', stop: 'Stop', q2: 'Does the export page look right?', accept: 'Accept if the checks pass', show: 'Stop and show me', reason: 'checkpoint 32-09 Task 3: deploy needs your answer' },
  ru: { q1: 'Деплой после зелёного CI?', yes: 'Да, по гейту', stop: 'Стоп', q2: 'Страница экспорта выглядит верно?', accept: 'Принять, если проверки прошли', show: 'Остановиться и показать мне', reason: 'чекпоинт 32-09 Task 3: для деплоя нужен твой ответ' },
};

// The view a scripted run shows at its tick-th read (1-based, repeating every 16 reads): the second question
// appears at read 4, CI turns red at 7, the lane stops for the owner at 10 and is done at 13.
export function demoView({ tick, lang = 'en', startedAt, now, answered = {} }) {
  const t = TEXT[lang === 'ru' ? 'ru' : 'en'];
  const s = ((tick - 1) % CYCLE) + 1;
  const iso = (ms) => new Date(ms).toISOString();
  const status = s >= 13 ? 'done' : s >= 10 ? 'needs-owner' : 'running';
  const agent = (id, type, plan, task, state, action, fromMs, tokens) => ({ agentId: id, type, description: '', plan, task, model: 'opus', worktreeBranch: null, state, action, startedAt: iso(fromMs), lastAt: iso(state === 'quiet' ? now - 16 * MIN : now), elapsedMs: (state === 'quiet' ? now - 16 * MIN : now) - fromMs, tokens, sessionId: 'demo', transcript: 'demo' });
  const questions = [
    { id: 'q1', phase: '32', plan: '32-09', task: '3', kind: 'decision', header: 'Deploy', question: t.q1, options: [{ label: t.yes }, { label: t.stop }], allowOther: true, state: 'open', rev: 1 },
    ...(s >= 4 ? [{ id: 'q2', phase: '32', plan: '32-10', task: '1', kind: 'human-verify', header: 'Check', question: t.q2, options: [{ label: t.accept }, { label: t.show }], allowOther: true, state: 'open', rev: 1 }] : []),
  ].filter((q) => !answered[q.id]);
  return {
    v: 1,
    at: iso(now),
    supervisor: { running: true, pid: 4242, finished: false, halted: false, failingSince: null, updatedAt: iso(now) },
    range: { from: '32', to: '34' },
    lanes: [{
      phase: '32', step: status === 'done' ? null : 'execute', done: [], notes: {}, status, reason: status === 'needs-owner' ? t.reason : '', sessionId: 'demo0001', mode: 'full',
      launchedAt: iso(startedAt - 72 * MIN), elapsedMs: now - startedAt + 72 * MIN, transcript: null, lastAt: iso(now), quiet: false,
      agents: status === 'running' ? [
        agent('a1', 'gsd-executor', '32-07', '2', 'running', { tool: 'Edit', detail: 'lib/export.mjs' }, startedAt - 6 * MIN, 120000 + tick * 1500),
        agent('a2', 'gsd-executor', '32-08', null, 'running', { tool: 'Bash', detail: 'node --test test/export.test.mjs' }, startedAt - 2 * MIN, 41000 + tick * 900),
        agent('a3', 'gsd-verifier', null, null, 'quiet', { tool: 'Bash', detail: 'npm test' }, startedAt - 30 * MIN, 88000),
        agent('a4', 'gsd-executor', '32-06', null, 'completed', { tool: 'Bash', detail: 'git commit' }, startedAt - 40 * MIN, 150000),
      ] : [agent('a4', 'gsd-executor', '32-06', null, 'completed', { tool: 'Bash', detail: 'git commit' }, startedAt - 40 * MIN, 150000)],
      push: { outcome: 'pushed', sha: s >= 7 ? 'b2c3d4e' : 'a1b2c3d', at: iso(now), ci: s >= 7 ? 'red' : 'green' },
    }],
    questions,
    commits: [{ sha: 'b2c3d4e', subject: 'feat: export page lists every chat' }, { sha: 'a1b2c3d', subject: 'fix: lane record keeps the reason' }, { sha: '9f8e7d6', subject: 'test: export of an empty chat' }],
    ui: { lang: lang === 'ru' ? 'ru' : 'en', refreshSeconds: 3 },
  };
}

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// The fake turbo-run, called by the mod in the demo project: view --json and answer. Returns { code, stdout, stderr }.
export function fakeTurboRun(args, cwd, now = Date.now()) {
  const dir = path.join(cwd, '.planning', 'turbo');
  const file = path.join(dir, STATE);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (args[0] === 'view') {
    state.tick += 1;
    fs.writeFileSync(file, JSON.stringify(state));
    return { code: 0, stdout: JSON.stringify(demoView({ tick: state.tick, lang: state.lang, startedAt: state.startedAt, now, answered: state.answered })), stderr: '' };
  }
  // the replies of S1's arbiter (docs/plans/2026-10-11-stage-3-s1-owner-channel.md, Contracts), one line on stdout:
  // exit 0 answered, 3 already answered (checked before --rev), 4 changed since it was shown, 1 refused, 2 usage
  if (args[0] === 'answer') {
    const [, , id] = args;
    const option = flag(args, '--option');
    const text = flag(args, '--text');
    const by = flag(args, '--by') ?? 'session';
    const q = demoView({ tick: state.tick, lang: state.lang, startedAt: state.startedAt, now }).questions.find((x) => x.id === id);
    if (!q) return { code: 1, stdout: `refused: no question ${id}\n`, stderr: '' };
    const prior = state.answered[id];
    if (prior) return { code: 3, stdout: `already answered: ${prior.answer}, ${prior.by}, ${prior.at}\n`, stderr: '' };
    const shown = flag(args, '--rev');
    if (shown !== undefined && Number(shown) !== q.rev) return { code: 4, stdout: `changed: question ${id} changed since it was shown (now rev ${q.rev}, shown rev ${shown}); read it again and answer the new version\n`, stderr: '' };
    const answer = text ?? q.options[Number(option) - 1]?.label;
    if (!answer) return { code: 2, stdout: `usage: question ${id} has no option ${option}\n`, stderr: '' };
    const at = new Date(now).toISOString();
    state.answered[id] = { answer, by, at };
    fs.writeFileSync(file, JSON.stringify(state));
    fs.appendFileSync(path.join(dir, ANSWERS), `${JSON.stringify({ id, option: option ?? null, text: text ?? null, by, at })}\n`);
    return { code: 0, stdout: `answered ${id}: ${answer}, ${by}, ${at}\n`, stderr: '' };
  }
  return { code: 2, stdout: '', stderr: 'the demo turbo-run knows view --json and answer only\n' };
}

// The demo directory: project/.planning/turbo/ with the scripted run's state, and turbo-view/, a copy of the mod
// without its tests (Claude Code writes type files into a mod loaded with --plugin-dir; they land there).
export function setupDemo({ dir, lang = 'en', repoDir = REPO, now = Date.now() }) {
  const project = path.join(dir, 'project');
  fs.mkdirSync(path.join(project, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(project, '.planning', 'turbo', 'config.json'), `${JSON.stringify({ lang, view: { refresh_seconds: 3 } }, null, 2)}\n`);
  fs.writeFileSync(path.join(project, '.planning', 'turbo', STATE), JSON.stringify({ tick: 0, lang, startedAt: now, answered: {} }));
  const mod = path.join(dir, 'turbo-view');
  fs.cpSync(path.join(repoDir, 'mod'), mod, { recursive: true, filter: (src) => !/\.test\.[cm]?[jt]sx?$/.test(src) });
  return { project, mod };
}

// What the owner runs and checks; the expected pane and band texts come from the mod's own view model.
export function instructions({ dir, project, mod, lang = 'en', self = SELF }) {
  const win = (p) => p.replace(/\//g, '\\');
  const first = demoView({ tick: 1, lang, startedAt: 0, now: 0 });
  const model = render(first);
  const q = model.rows.find((r) => r.kind === 'question');
  const buttons = `[${[...q.options.map((o) => o.label), q.otherLabel].join('] [')}]`;
  return [
    `turbo-view visual check — demo in ${dir}`,
    '',
    'Open it in Claude Code (2.1.290 or newer), in a terminal at least 144 columns wide:',
    `  bash / Git Bash:  cd "${project}" && TURBO_VIEW_BIN="${self}" claude --plugin-dir "${mod}"`,
    `  PowerShell:       cd "${win(project)}"; $env:TURBO_VIEW_BIN = "${win(self)}"; claude --plugin-dir "${win(mod)}"`,
    'Accept the trust prompt for the demo folder. Then check:',
    `  1. Within 3 s the pane opens by itself on the right: "${model.rows[0].text}", lane p32 execute, two running`,
    '     agents whose time and tokens grow every 3 s, a quiet gsd-verifier row with ⚠, one finished row,',
    `     one question with the buttons ${buttons}, and three commits.`,
    `  2. The band above the prompt reads "${bandLine(first)}".`,
    '  3. Over the next 40 s, toasts: a new question (read 4), CI red (read 7; the band then shows CI ✗), phase 32',
    '     stopped: needs-owner (read 10), phase 32 done (read 13). The script repeats every 16 reads.',
    `  4. Focus the pane (click it, or Ctrl+X then Tab), Tab to [${q.options[1].label}], press Enter: a toast`,
    `     "answered q1: ${q.options[1].label}, pane, <time>", and the question leaves the pane within 3 s.`,
    `  5. On the second question press [${q.otherLabel}] and type, slowly over a few seconds: проверка 👍 — the text stays`,
    '     while the pane redraws every 3 s. Then Enter: a toast with that text.',
    `     Both answers are in ${path.join(project, '.planning', 'turbo', ANSWERS)}.`,
    '  6. Close the pane (Ctrl+X then X): it does not come back by itself; /turbo-view opens it again.',
    '  7. In a new session in a terminal narrower than 110 columns the pane does not open by itself; /turbo-view opens it.',
    `For the ${lang === 'ru' ? 'English' : 'Russian'} texts run this script again with --lang ${lang === 'ru' ? 'en' : 'ru'}. When done, exit Claude Code and delete the demo folder.`,
  ].join('\n');
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF);
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  if (args[0] === 'view' || args[0] === 'answer') {
    const r = fakeTurboRun(args, process.cwd());
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exitCode = r.code;
  } else {
    const lang = flag(args, '--lang') === 'ru' ? 'ru' : 'en';
    const dir = flag(args, '--dir') ? path.resolve(flag(args, '--dir')) : fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-view-demo-'));
    process.stdout.write(`${instructions({ dir, lang, ...setupDemo({ dir, lang }) })}\n`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/turbo-view-demo.test.mjs`
Expected: PASS (3 tests).

Run: `node scripts/turbo-view-demo.mjs`
Expected: the instructions, starting with `turbo-view visual check — demo in <a new turbo-view-demo-… folder in the system temp directory>` and naming the `cd … && TURBO_VIEW_BIN=… claude --plugin-dir …` command. Do not run that command: opening it is the owner's step. The demo folder holds only the demo project and the mod copy.

- [ ] **Step 5: Commit**

```bash
git add scripts/turbo-view-demo.mjs test/turbo-view-demo.test.mjs
git commit -q -m "feat: scripts/turbo-view-demo.mjs — a scripted run that lets the owner check the turbo-view pane by eye"
```

---

### Task 8: README — requirements, install, live view, `status --watch`, config

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the behaviour of Tasks 2–7; S0's README edits (the `sh` line with `view [--json]`, the `stall_minutes` row).
- Produces: documentation only.

- [ ] **Step 1: Requirements and Install**

In `## Requirements`, right after the line that starts with `- Claude Code ≥ 2.1.234`, add:

```markdown
- For the live view in Claude Code (the `turbo-view` mod): Claude Code ≥ 2.1.290. With an older version the installer leaves the mod out, and `turbo-run status --watch` shows the run in any terminal.
```

In `## Install`, right after the list item that starts with `` - `agents/turbo-uat.md`: ``, add:

```markdown
- `skills/turbo-view/`: the `turbo-view` mod, the live view in your Claude Code sessions (see [Live view](#live-view)); only with Claude Code ≥ 2.1.290, otherwise the installer prints `turbo-view mod not installed: …`.
```

In `## Uninstall`, replace `Only files listed in the install manifest are removed.` with `Only files listed in the install manifest are removed, the turbo-view mod included.`

- [ ] **Step 2: Use**

In `## Use`, in the `sh` line that starts with `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" doctor   # also:`, change `status, view [--json],` to `status [--watch], view [--json],`.

Right before the line `## What happens`, add:

````markdown
### Live view

With Claude Code 2.1.290 or newer, the installer adds the `turbo-view` mod to `skills/turbo-view/` in your config directory. Claude Code loads it in every session as `turbo-view@skills-dir`, without a marketplace or a settings change. Outside a project with `.planning/turbo/` it does nothing. In such a project it runs `turbo-run view --json` every `view.refresh_seconds` seconds (every 15 seconds in a background session no terminal is attached to; never in `claude -p` runs) and shows:

- a band above the prompt, for example `turbo p32 execute · 3 agents · ? 2 questions · CI ✓`;
- a pane with the supervisor and its range, each lane with its `/turbo-phase` step and status, the lane's subagents (type, plan, current action, time, context tokens; `quiet` with ⚠), the open owner questions with one button per option and **Other…** for your own answer, and the last commits. The pane opens by itself while the supervisor runs or a question is open, in a terminal at least 144 columns wide (110 once you have opened it); `/turbo-view` opens it at any width;
- toasts for a new question, a finished phase, red CI, a lane that stopped (`needs-owner`, `failed`) and a halted supervisor.

A button runs `turbo-run answer <phase> <id> --option <n> --by pane --rev <r>`, where `<r>` is the question's revision as the pane showed it; **Other…** opens a field whose text goes as `--text <your answer>`. The first answer from any channel counts, and the command's reply shows as a toast. If the question changed since the pane showed it, nothing is recorded: the toast says so, the pane reads the run again, and **Other…** brings back what you typed. Texts follow `lang`. The mod runs nothing but these two `turbo-run` commands and writes no files.

To turn the mod off, set `"turbo-view@skills-dir": false` under `enabledPlugins` in your Claude Code settings. Without the mod, `turbo-run status --watch` shows what `turbo-run view` shows, in any terminal, and redraws it every `view.refresh_seconds` seconds until you press Ctrl+C.

To see the mod without a real run, run `node scripts/turbo-view-demo.mjs` (or `node scripts/turbo-view-demo.mjs --lang ru`) in the gsd-turbo clone. It builds a demo project with a scripted run in a new temporary folder and prints the command that opens it in Claude Code, and what to check.

````

- [ ] **Step 3: Config**

In the `## Config` table, replace the `lang` row with:

```markdown
| `lang` | `"en"` | Language of notifications, of the UAT owner request and of the live view: `en` or `ru` (`init --lang`). |
```

and right after the `stall_minutes` row (S0) add:

```markdown
| `view.refresh_seconds` | `3` | Seconds between two reads of the live view: the turbo-view mod while a terminal is attached (every 15 s otherwise) and `turbo-run status --watch`. A whole number from 1 to 60; anything else counts as 3. |
```

- [ ] **Step 4: Check the edits**

Run: `node -e "const t=require('fs').readFileSync('README.md','utf8');for(const s of ['Claude Code ≥ 2.1.290','skills/turbo-view/','status [--watch], view [--json]','### Live view','turbo-view@skills-dir','| \`view.refresh_seconds\` | \`3\` |','the turbo-view mod included','scripts/turbo-view-demo.mjs'])console.log(t.includes(s)?'ok ':'MISSING ',s)"`
Expected: every line starts with `ok`.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -q -m "docs: README covers the turbo-view live view, status --watch, view.refresh_seconds and the visual check"
```

---

## After the last task

- The controller runs the full suite once (`npm test`) before merging, as the Global Constraints require; `claude plugin validate ./mod` and `claude plugin test mod` once more on a machine with Claude Code ≥ 2.1.290. Nothing in this plan pushes, merges, tags or installs.
- **The owner's visual check** (spec §9.4: the pane can only be seen in his terminal), from the gsd-turbo clone:

  ```sh
  node scripts/turbo-view-demo.mjs            # English texts
  node scripts/turbo-view-demo.mjs --lang ru  # Russian texts
  ```

  Each prints the exact `cd … && TURBO_VIEW_BIN=… claude --plugin-dir …` command (bash and PowerShell forms) and the seven things to check. A real run is the second check: after `node install.mjs`, `/turbo-autonomous` in a project, with the pane open.
- **Release v0.3.0:** bump `mod/.claude-plugin/plugin.json` `version` together with `package.json` (the Task 3 CI test fails otherwise).
- **S1 coordination:** the pane follows S1's final `turbo-run answer` contract (Contracts in S1's plan): 1-based `--option`, `--rev` always, one stdout line per exit 0/1/2/3/4. If S1 changes it, `answerArgv`, `questionRow` and `afterAnswer` in `mod/hooks/view-model.mjs` change with it. Until S1 merges, the demo's fake (Task 7) is the only implementation of that contract the pane is checked against.

## Spec coverage

| Spec | Task |
|---|---|
| §7 Mod with `.claude-plugin/plugin.json` and `hooks/hooks.json` → `modules`, Claude Code ≥ 2.1.290, in `mod/` | 3 |
| §7 Install copies the mod to `~/.claude/skills/turbo-view/`, loaded as `turbo-view@skills-dir`; off via `enabledPlugins` | 6, 8 |
| §7 `doctor` checks the version; on an older one no mod, fallback `status --watch` | 5, 6, 4 |
| §7 Pure `render(view)` in `.mjs` with `node --test` in CI; the mod a thin shell (`$.clock.every`, `$.process.run`, `$.ui.open`, buttons); `validate` and `plugin test` locally | 1, 3 |
| §7 Active only with `.planning/turbo/`; `view --json` every 3 s, 15 s in the background | 1 (`refreshMs`), 3 |
| §7 Pane from 144 columns (110 once opened), `/turbo-view` in a narrow terminal; band always | 3 (D6, D7) |
| §7 Pane: lane → step → subagents (type, plan, action, time, tokens, quiet ⚠), questions with buttons and "Другое…" `Input`, commits | 1, 3 |
| §7 Button → `turbo-run answer … --by pane` | 1 (`answerArgv`), 3 |
| §7 Band `turbo p32 execute · 3 агента · ? 2 вопроса · CI ✓` | 1, 2 (`push`) |
| §7 Toasts: new question, phase done, red CI, lane stopped | 1, 3 |
| §7 `turbo-run status --watch`: the same view, redrawn every 3 s | 4 |
| §10 `"view": { "refresh_seconds": 3 }` | 2 |
| §11 Mod: render of the tree from a fixed `view --json`, the pure function outside the mod | 1 |
| §9.4 Pane drawing and `Button` seen live: the owner's visual check | 7 |
