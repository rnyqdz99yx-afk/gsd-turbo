# gsd-turbo Stage 4 L0 — slots and the control root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Stage 4 lane a lasting, trusted local clone of the project to work in (a slot), and keep all of turbo's state in the owner's main checkout (the control root), so that L1–L4 can run several phases at once on top of fixed interfaces.

**Architecture:** `lib/slots.mjs` creates, lists, prepares, releases and removes slots (`<parent>/<repo>.turbo/lane-<k>`, `git clone --local`), copies the git-ignored files a project needs, installs dependencies only when a lockfile changed, and records which job holds a slot in the slot's own git directory (`.git/turbo-lane.json`). `lib/trust.mjs` writes and removes one value in Claude Code's global config (`projects[<slot>].hasTrustDialogAccepted`) with a backup, re-reads and retries, or hands the owner one line. `lib/paths.mjs` learns the control root: a directory with a slot record is a slot, and its `runDir`, `logsDir` and `locksDir` (and the owner's answers) resolve into the control root that both the record and `TURBO_CONTROL_ROOT` (or else the slot's `remote.origin.url`) name; every `turbo-run` command a lane calls therefore reads and writes state in the control root while code and `.planning/phases` stay in the slot. Answers are committed in the control root under a file lock (`locks/merge`, `lib/merge-lock.mjs`) shared with L2's merges. `turbo-run lanes setup|trust|remove` and four `doctor` checks expose it.

**Tech Stack:** Node ≥ 20 (ESM `.mjs`, `node:test`, zero npm dependencies), git, Claude Code background sessions (2.1.29x), GSD 1.16.

**Spec:** `docs/specs/2026-10-13-stage-4-design.md` — L0's scope: §4 (slots: setup, prepare, deps, copy, remove), §4.1 (trust, with the S1 retry rules), §4.2 (control root: `TURBO_CONTROL_ROOT`, discovery through the slot's origin, every lane-side `turbo-run` command reads and writes state in the control root, answers committed in `main`), the §10 doctor checks `lane-slots`, `lane-trust`, `lane-deps`, `git-branching` and the §10 keys `lanes.mode`, `lanes.dir`, `lanes.copy`, `lanes.install`, `lanes.trust_write`; the facts S1–S5 of §3/§12; the L0 tests of §13. §11: "L0 идёт первым и фиксирует интерфейсы" — the last section of this plan pins them.

**Base:** branch `stage-4` at `05cf3def4f1cfa04c7656a6603b07ae85442c12d` (gsd-turbo 0.3.3 plus the Stage 4 spec). Existing code is referenced by function name and anchor text, never by line number. If an anchor moved, apply the same change next to the named code.

What this plan consumes, by exact name (it re-implements none of it):
- `lib/paths.mjs`: `findProjectRoot`, `dirKey`, `turboDir`, `runDir`, `logsDir`, `locksDir`.
- `lib/fsx.mjs`: `readJson`, `writeJsonAtomic`, `ensureDir`.
- `lib/config.mjs`: `DEFAULTS`, `loadConfig`, `deepMerge`, `fullEntries`, `pushSettings` (as the model for `lanesSettings`).
- `lib/questions.mjs`: `withPhaseLock` and its private `busy`, `lockState`, `takeOver`, `sleepSync`; `answersRel`, `ANSWERS_IGNORE_REL`, `writeAnswers`, `readAnswers`, `refreshQuestions`.
- `lib/answers.mjs`: `answerQuestion` (its `commit` parameter and its `laneRunning` rule); `lib/gates.mjs`: `commitPaths`, `gatesLeftovers`, the private `docsFile`, `activeFile`, `docsStates`.
- `lib/claude.mjs`: `laneSettings`, `buildBgArgs`. `lib/secrets.mjs`: `maskSecrets`. `lib/inbox.mjs`: `appendInbox`. `lib/doctor.mjs`: `doctor`, `oneLine`, `CLAUDE_TIMEOUT_MS`.
- `bin/turbo-run.mjs`: `projectArg`, `main`'s `switch (cmd)`, `USAGE`.
- Tests: `test/helpers/tmp.mjs` (`tmpDir`, `tmpGitRepo`), `test/helpers/plans.mjs` (`DECISION_PLAN`, `writePhase`), `test/doctor.test.mjs` (`env`, `execOk`, `BIN`).

## Decisions this plan makes where the spec is open

- **D1 The slot record.** The spec's "запись `lane.json` слота" is `<slot>/.git/turbo-lane.json` (`slotRecordFile`): inside the slot's git directory, so no checkout, `git clean` or commit ever touches it, next to `.git/turbo-deps.json` (spec §4) and `.git/turbo-last-green` (`test-changed`'s per-git-dir marker). Its presence is what makes a directory a slot. It holds the slot's identity and the job it holds: `{ v, k, path, control, createdAt, copied, job }` (Contracts).
- **D2 Control root resolution.** A directory without a slot record is its own control root, whatever `TURBO_CONTROL_ROOT` says (a developer may run turbo's own tests inside a lane: the variable must never redirect a temp project). In a slot, the candidate is `TURBO_CONTROL_ROOT`, or without it the local path of `remote.origin.url`; it counts only when it is the directory the record names (`dirKey` equal) and has `.planning/turbo/`. Anything else throws a one-line error: a slot never keeps turbo's state itself (`git clean -fdx` would erase it).
- **D3 One redirect point.** `runDir`, `logsDir` and `locksDir` resolve through `stateRoot(root)`, so every `turbo-run` command a lane calls (`phase-step`, `lane-status`, `ask`, `questions`, `push-request`, `inbox`, `context`, `state-sync`, `jobs`, `uat`, …) keeps its run files in the control root with no change to the command. What stays in the slot: `.planning/turbo/config.json` (committed, read from the slot), `.planning/phases/*` and every GSD file, `test-changed`'s marker in the slot's git directory, and the gates (spec §4.2: `gates/` lives and is committed in the slot) — `lib/gates.mjs`'s own run files (`docs-p<N>.json`, `gates-active-p<N>.json`) move to the new `localRunDir(root)`. The owner's answers (`.planning/turbo/answers/`) are read and written in the control root.
- **D4 Setup checks out.** `git clone --local --no-checkout <main> <slot>` (spec), then the main checkout's local git settings (D8), then `git checkout -q -f --detach refs/remotes/origin/<main branch>`: an empty index after `--no-checkout` would read as "every file deleted", and the first `checkout -B` to the same commit would keep those deletions.
- **D5 The main branch.** The control root's current branch (`git symbolic-ref --short HEAD`), read at every setup and prepare; a detached HEAD or a `turbo/*` branch refuses. It is recorded in each job as `base.branch` with the commit the job starts from (`base.sha`), which L2 needs.
- **D6 Job branches.** `jobBranch(job)`: `turbo/p<N>` (phase), `turbo/prep-<N>` (prep), `turbo/annotate` (annotate); a caller may pass `job.branch`, which must match `turbo/<letters, digits, . _ ->`. The previous `turbo/*` branch of the slot is deleted at the next prepare (spec §7.2 p.7).
- **D7 Copies.** `lanes.copy` masks are path globs from the project root: `*` and `?` stay within one path segment, `**` spans segments (`.env` is the root file only; `*/.env` one level down). Candidates are the files git lists as ignored (`git ls-files --others --ignored --exclude-standard --directory`; a file inside a wholly ignored directory is not seen). A mask that matches a tracked or an untracked-but-not-ignored file refuses the setup (spec: "если файл из `lanes.copy` не игнорируется — отказ"). Copies are refreshed from the main checkout at every prepare. The slot's `.git/info/exclude` gets a turbo block listing every copy and `.claude/settings.local.json`, so they never show in `git status` and are never committed, also where the project's `.gitignore` does not list `settings.local.json`.
- **D8 Local git settings.** A clone does not carry the main checkout's local config. The slot takes `user.name`, `user.email`, `user.signingkey`, `commit.gpgsign`, `gpg.format`, `core.autocrlf`, `core.eol`, `core.safecrlf` and a relative `core.hooksPath` (an absolute one names the main checkout's own hooks directory and is skipped), before its first checkout, so the slot writes the same bytes as the main checkout (S3: EOL differences break the verification fingerprint).
- **D9 `settings.local.json`.** The slot's `.claude/settings.local.json` is the main checkout's (if any, a JSON object) deep-merged with `{ "worktree": { "baseRef": "head" } }` (G8, S2), rewritten at every setup and prepare; the project's file is never written. A tracked `settings.local.json`, or one that is not valid JSON, refuses the setup.
- **D10 Dependencies.** For each directory of `test.full` (`fullEntries`), the first lockfile of `package-lock.json` / `npm-shrinkwrap.json` → `npm ci`, `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --immutable`; `lanes.install` replaces the command. The hash is sha256 of the lockfile bytes and the command; it is kept in `<slot>/.git/turbo-deps.json`; the install runs only when it differs. The command runs through `bash -c` (the system shell when there is no bash), exactly as `test-changed` runs `test.full` (GSD runs commands that way); the one shell use of this plan. A failed install refuses the job: the job is not recorded, the deps record keeps its old hash. A `node_modules` that is a link (junction or symlink) refuses: a slot never links another checkout's dependencies, and turbo never deletes through a link.
- **D11 Trust.** `~/.claude.json` is `<CLAUDE_CONFIG_DIR>/.claude.json` when that is set. A slot's key is `trustKey(dir)`: the absolute path, on Windows with `/` and an upper-case drive letter (S1); an existing entry for the slot is found case-insensitively on Windows and keeps its key and its fields. The format is "known" when the file is a JSON object whose `projects` is an object and every key is an absolute path in that form. One backup per command run (`run` object shared across calls): `<file>.turbo-bak-<yyyymmddThhmmssZ>`, `-1`, `-2`… when the name is taken. `trustState(dir)` is `'trusted' | 'untrusted' | 'unknown'`. The owner's line is `open claude in <slot> once and accept the trust dialog` (Russian with `lang: "ru"`).
- **D12 Prepare preconditions.** A slot is free for a job when its job is absent or `done`, it has no tracked changes, and it has no untracked files — except after a job that ended `merged`: then the untracked files are turbo's own leftovers (GSD's `.planning/state.json`, spec §4) and `git clean` removes them. After a `failed` or `abandoned` job, untracked files stay for the owner (spec §9: slots and branches stay for review). Anything else refuses and changes nothing.
- **D13 Removal.** `removeSlot` removes only a free slot that has no `turbo/*` branch with commits the main branch does not have (after `git fetch origin`), removes its trust first, then removes every link inside it that leads outside it (as a link), then the directory.
- **D14 Answers.** `answerQuestion` commits in `stateRoot(root)` under the merge lock (waits up to 30 s). `laneRunning` keeps its v0.3 meaning: "a lane commits in this same checkout" (checkout mode); L1 passes `false` for lanes in slots. A busy lock records the answer and reports `not committed: main is busy: …`; `commitPendingAnswers(root)` commits every uncommitted answers file (L2 calls it inside its merge lock, before it checks that `main` is clean).
- **D15 The merge lock.** `locks/merge` in the control root; `withFileLock(file, fn, opts)` is extracted from `withPhaseLock` unchanged in behaviour; a merge lock older than 30 minutes is a crash's and is taken over.
- **D16 `TURBO_CONTROL_ROOT`.** `buildBgArgs({ …, controlRoot })` adds it to the session's `--settings` `env` only when given (L1 passes it for slot lanes; v0.3 launches stay byte-identical).
- **D17 `turbo-run lanes`.** `setup [--no-trust-write]`, `trust [--no-trust-write]`, `remove [<k>]`. Exit 0: every slot ready; 1: refused; 2: usage; 3: a slot waits for the owner's trust. Refused inside a lane (`TURBO_LANE`) and inside a slot. No `list` subcommand (not in the spec; `doctor` shows the slots).
- **D18 Doctor.** `git-branching`, `lane-slots`, `lane-trust`, `lane-deps` run only in `lanes.mode: "slots"` and never change the mode (v0.3's single lane runs without slots). No slots yet is a passing check with a warning; `claude.json` is read only when slots exist.
- **D19 `lanes.mode` default `"slots"`** changes nothing at runtime in L0: the supervisor still launches its single lane in the main checkout until L1 lands. L0 builds slots only through `turbo-run lanes setup` (and later L1's `start`).

## Global Constraints

- Node ≥ 20, ESM `.mjs` only, **zero runtime npm dependencies**; tests use `node:test` and `node:assert/strict`.
- Windows and Linux (CI: Linux / Node 22; dev: Windows / Node 24): paths with `path.join` / `path.resolve`; child processes only through `execFileSync` or `spawnSync` with an argument array, `windowsHide: true` and a timeout, never a shell — except the dependency install of D10, which runs through `bash -c` like `test.full`.
- Public repository: no personal names, private project names, hosts, user paths or emails in code, tests, fixtures or commits; synthetic paths look like `C:\Users\dev\…` or `/home/dev/…`.
- Spec values, verbatim:
  - slot `<parent>/<repo>.turbo/lane-<k>`, `k = 1..max_lanes`, directory `lanes.dir`; `git clone --local --no-checkout <main> <slot>`; remote `origin` of the slot = the main checkout;
  - copied: `.claude/settings.local.json` and the masks of `lanes.copy` (default `.env`, `*/.env`, `.env.local`, `*/.env.local`); copies are never committed; a `lanes.copy` file git does not ignore → refusal with an explanation; the slot's `.claude/settings.local.json` gets `worktree.baseRef: "head"`; the project's file is never touched;
  - prepare: `git fetch origin`, `git checkout -B turbo/<job> origin/<main_branch>`, `git clean -fdx -e <copied files> -e node_modules`, only when the slot has no unfinished work; otherwise refusal; never `--force` over someone's work;
  - deps: `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, per directory of `test.full`, only when the lockfile hash changed since the slot's last install (`.git/turbo-deps.json` of the slot); links to the main checkout's `node_modules` are forbidden; `lanes.install` sets the command;
  - remove: `turbo-run lanes remove [k]` — only clean slots without a job; trust removed by the same rules it was set;
  - trust: already `projects[<path>].hasTrustDialogAccepted === true` → nothing; backup `~/.claude.json.turbo-bak-<UTC>` (one per command run); re-read, change only that key in memory, write a temporary file next to it, re-read the original and start over if it changed (up to 5 times); rename retried on `EPERM`/`EBUSY`/`EACCES` (up to 10 times, 500 ms apart); on failure the temporary file is deleted; then read back and check; untrust removes the slot's whole entry; nothing else in the file changes; unknown format or a failed write → one line per slot for the owner; `--no-trust-write` and `lanes.trust_write: false` disable writing;
  - control root: `run/`, `logs/`, `locks/`, owner questions and answers live in the main checkout; `gates/` lives and is committed in the slot; `TURBO_CONTROL_ROOT` through the session's `--settings` `env`; without it, discovery through `remote.origin.url` when it names a local checkout with `.planning/turbo/`; answers committed in `main` by `turbo-run answer` under the merge lock (`locks/merge`);
  - config: `lanes.mode` `"slots"` (`"checkout"` = v0.3), `lanes.dir` `"<parent>/<repo>.turbo"`, `lanes.copy` as above, `lanes.install` auto by lockfile, `lanes.trust_write` `true`; doctor: `git-branching` (`git.branching_strategy` = `none`), `lane-slots` (created, clean), `lane-trust`, `lane-deps`.
- Tests never touch the network, a real `claude`, the developer's `~/.claude.json` or Claude home: every trust call gets a `claude.json` in a temp directory and an injected `sleep`/clock; every slot test runs git with `GIT_CONFIG_GLOBAL` pointing at a missing file and `GIT_CONFIG_NOSYSTEM=1` (`ISOLATED`), and `test/helpers/slots.mjs` deletes `TURBO_CONTROL_ROOT` from the test process's env.
- State files are written with `writeJsonAtomic` (`lib/fsx.mjs`).
- TDD. While implementing a task, run only the test files that task names (`node --test <files>`), never the full suite (`npm test`): the controller runs it once at merge. One commit per task, conventional style, the repository's configured identity. Never push, merge, tag or install; never `--no-verify`.

## Review Focus

1. **turbo's own tests run inside a lane** (the developer's process has `TURBO_CONTROL_ROOT` naming a real control root). Expected: a temp project that is not a slot keeps its state in itself; the variable never redirects it; a slot whose record names another root fails loudly instead of writing anywhere. Pinned in Task 3 (`a directory that is not a slot keeps its own state…`, `a slot whose control root cannot be confirmed fails loudly…`), and every slot test file drops the variable through the helper.
2. **Claude Code rewrites `~/.claude.json` while turbo writes the trust** (it holds the file open: rename `EPERM`; it adds its own fields to the entry). Expected: retries, Claude Code's change kept, never a half-written file, the temporary file gone, the owner's line when it keeps failing. Pinned in Task 2 (`rename refused…`, `a file that changes while turbo writes…`).
3. **A slot with leftover work when the next job is prepared** (tracked edits after a merge, an unknown file in a slot without a job, a failed job's new files, a crashed lane whose job is still active). Expected: refused with the paths named, nothing changed (branch, files, record). Pinned in Task 5 (`prepare never overwrites work…`).
4. **`lanes.copy` names a committed `.env`, or an `.env` the project forgot to ignore.** Expected: setup refuses before any clone and names the file; copies never show in a slot's `git status`. Pinned in Task 4 (`setup refuses, creating nothing…`, `settings.local.json stays hidden…`).
5. **Removing a slot whose `node_modules` is a junction into another checkout, or whose `turbo/*` branch holds commits `main` lacks.** Expected: the link goes as a link and the target survives; the branch stops the removal. Pinned in Task 5 (`remove: only a free slot…`), and prepare refuses a linked `node_modules` before any install (`a failed install or a linked node_modules…`).

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/config.mjs` | modify | `DEFAULTS.lanes`; `LANE_MODES`, `lanesSettings` |
| `lib/trust.mjs` | create | `claudeJsonPath`, `trustKey`, `trustLine`, `trustState`, `trustSlot`, `untrustSlot` |
| `lib/paths.mjs` | modify | `CONTROL_ENV`, `SLOT_RECORD`, `slotRecordFile`, `isSlot`, `localRemotePath`, `stateRoot`, `controlRoot`, `localRunDir`; `runDir`/`logsDir`/`locksDir` through `stateRoot` |
| `lib/gates.mjs` | modify | its run files through `localRunDir` (they describe the slot's own GSD config) |
| `lib/questions.mjs` | modify | answers file in `stateRoot(root)`; `withFileLock` extracted from `withPhaseLock` |
| `lib/claude.mjs` | modify | `buildBgArgs({ …, controlRoot })` → `TURBO_CONTROL_ROOT` in the session env |
| `lib/slots.mjs` | create | slots: setup, list, prepare, deps, release, lookup, remove |
| `lib/merge-lock.mjs` | create | `mergeLockFile`, `withMergeLock`, `MergeLocked` |
| `lib/answers.mjs` | modify | `commitAnswerPaths`, `commitPendingAnswers`; `answerQuestion` commits in the control root under the merge lock |
| `lib/cli-lanes.mjs` | create | `turbo-run lanes setup|trust|remove` |
| `lib/doctor.mjs` | modify | `git-branching`, `lane-slots`, `lane-trust`, `lane-deps` |
| `bin/turbo-run.mjs` | modify | `USAGE`; `case 'lanes'` |
| `docs/reference.md` | modify | section `## Lane slots`; five Config rows |
| `test/helpers/slots.mjs` | create | `ISOLATED`, `gitIn`, `controlProject`, `fakeSlot` (Task 3); `mainProject`, `slotFixture` (Task 4) |
| `test/trust.test.mjs`, `test/control-root.test.mjs`, `test/slots.test.mjs`, `test/slots-prepare.test.mjs`, `test/answers-control.test.mjs`, `test/cli-lanes.test.mjs` | create | tests |
| `test/config.test.mjs`, `test/doctor.test.mjs` | modify | imports, appended tests |

## Contracts

- **Slot record** `<slot>/.git/turbo-lane.json` (written only by `lib/slots.mjs`):
  ```json
  { "v": 1, "k": 2, "path": "<absolute slot path>", "control": "<absolute control root>", "createdAt": "<ISO>",
    "copied": [".env", "api/.env"],
    "job": null }
  ```
  `job` when a job holds or held the slot: `{ "kind": "phase"|"prep"|"annotate", "phase": "34"|null, "branch": "turbo/p34", "base": { "branch": "main", "sha": "<40 hex>" }, "state": "active"|"done", "startedAt": "<ISO>", "endedAt": "<ISO>"|null, "outcome": null|"merged"|"failed"|"abandoned" }`.
- **Deps record** `<slot>/.git/turbo-deps.json`: `{ "v": 1, "entries": { "<dir, '' for the root>": { "lockfile", "sha256", "command", "at" } } }`.
- **Exclude block** in `<slot>/.git/info/exclude`: `# gsd-turbo slot files: begin`, one `/<path>` line per copy and `/.claude/settings.local.json`, `# gsd-turbo slot files: end`; replaced as a whole at every refresh.
- **Lane session env** (`--settings`): `{ "worktree": { "bgIsolation": "none" }, "env": { "TURBO_LANE": "1", [TMP, TEMP, TMPDIR], ["TURBO_CONTROL_ROOT": "<control root>"] } }`.
- **`turbo-run lanes setup`**: per slot in order, `lane-<k>: created <path>` or `lane-<k>: kept <path>`, then `lane-<k>: trusted`, `lane-<k>: trusted (already)` or `lane-<k>: <owner line> (<why>)`; `lane-<k>: refused: <why>` on stderr; last `backup of <claude.json>: <backup>` when one was written. **`lanes trust`**: the trust lines and the backup line. **`lanes remove [<k>]`**: `lane-<k>: removed <path>` (plus the owner line when the trust could not be removed, and the backup line), `lane-<k>: nothing to remove`, or `lane-<k>: refused: <why>` on stderr. Exit codes as D17.
- **`answerQuestion(...).commit`**: `committed`, `not committed: <reason>` (`main is busy: another turbo-run holds the merge lock (merge); try again` when the lock stays held), or `null` while `laneRunning`.

---

### Task 1: `lanes` config keys

**Files:**
- Modify: `lib/config.mjs` (`DEFAULTS`; new exports after `pushSettings`)
- Test: `test/config.test.mjs` (import line, then append)

**Interfaces:**
- Consumes: `DEFAULTS`, `loadConfig`, the private `isObj` of `lib/config.mjs`.
- Produces: `DEFAULTS.lanes = { mode: 'slots', dir: '', copy: ['.env', '*/.env', '.env.local', '*/.env.local'], install: '', trust_write: true }`; `LANE_MODES = ['slots', 'checkout']`; `lanesSettings(raw = DEFAULTS.lanes) → { ...raw, mode, dir, copy, install, trust_write }` (trimmed strings) or throws `invalid turbo config lanes.<key>: <why>`. Keys it does not know (L1's `lanes.gates`) pass through unchecked: they stay in the config and are returned as they are.

- [ ] **Step 1: Write the failing test**

In `test/config.test.mjs`, replace `import { DEFAULTS, loadConfig, initConfig, deepMerge, fullEntries, pushSettings } from '../lib/config.mjs';` with:

```js
import { DEFAULTS, LANE_MODES, loadConfig, initConfig, deepMerge, fullEntries, lanesSettings, pushSettings } from '../lib/config.mjs';
```

Append:

```js
test('lanes (Stage 4 L0): defaults, a valid hand-edited value, and every invalid one stops with the key named', () => {
  assert.deepEqual(DEFAULTS.lanes, { mode: 'slots', dir: '', copy: ['.env', '*/.env', '.env.local', '*/.env.local'], install: '', trust_write: true });
  assert.deepEqual(LANE_MODES, ['slots', 'checkout']);
  assert.deepEqual(lanesSettings(), DEFAULTS.lanes);
  assert.deepEqual(
    lanesSettings({ mode: 'checkout', dir: ' ../slots ', copy: [' config/*.env ', '**/.npmrc'], install: ' pnpm install --offline ', trust_write: false, gates: ['packaged-build'] }),
    { mode: 'checkout', dir: '../slots', copy: ['config/*.env', '**/.npmrc'], install: 'pnpm install --offline', trust_write: false, gates: ['packaged-build'] },
  );
  const cases = [
    [null, /lanes: must be an object/],
    [{ mode: 'worktree' }, /lanes\.mode: must be one of slots, checkout/],
    [{ dir: 3 }, /lanes\.dir: must be a path/],
    [{ copy: '.env' }, /lanes\.copy: must be a list of path masks/],
    [{ copy: [''] }, /lanes\.copy: must be a list of path masks/],
    [{ copy: ['api\\.env'] }, /must use forward slashes/],
    [{ copy: ['/etc/app.env'] }, /must be relative to the project root/],
    [{ copy: ['C:/app.env'] }, /must be relative to the project root/],
    [{ copy: ['../.env'] }, /must stay inside the project/],
    [{ copy: ['.git/config'] }, /must not name \.git/],
    [{ install: 1 }, /lanes\.install: must be a command string/],
    [{ trust_write: 'no' }, /lanes\.trust_write: must be true or false/],
  ];
  for (const [v, re] of cases) assert.throws(() => lanesSettings(v), re, JSON.stringify(v));
  // a hand-edited config file reaches it through loadConfig; the rest keeps its default
  const root = tmpDir('lanes');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify({ lanes: { mode: 'checkout' } }));
  assert.deepEqual(lanesSettings(loadConfig(root).lanes), { ...DEFAULTS.lanes, mode: 'checkout' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `The requested module '../lib/config.mjs' does not provide an export named 'LANE_MODES'`.

- [ ] **Step 3: Implement**

`lib/config.mjs` — in `DEFAULTS`, right after the line that starts `  push: { mode: 'off',`, add:

```js
  // spec §4, §10 (Stage 4 L0): where lanes work. slots: one lasting local clone per lane under lanes.dir (empty:
  // <parent>/<repo>.turbo), with the git-ignored files of lanes.copy; checkout: v0.3's single lane in this checkout
  lanes: { mode: 'slots', dir: '', copy: ['.env', '*/.env', '.env.local', '*/.env.local'], install: '', trust_write: true },
```

Right after the closing brace of `export function pushSettings`, add:

```js
export const LANE_MODES = Object.freeze(['slots', 'checkout']);

// lanes.* (spec §4, §10, Stage 4 L0), checked where slots are built or read: a typo must never widen what turbo copies
// or where it clones. Keys of later sub-projects (lanes.gates) pass through unchecked, left to them.
export function lanesSettings(raw = DEFAULTS.lanes) {
  if (!isObj(raw)) throw new Error('invalid turbo config lanes: must be an object');
  const bad = (key, why) => new Error(`invalid turbo config lanes.${key}: ${why}`);
  const l = { ...DEFAULTS.lanes, ...raw };
  if (!LANE_MODES.includes(l.mode)) throw bad('mode', `must be one of ${LANE_MODES.join(', ')}`);
  if (typeof l.dir !== 'string') throw bad('dir', 'must be a path (empty: next to the project, <repo>.turbo)');
  if (!Array.isArray(l.copy) || l.copy.some((m) => typeof m !== 'string' || !m.trim())) throw bad('copy', 'must be a list of path masks');
  const copy = l.copy.map((m) => m.trim());
  for (const m of copy) {
    if (m.includes('\\')) throw bad('copy', `"${m}" must use forward slashes`);
    if (m.startsWith('/') || /^[A-Za-z]:/.test(m)) throw bad('copy', `"${m}" must be relative to the project root`);
    if (m.split('/').includes('..')) throw bad('copy', `"${m}" must stay inside the project (no "..")`);
    if (m.split('/').includes('.git')) throw bad('copy', `"${m}" must not name .git`);
  }
  if (typeof l.install !== 'string') throw bad('install', 'must be a command string (empty: by the lockfile)');
  if (typeof l.trust_write !== 'boolean') throw bad('trust_write', 'must be true or false');
  return { ...raw, mode: l.mode, dir: l.dir.trim(), copy, install: l.install.trim(), trust_write: l.trust_write };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/config.test.mjs`
Expected: PASS (the new test; the others unchanged: `loadConfig` without a file still deep-equals `DEFAULTS`).

- [ ] **Step 5: Commit**

```bash
git add lib/config.mjs test/config.test.mjs
git commit -q -m "feat(lanes): lanes.mode, dir, copy, install and trust_write config keys"
```

---

### Task 2: Trust in Claude Code's global config (`lib/trust.mjs`)

**Files:**
- Create: `lib/trust.mjs`
- Test: `test/trust.test.mjs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (all in `lib/trust.mjs`):
  - `CHANGE_TRIES = 5`, `RENAME_TRIES = 10`, `RENAME_PAUSE_MS = 500`;
  - `claudeJsonPath(env = process.env, home = os.homedir()) → string`;
  - `trustKey(dir, platform = process.platform) → string`;
  - `trustLine(dir, lang = 'en') → string`;
  - `trustState(dir, { file, platform, read }) → 'trusted' | 'untrusted' | 'unknown'`;
  - `trustSlot(dir, { file, platform, write = true, run = {}, lang, now, sleep, rename, read }) → { status: 'already'|'trusted'|'manual', key, backup?, why?, line? }`;
  - `untrustSlot(dir, { same options }) → { status: 'absent'|'removed'|'manual', key, backup?, why?, line? }`.
  - `run` is the per-command object: `run.backup` holds the one backup this command run wrote.

- [ ] **Step 1: Write the failing tests**

Create `test/trust.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { CHANGE_TRIES, RENAME_PAUSE_MS, RENAME_TRIES, claudeJsonPath, trustKey, trustLine, trustSlot, trustState, untrustSlot } from '../lib/trust.mjs';

const NOW = () => new Date('2026-10-13T12:00:00.000Z');
// A copy of Claude Code's global config in a temp directory: never the developer's own.
function claudeJson() {
  const home = tmpDir('cj');
  const file = path.join(home, '.claude.json');
  const other = trustKey(path.join(home, 'other-project'));
  const data = { numStartups: 7, projects: { [other]: { allowedTools: [], hasTrustDialogAccepted: true } }, userID: 'u-test' };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { home, file, other, slot: path.join(home, 'app.turbo', 'lane-1') };
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const opts = (c, more = {}) => ({ file: c.file, now: NOW, sleep: () => {}, run: {}, ...more });
const backups = (c) => fs.readdirSync(c.home).filter((n) => n.startsWith('.claude.json.turbo-bak-')).sort();
const leftovers = (c) => fs.readdirSync(c.home).filter((n) => n.includes('.turbo-tmp-'));

test('where Claude Code keeps its config, and the key it writes for a folder (S1)', () => {
  assert.equal(claudeJsonPath({ CLAUDE_CONFIG_DIR: path.join('cfg', 'claude') }, path.join(path.sep, 'home', 'dev')), path.join(path.resolve('cfg', 'claude'), '.claude.json'));
  assert.equal(claudeJsonPath({}, path.join(path.sep, 'home', 'dev')), path.join(path.sep, 'home', 'dev', '.claude.json'));
  assert.equal(trustKey('c:\\Users\\dev\\app.turbo\\lane-1', 'win32'), 'C:/Users/dev/app.turbo/lane-1');
  assert.equal(trustKey('C:/Users/dev/app.turbo/lane-2/', 'win32'), 'C:/Users/dev/app.turbo/lane-2');
  assert.equal(trustKey('/home/dev/app.turbo/lane-1/', 'linux'), '/home/dev/app.turbo/lane-1');
  assert.equal(trustLine('/home/dev/app.turbo/lane-1'), 'open claude in /home/dev/app.turbo/lane-1 once and accept the trust dialog');
  assert.equal(trustLine('/home/dev/app.turbo/lane-1', 'ru'), 'откройте claude в /home/dev/app.turbo/lane-1 один раз и примите доверие к папке');
});

test('trust writes one value with a backup, once per command run, and changes nothing else', () => {
  const c = claudeJson();
  const before = read(c.file);
  assert.equal(trustState(c.slot, { file: c.file }), 'untrusted');
  const run = {};
  const r = trustSlot(c.slot, opts(c, { run }));
  assert.deepEqual([r.status, r.key, r.backup], ['trusted', trustKey(c.slot), `${c.file}.turbo-bak-20261013T120000Z`]);
  const after = read(c.file);
  assert.deepEqual(after, { ...before, projects: { ...before.projects, [trustKey(c.slot)]: { hasTrustDialogAccepted: true } } });
  assert.deepEqual(Object.keys(after), Object.keys(before), 'top-level order kept');
  assert.equal(trustState(c.slot, { file: c.file }), 'trusted');
  assert.deepEqual(read(path.join(c.home, backups(c)[0])), before);
  assert.equal(trustSlot(path.join(c.home, 'app.turbo', 'lane-2'), opts(c, { run })).status, 'trusted');
  assert.equal(backups(c).length, 1, 'one backup per run of the command');
  assert.equal(trustSlot(c.slot, opts(c, { run })).status, 'already');
  assert.equal(trustSlot(path.join(c.home, 'app.turbo', 'lane-3'), opts(c)).backup, `${c.file}.turbo-bak-20261013T120000Z-1`, 'a new run: a backup of its own');
  assert.deepEqual(leftovers(c), []);
});

test('an entry Claude Code already keeps is found case-insensitively on Windows and keeps its fields; untrust removes it whole', () => {
  const home = tmpDir('cjw');
  const file = path.join(home, '.claude.json');
  const other = { hasTrustDialogAccepted: true };
  fs.writeFileSync(file, JSON.stringify({ projects: { 'C:/Users/dev/other': other, 'C:/Users/Dev/App.turbo/lane-1': { allowedTools: ['Bash'], lastCost: 1.5 } } }));
  const o = { file, platform: 'win32', now: NOW, sleep: () => {}, run: {} };
  const slot = 'C:\\Users\\dev\\app.turbo\\lane-1';
  assert.equal(trustSlot(slot, o).status, 'trusted');
  assert.deepEqual(read(file).projects, { 'C:/Users/dev/other': other, 'C:/Users/Dev/App.turbo/lane-1': { allowedTools: ['Bash'], lastCost: 1.5, hasTrustDialogAccepted: true } });
  assert.equal(trustState(slot, { file, platform: 'win32' }), 'trusted');
  assert.equal(untrustSlot(slot, o).status, 'removed');
  assert.deepEqual(read(file).projects, { 'C:/Users/dev/other': other });
  assert.equal(untrustSlot(slot, o).status, 'absent');
});

test('a format turbo does not know, a missing file, or writing turned off: the owner\'s line, the file untouched', () => {
  for (const text of ['not json', '[]', '{"projects":[]}', '{"numStartups":1}', '{"projects":{"relative/key":{}}}']) {
    const c = claudeJson();
    fs.writeFileSync(c.file, text);
    const r = trustSlot(c.slot, opts(c));
    assert.deepEqual([r.status, r.line], ['manual', trustLine(c.slot)], text);
    assert.match(r.why, /is not one turbo knows/, text);
    assert.equal(fs.readFileSync(c.file, 'utf8'), text);
    assert.equal(trustState(c.slot, { file: c.file }), 'unknown');
    assert.deepEqual([backups(c), leftovers(c)], [[], []]);
  }
  const gone = claudeJson();
  fs.rmSync(gone.file);
  assert.match(trustSlot(gone.slot, opts(gone)).why, /cannot read .*ENOENT/);
  assert.equal(untrustSlot(gone.slot, opts(gone)).status, 'absent');
  const off = claudeJson();
  const bytes = fs.readFileSync(off.file, 'utf8');
  const r = trustSlot(off.slot, opts(off, { write: false, lang: 'ru' }));
  assert.deepEqual([r.status, r.line, r.why], ['manual', trustLine(off.slot, 'ru'), 'writing the trust is off: lanes.trust_write is false or --no-trust-write was given']);
  assert.equal(fs.readFileSync(off.file, 'utf8'), bytes);
  trustSlot(off.slot, opts(off));
  assert.equal(trustSlot(off.slot, opts(off, { write: false })).status, 'already', 'a trusted slot needs no write');
  assert.equal(untrustSlot(off.slot, opts(off, { write: false })).status, 'manual');
  assert.equal(trustState(off.slot, { file: off.file }), 'trusted');
});

test('rename refused while Claude Code holds the file: retried 500 ms apart; held for good: the owner\'s line, nothing left behind (Review Focus 2)', () => {
  const c = claudeJson();
  const sleeps = [];
  let fails = 2;
  const rename = (a, b) => {
    if (fails-- > 0) throw Object.assign(new Error('held'), { code: 'EPERM' });
    fs.renameSync(a, b);
  };
  assert.equal(trustSlot(c.slot, opts(c, { rename, sleep: (ms) => sleeps.push(ms) })).status, 'trusted');
  assert.deepEqual(sleeps, [RENAME_PAUSE_MS, RENAME_PAUSE_MS]);

  const d = claudeJson();
  const bytes = fs.readFileSync(d.file, 'utf8');
  const slept = [];
  const r = trustSlot(d.slot, opts(d, { rename: () => { throw Object.assign(new Error('held'), { code: 'EBUSY' }); }, sleep: (ms) => slept.push(ms) }));
  assert.equal(r.status, 'manual');
  assert.match(r.why, /cannot write .*EBUSY/);
  assert.equal(slept.length, RENAME_TRIES - 1);
  assert.equal(fs.readFileSync(d.file, 'utf8'), bytes);
  assert.deepEqual(leftovers(d), []);

  const e = claudeJson();
  const once = [];
  const r2 = trustSlot(e.slot, opts(e, { rename: () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); }, sleep: (ms) => once.push(ms) }));
  assert.deepEqual([r2.status, once], ['manual', []], 'no retry for other errors');
});

test('a file that changes while turbo writes it: read again and the change kept; changing on every try: the owner\'s line (Review Focus 2)', () => {
  const c = claudeJson();
  let changed = false;
  // Claude Code writes the file at the moment turbo has its temporary file ready
  const readOnce = (f) => {
    if (!changed && leftovers(c).length) {
      changed = true;
      const d = read(c.file);
      d.numStartups = 8;
      fs.writeFileSync(c.file, JSON.stringify(d));
    }
    return fs.readFileSync(f, 'utf8');
  };
  assert.equal(trustSlot(c.slot, opts(c, { read: readOnce })).status, 'trusted');
  assert.deepEqual([read(c.file).numStartups, read(c.file).projects[trustKey(c.slot)]], [8, { hasTrustDialogAccepted: true }]);
  assert.deepEqual(leftovers(c), []);

  const d = claudeJson();
  let n = 0;
  const readAlways = (f) => {
    if (leftovers(d).length) fs.writeFileSync(d.file, JSON.stringify({ ...read(d.file), numStartups: (n += 1) }));
    return fs.readFileSync(f, 'utf8');
  };
  const r = trustSlot(d.slot, opts(d, { read: readAlways }));
  assert.equal(r.status, 'manual');
  assert.match(r.why, new RegExp(`kept changing while turbo wrote it \\(${CHANGE_TRIES} tries\\)`));
  assert.equal(read(d.file).projects[trustKey(d.slot)], undefined);
  assert.deepEqual(leftovers(d), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/trust.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/trust.mjs`.

- [ ] **Step 3: Implement**

Create `lib/trust.mjs`:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// spec §4.1 (S1): Claude Code keeps a folder's trust in its global config, projects[<folder>].hasTrustDialogAccepted.
// turbo writes that one value for its own slots and removes a slot's whole entry when the slot goes (Claude Code adds
// its own fields to it), with a backup, and changes nothing else. The file is Claude Code's internal format: a
// format turbo does not know is left alone and the owner gets one line instead.
export const CHANGE_TRIES = 5;
export const RENAME_TRIES = 10;
export const RENAME_PAUSE_MS = 500;
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const OFF = 'writing the trust is off: lanes.trust_write is false or --no-trust-write was given';
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const readText = (file) => fs.readFileSync(file, 'utf8');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const why = (err) => err?.code || String(err?.message ?? err).split(/\r?\n/)[0];

// Claude Code's global config: .claude.json in CLAUDE_CONFIG_DIR when that is set, else in the home directory.
export function claudeJsonPath(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR ? path.join(path.resolve(env.CLAUDE_CONFIG_DIR), '.claude.json') : path.join(home, '.claude.json');
}

// The key Claude Code writes for a folder (S1): its absolute path; on Windows with forward slashes and an upper-case
// drive letter.
export function trustKey(dir, platform = process.platform) {
  if (platform !== 'win32') return path.posix.resolve(String(dir));
  return path.win32.resolve(String(dir)).replace(/\\/g, '/').replace(/^([a-z]):/, (m, d) => `${d.toUpperCase()}:`);
}

export function trustLine(dir, lang = 'en') {
  return lang === 'ru' ? `откройте claude в ${dir} один раз и примите доверие к папке` : `open claude in ${dir} once and accept the trust dialog`;
}

// { data } when turbo knows the format: a JSON object whose projects is an object keyed by absolute paths in the form
// Claude Code writes on this system; else { why }. Keys are never echoed: they are the owner's paths.
function parse(text, platform) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    return { why: 'not JSON' };
  }
  if (!isObj(data)) return { why: 'not a JSON object' };
  if (!isObj(data.projects)) return { why: 'no projects object' };
  const re = platform === 'win32' ? /^[A-Z]:\// : /^\//;
  if (Object.keys(data.projects).some((k) => !re.test(k))) return { why: 'a projects key that is not an absolute path in the form Claude Code writes here' };
  return { data };
}

// The keys of projects that name the folder: its own key, and its real path's (a link, an 8.3 name); on Windows in
// any case.
function entryKeys(projects, dir, platform) {
  const want = new Set([trustKey(dir, platform)]);
  try {
    want.add(trustKey(fs.realpathSync.native(dir), platform));
  } catch {
    // a folder that does not exist (yet) has no other name
  }
  const norm = (k) => (platform === 'win32' ? k.toLowerCase() : k);
  const wanted = new Set([...want].map(norm));
  return Object.keys(projects).filter((k) => wanted.has(norm(k)));
}

export function trustState(dir, { file = claudeJsonPath(), platform = process.platform, read = readText } = {}) {
  let text;
  try {
    text = read(file);
  } catch {
    return 'unknown';
  }
  const p = parse(text, platform);
  if (!p.data) return 'unknown';
  return entryKeys(p.data.projects, dir, platform).some((k) => p.data.projects[k]?.hasTrustDialogAccepted === true) ? 'trusted' : 'untrusted';
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// One backup per command run: the bytes turbo read before its first write, next to the file.
function backupOnce(file, text, run, now) {
  if (run.backup) return;
  const base = `${file}.turbo-bak-${stamp(now())}`;
  for (let i = 0; i < 100; i++) {
    const target = i ? `${base}-${i}` : base;
    try {
      fs.writeFileSync(target, text, { flag: 'wx', mode: 0o600 });
      run.backup = target;
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`no free backup name next to ${file}`);
}

function renameRetry(from, to, { rename, sleep }) {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_TRIES || !RETRY_CODES.has(err.code)) throw err;
      sleep(RENAME_PAUSE_MS);
    }
  }
}

// The spec §4.1 write: read, change in memory, write a temporary file next to it, read the original again and start
// over when it changed (Claude Code wrote it meanwhile), then rename with retries while Windows refuses. change returns
// the new object, or null when nothing needs writing.
function rewrite(file, change, { platform, run, now, sleep, rename, read }) {
  const tmp = `${file}.turbo-tmp-${process.pid}`;
  for (let round = 1; round <= CHANGE_TRIES; round++) {
    let before;
    try {
      before = read(file);
    } catch (err) {
      return { ok: false, missing: err?.code === 'ENOENT', why: `cannot read ${file} (${why(err)})` };
    }
    const p = parse(before, platform);
    if (!p.data) return { ok: false, why: `the format of ${file} is not one turbo knows (${p.why})` };
    const next = change(p.data);
    if (next === null) return { ok: true, changed: false };
    try {
      backupOnce(file, before, run, now);
      let mode = 0o600;
      try {
        mode = fs.statSync(file).mode & 0o777;
      } catch {
        // keep the private default
      }
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
      if (read(file) !== before) {
        fs.rmSync(tmp, { force: true });
        continue;
      }
      renameRetry(tmp, file, { rename, sleep });
      return { ok: true, changed: true };
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      return { ok: false, why: `cannot write ${file} (${why(err)})` };
    }
  }
  return { ok: false, why: `${file} kept changing while turbo wrote it (${CHANGE_TRIES} tries)` };
}

const defaults = (o) => ({
  file: o.file ?? claudeJsonPath(),
  platform: o.platform ?? process.platform,
  write: o.write ?? true,
  run: o.run ?? {},
  lang: o.lang ?? 'en',
  now: o.now ?? (() => new Date()),
  sleep: o.sleep ?? sleepSync,
  rename: o.rename ?? fs.renameSync,
  read: o.read ?? readText,
});

export function trustSlot(dir, options = {}) {
  const o = defaults(options);
  const key = trustKey(dir, o.platform);
  const manual = (reason) => ({ status: 'manual', key, why: reason, line: trustLine(dir, o.lang) });
  if (trustState(dir, o) === 'trusted') return { status: 'already', key };
  if (!o.write) return manual(OFF);
  const r = rewrite(o.file, (data) => {
    const keys = entryKeys(data.projects, dir, o.platform);
    if (keys.some((k) => data.projects[k]?.hasTrustDialogAccepted === true)) return null;
    // an entry Claude Code already keeps for the folder keeps its key and its fields
    const k = keys[0] ?? key;
    const entry = isObj(data.projects[k]) ? data.projects[k] : {};
    return { ...data, projects: { ...data.projects, [k]: { ...entry, hasTrustDialogAccepted: true } } };
  }, o);
  if (!r.ok) return manual(r.why);
  if (trustState(dir, o) !== 'trusted') return manual(`${o.file} did not keep the trust after the write`);
  return { status: r.changed ? 'trusted' : 'already', key, backup: o.run.backup ?? null };
}

export function untrustSlot(dir, options = {}) {
  const o = defaults(options);
  const key = trustKey(dir, o.platform);
  const manual = (reason) => ({ status: 'manual', key, why: reason, line: `remove the entry ${key} from projects in ${o.file}, or leave it: it only marks a folder that is gone as trusted` });
  if (!o.write) return manual(OFF);
  const r = rewrite(o.file, (data) => {
    const keys = entryKeys(data.projects, dir, o.platform);
    if (!keys.length) return null;
    const projects = { ...data.projects };
    for (const k of keys) delete projects[k];
    return { ...data, projects };
  }, o);
  if (!r.ok) return r.missing ? { status: 'absent', key } : manual(r.why);
  if (trustState(dir, o) === 'trusted') return manual(`${o.file} still trusts the folder after the write`);
  return { status: r.changed ? 'removed' : 'absent', key, backup: o.run.backup ?? null };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/trust.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/trust.mjs test/trust.test.mjs
git commit -q -m "feat(lanes): trust and untrust slots in Claude Code's global config, with a backup and retries"
```

---

### Task 3: The control root

**Files:**
- Modify: `lib/paths.mjs` (imports; new block after `dirKey`; `runDir`, `logsDir`, `locksDir`; new `localRunDir`)
- Modify: `lib/gates.mjs` (import; `docsFile`, `activeFile`, `docsStates`)
- Modify: `lib/questions.mjs` (import; `answersFile`; `writeAnswers`)
- Modify: `lib/claude.mjs` (import; `laneSettings`; `buildBgArgs`)
- Create: `test/helpers/slots.mjs`
- Test: `test/control-root.test.mjs` (create)

**Interfaces:**
- Consumes: `findProjectRoot`, `dirKey`, `turboDir` (`lib/paths.mjs`); `readJson` (`lib/fsx.mjs`).
- Produces (in `lib/paths.mjs`):
  - `CONTROL_ENV = 'TURBO_CONTROL_ROOT'`, `SLOT_RECORD = 'turbo-lane.json'`;
  - `slotRecordFile(slot) → <slot>/.git/turbo-lane.json`; `isSlot(root) → boolean`;
  - `localRemotePath(url) → string | null`;
  - `stateRoot(root, env = process.env) → string` (the root itself unless it is a slot; throws for a slot whose control root cannot be confirmed);
  - `controlRoot(cwd = process.cwd(), env = process.env) → string | null`;
  - `runDir`, `logsDir`, `locksDir` resolve through `stateRoot(root)`; `localRunDir(root) → <root>/.planning/turbo/run`.
- Produces (in `lib/claude.mjs`): `buildBgArgs({ name, prompt, systemPrompt, permissionMode, model, tmpDir, controlRoot })`.
- Produces (tests): `test/helpers/slots.mjs` `ISOLATED`, `gitIn(dir, ...args)`, `controlProject()`, `fakeSlot({ control, record })`.

- [ ] **Step 1: Write the helper and the failing tests**

Create `test/helpers/slots.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './tmp.mjs';
import { CONTROL_ENV, slotRecordFile } from '../../lib/paths.mjs';

// A test process never inherits a lane's control root: turbo's own tests may run inside a turbo lane.
delete process.env[CONTROL_ENV];

// git without the developer's global or system config (hooks, templates, autocrlf): for the tests' own git calls and,
// as deps.env, for lib/slots.mjs.
export const ISOLATED = { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmpDir('gitcfg'), 'none'), GIT_CONFIG_NOSYSTEM: '1' };
export const gitIn = (dir, ...args) => execFileSync('git', args, { cwd: dir, env: ISOLATED, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).replace(/\r?\n$/, '');

// A main checkout with .planning/turbo/ (its run, logs and locks ignored), committed.
export function controlProject() {
  const root = tmpGitRepo();
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', '.gitignore'), 'run/\nlogs/\nlocks/\n');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'turbo');
  return root;
}

// A slot as lib/slots.mjs leaves it, built without it: a repository whose origin is the control root, with .planning
// and its record.
export function fakeSlot({ control = controlProject(), record = {} } = {}) {
  const slot = tmpDir('slot');
  gitIn(slot, 'init', '-q');
  gitIn(slot, 'remote', 'add', 'origin', control);
  fs.mkdirSync(path.join(slot, '.planning'), { recursive: true });
  fs.writeFileSync(slotRecordFile(slot), JSON.stringify({ v: 1, k: 1, path: slot, control, createdAt: '2026-10-13T10:00:00.000Z', copied: [], job: null, ...record }));
  return { control, slot };
}
```

Create `test/control-root.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { ISOLATED, controlProject, fakeSlot, gitIn } from './helpers/slots.mjs';
import { CONTROL_ENV, controlRoot, dirKey, isSlot, localRemotePath, localRunDir, locksDir, logsDir, runDir, slotRecordFile, stateRoot } from '../lib/paths.mjs';
import { buildBgArgs } from '../lib/claude.mjs';
import { gatesLeftovers } from '../lib/gates.mjs';
import { appendInbox } from '../lib/inbox.mjs';
import { readAnswers, writeAnswers } from '../lib/questions.mjs';
import { readJson } from '../lib/fsx.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const state = (root, ...rest) => path.join(root, '.planning', 'turbo', ...rest);

test('a directory that is not a slot keeps its own state, whatever TURBO_CONTROL_ROOT says (Review Focus 1)', () => {
  const root = tmpDir('plain');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  const other = controlProject();
  assert.equal(isSlot(root), false);
  assert.equal(stateRoot(root, { [CONTROL_ENV]: other }), root);
  assert.equal(controlRoot(path.join(root, '.planning'), { [CONTROL_ENV]: other }), root);
  assert.equal(runDir(root), state(root, 'run'));
  assert.equal(localRunDir(root), state(root, 'run'));
});

test('a slot keeps its state in its control root, found through remote.origin.url or TURBO_CONTROL_ROOT; gates stay in the slot; answers in the control root', () => {
  const { control, slot } = fakeSlot();
  fs.mkdirSync(path.join(slot, 'src'));
  assert.equal(isSlot(slot), true);
  assert.equal(dirKey(controlRoot(path.join(slot, 'src'), {})), dirKey(control));
  assert.equal(dirKey(controlRoot(slot, { [CONTROL_ENV]: control })), dirKey(control));
  for (const [fn, name] of [[runDir, 'run'], [logsDir, 'logs'], [locksDir, 'locks']]) assert.equal(dirKey(fn(slot)), dirKey(state(control, name)), name);
  assert.equal(localRunDir(slot), state(slot, 'run'));
  // GSD's gate switches describe the slot's own GSD config: their run files stay in the slot
  fs.mkdirSync(localRunDir(slot), { recursive: true });
  fs.writeFileSync(path.join(localRunDir(slot), 'docs-p3.json'), '{}');
  assert.deepEqual(gatesLeftovers(slot), { gates: [], docs: ['3'] });
  assert.deepEqual(gatesLeftovers(control), { gates: [], docs: [] });
  // the owner's answers are written and read in the control root
  writeAnswers(slot, '3', [{ id: '03-01-t1', answer: 'yes' }]);
  assert.deepEqual(readJson(state(control, 'answers', 'p3.json')), [{ id: '03-01-t1', answer: 'yes' }]);
  assert.equal(fs.existsSync(state(slot, 'answers')), false);
  assert.deepEqual(readAnswers(slot, '3'), [{ id: '03-01-t1', answer: 'yes' }]);
});

test('a slot whose control root cannot be confirmed fails loudly and never keeps state itself (Review Focus 1)', () => {
  const { control, slot } = fakeSlot();
  const other = controlProject();
  assert.throws(() => stateRoot(slot, { [CONTROL_ENV]: other }), /TURBO_CONTROL_ROOT names .* but the slot belongs to/);
  gitIn(slot, 'remote', 'set-url', 'origin', other);
  assert.throws(() => stateRoot(slot, {}), /remote\.origin\.url names .* but the slot belongs to/);
  gitIn(slot, 'remote', 'set-url', 'origin', 'https://example.com/app.git');
  assert.throws(() => stateRoot(slot, {}), /names no local checkout/);
  assert.equal(dirKey(stateRoot(slot, { [CONTROL_ENV]: control })), dirKey(control), 'the env names it: no remote needed');
  const bare = fakeSlot({ control: tmpDir('bare-control') });
  assert.throws(() => stateRoot(bare.slot, {}), /has no \.planning\/turbo/);
  fs.writeFileSync(slotRecordFile(slot), '{}');
  assert.throws(() => stateRoot(slot, {}), /names no control root/);
});

test('localRemotePath: a local path or a file URL; any other URL is no local checkout', () => {
  const local = tmpDir('remote');
  assert.equal(localRemotePath(local), local);
  assert.equal(localRemotePath(pathToFileURL(local).href), local);
  for (const u of ['https://example.com/app.git', 'ssh://git@example.com/app.git', 'git@example.com:team/app.git', '']) assert.equal(localRemotePath(u), null, u);
});

test('the lane session gets TURBO_CONTROL_ROOT in its --settings env only when the supervisor passes a control root', () => {
  const settings = (more) => {
    const args = buildBgArgs({ name: 'n', prompt: 'P', systemPrompt: 'S', permissionMode: 'auto', model: '', ...more });
    return JSON.parse(args[args.indexOf('--settings') + 1]);
  };
  const control = path.resolve('/projects/app');
  assert.deepEqual(settings({}), { worktree: { bgIsolation: 'none' }, env: { TURBO_LANE: '1' } });
  assert.deepEqual(settings({ controlRoot: control }).env, { TURBO_LANE: '1', TURBO_CONTROL_ROOT: control });
});

test('lane commands run in a slot keep their state in the control root (turbo-run lane-status, inbox); a wrong root writes nothing', () => {
  const { control, slot } = fakeSlot();
  appendInbox(control, '3', { kind: 'note', text: 'hello' });
  const env = { ...ISOLATED, [CONTROL_ENV]: control };
  execFileSync(process.execPath, [CLI, 'lane-status', '3', 'running'], { cwd: slot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  assert.equal(readJson(state(control, 'run', 'p3.json')).status, 'running');
  const inbox = execFileSync(process.execPath, [CLI, 'inbox', '3', '--json'], { cwd: slot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  assert.deepEqual(JSON.parse(inbox).map((m) => m.text), ['hello']);
  const r = spawnSync(process.execPath, [CLI, 'lane-status', '3', 'done'], { cwd: slot, env: { ...env, [CONTROL_ENV]: controlProject() }, encoding: 'utf8', windowsHide: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /but the slot belongs to/);
  assert.equal(fs.existsSync(state(slot, 'run')), false);
  assert.equal(readJson(state(control, 'run', 'p3.json')).status, 'running');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/control-root.test.mjs`
Expected: FAIL — `The requested module '../../lib/paths.mjs' does not provide an export named 'CONTROL_ENV'`.

- [ ] **Step 3: Implement**

`lib/paths.mjs`:

1. Replace the three import lines at the top with:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson } from './fsx.mjs';
```

2. Replace the four lines `export const turboDir = …`, `export const runDir = …`, `export const logsDir = …`, `export const locksDir = …` at the end of the file with:

```js
export const turboDir = (root) => path.join(root, '.planning', 'turbo');

// Stage 4 (spec §4.2): the main checkout that owns a lane's slot (the control root) keeps turbo's state: run/, logs/,
// locks/ and the owner's answers. A slot names it in its record, kept in the slot's git directory, where no checkout,
// clean or commit reaches it; the record's presence is what makes a directory a slot.
export const CONTROL_ENV = 'TURBO_CONTROL_ROOT';
export const SLOT_RECORD = 'turbo-lane.json';
export const slotRecordFile = (slot) => path.join(slot, '.git', SLOT_RECORD);
export const isSlot = (root) => Boolean(root) && fs.existsSync(slotRecordFile(root));

// The local directory a git remote URL names, or null for a URL of another host (https, ssh, scp-like host:path).
export function localRemotePath(url) {
  const u = String(url ?? '').trim();
  if (!u) return null;
  if (/^file:\/\//i.test(u)) {
    try {
      return fileURLToPath(u);
    } catch {
      return null;
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(u)) return null;
  if (!/^[A-Za-z]:[\\/]/.test(u) && /^[^/\\]+:/.test(u)) return null;
  return path.resolve(u);
}

function originUrl(dir) {
  try {
    return String(execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10000, killSignal: 'SIGKILL' })).trim();
  } catch {
    return '';
  }
}

// A slot's control root: the directory its record names, confirmed by TURBO_CONTROL_ROOT (the lane session's env) or
// else by the slot's remote.origin.url, with .planning/turbo/ in it. Anything else throws: a slot never keeps turbo's
// state itself (the next job's git clean would erase it).
function slotControl(slot, env) {
  const rec = readJson(slotRecordFile(slot), null);
  const named = rec && typeof rec.control === 'string' && rec.control ? path.resolve(rec.control) : null;
  if (!named) throw new Error(`${slotRecordFile(slot)} names no control root: turbo's state of this slot has nowhere to go; repair or remove the slot by hand`);
  const fromEnv = env?.[CONTROL_ENV] ? String(env[CONTROL_ENV]) : '';
  const via = fromEnv ? CONTROL_ENV : 'remote.origin.url';
  const candidate = fromEnv ? path.resolve(fromEnv) : localRemotePath(originUrl(slot));
  if (!candidate) throw new Error(`slot ${slot}: no ${CONTROL_ENV} and its remote.origin.url names no local checkout; its control root is ${named}`);
  if (dirKey(candidate) !== dirKey(named)) throw new Error(`slot ${slot}: ${via} names ${candidate}, but the slot belongs to ${named}`);
  if (!fs.existsSync(turboDir(named))) throw new Error(`slot ${slot}: its control root ${named} has no .planning/turbo`);
  return named;
}

const controls = new Map();
// Where the state of the project at root lives: root itself, or for a slot its control root (remembered per slot
// and TURBO_CONTROL_ROOT value; a failure is never remembered).
export function stateRoot(root, env = process.env) {
  if (!isSlot(root)) return root;
  const slot = path.resolve(root);
  const key = `${slot}\0${env?.[CONTROL_ENV] ?? ''}`;
  if (!controls.has(key)) controls.set(key, slotControl(slot, env));
  return controls.get(key);
}

// The control root for a directory inside a project (spec §4.2), or null outside any project.
export function controlRoot(cwd = process.cwd(), env = process.env) {
  const root = findProjectRoot(cwd);
  return root === null ? null : stateRoot(root, env);
}

// turbo's state: a slot's lands in its control root, so every turbo-run command a lane calls in its slot reads and
// writes it there without knowing about slots.
export const runDir = (root) => path.join(turboDir(stateRoot(root)), 'run');
export const logsDir = (root) => path.join(turboDir(stateRoot(root)), 'logs');
export const locksDir = (root) => path.join(turboDir(stateRoot(root)), 'locks');
// The run directory of the checkout itself: what describes this checkout's own GSD config (lib/gates.mjs).
export const localRunDir = (root) => path.join(turboDir(root), 'run');
```

`lib/gates.mjs`:

1. Replace `import { runDir } from './paths.mjs';` with `import { localRunDir } from './paths.mjs';`.
2. Replace `const docsFile = (root, phase) => path.join(runDir(root), \`docs-p${phase}.json\`);` and the `activeFile` line after it with:

```js
// spec §4.2: the gates describe the GSD config of the checkout they run in (a lane's slot), so their run files stay
// in that checkout, never in the control root
const docsFile = (root, phase) => path.join(localRunDir(root), `docs-p${phase}.json`);
const activeFile = (root, phase) => path.join(localRunDir(root), `gates-active-p${phase}.json`);
```

3. In `function docsStates`, replace `fs.readdirSync(runDir(root))` with `fs.readdirSync(localRunDir(root))`.

`lib/questions.mjs`:

1. Replace `import { runDir } from './paths.mjs';` with `import { runDir, stateRoot } from './paths.mjs';`.
2. Replace `const answersFile = (root, phase) => path.join(root, ...answersRel(phase).split('/'));` with:

```js
// spec §4.2: the owner's answers live in the control root, also when a lane in a slot reads or writes them
const answersFile = (root, phase) => path.join(stateRoot(root), ...answersRel(phase).split('/'));
```

3. In `export function writeAnswers`, replace `    ensureAnswersIgnore(root);` with `    ensureAnswersIgnore(stateRoot(root));`.

`lib/claude.mjs`:

1. Add after the existing imports: `import { CONTROL_ENV } from './paths.mjs';`.
2. Replace `function laneSettings(tmpDir) {` and its body with:

```js
// Stage 4 (spec §4.2): a lane in a slot also gets its control root, where every turbo-run command it calls keeps
// turbo's state; given only when the supervisor passes one, so a v0.3 launch stays as it was.
function laneSettings(tmpDir, controlRoot) {
  return JSON.stringify({ worktree: { bgIsolation: 'none' }, env: { TURBO_LANE: '1', ...(tmpDir ? { TMP: tmpDir, TEMP: tmpDir, TMPDIR: tmpDir } : {}), ...(controlRoot ? { [CONTROL_ENV]: controlRoot } : {}) } });
}
```

3. In `export function buildBgArgs`, replace `({ name, prompt, systemPrompt, permissionMode, model, tmpDir })` with `({ name, prompt, systemPrompt, permissionMode, model, tmpDir, controlRoot })` and `'--settings', laneSettings(tmpDir),` with `'--settings', laneSettings(tmpDir, controlRoot),`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/control-root.test.mjs test/paths.test.mjs test/claude.test.mjs test/gates.test.mjs test/inbox.test.mjs`
Expected: PASS (6 new tests; the others unchanged: outside a slot `runDir(root)` is the same path as before and the v0.3 `--settings` string is byte-identical).

- [ ] **Step 5: Commit**

```bash
git add lib/paths.mjs lib/gates.mjs lib/questions.mjs lib/claude.mjs test/helpers/slots.mjs test/control-root.test.mjs
git commit -q -m "feat(lanes): the control root keeps turbo's state for commands run in a slot; TURBO_CONTROL_ROOT in the lane env"
```

---

### Task 4: Slots — setup, copies, listing (`lib/slots.mjs`)

**Files:**
- Create: `lib/slots.mjs`
- Modify: `test/helpers/slots.mjs` (one import; two helpers appended)
- Test: `test/slots.test.mjs` (create)

**Interfaces:**
- Consumes: `dirKey`, `slotRecordFile` (Task 3); `lanesSettings` (Task 1); `trustSlot`, `trustState`, `trustKey` (Task 2); `DEFAULTS`, `deepMerge`; `readJson`, `writeJsonAtomic`, `ensureDir`.
- Produces (in `lib/slots.mjs`):
  - `SLOT_RE`, `SETTINGS_LOCAL = '.claude/settings.local.json'`, `COPIED_GIT_CONFIG`; `class SlotRefused extends Error` with `.code` (`'mode' | 'layout' | 'inside' | 'settings' | 'copy' | 'detached' | 'missing' | 'foreign' | 'broken' | 'busy' | 'dirty' | 'install' | 'link' | 'unmerged'`);
  - `slotGit(env) → (dir, args, { ok, timeout }) → string | null`;
  - `maxLanes(config) → number`; `slotsDir(root, config) → string`; `slotPath(root, config, k) → string`;
  - `readSlotRecord(slot) → SlotRecord | null`;
  - `listSlots(root, config, deps) → Slot[]`, `Slot = { k, path, state: 'missing'|'free'|'busy'|'dirty'|'foreign'|'broken', record, dirty: string[], why? }`;
  - `mainBranch(root, deps) → string`; `maskRegExp(mask) → RegExp`; `copyPlan(root, config, deps) → { files, notIgnored }`;
  - `setupSlots(root, config, deps) → { dir, slots: Array<{ k, path, action: 'created'|'kept'|'refused', why, trust }>, backup }`;
  - private, used by Task 5: `gitOf`, `ours`, `slotInfo`, `slotNumbers`, `blocking`, `checkedCopies`, `refreshSlot`, `writeSlotRecord`, `ignoreLine`, `describeJob`, `isObj`, `errLine`, `refuse`.
- `deps` everywhere: `{ git?, env?, now?, claudeJson?, trustWrite?, trust?, config?, run?, log? }`.
- Produces (tests): `mainProject({ ignore, files })`, `slotFixture(root, { max, lanes })`.

- [ ] **Step 1: Write the helpers and the failing tests**

In `test/helpers/slots.mjs`, add after `import { CONTROL_ENV, slotRecordFile } from '../../lib/paths.mjs';`:

```js
import { DEFAULTS } from '../../lib/config.mjs';
```

Append to `test/helpers/slots.mjs`:

```js
// A main checkout as a project has it: .gitignore, .planning (ROADMAP, turbo config and its .gitignore), a tracked
// api/ directory and the given files, committed. Untracked files are written afterwards with write().
export function mainProject({ ignore = ['.env', '.env.local', 'node_modules', 'dist/', '.claude/settings.local.json'], files = {} } = {}) {
  const root = tmpGitRepo();
  const write = (rel, text) => {
    const f = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  write('.gitignore', `${ignore.join('\n')}\n`);
  write('.planning/ROADMAP.md', '# Roadmap\n');
  write('.planning/turbo/.gitignore', 'run/\nlogs/\nlocks/\n');
  write('.planning/turbo/config.json', `${JSON.stringify({ max_lanes: 2 })}\n`);
  write('api/index.js', 'export {};\n');
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'project');
  return { root, write, git: (...a) => gitIn(root, ...a) };
}

// Where a test's slots live (a temp directory, never next to the developer's projects), its Claude Code config copy,
// its config and the deps lib/slots.mjs takes: isolated git, a fixed clock, a fake installer that records its calls.
export function slotFixture(root, { max = 2, lanes = {} } = {}) {
  const dir = path.join(tmpDir('slots'), 'app.turbo');
  const home = tmpDir('home');
  const claudeJson = path.join(home, '.claude.json');
  fs.writeFileSync(claudeJson, `${JSON.stringify({ projects: {} }, null, 2)}\n`);
  const config = { ...structuredClone(DEFAULTS), max_lanes: max, lanes: { ...DEFAULTS.lanes, dir, ...lanes } };
  const calls = [];
  const deps = {
    env: ISOLATED,
    claudeJson,
    config,
    now: () => new Date('2026-10-13T12:00:00.000Z'),
    run: (command, { cwd }) => {
      calls.push({ command, cwd });
      fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
      return { code: 0, tail: '' };
    },
  };
  return { dir, home, claudeJson, config, deps, calls };
}
```

Create `test/slots.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitIn, mainProject, slotFixture } from './helpers/slots.mjs';
import { controlRoot, dirKey, localRemotePath } from '../lib/paths.mjs';
import { SlotRefused, listSlots, maskRegExp, readSlotRecord, setupSlots, slotPath, slotsDir } from '../lib/slots.mjs';
import { trustLine, trustState } from '../lib/trust.mjs';

const refused = (fn, code, re) => assert.throws(fn, (e) => e instanceof SlotRefused && e.code === code && (!re || re.test(e.message)), `${code} ${re ?? ''}`);
const readJsonFile = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('lanes.copy masks: * and ? within one path segment, ** across segments', () => {
  const cases = [
    ['.env', '.env', true], ['.env', 'api/.env', false],
    ['*/.env', 'api/.env', true], ['*/.env', '.env', false], ['*/.env', 'a/b/.env', false],
    ['**/.env', '.env', true], ['**/.env', 'a/b/.env', true], ['config/*.env', 'config/dev.env', true],
    ['.env.?', '.env.1', true], ['.env.?', '.env.12', false], ['a+b/(x).env', 'a+b/(x).env', true],
  ];
  for (const [mask, p, want] of cases) assert.equal(maskRegExp(mask).test(p), want, `${mask} ${p}`);
});

test('setup clones each slot next to the project, copies the ignored files lanes.copy names, sets baseRef head and trusts it', () => {
  const p = mainProject();
  p.write('.env', 'A=1\n');
  p.write('api/.env', 'B=2\n');
  p.write('.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
  const t = slotFixture(p.root);
  assert.equal(slotsDir(p.root, t.config), t.dir);
  const r = setupSlots(p.root, t.config, t.deps);
  assert.deepEqual(r.slots.map((s) => [s.k, s.action, s.trust.status]), [[1, 'created', 'trusted'], [2, 'created', 'trusted']]);
  assert.equal(r.backup, `${t.claudeJson}.turbo-bak-20261013T120000Z`);
  for (const k of [1, 2]) {
    const s = slotPath(p.root, t.config, k);
    assert.equal(s, path.join(t.dir, `lane-${k}`));
    assert.equal(fs.readFileSync(path.join(s, '.env'), 'utf8'), 'A=1\n');
    assert.equal(fs.readFileSync(path.join(s, 'api', '.env'), 'utf8'), 'B=2\n');
    assert.deepEqual(readJsonFile(path.join(s, '.claude', 'settings.local.json')), { permissions: { allow: ['Bash(ls)'] }, worktree: { baseRef: 'head' } });
    assert.equal(gitIn(s, 'status', '--porcelain', '--untracked-files=all'), '', 'copies never show');
    assert.equal(dirKey(localRemotePath(gitIn(s, 'config', '--get', 'remote.origin.url'))), dirKey(p.root));
    assert.deepEqual([gitIn(s, 'config', '--local', '--get', 'core.autocrlf'), gitIn(s, 'config', '--local', '--get', 'user.name')], ['false', 'test']);
    assert.equal(gitIn(s, 'rev-parse', 'HEAD'), p.git('rev-parse', 'HEAD'));
    const rec = readSlotRecord(s);
    assert.deepEqual([rec.v, rec.k, rec.path, rec.job, rec.copied, rec.createdAt], [1, k, s, null, ['.env', 'api/.env'], '2026-10-13T12:00:00.000Z']);
    assert.equal(dirKey(rec.control), dirKey(p.root));
    assert.equal(trustState(s, { file: t.claudeJson }), 'trusted');
  }
  assert.deepEqual(readJsonFile(path.join(p.root, '.claude', 'settings.local.json')), { permissions: { allow: ['Bash(ls)'] } }, 'the project file is untouched');
  assert.equal(dirKey(controlRoot(path.join(slotPath(p.root, t.config, 1), 'api'), {})), dirKey(p.root));
  assert.deepEqual(listSlots(p.root, t.config, t.deps).map((s) => [s.k, s.state]), [[1, 'free'], [2, 'free']]);
  // again: kept, nothing cloned again, the trust already there
  const again = setupSlots(p.root, t.config, t.deps);
  assert.deepEqual(again.slots.map((s) => [s.k, s.action, s.trust.status]), [[1, 'kept', 'already'], [2, 'kept', 'already']]);
  assert.equal(again.backup, null);
});

test('settings.local.json stays hidden in a slot even when the project does not ignore it; trust_write false gives the owner\'s line (Review Focus 4)', () => {
  const p = mainProject({ ignore: ['.env'] });
  p.write('.claude/settings.local.json', '{}');
  const t = slotFixture(p.root, { max: 1, lanes: { trust_write: false } });
  const bytes = fs.readFileSync(t.claudeJson, 'utf8');
  const r = setupSlots(p.root, t.config, t.deps);
  const s = slotPath(p.root, t.config, 1);
  assert.deepEqual([r.slots[0].trust.status, r.slots[0].trust.line], ['manual', trustLine(s)]);
  assert.equal(fs.readFileSync(t.claudeJson, 'utf8'), bytes);
  assert.equal(gitIn(s, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.match(fs.readFileSync(path.join(s, '.git', 'info', 'exclude'), 'utf8'), /# gsd-turbo slot files: begin\n\/\.claude\/settings\.local\.json\n# gsd-turbo slot files: end\n/);
});

test('setup refuses, creating nothing: a lanes.copy file git does not ignore, lanes.dir inside the project, a detached main checkout, lanes.mode checkout, a tracked settings.local.json (Review Focus 4)', () => {
  const tracked = mainProject({ ignore: ['node_modules'], files: { '.env': 'A=1\n' } });
  let t = slotFixture(tracked.root);
  refused(() => setupSlots(tracked.root, t.config, t.deps), 'copy', /lanes\.copy names files git does not ignore: \.env/);
  assert.equal(fs.existsSync(t.dir), false);

  const loose = mainProject({ ignore: ['node_modules'] });
  loose.write('api/.env', 'B=2\n');
  t = slotFixture(loose.root);
  refused(() => setupSlots(loose.root, t.config, t.deps), 'copy', /api\/\.env/);
  assert.equal(fs.existsSync(t.dir), false);

  const p = mainProject();
  refused(() => setupSlots(p.root, slotFixture(p.root, { lanes: { dir: 'slots' } }).config, t.deps), 'inside');
  refused(() => setupSlots(p.root, slotFixture(p.root, { lanes: { mode: 'checkout' } }).config, t.deps), 'mode');
  t = slotFixture(p.root);
  p.git('checkout', '-q', '--detach');
  refused(() => setupSlots(p.root, t.config, t.deps), 'detached');
  assert.equal(fs.existsSync(t.dir), false);
  p.git('checkout', '-q', 'main');

  const s = mainProject({ ignore: ['.env'], files: { '.claude/settings.local.json': '{}' } });
  t = slotFixture(s.root);
  refused(() => setupSlots(s.root, t.config, t.deps), 'settings', /is tracked by git/);
});

test('a directory in a slot\'s place that is not a slot of this project is never touched', () => {
  const p = mainProject();
  const t = slotFixture(p.root);
  fs.mkdirSync(path.join(t.dir, 'lane-1'), { recursive: true });
  fs.writeFileSync(path.join(t.dir, 'lane-1', 'notes.txt'), 'mine');
  const r = setupSlots(p.root, t.config, t.deps);
  assert.deepEqual(r.slots.map((s) => [s.k, s.action]), [[1, 'refused'], [2, 'created']]);
  assert.match(r.slots[0].why, /exists and is not slot 1 of this project/);
  assert.equal(fs.readFileSync(path.join(t.dir, 'lane-1', 'notes.txt'), 'utf8'), 'mine');
  assert.deepEqual(listSlots(p.root, t.config, t.deps).map((s) => [s.k, s.state]), [[1, 'foreign'], [2, 'free']]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/slots.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/slots.mjs`.

- [ ] **Step 3: Implement**

Create `lib/slots.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dirKey, slotRecordFile } from './paths.mjs';
import { ensureDir, readJson, writeJsonAtomic } from './fsx.mjs';
import { DEFAULTS, deepMerge, lanesSettings } from './config.mjs';
import { trustSlot } from './trust.mjs';

// Stage 4 (spec §4): a slot is a lasting local clone of the project, <lanes.dir>/lane-<k>, where one lane, prep or
// annotate job works at a time. Its record (.git/turbo-lane.json, lib/paths.mjs slotRecordFile) names the project that
// owns it (the control root) and the job it holds; only this module writes it.
export const SLOT_RE = /^lane-([1-9]\d*)$/;
export const SETTINGS_LOCAL = '.claude/settings.local.json';
// The main checkout's local git settings a slot takes before its first checkout: the same identity, signing and line
// endings (S3: other line endings break the verification fingerprint). An absolute core.hooksPath names the main
// checkout's own hooks directory and is skipped.
export const COPIED_GIT_CONFIG = Object.freeze(['user.name', 'user.email', 'user.signingkey', 'commit.gpgsign', 'gpg.format', 'core.autocrlf', 'core.eol', 'core.safecrlf', 'core.hooksPath']);
const GIT_TIMEOUT_MS = 120000;
const CLONE_TIMEOUT_MS = 600000;
const EXCLUDE_BEGIN = '# gsd-turbo slot files: begin';
const EXCLUDE_END = '# gsd-turbo slot files: end';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const errLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0];
const zList = (out) => String(out ?? '').split('\0').filter(Boolean);

export class SlotRefused extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SlotRefused';
    this.code = code;
  }
}
const refuse = (code, text) => { throw new SlotRefused(code, text); };

// git in a directory: its output without the last newline; { ok: true } turns exit 1 (git's documented "no") into null.
export function slotGit(env = process.env) {
  return (dir, args, { ok = false, timeout = GIT_TIMEOUT_MS } = {}) => {
    try {
      return String(execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 * 1024 })).replace(/\r?\n$/, '');
    } catch (err) {
      if (ok && err?.status === 1) return null;
      const why = err?.code === 'ETIMEDOUT' ? `timed out after ${timeout / 1000} s` : String(err?.stderr || err?.message || err).trim().split(/\r?\n/).at(-1);
      throw new Error(`git ${args[0]} in ${dir} failed: ${why}`);
    }
  };
}
const gitOf = (deps) => deps?.git || slotGit(deps?.env);

export function maxLanes(config) {
  const n = config?.max_lanes;
  return Number.isInteger(n) && n >= 1 ? n : DEFAULTS.max_lanes;
}

// <parent>/<repo>.turbo next to the project, or lanes.dir (a relative one counts from the project root).
export function slotsDir(root, config) {
  const { dir } = lanesSettings(config?.lanes);
  const abs = path.resolve(root);
  return dir ? path.resolve(abs, dir) : path.join(path.dirname(abs), `${path.basename(abs)}.turbo`);
}
export const slotPath = (root, config, k) => path.join(slotsDir(root, config), `lane-${k}`);

const inside = (root, dir) => {
  const r = path.relative(path.resolve(root), dir);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

export function readSlotRecord(slot) {
  const r = readJson(slotRecordFile(slot), null);
  return isObj(r) && Number.isInteger(r.k) && typeof r.control === 'string' && r.control ? r : null;
}
const writeSlotRecord = (slot, rec) => writeJsonAtomic(slotRecordFile(slot), rec);
const ours = (rec, root) => rec !== null && dirKey(rec.control) === dirKey(root);
const describeJob = (job) => `${job.kind}${job.phase ? ` ${job.phase}` : ''} on ${job.branch}`;

// What keeps a slot from its next job: its tracked changes always; its untracked files unless the last job ended
// merged (then they are turbo's own leftovers, such as GSD's .planning/state.json, and git clean removes them).
function blocking(record, lines) {
  const merged = record?.job?.state === 'done' && record.job.outcome === 'merged';
  return lines.filter((l) => !(merged && l.startsWith('?? ')));
}

function slotInfo(root, k, slot, git) {
  if (!fs.existsSync(slot)) return { k, path: slot, state: 'missing', record: null, dirty: [] };
  const record = readSlotRecord(slot);
  if (!ours(record, root) || record.k !== k) return { k, path: slot, state: 'foreign', record, dirty: [] };
  const lines = git(slot, ['status', '--porcelain', '--untracked-files=normal']).split(/\r?\n/).filter(Boolean);
  if (record.job?.state === 'active') return { k, path: slot, state: 'busy', record, dirty: lines };
  const dirty = blocking(record, lines);
  return { k, path: slot, state: dirty.length ? 'dirty' : 'free', record, dirty };
}

function slotNumbers(root, config) {
  const ks = new Set(Array.from({ length: maxLanes(config) }, (_, i) => i + 1));
  try {
    for (const n of fs.readdirSync(slotsDir(root, config))) {
      const m = SLOT_RE.exec(n);
      if (m) ks.add(Number(m[1]));
    }
  } catch {
    // no slots directory yet
  }
  return [...ks].sort((a, b) => a - b);
}

// Every slot place 1..max_lanes, and every lane-<k> directory beyond it, with its state.
export function listSlots(root, config, deps = {}) {
  const git = gitOf(deps);
  return slotNumbers(root, config).map((k) => {
    const slot = slotPath(root, config, k);
    try {
      return slotInfo(root, k, slot, git);
    } catch (err) {
      return { k, path: slot, state: 'broken', record: readSlotRecord(slot), dirty: [], why: errLine(err) };
    }
  });
}

// The branch of the main checkout (spec §7 <main_branch>): its current branch; never a detached HEAD or a lane branch.
export function mainBranch(root, deps = {}) {
  const b = gitOf(deps)(root, ['symbolic-ref', '-q', '--short', 'HEAD'], { ok: true });
  if (!b) refuse('detached', `the main checkout ${root} is not on a branch (detached HEAD): check out the main branch first`);
  if (b.startsWith('turbo/')) refuse('detached', `the main checkout is on ${b}, a lane branch: check out the main branch first`);
  return b;
}

// A lanes.copy mask as a regular expression over a path from the project root: * and ? stay within one segment, **
// spans segments.
export function maskRegExp(mask) {
  const segs = mask.split('/');
  let re = '';
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    if (s === '**') {
      re += last ? '.*' : '(?:[^/]+/)*';
      return;
    }
    re += s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + (last ? '' : '/');
  });
  return new RegExp(`^${re}$`);
}

// The ignored files of the main checkout that lanes.copy names, and the files it names that git does not ignore.
export function copyPlan(root, config, deps = {}) {
  const git = gitOf(deps);
  const masks = lanesSettings(config?.lanes).copy.map(maskRegExp);
  const hit = (p) => masks.some((re) => re.test(p));
  const files = zList(git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])).filter((p) => !p.endsWith('/') && hit(p));
  const notIgnored = [...zList(git(root, ['ls-files', '-z'])), ...zList(git(root, ['ls-files', '-z', '--others', '--exclude-standard']))].filter(hit);
  return { files: files.sort(), notIgnored: notIgnored.sort() };
}

function checkedCopies(root, config, git) {
  const plan = copyPlan(root, config, { git });
  if (plan.notIgnored.length) refuse('copy', `lanes.copy names files git does not ignore: ${plan.notIgnored.join(', ')}; a slot copies only ignored files (add them to .gitignore, or drop the mask from lanes.copy); nothing was changed`);
  return plan.files;
}

// A path as a gitignore line (exclude block, git clean -e): anchored at the root, its pattern characters escaped.
const ignoreLine = (rel) => `/${rel.replace(/[\\*?[]/g, '\\$&').replace(/ +$/, (s) => s.replace(/ /g, '\\ '))}`;

function copyFiles(root, slot, files) {
  for (const f of files) {
    const src = path.join(root, ...f.split('/'));
    let st;
    try {
      st = fs.lstatSync(src);
    } catch {
      continue; // gone since git listed it
    }
    if (!st.isFile()) continue; // a link is never followed out of the project
    const dst = path.join(slot, ...f.split('/'));
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
  }
}

// G8, S2: the slot's settings.local.json is the main checkout's with worktree.baseRef "head", so GSD runs a wave's
// plans in parallel in the slot. The project's own file is never written.
function writeSlotSettings(root, slot) {
  const src = path.join(root, ...SETTINGS_LOCAL.split('/'));
  let base = {};
  if (fs.existsSync(src)) {
    try {
      base = JSON.parse(fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
      refuse('settings', `${SETTINGS_LOCAL} of the main checkout is not valid JSON (${errLine(err)}): fix it, then run turbo-run lanes setup again`);
    }
    if (!isObj(base)) refuse('settings', `${SETTINGS_LOCAL} of the main checkout is not a JSON object`);
  }
  writeJsonAtomic(path.join(slot, ...SETTINGS_LOCAL.split('/')), deepMerge(base, { worktree: { baseRef: 'head' } }));
}

// The copies and settings.local.json never show in the slot's git status and are never committed: turbo lists them in
// the slot's .git/info/exclude, a block it replaces whole.
function writeSlotExclude(slot, files) {
  const file = path.join(slot, '.git', 'info', 'exclude');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // a clone usually has one; none is fine
  }
  const start = text.indexOf(EXCLUDE_BEGIN);
  const end = text.indexOf(EXCLUDE_END);
  const kept = start >= 0 && end > start ? text.slice(0, start) + text.slice(end + EXCLUDE_END.length).replace(/^\r?\n/, '') : text;
  const block = [EXCLUDE_BEGIN, ...[SETTINGS_LOCAL, ...files].map(ignoreLine), EXCLUDE_END].join('\n');
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${kept}${kept && !kept.endsWith('\n') ? '\n' : ''}${block}\n`);
}

function copyGitConfig(root, slot, git) {
  for (const key of COPIED_GIT_CONFIG) {
    const v = git(root, ['config', '--local', '--get', key], { ok: true });
    if (v === null) continue;
    if (key === 'core.hooksPath' && path.isAbsolute(v)) continue;
    git(slot, ['config', '--local', key, v]);
  }
}

// The files a slot takes from the main checkout, again: local git settings, copies, settings.local.json, the exclude
// block, and the list of copies in the record (prepare keeps them out of git clean).
function refreshSlot(root, slot, files, git) {
  copyGitConfig(root, slot, git);
  copyFiles(root, slot, files);
  writeSlotSettings(root, slot);
  writeSlotExclude(slot, files);
  writeSlotRecord(slot, { ...readSlotRecord(slot), copied: files });
}

function createSlot(root, slot, k, { git, now, branch, files }) {
  ensureDir(path.dirname(slot));
  try {
    git(path.dirname(slot), ['clone', '-q', '--local', '--no-checkout', '--', root, slot], { timeout: CLONE_TIMEOUT_MS });
    copyGitConfig(root, slot, git);
    // D4: an empty index after --no-checkout would read as every file deleted
    git(slot, ['checkout', '-q', '-f', '--detach', `refs/remotes/origin/${branch}`]);
    writeSlotRecord(slot, { v: 1, k, path: slot, control: path.resolve(root), createdAt: now().toISOString(), copied: [], job: null });
    refreshSlot(root, slot, files, git);
  } catch (err) {
    // only what this call created: the directory did not exist before it
    fs.rmSync(slot, { recursive: true, force: true });
    throw err;
  }
}

// turbo-run lanes setup (spec §4): slots 1..max_lanes, each created when missing (clone, copies, settings, record) or
// refreshed when it is this project's, then trusted (§4.1). A directory in a slot's place that is not this project's
// slot is refused and never touched. Refusals of the whole setup come before any clone.
export function setupSlots(root, config, deps = {}) {
  const git = gitOf(deps);
  const now = deps.now || (() => new Date());
  const lanes = lanesSettings(config?.lanes);
  if (lanes.mode !== 'slots') refuse('mode', 'lanes.mode is checkout: lanes work in this checkout, no slots');
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (dirKey(top) !== dirKey(root)) refuse('layout', `the project root ${root} is not the top of its git repository (${top}): a slot clones the whole repository`);
  const dir = slotsDir(root, config);
  if (inside(root, dir)) refuse('inside', `lanes.dir ${dir} lies inside the project: slots live outside it (empty lanes.dir: next to the project)`);
  if (git(root, ['ls-files', '--error-unmatch', '--', SETTINGS_LOCAL], { ok: true }) !== null) refuse('settings', `${SETTINGS_LOCAL} is tracked by git: turbo writes a slot's own copy of it, which would show as a change; untrack it (git rm --cached) and ignore it`);
  const files = checkedCopies(root, config, git);
  const branch = mainBranch(root, { git });
  const run = {};
  const trust = deps.trust || ((slot) => trustSlot(slot, { file: deps.claudeJson, write: deps.trustWrite ?? lanes.trust_write, run, lang: config?.lang, now }));
  const slots = [];
  for (let k = 1; k <= maxLanes(config); k++) {
    const slot = slotPath(root, config, k);
    const exists = fs.existsSync(slot);
    const rec = exists ? readSlotRecord(slot) : null;
    if (exists && !(ours(rec, root) && rec.k === k)) {
      slots.push({ k, path: slot, action: 'refused', why: `${slot} exists and is not slot ${k} of this project: move it away, or set lanes.dir`, trust: null });
      continue;
    }
    if (exists) refreshSlot(root, slot, files, git);
    else createSlot(root, slot, k, { git, now, branch, files });
    slots.push({ k, path: slot, action: exists ? 'kept' : 'created', why: null, trust: trust(slot) });
  }
  return { dir, slots, backup: run.backup ?? null };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/slots.test.mjs test/control-root.test.mjs`
Expected: PASS (6 new tests; `control-root.test.mjs` unchanged and green with the extended helper).

- [ ] **Step 5: Commit**

```bash
git add lib/slots.mjs test/helpers/slots.mjs test/slots.test.mjs
git commit -q -m "feat(lanes): turbo slots: local clones with the ignored files they need, baseRef head and trust"
```

---

### Task 5: Slots — prepare, dependencies, release, lookup, remove

**Files:**
- Modify: `lib/slots.mjs` (imports; appended exports)
- Test: `test/slots-prepare.test.mjs` (create)

**Interfaces:**
- Consumes: everything Task 4 produced (public and private), `loadConfig`, `fullEntries` (`lib/config.mjs`), `trustState`, `untrustSlot` (Task 2), `maskSecrets` (`lib/secrets.mjs`).
- Produces (in `lib/slots.mjs`):
  - `JOB_KINDS = ['phase', 'prep', 'annotate']`, `JOB_OUTCOMES = ['merged', 'failed', 'abandoned']`, `LOCKFILES`, `INSTALL_TIMEOUT_MS`;
  - `jobBranch(job) → 'turbo/p<N>' | 'turbo/prep-<N>' | 'turbo/annotate'`;
  - `prepareSlot(root, slot, job, deps) → { k, path, branch, base: { branch, sha }, deps: Array<{ dir, lockfile, command, action: 'installed'|'unchanged'|'none' }>, record }`; `slot` is `k`, a slot path or a `Slot`; `job = { kind, phase, branch? }`;
  - `depsFile(slot)`, `depsPlan(slot, config) → Array<{ dir, cwd, lockfile, command, sha256, action: 'install'|'unchanged'|'none' }>`, `ensureDeps(slot, config, { run, now })`, `runInstall(command, { cwd, timeout }) → { code, tail }`;
  - `releaseSlot(root, slot, { outcome = 'merged', now, config }) → SlotRecord`;
  - `slotForPhase(root, config, phase, { kind = 'phase' }) → { k, path, record } | null`;
  - `freeSlot(root, config, deps) → Slot | null` (free and trusted);
  - `removeSlot(root, config, k, deps) → { k, path, removed, why, untrust }`.

- [ ] **Step 1: Write the failing tests**

Create `test/slots-prepare.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { gitIn, mainProject, slotFixture } from './helpers/slots.mjs';
import { SlotRefused, depsFile, freeSlot, jobBranch, listSlots, prepareSlot, readSlotRecord, releaseSlot, removeSlot, setupSlots, slotForPhase, slotPath } from '../lib/slots.mjs';
import { trustState, untrustSlot } from '../lib/trust.mjs';

const refused = (fn, code, re) => assert.throws(fn, (e) => e instanceof SlotRefused && e.code === code && (!re || re.test(e.message)), `${code} ${re ?? ''}`);
const LOCK = { 'package.json': '{"name":"app","private":true}\n', 'package-lock.json': '{"lockfileVersion":3,"packages":{}}\n' };
const AT = '2026-10-13T12:00:00.000Z';
function ready({ files = {}, before = () => {} } = {}) {
  const p = mainProject({ files });
  before(p);
  const t = slotFixture(p.root);
  setupSlots(p.root, t.config, t.deps);
  return { p, t, s1: slotPath(p.root, t.config, 1), s2: slotPath(p.root, t.config, 2) };
}
const head = (dir) => gitIn(dir, 'rev-parse', 'HEAD');
const branchOf = (dir) => gitIn(dir, 'symbolic-ref', '--short', 'HEAD');

test('prepare puts a fresh slot on turbo/<job> at the main branch and records the job; a held slot is refused', () => {
  const { p, t, s1 } = ready();
  assert.deepEqual([jobBranch({ kind: 'phase', phase: '3' }), jobBranch({ kind: 'prep', phase: '4' }), jobBranch({ kind: 'annotate' })], ['turbo/p3', 'turbo/prep-4', 'turbo/annotate']);
  const r = prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, t.deps);
  const base = { branch: 'main', sha: head(p.root) };
  assert.deepEqual([r.k, r.path, r.branch, r.base], [1, s1, 'turbo/p3', base]);
  assert.deepEqual([branchOf(s1), head(s1)], ['turbo/p3', head(p.root)]);
  assert.deepEqual(readSlotRecord(s1).job, { kind: 'phase', phase: '3', branch: 'turbo/p3', base, state: 'active', startedAt: AT, endedAt: null, outcome: null });
  assert.deepEqual(r.deps, [{ dir: '', lockfile: null, command: null, action: 'none' }]);
  assert.equal(slotForPhase(p.root, t.config, '3').k, 1);
  assert.equal(slotForPhase(p.root, t.config, '4'), null);
  assert.equal(slotForPhase(p.root, t.config, '3', { kind: 'prep' }), null);
  assert.deepEqual(listSlots(p.root, t.config, t.deps).map((s) => [s.k, s.state]), [[1, 'busy'], [2, 'free']]);
  refused(() => prepareSlot(p.root, 1, { kind: 'prep', phase: '4' }, t.deps), 'busy', /slot 1 holds phase 3 on turbo\/p3/);
  assert.throws(() => prepareSlot(p.root, 2, { kind: 'phase' }, t.deps), /a phase job needs a phase id/);
  assert.throws(() => prepareSlot(p.root, 2, { kind: 'phase', phase: '3', branch: 'main' }, t.deps), /job\.branch must be turbo\//);
  assert.throws(() => prepareSlot(p.root, 2, { kind: 'deploy', phase: '3' }, t.deps), /job\.kind must be one of phase, prep, annotate/);
  const a = prepareSlot(p.root, 2, { kind: 'annotate' }, t.deps);
  assert.deepEqual([a.branch, readSlotRecord(a.path).job.phase], ['turbo/annotate', null]);
  assert.equal(slotForPhase(p.root, t.config, null, { kind: 'annotate' }).k, 2);
});

test('the next job: the new main, the last job\'s leftovers and branch gone, the copies refreshed, node_modules kept', () => {
  const { p, t, s1 } = ready({ before: (q) => q.write('.env', 'A=1\n') });
  prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, t.deps);
  fs.writeFileSync(path.join(s1, '.planning', 'state.json'), '{}');
  fs.mkdirSync(path.join(s1, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(s1, 'dist', 'app.js'), 'x');
  fs.mkdirSync(path.join(s1, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(s1, 'node_modules', 'dep', 'index.js'), 'x');
  const done = releaseSlot(p.root, 1, { outcome: 'merged', config: t.config, now: t.deps.now });
  assert.deepEqual([done.job.state, done.job.outcome, done.job.endedAt], ['done', 'merged', AT]);
  assert.equal(listSlots(p.root, t.config, t.deps)[0].state, 'free', 'a merged job\'s untracked leftovers do not block');
  p.write('.env', 'A=2\n');
  p.write('src/next.js', 'export const x = 1;\n');
  p.git('add', 'src/next.js');
  p.git('commit', '-q', '-m', 'next');
  const r = prepareSlot(p.root, 1, { kind: 'prep', phase: '4' }, t.deps);
  assert.deepEqual([r.branch, head(s1), branchOf(s1)], ['turbo/prep-4', head(p.root), 'turbo/prep-4']);
  assert.equal(fs.existsSync(path.join(s1, '.planning', 'state.json')), false);
  assert.equal(fs.existsSync(path.join(s1, 'dist')), false);
  assert.equal(fs.existsSync(path.join(s1, 'src', 'next.js')), true);
  assert.equal(fs.readFileSync(path.join(s1, 'node_modules', 'dep', 'index.js'), 'utf8'), 'x');
  assert.equal(fs.readFileSync(path.join(s1, '.env'), 'utf8'), 'A=2\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s1, '.claude', 'settings.local.json'), 'utf8')).worktree.baseRef, 'head');
  assert.equal(gitIn(s1, 'branch', '--list', 'turbo/p3'), '', 'the last job\'s branch is gone');
  assert.equal(gitIn(s1, 'status', '--porcelain'), '');
  assert.equal(slotForPhase(p.root, t.config, '4', { kind: 'prep' }).k, 1);
});

test('prepare never overwrites work: tracked changes, a file no job explains, a failed job\'s files; nothing changes (Review Focus 3)', () => {
  const { p, t, s1, s2 } = ready();
  prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, t.deps);
  fs.appendFileSync(path.join(s1, 'README.md'), 'edited\n');
  releaseSlot(p.root, 1, { outcome: 'merged', config: t.config });
  refused(() => prepareSlot(p.root, 1, { kind: 'phase', phase: '5' }, t.deps), 'dirty', /M README\.md/);
  assert.deepEqual([branchOf(s1), fs.readFileSync(path.join(s1, 'README.md'), 'utf8')], ['turbo/p3', '# t\nedited\n']);
  assert.equal(readSlotRecord(s1).job.outcome, 'merged');
  fs.writeFileSync(path.join(s2, 'notes.txt'), 'mine');
  refused(() => prepareSlot(p.root, 2, { kind: 'phase', phase: '5' }, t.deps), 'dirty', /\?\? notes\.txt/);
  assert.equal(fs.readFileSync(path.join(s2, 'notes.txt'), 'utf8'), 'mine');
  fs.rmSync(path.join(s2, 'notes.txt'));
  prepareSlot(p.root, 2, { kind: 'phase', phase: '5' }, t.deps);
  fs.writeFileSync(path.join(s2, 'draft.js'), 'x');
  releaseSlot(p.root, 2, { outcome: 'failed', config: t.config });
  refused(() => prepareSlot(p.root, 2, { kind: 'phase', phase: '6' }, t.deps), 'dirty', /\?\? draft\.js/);
  assert.equal(fs.readFileSync(path.join(s2, 'draft.js'), 'utf8'), 'x');
  assert.deepEqual(listSlots(p.root, t.config, t.deps).map((s) => s.state), ['dirty', 'dirty']);
  assert.throws(() => releaseSlot(p.root, 2, { outcome: 'lost', config: t.config }), /outcome must be one of merged, failed, abandoned/);
});

test('dependencies: installed by the lockfile at the first job, again only when the lockfile or lanes.install changes', () => {
  const { p, t, s1 } = ready({ files: LOCK });
  let r = prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, t.deps);
  assert.deepEqual(r.deps, [{ dir: '', lockfile: 'package-lock.json', command: 'npm ci', action: 'installed' }]);
  assert.deepEqual(t.calls, [{ command: 'npm ci', cwd: s1 }]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(depsFile(s1), 'utf8')).entries), ['']);
  releaseSlot(p.root, 1, { config: t.config });
  r = prepareSlot(p.root, 1, { kind: 'phase', phase: '4' }, t.deps);
  assert.deepEqual([r.deps[0].action, t.calls.length], ['unchanged', 1]);
  releaseSlot(p.root, 1, { config: t.config });
  p.write('package-lock.json', '{"lockfileVersion":3,"packages":{"":{"name":"app"}}}\n');
  p.git('commit', '-q', '-am', 'lock');
  r = prepareSlot(p.root, 1, { kind: 'phase', phase: '5' }, t.deps);
  assert.deepEqual([r.deps[0].action, t.calls.length], ['installed', 2]);
  releaseSlot(p.root, 1, { config: t.config });
  const custom = { ...t.deps, config: { ...t.config, lanes: { ...t.config.lanes, install: 'npm install --offline' } } };
  r = prepareSlot(p.root, 1, { kind: 'phase', phase: '6' }, custom);
  assert.deepEqual([r.deps[0].command, r.deps[0].action, t.calls.at(-1).command], ['npm install --offline', 'installed', 'npm install --offline']);
});

test('a failed install or a linked node_modules refuses the job: the slot stays free, the deps record unchanged, the link target untouched', () => {
  const { p, t, s1 } = ready({ files: LOCK });
  const failing = { ...t.deps, run: () => ({ code: 1, tail: 'npm ERR! network' }) };
  refused(() => prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, failing), 'install', /npm ci in the project root of .* failed \(exit 1\): npm ERR! network/);
  assert.equal(readSlotRecord(s1).job, null);
  assert.equal(fs.existsSync(depsFile(s1)), false);
  assert.equal(listSlots(p.root, t.config, t.deps)[0].state, 'free');
  const outside = tmpDir('outside');
  fs.writeFileSync(path.join(outside, 'keep.js'), 'x');
  fs.symlinkSync(outside, path.join(s1, 'node_modules'), 'junction');
  refused(() => prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, t.deps), 'link', /node_modules is a link/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.js'), 'utf8'), 'x');
  assert.deepEqual(t.calls, []);
});

test('free and trusted for a job; remove only a free slot, with its trust; links leading outside go as links; unmerged lane branches stop it (Review Focus 5)', () => {
  const { p, t, s1, s2 } = ready();
  assert.equal(freeSlot(p.root, t.config, t.deps).k, 1);
  untrustSlot(s1, { file: t.claudeJson });
  assert.equal(freeSlot(p.root, t.config, t.deps).k, 2, 'an untrusted slot takes no job');
  prepareSlot(p.root, 2, { kind: 'phase', phase: '3' }, t.deps);
  assert.equal(freeSlot(p.root, t.config, t.deps), null);
  refused(() => removeSlot(p.root, t.config, 2, t.deps), 'busy', /slot 2 holds phase 3 on turbo\/p3/);
  fs.writeFileSync(path.join(s2, 'work.js'), 'x');
  gitIn(s2, 'add', 'work.js');
  gitIn(s2, 'commit', '-q', '-m', 'work');
  releaseSlot(p.root, 2, { outcome: 'failed', config: t.config });
  refused(() => removeSlot(p.root, t.config, 2, t.deps), 'unmerged', /turbo\/p3/);
  gitIn(s2, 'checkout', '-q', '--detach');
  gitIn(s2, 'branch', '-q', '-D', 'turbo/p3');
  const outside = tmpDir('outside');
  fs.writeFileSync(path.join(outside, 'keep.js'), 'x');
  fs.symlinkSync(outside, path.join(s2, 'node_modules'), 'junction');
  const r = removeSlot(p.root, t.config, 2, t.deps);
  assert.deepEqual([r.removed, r.untrust.status], [true, 'removed']);
  assert.equal(fs.existsSync(s2), false);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.js'), 'utf8'), 'x');
  assert.equal(trustState(s2, { file: t.claudeJson }), 'untrusted');
  assert.deepEqual(removeSlot(p.root, t.config, 2, t.deps), { k: 2, path: s2, removed: false, why: 'missing', untrust: null });
  const foreign = path.join(t.dir, 'lane-3');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'x'), 'x');
  refused(() => removeSlot(p.root, t.config, 3, t.deps), 'foreign');
  assert.equal(fs.existsSync(path.join(foreign, 'x')), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/slots-prepare.test.mjs`
Expected: FAIL — `The requested module '../lib/slots.mjs' does not provide an export named 'depsFile'`.

- [ ] **Step 3: Implement**

`lib/slots.mjs`:

1. Replace the import block at the top (the seven lines from `import fs from 'node:fs';` to `import { trustSlot } from './trust.mjs';`) with:

```js
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirKey, slotRecordFile } from './paths.mjs';
import { ensureDir, readJson, writeJsonAtomic } from './fsx.mjs';
import { DEFAULTS, deepMerge, fullEntries, lanesSettings, loadConfig } from './config.mjs';
import { maskSecrets } from './secrets.mjs';
import { trustSlot, trustState, untrustSlot } from './trust.mjs';
```

2. Append to the end of the file:

```js
export const JOB_KINDS = Object.freeze(['phase', 'prep', 'annotate']);
export const JOB_OUTCOMES = Object.freeze(['merged', 'failed', 'abandoned']);
const BRANCH_RE = /^turbo\/[A-Za-z0-9._-]+$/;

// D6: the branch of a job: turbo/p<N>, turbo/prep-<N>, turbo/annotate.
export function jobBranch(job) {
  if (job.kind === 'phase') return `turbo/p${job.phase}`;
  if (job.kind === 'prep') return `turbo/prep-${job.phase}`;
  return 'turbo/annotate';
}

function checkJob(job) {
  if (!isObj(job) || !JOB_KINDS.includes(job.kind)) throw new Error(`job.kind must be one of ${JOB_KINDS.join(', ')}`);
  const phase = job.phase === undefined || job.phase === null ? null : String(job.phase);
  if (job.kind !== 'annotate' && !/^[A-Za-z0-9._-]+$/.test(phase ?? '')) throw new Error(`a ${job.kind} job needs a phase id`);
  const branch = job.branch ?? jobBranch({ ...job, phase });
  if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.endsWith('.lock')) throw new Error(`job.branch must be turbo/<name> (letters, digits, . _ -), not ${branch}`);
  return { kind: job.kind, phase, branch };
}

// A slot given as its number, its path or a Slot: always looked up again at its place for this project, so a path
// never leads turbo elsewhere.
function slotK(slot) {
  const k = typeof slot === 'number' ? slot : slot?.k ?? Number(SLOT_RE.exec(path.basename(String(slot)))?.[1]);
  if (!Number.isInteger(k) || k < 1) throw new Error(`not a slot: ${String(slot?.path ?? slot)}`);
  return k;
}

// D10: the lockfiles of npm, pnpm and yarn and their install commands, first match per directory.
export const LOCKFILES = Object.freeze([
  ['package-lock.json', 'npm ci'],
  ['npm-shrinkwrap.json', 'npm ci'],
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --immutable'],
]);
export const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
export const depsFile = (slot) => path.join(slot, '.git', 'turbo-deps.json');
const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

// For each directory of test.full: its lockfile, the install command (lanes.install or by the lockfile), the hash of
// both, and whether the slot's last install had that hash.
export function depsPlan(slot, config) {
  const lanes = lanesSettings(config?.lanes);
  const saved = readJson(depsFile(slot), null);
  const entries = isObj(saved?.entries) ? saved.entries : {};
  return fullEntries(config?.test?.full, slot).map(({ dir }) => {
    const cwd = dir ? path.join(slot, ...dir.split('/')) : slot;
    const found = LOCKFILES.find(([f]) => fs.existsSync(path.join(cwd, f)));
    if (!found) return { dir, cwd, lockfile: null, command: null, sha256: null, action: 'none' };
    const [lockfile, auto] = found;
    const command = lanes.install || auto;
    const sha256 = createHash('sha256').update(fs.readFileSync(path.join(cwd, lockfile))).update('\0').update(command).digest('hex');
    return { dir, cwd, lockfile, command, sha256, action: entries[dir]?.sha256 === sha256 ? 'unchanged' : 'install' };
  });
}

// The install command through bash -c, as test.full runs (GSD runs commands that way); the system shell without bash.
export function runInstall(command, { cwd, timeout = INSTALL_TIMEOUT_MS } = {}) {
  const opts = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 };
  let r = spawnSync('bash', ['-c', command], opts);
  if (r.error?.code === 'ENOENT') r = spawnSync(command, { ...opts, shell: true });
  if (r.error) return { code: 1, tail: r.error.code || errLine(r.error) };
  const tail = maskSecrets(String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-3).join(' ')).slice(-300);
  return { code: r.status ?? 1, tail };
}

// spec §4: install only where the lockfile (or the command) changed since the slot's last install. A failure refuses
// the job and leaves that directory's record as it was; a node_modules that is a link refuses before anything runs.
export function ensureDeps(slot, config, deps = {}) {
  const run = deps.run || runInstall;
  const now = deps.now || (() => new Date());
  const plan = depsPlan(slot, config);
  const saved = readJson(depsFile(slot), null);
  const entries = isObj(saved?.entries) ? { ...saved.entries } : {};
  for (const p of plan) {
    if (p.action !== 'install') continue;
    const nm = path.join(p.cwd, 'node_modules');
    if (isLink(nm)) refuse('link', `${nm} is a link: node_modules is a link; a slot installs its own dependencies, never another checkout's (remove the link, not its target)`);
    const r = run(p.command, { cwd: p.cwd });
    if (r.code !== 0) refuse('install', `${p.command} in ${p.dir || 'the project root'} of ${slot} failed (exit ${r.code})${r.tail ? `: ${r.tail}` : ''}`);
    entries[p.dir] = { lockfile: p.lockfile, sha256: p.sha256, command: p.command, at: now().toISOString() };
    writeJsonAtomic(depsFile(slot), { v: 1, entries });
  }
  return plan.map(({ dir, lockfile, command, action }) => ({ dir, lockfile, command, action: action === 'install' ? 'installed' : action }));
}

// spec §4 Подготовка к задаче: fetch the main checkout, a fresh turbo/<job> branch at its main branch, git clean of
// everything but the copies and node_modules, the copies and settings again, the dependencies, then the job record.
// Only a free slot (D12); every refusal changes nothing.
export function prepareSlot(root, slot, job, deps = {}) {
  const git = gitOf(deps);
  const now = deps.now || (() => new Date());
  const config = deps.config || loadConfig(root);
  if (lanesSettings(config.lanes).mode !== 'slots') refuse('mode', 'lanes.mode is checkout: lanes work in this checkout, no slots');
  const j = checkJob(job);
  const k = slotK(slot);
  const s = slotPath(root, config, k);
  let info;
  try {
    info = slotInfo(root, k, s, git);
  } catch (err) {
    refuse('broken', `slot ${k} cannot be read (${errLine(err)}): nothing was changed; look at ${s}`);
  }
  if (info.state === 'missing') refuse('missing', `slot ${k} does not exist (${s}): turbo-run lanes setup`);
  if (info.state === 'foreign') refuse('foreign', `${s} is not slot ${k} of this project: turbo never uses it`);
  if (info.state === 'busy') refuse('busy', `slot ${k} holds ${describeJob(info.record.job)}: release it first; its work is never overwritten`);
  if (info.state === 'dirty') refuse('dirty', `slot ${k} has changes no finished job explains (${info.dirty.slice(0, 10).join('; ')}${info.dirty.length > 10 ? '; …' : ''}): nothing was changed; look at ${s}`);
  const files = checkedCopies(root, config, git);
  const branch = mainBranch(root, { git });
  const prev = git(s, ['symbolic-ref', '-q', '--short', 'HEAD'], { ok: true });
  git(s, ['fetch', '-q', '--prune', 'origin']);
  const sha = git(s, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}^{commit}`]);
  const keep = ['-e', 'node_modules', ...[SETTINGS_LOCAL, ...(info.record.copied || [])].flatMap((f) => ['-e', ignoreLine(f)])];
  git(s, ['clean', '-q', '-f', '-d', '-x', ...keep]);
  git(s, ['checkout', '-q', '--no-track', '-B', j.branch, `refs/remotes/origin/${branch}`]);
  git(s, ['clean', '-q', '-f', '-d', '-x', ...keep]);
  if (prev && prev !== j.branch && prev.startsWith('turbo/')) {
    try {
      git(s, ['branch', '-q', '-D', prev], { ok: true });
    } catch (err) {
      deps.log?.(`slot ${k}: the old branch ${prev} was kept (${errLine(err)})`);
    }
  }
  refreshSlot(root, s, files, git);
  const installed = ensureDeps(s, config, { run: deps.run, now });
  const record = {
    ...readSlotRecord(s),
    job: { kind: j.kind, phase: j.phase, branch: j.branch, base: { branch, sha }, state: 'active', startedAt: now().toISOString(), endedAt: null, outcome: null },
  };
  writeSlotRecord(s, record);
  return { k, path: s, branch: j.branch, base: { branch, sha }, deps: installed, record };
}

// The job of the slot is over (L2 after the merge and green CI, L1 when a lane fails or is abandoned). The slot keeps
// its branch and files until its next prepare.
export function releaseSlot(root, slot, { outcome = 'merged', now = () => new Date(), config } = {}) {
  if (!JOB_OUTCOMES.includes(outcome)) throw new Error(`outcome must be one of ${JOB_OUTCOMES.join(', ')}`);
  const k = slotK(slot);
  const s = slotPath(root, config ?? loadConfig(root), k);
  const rec = readSlotRecord(s);
  if (!ours(rec, root) || rec.k !== k) refuse('foreign', `${s} is not slot ${k} of this project`);
  if (!rec.job || rec.job.state === 'done') return rec;
  const next = { ...rec, job: { ...rec.job, state: 'done', endedAt: now().toISOString(), outcome } };
  writeSlotRecord(s, next);
  return next;
}

// The slot whose active job is this phase's (kind phase by default; prep, or annotate with phase null). Records only:
// no git call.
export function slotForPhase(root, config, phase, { kind = 'phase' } = {}) {
  const want = phase === null || phase === undefined ? null : String(phase);
  for (const k of slotNumbers(root, config)) {
    const p = slotPath(root, config, k);
    const rec = readSlotRecord(p);
    if (ours(rec, root) && rec.k === k && rec.job?.state === 'active' && rec.job.kind === kind && (rec.job.phase ?? null) === want) return { k, path: p, record: rec };
  }
  return null;
}

// spec §5 p.4: the first slot that is free and that Claude Code trusts, or null.
export function freeSlot(root, config, deps = {}) {
  return listSlots(root, config, deps).find((s) => s.state === 'free' && trustState(s.path, { file: deps.claudeJson, platform: deps.platform }) === 'trusted') ?? null;
}

function removeLink(p) {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EISDIR') fs.rmdirSync(p);
    else throw err;
  }
}

// Links inside a slot that lead outside it (a junction into another checkout's node_modules, say) are removed first,
// as links: the recursive delete never reaches what they point to.
function unlinkOutsideLinks(dir) {
  const base = fs.realpathSync.native(dir);
  const within = (p) => {
    const r = path.relative(base, p);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  };
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        let target = null;
        try {
          target = fs.realpathSync.native(p);
        } catch {
          // a dangling link goes too
        }
        if (target === null || !within(target)) removeLink(p);
      } else if (e.isDirectory()) {
        walk(p);
      }
    }
  };
  walk(dir);
}

// turbo-run lanes remove (spec §4): only a free slot without lane branches the main branch lacks; its trust goes first
// (§4.1 rules), then its outside links, then the directory.
export function removeSlot(root, config, k, deps = {}) {
  const git = gitOf(deps);
  const s = slotPath(root, config, k);
  const info = slotInfo(root, k, s, git);
  if (info.state === 'missing') return { k, path: s, removed: false, why: 'missing', untrust: null };
  if (info.state === 'foreign') refuse('foreign', `${s} is not slot ${k} of this project: turbo never deletes it`);
  if (info.state === 'busy') refuse('busy', `slot ${k} holds ${describeJob(info.record.job)}: release it first`);
  if (info.state !== 'free') refuse('dirty', `slot ${k} has changes (${info.dirty.slice(0, 10).join('; ')}): nothing was removed; look at ${s}`);
  const branch = mainBranch(root, { git });
  git(s, ['fetch', '-q', '--prune', 'origin']);
  const unmerged = (git(s, ['for-each-ref', '--format=%(refname:short)', '--no-merged', `refs/remotes/origin/${branch}`, 'refs/heads/turbo']) || '').split(/\r?\n/).filter(Boolean);
  if (unmerged.length) refuse('unmerged', `slot ${k} has lane branches with commits ${branch} does not have (${unmerged.join(', ')}): nothing was removed; when their work is not needed, delete them in ${s} (git branch -D <branch>)`);
  const lanes = lanesSettings(config?.lanes);
  const untrust = (deps.untrust || ((p) => untrustSlot(p, { file: deps.claudeJson, write: deps.trustWrite ?? lanes.trust_write, now: deps.now })))(s);
  unlinkOutsideLinks(s);
  fs.rmSync(s, { recursive: true, force: true, maxRetries: 3 });
  return { k, path: s, removed: true, why: null, untrust };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/slots-prepare.test.mjs test/slots.test.mjs`
Expected: PASS (6 new tests; `slots.test.mjs` unchanged and green).

- [ ] **Step 5: Commit**

```bash
git add lib/slots.mjs test/slots-prepare.test.mjs
git commit -q -m "feat(lanes): prepare, release, find and remove slots; install dependencies only when a lockfile changed"
```

---

### Task 6: Answers committed in the control root under the merge lock

**Files:**
- Create: `lib/merge-lock.mjs`
- Modify: `lib/questions.mjs` (`export function withPhaseLock` → `withFileLock` + a thin `withPhaseLock`)
- Modify: `lib/answers.mjs` (imports; `answerQuestion`'s default `commit`; two new exports after `answerQuestion`)
- Test: `test/answers-control.test.mjs` (create)

**Interfaces:**
- Consumes: `stateRoot`, `locksDir` (Task 3); `commitPaths` (`lib/gates.mjs`); `answersRel`, `ANSWERS_IGNORE_REL`; `fakeSlot`, `gitIn` (Task 3 helper); `DECISION_PLAN`, `writePhase`.
- Produces:
  - `lib/questions.mjs`: `withFileLock(file, fn, { waitMs, staleMs, platform, locked, alive })` (`locked: () => Error`; `alive: (token) => boolean`, optional: a lock whose owner is alive is never taken over, however old); `withPhaseLock` unchanged in signature and behaviour;
  - `lib/merge-lock.mjs`: `MERGE_LOCK_WAIT_MS = 30000`, `MERGE_LOCK_STALE_MS = 1800000`, `class MergeLocked extends Error`, `mergeLockFile(root) → <control>/.planning/turbo/locks/merge`, `pidAlive(pid) → boolean`, `withMergeLock(root, fn, { waitMs, staleMs, platform, alive = pidAlive }) → fn's result`. A stale merge lock is taken over only when the pid in its token is dead (`process.kill(pid, 0)` throws ESRCH) **and** it is older than `staleMs`; a live owner keeps it regardless of age. **L2 must NOT hold `locks/merge` while pushing or waiting for CI**: only around the merge and its commits;
  - `lib/answers.mjs`: `commitAnswerPaths(root, paths, message, { lock = true, waitMs }) → { committed, reason? }`, `commitPendingAnswers(root, { lock = false, message }) → { committed, reason? }`.

- [ ] **Step 1: Write the failing tests**

Create `test/answers-control.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeSlot, gitIn } from './helpers/slots.mjs';
import { DECISION_PLAN, writePhase } from './helpers/plans.mjs';
import { readAnswers, refreshQuestions, withPhaseLock } from '../lib/questions.mjs';
import { answerQuestion, commitAnswerPaths, commitPendingAnswers } from '../lib/answers.mjs';
import { MergeLocked, mergeLockFile, withMergeLock } from '../lib/merge-lock.mjs';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const subject = (dir) => gitIn(dir, 'log', '-1', '--format=%s');
const files = (dir) => gitIn(dir, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n');
function lane() {
  const { control, slot } = fakeSlot();
  writePhase(slot, '32-auth', { '32-09-PLAN.md': DECISION_PLAN });
  refreshQuestions(slot, '32');
  return { control, slot };
}

test('an answer for a lane in a slot is committed in the control root, under the merge lock; the slot never holds it', () => {
  const { control, slot } = lane();
  const r = answerQuestion({ root: slot, phase: '32', id: '32-09-t2', option: 1, by: 'session', now: NOW });
  assert.deepEqual([r.status, r.commit], ['recorded', 'committed']);
  assert.equal(subject(control), 'docs(turbo): owner answer 32-09-t2 (phase 32)');
  assert.deepEqual(files(control), ['.planning/turbo/answers/.gitignore', '.planning/turbo/answers/p32.json']);
  assert.equal(fs.existsSync(path.join(slot, '.planning', 'turbo', 'answers')), false);
  assert.equal(fs.existsSync(mergeLockFile(control)), false, 'the lock is released');
  assert.equal(readAnswers(slot, '32')[0].label, 'Clerk');
});

test('main busy: the answer is recorded, not committed; commitPendingAnswers commits it later', () => {
  const { control, slot } = lane();
  const before = subject(control);
  fs.mkdirSync(path.dirname(mergeLockFile(control)), { recursive: true });
  fs.writeFileSync(mergeLockFile(control), 'held-by-a-merge');
  const r = answerQuestion({ root: slot, phase: '32', id: '32-09-t2', option: 1, by: 'session', now: NOW, commit: (paths, message) => commitAnswerPaths(slot, paths, message, { waitMs: 50 }) });
  assert.equal(r.status, 'recorded');
  assert.match(r.commit, /^not committed: main is busy: another turbo-run holds the merge lock \(merge\); try again$/);
  assert.equal(subject(control), before);
  fs.rmSync(mergeLockFile(control));
  assert.deepEqual(commitPendingAnswers(slot), { committed: true });
  assert.equal(subject(control), 'docs(turbo): owner answers');
  assert.deepEqual(commitPendingAnswers(slot), { committed: false, reason: 'no changes' });
});

test('withMergeLock: one writer at a time; a lock a crash left is taken over after its time; the phase lock still works', () => {
  const { control } = lane();
  assert.equal(withMergeLock(control, () => 'ran'), 'ran');
  assert.equal(fs.existsSync(mergeLockFile(control)), false);
  fs.writeFileSync(mergeLockFile(control), 'crashed');
  assert.throws(() => withMergeLock(control, () => 'no', { waitMs: 30 }), (e) => e instanceof MergeLocked);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(mergeLockFile(control), old, old);
  assert.equal(withMergeLock(control, () => 'taken over', { waitMs: 30 }), 'taken over');
  assert.equal(withPhaseLock(control, '32', () => 'phase'), 'phase');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/answers-control.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/merge-lock.mjs`.

- [ ] **Step 3: Implement**

`lib/questions.mjs` — replace the whole `export function withPhaseLock(root, phase, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, platform = process.platform } = {}) {` function (through its closing brace) with:

```js
// One writer at a time on a lock file, an exclusive file holding its owner's token. A writer waits up to waitMs; a
// lock older than staleMs was left by a crash and is taken over (takeOver). The lock is released only while it still
// holds this writer's token. locked() makes the error thrown after waitMs in vain.
export function withFileLock(file, fn, { waitMs, staleMs, platform = process.platform, locked }) {
  ensureDir(path.dirname(file));
  const token = `${process.pid}-${randomUUID()}`;
  const until = Date.now() + waitMs;
  for (;;) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (err) {
      if (!busy(err, platform)) throw err;
    }
    if (fd !== null) {
      try {
        fs.writeSync(fd, token);
      } catch (err) {
        fs.closeSync(fd);
        fs.rmSync(file, { force: true });
        throw err;
      }
      fs.closeSync(fd);
      break;
    }
    const seen = lockState(file);
    // a stale lock moved aside: try at once; one that cannot be moved is waited on like a live lock
    if (seen && Date.now() - seen.mtimeMs > staleMs && takeOver(file, seen, token)) continue;
    if (Date.now() >= until) throw locked();
    sleepSync(seen ? 25 : 5);
  }
  try {
    return fn();
  } finally {
    if (lockState(file)?.token === token) fs.rmSync(file, { force: true });
  }
}

// Every change to a phase's questions or answers runs inside this lock.
export function withPhaseLock(root, phase, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, platform = process.platform } = {}) {
  const file = lockFile(root, phase);
  return withFileLock(file, fn, { waitMs, staleMs, platform, locked: () => new PhaseLocked(`the questions of phase ${phase} are locked by another turbo-run (${path.basename(file)}); try again`) });
}
```

Create `lib/merge-lock.mjs`:

```js
import path from 'node:path';
import { locksDir } from './paths.mjs';
import { withFileLock } from './questions.mjs';

// spec §5, §4.2: one file lock orders every write to the main branch in the control root: a lane's merge (L2), an
// owner's answer commit (L0), the merge of prep and annotate (L3). A slot's locksDir is its control root's.
export const MERGE_LOCK_WAIT_MS = 30000;
// a merge (merge, phase.complete, state-sync, commit) takes minutes at most: an older lock is a crash's
export const MERGE_LOCK_STALE_MS = 30 * 60 * 1000;
export class MergeLocked extends Error {}
export const mergeLockFile = (root) => path.join(locksDir(root), 'merge');

export function withMergeLock(root, fn, { waitMs = MERGE_LOCK_WAIT_MS, staleMs = MERGE_LOCK_STALE_MS, platform = process.platform } = {}) {
  const file = mergeLockFile(root);
  return withFileLock(file, fn, { waitMs, staleMs, platform, locked: () => new MergeLocked(`main is busy: another turbo-run holds the merge lock (${path.basename(file)}); try again`) });
}
```

`lib/answers.mjs`:

1. Add at the top of the imports:

```js
import fs from 'node:fs';
import path from 'node:path';
import { stateRoot } from './paths.mjs';
import { withMergeLock } from './merge-lock.mjs';
```

2. In `export function answerQuestion`, replace the parameter default `commit = (paths, message) => commitPaths(root, paths, message)` with `commit = (paths, message) => commitAnswerPaths(root, paths, message)`, and extend the comment above the function with this sentence at its end: `The commit lands in the control root (a lane's slot never holds the answers) under the merge lock (spec §4.2); laneRunning means a lane commits in that same checkout (lanes.mode checkout).`

3. Right after the closing brace of `export function answerQuestion`, add:

```js
// spec §4.2: the owner's answers are committed in the control root, under the merge lock: L2's merges and these commits
// write the main branch one at a time. A held lock throws MergeLocked (answerQuestion reports it as not committed).
export function commitAnswerPaths(root, paths, message, { lock = true, waitMs } = {}) {
  const control = stateRoot(root);
  const run = () => commitPaths(control, paths, message);
  return lock ? withMergeLock(control, run, waitMs === undefined ? {} : { waitMs }) : run();
}

// Every answers file of the control root not committed yet, in one commit. L2 calls it inside its own merge lock
// (lock: false), before it checks that the main checkout is clean.
export function commitPendingAnswers(root, { lock = false, message = 'docs(turbo): owner answers' } = {}) {
  const control = stateRoot(root);
  let names = [];
  try {
    names = fs.readdirSync(path.join(control, ...answersRel('x').split('/').slice(0, -1))).filter((n) => /^p.+\.json$/.test(n));
  } catch {
    // no answers yet
  }
  return commitAnswerPaths(control, [...names.map((n) => answersRel(n.slice(1, -5))), ANSWERS_IGNORE_REL], message, { lock });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/answers-control.test.mjs test/answers.test.mjs test/questions.test.mjs`
Expected: PASS (3 new tests; `answers.test.mjs` and `questions.test.mjs` unchanged and green: `withPhaseLock` behaves as before, and outside a slot the commit still lands in `root`).

- [ ] **Step 5: Commit**

```bash
git add lib/merge-lock.mjs lib/questions.mjs lib/answers.mjs test/answers-control.test.mjs
git commit -q -m "feat(lanes): owner answers are committed in the control root under the merge lock"
```

---

### Task 7: `turbo-run lanes setup|trust|remove` and the reference

**Files:**
- Create: `lib/cli-lanes.mjs`
- Modify: `bin/turbo-run.mjs` (imports; `USAGE`; `main`'s `switch (cmd)`)
- Modify: `docs/reference.md` (new section before `## Config`; five rows in the Config table)
- Test: `test/cli-lanes.test.mjs` (create)

**Interfaces:**
- Consumes: `setupSlots`, `listSlots`, `removeSlot`, `slotPath`, `prepareSlot`, `SlotRefused` (Tasks 4–5); `trustSlot`, `trustLine`, `trustState`, `claudeJsonPath` (Task 2); `isSlot` (Task 3); `lanesSettings`, `loadConfig` (Task 1).
- Produces: `LANES_USAGE`; `runLanesCommand(args, { root, out, err, env, deps }) → 0 | 1 | 2 | 3` (D17); `turbo-run lanes …` in `bin/turbo-run.mjs`.

- [ ] **Step 1: Write the failing tests**

Create `test/cli-lanes.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { ISOLATED, mainProject, slotFixture } from './helpers/slots.mjs';
import { runLanesCommand } from '../lib/cli-lanes.mjs';
import { prepareSlot, slotPath } from '../lib/slots.mjs';
import { trustLine, trustState } from '../lib/trust.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
function lanes(root, t, args, env = {}) {
  const out = [];
  const err = [];
  const code = runLanesCommand(args, { root, out: (l) => out.push(l), err: (l) => err.push(l), env: { TURBO_LANE: '', ...env }, deps: t.deps });
  return { code, out, err };
}

test('turbo-run lanes setup creates and trusts the slots, then keeps them; remove takes the trust with it; trust and --no-trust-write', () => {
  const p = mainProject();
  const t = slotFixture(p.root);
  const s1 = slotPath(p.root, t.config, 1);
  const s2 = slotPath(p.root, t.config, 2);
  let r = lanes(p.root, t, ['setup']);
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.deepEqual(r.out, [`lane-1: created ${s1}`, 'lane-1: trusted', `lane-2: created ${s2}`, 'lane-2: trusted', `backup of ${t.claudeJson}: ${t.claudeJson}.turbo-bak-20261013T120000Z`]);
  r = lanes(p.root, t, ['setup']);
  assert.deepEqual([r.code, r.out], [0, [`lane-1: kept ${s1}`, 'lane-1: trusted (already)', `lane-2: kept ${s2}`, 'lane-2: trusted (already)']]);
  r = lanes(p.root, t, ['remove', '2']);
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.equal(r.out[0], `lane-2: removed ${s2}`);
  assert.match(r.out[1], /^backup of /);
  assert.equal(fs.existsSync(s2), false);
  assert.equal(trustState(s2, { file: t.claudeJson }), 'untrusted');
  const bytes = fs.readFileSync(t.claudeJson, 'utf8');
  r = lanes(p.root, t, ['setup', '--no-trust-write']);
  assert.equal(r.code, 3);
  assert.ok(r.out.includes(`lane-2: ${trustLine(s2)} (writing the trust is off: lanes.trust_write is false or --no-trust-write was given)`), r.out.join('\n'));
  assert.equal(fs.readFileSync(t.claudeJson, 'utf8'), bytes);
  r = lanes(p.root, t, ['trust']);
  assert.deepEqual([r.code, r.out.slice(0, 2)], [0, ['lane-1: trusted (already)', 'lane-2: trusted']]);
  assert.match(r.out[2], /^backup of /);
  prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, t.deps);
  r = lanes(p.root, t, ['remove']);
  assert.equal(r.code, 1);
  assert.match(r.err.join('\n'), /lane-1: refused: slot 1 holds phase 3 on turbo\/p3/);
  assert.equal(r.out[0], `lane-2: removed ${s2}`);
  assert.equal(fs.existsSync(s1), true);
});

test('turbo-run lanes refuses inside a lane and inside a slot; a bad subcommand prints its usage (exit 2)', () => {
  const p = mainProject();
  const t = slotFixture(p.root);
  const inLane = lanes(p.root, t, ['setup'], { TURBO_LANE: '1' });
  assert.equal(inLane.code, 1);
  assert.match(inLane.err[0], /a lane never runs it/);
  assert.equal(fs.existsSync(t.dir), false);
  lanes(p.root, t, ['setup']);
  const inSlot = lanes(slotPath(p.root, t.config, 1), t, ['setup']);
  assert.equal(inSlot.code, 1);
  assert.match(inSlot.err[0], /is a lane slot: run turbo-run lanes in the main checkout/);
  assert.equal(lanes(p.root, t, ['remove', 'x']).code, 2);
  assert.equal(lanes(p.root, t, ['trust', '1']).code, 2);
  const home = tmpDir('home');
  const u = spawnSync(process.execPath, [CLI, 'lanes'], { cwd: p.root, env: { ...ISOLATED, TURBO_LANE: '', CLAUDE_CONFIG_DIR: home }, encoding: 'utf8', windowsHide: true });
  assert.equal(u.status, 2);
  assert.match(u.stderr, /usage: turbo-run lanes setup \[--no-trust-write\] \| lanes trust \[--no-trust-write\] \| lanes remove \[<k>\]/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/cli-lanes.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/cli-lanes.mjs`.

- [ ] **Step 3: Implement**

Create `lib/cli-lanes.mjs`:

```js
import { lanesSettings, loadConfig } from './config.mjs';
import { isSlot } from './paths.mjs';
import { SlotRefused, listSlots, removeSlot, setupSlots } from './slots.mjs';
import { claudeJsonPath, trustSlot } from './trust.mjs';

export const LANES_USAGE = 'lanes setup [--no-trust-write] | lanes trust [--no-trust-write] | lanes remove [<k>]';
const errLine = (e) => String(e?.message ?? e).split(/\r?\n/)[0];

function trustText(k, t) {
  if (t.status === 'trusted') return `lane-${k}: trusted`;
  if (t.status === 'already') return `lane-${k}: trusted (already)`;
  return `lane-${k}: ${t.line} (${t.why})`;
}

function setup(root, config, d, out, err) {
  const r = setupSlots(root, config, d);
  let code = 0;
  for (const s of r.slots) {
    if (s.action === 'refused') {
      err(`lane-${s.k}: refused: ${s.why}`);
      code = 1;
      continue;
    }
    out(`lane-${s.k}: ${s.action} ${s.path}`);
    out(trustText(s.k, s.trust));
    if (s.trust.status === 'manual' && code === 0) code = 3;
  }
  if (r.backup) out(`backup of ${d.claudeJson}: ${r.backup}`);
  return code;
}

function trust(root, config, d, out) {
  const run = {};
  let code = 0;
  for (const s of listSlots(root, config, d)) {
    if (s.state === 'missing' || s.state === 'foreign') continue;
    const t = trustSlot(s.path, { file: d.claudeJson, write: d.trustWrite, run, lang: config.lang, now: d.now });
    out(trustText(s.k, t));
    if (t.status === 'manual') code = 3;
  }
  if (run.backup) out(`backup of ${d.claudeJson}: ${run.backup}`);
  return code;
}

function remove(root, config, k, d, out, err) {
  const ks = k === null ? listSlots(root, config, d).filter((s) => s.state !== 'missing' && s.state !== 'foreign').map((s) => s.k) : [k];
  let code = 0;
  for (const n of ks) {
    try {
      const r = removeSlot(root, config, n, d);
      if (!r.removed) {
        out(`lane-${n}: nothing to remove`);
        continue;
      }
      out(`lane-${n}: removed ${r.path}`);
      if (r.untrust?.status === 'manual') out(`lane-${n}: ${r.untrust.line} (${r.untrust.why})`);
      if (r.untrust?.backup) out(`backup of ${d.claudeJson}: ${r.untrust.backup}`);
    } catch (e) {
      if (!(e instanceof SlotRefused)) throw e;
      err(`lane-${n}: refused: ${e.message}`);
      code = 1;
    }
  }
  return code;
}

// spec §4, §4.1: the slot commands of the owner (and of the supervisor's start, through lib/slots.mjs directly).
// Exit 0: every slot ready; 1: a slot or the command refused; 2: usage; 3: a slot waits for the owner to accept its
// trust in Claude Code. Never inside a lane, never inside a slot.
export function runLanesCommand(args, { root, out = (l) => process.stdout.write(`${l}\n`), err = (l) => process.stderr.write(`${l}\n`), env = process.env, deps = {} } = {}) {
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project') i++;
    else if (!args[i].startsWith('--')) pos.push(args[i]);
  }
  const [sub, which, extra] = pos;
  const okWhich = which === undefined || (sub === 'remove' && /^[1-9]\d*$/.test(which));
  if (!['setup', 'trust', 'remove'].includes(sub) || !okWhich || extra !== undefined) {
    err(`usage: turbo-run ${LANES_USAGE}`);
    return 2;
  }
  if (env.TURBO_LANE) {
    err("refused: turbo-run lanes is the owner's and the supervisor's: a lane never runs it");
    return 1;
  }
  if (isSlot(root)) {
    err(`refused: ${root} is a lane slot: run turbo-run lanes in the main checkout`);
    return 1;
  }
  let config;
  let lanes;
  try {
    config = deps.config || loadConfig(root);
    lanes = lanesSettings(config.lanes);
  } catch (e) {
    err(`turbo-run lanes ${sub}: ${errLine(e)}`);
    return 1;
  }
  const claudeJson = deps.claudeJson || claudeJsonPath(env);
  const d = { ...deps, config, claudeJson, trustWrite: lanes.trust_write && !args.includes('--no-trust-write') };
  try {
    if (sub === 'setup') return setup(root, config, d, out, err);
    if (sub === 'trust') return trust(root, config, d, out);
    return remove(root, config, which === undefined ? null : Number(which), d, out, err);
  } catch (e) {
    if (!(e instanceof SlotRefused)) throw e;
    err(`turbo-run lanes ${sub}: ${e.message}`);
    return 1;
  }
}
```

`bin/turbo-run.mjs`:

1. Add after `import { attendFile, … } from '../lib/attend.mjs';`: `import { runLanesCommand } from '../lib/cli-lanes.mjs';`.
2. In `USAGE`, replace `|attend|` with `|attend|lanes|`.
3. In `main`'s `switch (cmd)`, right before `    case 'context': {`, add:

```js
    case 'lanes': {
      // spec §4, §4.1 (Stage 4 L0): the slots of this project: setup, trust, remove
      if (!root) die('no .planning directory found');
      return runLanesCommand(args, { root });
    }
```

`docs/reference.md`:

1. Right before `## Config`, add:

```markdown
## Lane slots

From v0.4 each lane works in a slot: a lasting local clone of your repository next to it, `<parent>/<repo>.turbo/lane-<k>` (`k` from 1 to `max_lanes`; `lanes.dir` moves them). `turbo-run lanes setup` creates the missing slots (`git clone --local`; a slot's `origin` is your checkout), gives each your checkout's local git identity, signing and line-ending settings, copies into it the git-ignored files that `lanes.copy` names (the `.env` files by default) and your `.claude/settings.local.json` with `worktree.baseRef: "head"` added (so GSD runs a wave's plans in parallel there), and lists those copies in the slot's `.git/info/exclude`, so they never show in its `git status` and are never committed. A file `lanes.copy` names that git does not ignore stops the setup before anything is created. A directory in a slot's place that is not a slot of this project is never touched.

Claude Code starts a background session only in a folder it trusts. `lanes setup` and `turbo-run lanes trust` write that trust for each slot into Claude Code's global config (`~/.claude.json`, or `.claude.json` in `CLAUDE_CONFIG_DIR`): one value, `projects["<slot>"].hasTrustDialogAccepted`, after a backup next to the file (`.claude.json.turbo-bak-<UTC time>`, one per command). Nothing else in the file changes. When its format is not one turbo knows, or Claude Code keeps the file busy, turbo prints `open claude in <slot> once and accept the trust dialog` and exits with code 3. `lanes.trust_write: false`, or `--no-trust-write`, never writes the file.

Before each job a slot goes to a fresh branch at your main branch (`turbo/p<N>` for a phase, `turbo/prep-<N>`, `turbo/annotate`), and git removes what the last job left, except the copied files and `node_modules`. A slot with changes that no finished job explains is never used and never cleaned: you get its path and the changed files. Dependencies are installed by the lockfile (`npm ci`, `pnpm install --frozen-lockfile` or `yarn install --immutable`, in each directory of `test.full`, through `bash -c`; `lanes.install` replaces the command) only when the lockfile changed since that slot's last install. A `node_modules` that is a link is refused: a slot never uses another checkout's dependencies.

turbo's state stays in your checkout (the control root): `.planning/turbo/run/`, `logs/`, `locks/` and your answers. The commands a lane runs in its slot find it through `TURBO_CONTROL_ROOT`, which the lane's session gets, or else through the slot's `origin`; a slot whose control root cannot be confirmed stops those commands with an error instead of keeping state itself. GSD's gate switches (`.planning/turbo/gates/`) belong to the slot. Your answers are committed in your checkout under the merge lock (`.planning/turbo/locks/merge`); when the lock stays busy, the answer is recorded and committed with the next merge.

`turbo-run lanes remove [<k>]` removes free slots (all, or slot k) and their trust; a slot with a job, with changes, or with a `turbo/` branch whose commits your main branch does not have is kept. Links inside a slot that lead outside it are removed as links first, so nothing outside the slot is deleted. `turbo-run doctor` checks the slots (`lane-slots`), their trust (`lane-trust`) and dependencies (`lane-deps`), and GSD's `git.branching_strategy` (`git-branching`, which must be `none`); none of these changes the mode. `lanes.mode: "checkout"` keeps v0.3's single lane in your checkout, without slots.
```

2. In the `## Config` table, right after the row that starts `| \`push.ci_fix_rounds\``, add:

```markdown
| `lanes.mode` | `"slots"` | `slots`: each lane in its own slot (see [Lane slots](#lane-slots)); `checkout`: v0.3's single lane in your checkout. |
| `lanes.dir` | `""` | Where the slots live; empty: `<parent>/<repo>.turbo` next to the project. A relative path counts from the project root and must lead outside it. |
| `lanes.copy` | `[".env", "*/.env", ".env.local", "*/.env.local"]` | Git-ignored files copied into each slot, as masks from the project root (`*` and `?` within one path segment, `**` across segments). A mask that matches a file git does not ignore stops `lanes setup`. |
| `lanes.install` | `""` | The command that installs dependencies in a slot, run through `bash -c` in each directory of `test.full` that has a lockfile; empty: by the lockfile. |
| `lanes.trust_write` | `true` | Write the slots' trust into Claude Code's global config (see [Lane slots](#lane-slots)); `false`: print the line for you instead. |
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/cli-lanes.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/cli-lanes.mjs bin/turbo-run.mjs docs/reference.md test/cli-lanes.test.mjs
git commit -q -m "feat(lanes): turbo-run lanes setup, trust and remove; document lane slots"
```

---

### Task 8: Doctor — `git-branching`, `lane-slots`, `lane-trust`, `lane-deps`

**Files:**
- Modify: `lib/doctor.mjs` (imports; a new function above `export function doctor`; its signature; one call)
- Test: `test/doctor.test.mjs` (imports, then append)

**Interfaces:**
- Consumes: `stateRoot` (Task 3); `lanesSettings`, `loadConfig` (Task 1); `listSlots`, `slotsDir`, `depsPlan` (Tasks 4–5); `claudeJsonPath`, `trustLine`, `trustState` (Task 2); `oneLine`, `CLAUDE_TIMEOUT_MS`, `sh`, `add` inside `doctor`.
- Produces: `doctor({ root, env, exec, claudeBin, claudeJson = claudeJsonPath(env), slotDeps = {} })`; checks `git-branching`, `lane-slots`, `lane-trust`, `lane-deps` (never in the `hard` list, never in `stage2`).

- [ ] **Step 1: Write the failing test**

In `test/doctor.test.mjs`, add after `import { doctor, supportsMods } from '../lib/doctor.mjs';`:

```js
import { mainProject, slotFixture } from './helpers/slots.mjs';
import { setupSlots, slotPath } from '../lib/slots.mjs';
import { trustLine, untrustSlot } from '../lib/trust.mjs';
```

Append:

```js
test('doctor: lane slots, their trust and dependencies, and GSD\'s branching strategy (Stage 4); none of them changes the mode', () => {
  const e = env();
  const check = (r, name) => r.checks.find((c) => c.name === name);
  // a project without slots: a passing check that says so; GSD's value unreadable: a warning
  const plain = doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec: execOk('2.1.291'), claudeBin: BIN });
  assert.equal(plain.mode, 'full');
  assert.deepEqual([check(plain, 'lane-slots').ok, check(plain, 'lane-slots').warn], [true, true]);
  assert.match(check(plain, 'lane-slots').detail, /^no slots yet in .*: turbo-run lanes setup \(start creates them\)$/);
  assert.deepEqual([check(plain, 'git-branching').ok, check(plain, 'git-branching').warn], [true, true]);

  const p = mainProject({ files: { 'package.json': '{"name":"app","private":true}\n', 'package-lock.json': '{"lockfileVersion":3}\n' } });
  const t = slotFixture(p.root);
  fs.writeFileSync(path.join(p.root, '.planning', 'turbo', 'config.json'), JSON.stringify({ max_lanes: 2, lanes: { dir: t.dir } }));
  setupSlots(p.root, t.config, t.deps);
  const branching = (v) => (cmd, args) => (args.includes('git.branching_strategy') ? `${v}\n` : execOk('2.1.291')(cmd, args));
  const run = (v = 'none') => doctor({ root: p.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec: branching(v), claudeBin: BIN, claudeJson: t.claudeJson, slotDeps: t.deps });
  let r = run();
  assert.equal(r.mode, 'full', JSON.stringify(r.checks));
  assert.deepEqual([check(r, 'git-branching').ok, check(r, 'git-branching').detail], [true, 'none']);
  assert.deepEqual([check(r, 'lane-slots').ok, check(r, 'lane-slots').detail], [true, `2 slot(s) in ${t.dir}`]);
  assert.deepEqual([check(r, 'lane-trust').ok, check(r, 'lane-trust').detail], [true, '2 slot(s) trusted']);
  assert.deepEqual([check(r, 'lane-deps').ok, check(r, 'lane-deps').warn, check(r, 'lane-deps').detail], [true, true, 'installs at the next job: lane-1 ., lane-2 .']);
  r = run('phase');
  assert.equal(check(r, 'git-branching').ok, false);
  assert.match(check(r, 'git-branching').detail, /^git\.branching_strategy is phase: .*gsd-tools config-set git\.branching_strategy none$/);
  assert.equal(r.mode, 'full');
  const s1 = slotPath(p.root, t.config, 1);
  untrustSlot(s1, { file: t.claudeJson });
  fs.appendFileSync(path.join(s1, 'README.md'), 'x\n');
  r = run();
  assert.deepEqual([check(r, 'lane-slots').ok, check(r, 'lane-slots').detail], [false, 'lane-1 dirty (1 changed path)']);
  assert.deepEqual([check(r, 'lane-trust').ok, check(r, 'lane-trust').detail], [false, trustLine(s1)]);
  assert.equal(r.mode, 'full');
  fs.writeFileSync(path.join(p.root, '.planning', 'turbo', 'config.json'), JSON.stringify({ lanes: { mode: 'checkout' } }));
  r = run('phase');
  assert.deepEqual([check(r, 'lane-slots').ok, check(r, 'lane-slots').detail], [true, 'lanes.mode checkout: one lane in this checkout, no slots']);
  assert.deepEqual([check(r, 'git-branching'), check(r, 'lane-trust'), check(r, 'lane-deps')], [undefined, undefined, undefined]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/doctor.test.mjs`
Expected: FAIL — the new test: `check(plain, 'lane-slots')` is `undefined` (`Cannot read properties of undefined (reading 'ok')`); every other test in the file passes.

- [ ] **Step 3: Implement**

`lib/doctor.mjs`:

1. Replace `import { claudeHome, gsdCoreDir } from './paths.mjs';` with `import { claudeHome, gsdCoreDir, stateRoot } from './paths.mjs';`, and `import { loadConfig, fullEntries, pushSettings } from './config.mjs';` with `import { loadConfig, fullEntries, lanesSettings, pushSettings } from './config.mjs';`. Add after the imports:

```js
import { depsPlan, listSlots, slotsDir } from './slots.mjs';
import { claudeJsonPath, trustLine, trustState } from './trust.mjs';
```

2. Right above `export function doctor(`, add:

```js
const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

// Stage 4 (spec §10): the lanes' slots, their trust and dependencies, and GSD's branching in them. Only in lanes.mode
// slots; never part of the mode (v0.3's single lane runs without slots). claude.json is read only when slots exist.
function laneChecks({ root, core, initOk, sh, add, claudeJson, slotDeps }) {
  let control;
  let config;
  let lanes;
  try {
    control = stateRoot(root);
    config = loadConfig(control);
    lanes = lanesSettings(config.lanes);
  } catch (e) {
    add('lane-slots', false, oneLine(e.message));
    return;
  }
  if (lanes.mode !== 'slots') {
    add('lane-slots', true, 'lanes.mode checkout: one lane in this checkout, no slots');
    return;
  }
  if (core && initOk) {
    let v = '';
    try {
      v = sh(process.execPath, [path.join(core, 'bin', 'gsd-tools.cjs'), 'config-get', 'git.branching_strategy', '--default', 'none', '--raw', '--cwd', control], { timeout: CLAUDE_TIMEOUT_MS }).trim();
    } catch {
      v = '';
    }
    if (!v) add('git-branching', true, 'git.branching_strategy cannot be read', { warn: true });
    else if (v === 'none') add('git-branching', true, 'none');
    else add('git-branching', false, `git.branching_strategy is ${v}: GSD would switch a slot's branch from origin/<default>; set it with gsd-tools config-set git.branching_strategy none`);
  }
  let slots;
  try {
    slots = listSlots(control, config, slotDeps).filter((s) => s.state !== 'missing');
  } catch (e) {
    add('lane-slots', false, oneLine(e.message));
    return;
  }
  const dir = slotsDir(control, config);
  if (!slots.length) {
    add('lane-slots', true, `no slots yet in ${dir}: turbo-run lanes setup (start creates them)`, { warn: true });
    return;
  }
  const paths = (n) => `${n} changed path${n === 1 ? '' : 's'}`;
  const bad = slots.filter((s) => s.state !== 'free' && s.state !== 'busy');
  add('lane-slots', !bad.length, bad.length ? bad.map((s) => `lane-${s.k} ${s.state}${s.dirty.length ? ` (${paths(s.dirty.length)})` : ''}`).join('; ') : `${slots.length} slot(s) in ${dir}`);
  const ours = slots.filter((s) => s.state !== 'foreign');
  const untrusted = ours.filter((s) => trustState(s.path, { file: claudeJson }) !== 'trusted');
  add('lane-trust', !untrusted.length, untrusted.length ? untrusted.map((s) => trustLine(s.path, config.lang)).join('; ') : `${ours.length} slot(s) trusted`);
  const pending = [];
  const links = [];
  for (const s of ours) {
    try {
      for (const p of depsPlan(s.path, config)) {
        if (p.lockfile && isLink(path.join(p.cwd, 'node_modules'))) links.push(`lane-${s.k} ${p.dir || '.'}`);
        else if (p.action === 'install') pending.push(`lane-${s.k} ${p.dir || '.'}`);
      }
    } catch (e) {
      pending.push(`lane-${s.k} (${oneLine(e.message)})`);
    }
  }
  if (links.length) add('lane-deps', false, `node_modules is a link in ${links.join(', ')}: a slot installs its own dependencies (remove the link, not its target)`);
  else if (pending.length) add('lane-deps', true, `installs at the next job: ${pending.join(', ')}`, { warn: true });
  else add('lane-deps', true, 'up to date');
}
```

3. Replace `export function doctor({ root, env = process.env, exec = execFileSync, claudeBin = resolveBin() } = {}) {` with:

```js
export function doctor({ root, env = process.env, exec = execFileSync, claudeBin = resolveBin(), claudeJson = claudeJsonPath(env), slotDeps = {} } = {}) {
```

4. Right before the line `  const stage2 = ['turbo-phase-skill', 'turbo-uat-agent', 'gsd-render-hooks'].every(`, add:

```js
  // Stage 4 (spec §10): lane slots; never part of the mode
  if (root) laneChecks({ root, core, initOk, sh, add, claudeJson, slotDeps });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/doctor.test.mjs test/lane-mode.test.mjs`
Expected: PASS (the new test; the others unchanged: the four checks are never hard, and without slots no `claude.json` is read).

- [ ] **Step 5: Commit**

```bash
git add lib/doctor.mjs test/doctor.test.mjs
git commit -q -m "feat(lanes): doctor checks the slots, their trust and dependencies, and GSD's branching strategy"
```

---

## After the last task

The controller runs the full suite once (`npm test`) before merging into `stage-4`, as the Global Constraints require. Nothing in this plan pushes, merges, tags or installs.

Live check outside CI (spec §12 facts S1, S2, with the evidence in the Stage 4 journal), on the reference project, by the controller: `turbo-run lanes setup` → `claude --bg` started with cwd = `lane-1` is accepted (no `Workspace not trusted`); `turbo-run lane-status <N> running` run in `lane-1` with `TURBO_CONTROL_ROOT` writes `run/p<N>.json` in the main checkout; `turbo-run lanes remove 1` → the slot's entry is gone from `~/.claude.json` and its backup exists.

## Spec coverage

| Spec | Task |
|---|---|
| §4 slot `<parent>/<repo>.turbo/lane-<k>`, `lanes.dir`; `git clone --local --no-checkout`, `origin` = main checkout | 4 |
| §4 copies: `.claude/settings.local.json` + `lanes.copy`, never committed, refusal for a non-ignored file; `worktree.baseRef: "head"`; project file untouched | 4 (refresh at prepare: 5) |
| §4 trust at setup (§4.1) | 2, 4, 7 |
| §4 prepare: `git fetch origin`, `checkout -B turbo/<job> origin/<main_branch>`, `clean -fdx -e <copies> -e node_modules`, only when the record is empty or `done`, else refusal, never `--force` | 5 (D12) |
| §4 `--no-transition` | L2/L1 (the lane prompt; nothing in L0) |
| §4 deps by lockfile per `test.full` directory, only on a hash change, `.git/turbo-deps.json`, no links to main's `node_modules`, `lanes.install` | 5 |
| §4 remove: only clean slots without a job; trust removed by the same rules | 5, 7 |
| §4.1 already trusted → nothing; backup per run; one key; re-read up to 5; rename retries 10 × 500 ms; tmp deleted; verify; untrust removes the entry; unknown format / failure → owner's line; `--no-trust-write`, `lanes.trust_write` | 2, 7 |
| §4.2 state in the control root (`run/`, `logs/`, `locks/`, questions, answers); `gates/` in the slot | 3 |
| §4.2 `TURBO_CONTROL_ROOT` through `--settings` `env`; discovery through `remote.origin.url` with `.planning/turbo/` | 3 |
| §4.2 every lane-side command reads and writes state in the control root | 3 (one redirect point, D3; CLI test) |
| §4.2 answers committed in `main` under the merge lock; lanes read them from the control root | 3, 6 |
| §10 `lanes.mode`, `lanes.dir`, `lanes.copy`, `lanes.install`, `lanes.trust_write` | 1, 7 (docs) |
| §10 doctor `git-branching`, `lane-slots`, `lane-trust`, `lane-deps` | 8 |
| §12 S1 (key form, EPERM retry, Claude Code's own fields), S2 (`baseRef: head`, clone), S3 (EOL: local git settings before checkout) | 2, 4 (D8) |
| §13 unit: `~/.claude.json` format and trust write on a copy; control root | 2, 3 |
| §13 real git: setup/prepare/remove, copying ignored files, deps only on a lockfile change | 4, 5 |

## Interfaces for L1–L4

Everything below is exported exactly as written; L1–L4 import these names and never re-implement them. `root` is always the control root unless a line says otherwise; `config` is `loadConfig(root)` (L1–L3 may pass a modified copy).

**Environment and files**
- `CONTROL_ENV = 'TURBO_CONTROL_ROOT'` (`lib/paths.mjs`). The supervisor launches every slot lane with `buildBgArgs({ name, prompt, systemPrompt, permissionMode, model, tmpDir, controlRoot: root })` (`lib/claude.mjs`) and `cwd` = exactly `slotPath(root, config, k)` (the path the trust was written for).
- Slot record: `<slot>/.git/turbo-lane.json` = `slotRecordFile(slot)` (`lib/paths.mjs`); shape `SlotRecord = { v: 1, k: number, path: string, control: string, createdAt: string, copied: string[], job: Job | null }`, `Job = { kind: 'phase'|'prep'|'annotate', phase: string|null, branch: string, base: { branch: string, sha: string }, state: 'active'|'done', startedAt: string, endedAt: string|null, outcome: null|'merged'|'failed'|'abandoned' }`. Written only by `lib/slots.mjs` (`setupSlots`, `prepareSlot`, `releaseSlot`); everyone else reads it with `readSlotRecord(slot)`. It is the source of truth for which slot holds which job; on a supervisor restart L1 reconciles `supervisor.json.lanes` against it (`slotForPhase`).
- Deps record: `<slot>/.git/turbo-deps.json` = `depsFile(slot)`: `{ v: 1, entries: { [dir]: { lockfile, sha256, command, at } } }`.
- Merge lock: `<control>/.planning/turbo/locks/merge` = `mergeLockFile(root)` (`lib/merge-lock.mjs`).

**Control root (`lib/paths.mjs`)**
- `controlRoot(cwd = process.cwd(), env = process.env) → string | null` — the control root of the project containing `cwd`; null outside a project; throws for a slot whose control root cannot be confirmed.
- `stateRoot(root, env = process.env) → string` — `root` itself unless `root` is a slot; then its control root (record + `TURBO_CONTROL_ROOT` or `remote.origin.url`, with `.planning/turbo/`), else throws.
- `isSlot(root) → boolean`; `slotRecordFile(slot) → string`; `localRemotePath(url) → string | null`.
- `runDir(root)`, `logsDir(root)`, `locksDir(root)` → `<stateRoot(root)>/.planning/turbo/{run,logs,locks}`; `localRunDir(root)` → `<root>/.planning/turbo/run` (the slot's own; only `lib/gates.mjs` uses it).
- How lane-side commands resolve state: a lane runs `turbo-run <cmd>` with cwd inside its slot; `bin/turbo-run.mjs` `projectArg` → `findProjectRoot(cwd)` = the slot = `root` for every handler; phase files (`.planning/phases`, plans, VERIFICATION, UAT, `config.json`, `gates/`) are read from `root`; every run/log/lock file and the answers go through `runDir`/`logsDir`/`locksDir`/`stateRoot` to the control root. So any function that takes `root` and reads a phase's files (`refreshQuestions`, `planCheckpoints`, `openPlans`, `findPhaseDir`, `phaseArtifacts`, `gapEvidence`, `stalenessReport`, …) must be given the **slot path** when the phase runs in a slot; its state still lands in the control root.

**Slots (`lib/slots.mjs`)**
- `slotsDir(root, config) → string` — `lanes.dir` resolved from `root`, or `<parent>/<repo>.turbo`.
- `slotPath(root, config, k) → string` — `<slotsDir>/lane-<k>`.
- `maxLanes(config) → number`.
- `listSlots(root, config, deps = {}) → Slot[]`, `Slot = { k: number, path: string, state: 'missing'|'free'|'busy'|'dirty'|'foreign'|'broken', record: SlotRecord|null, dirty: string[], why?: string }` — every place `1..max_lanes` plus any `lane-<k>` directory beyond; `free` = this project's slot, no active job, nothing blocking (D12); `dirty` lists the blocking `git status --porcelain` lines; `busy` lists all of them.
- `setupSlots(root, config, deps = {}) → { dir: string, slots: Array<{ k, path, action: 'created'|'kept'|'refused', why: string|null, trust: TrustResult|null }>, backup: string|null }` — throws `SlotRefused` (`mode`, `layout`, `inside`, `settings`, `copy`, `detached`) before any clone.
- `prepareSlot(root, slot, job, deps = {}) → { k, path, branch, base: { branch, sha }, deps: Array<{ dir, lockfile, command, action: 'installed'|'unchanged'|'none' }>, record: SlotRecord }` — `slot` = `k` | slot path | `Slot`; `job = { kind: 'phase'|'prep'|'annotate', phase: string|null, branch?: string }` (default branch `jobBranch(job)`); throws `SlotRefused` (`mode`, `missing`, `foreign`, `broken`, `busy`, `dirty`, `copy`, `detached`, `install`, `link`) and changes nothing on `missing`…`dirty`.
- `jobBranch(job) → 'turbo/p<N>' | 'turbo/prep-<N>' | 'turbo/annotate'`.
- `releaseSlot(root, slot, { outcome = 'merged', now, config } = {}) → SlotRecord` — `outcome ∈ JOB_OUTCOMES = ['merged', 'failed', 'abandoned']`; idempotent; L2 calls it with `merged` after the merge and green CI (or at once with `push.mode: off`), L1 with `failed`/`abandoned`.
- `slotForPhase(root, config, phase, { kind = 'phase' } = {}) → { k, path, record } | null` — the slot whose **active** job is this one (annotate: `phase` null). Records only, no git.
- `freeSlot(root, config, deps = {}) → Slot | null` — first `free` slot that Claude Code trusts (`deps.claudeJson`).
- `removeSlot(root, config, k, deps = {}) → { k, path, removed: boolean, why: string|null, untrust: TrustResult|null }` — throws `SlotRefused` (`foreign`, `busy`, `dirty`, `unmerged`, `detached`).
- `mainBranch(root, deps = {}) → string`; `depsPlan(slot, config)`; `ensureDeps(slot, config, { run, now })`; `runInstall(command, { cwd, timeout })`; `copyPlan(root, config, deps)`; `maskRegExp(mask)`; `slotGit(env)`; `readSlotRecord(slot)`; `depsFile(slot)`.
- `class SlotRefused extends Error { code }`; `JOB_KINDS = ['phase', 'prep', 'annotate']`; `SETTINGS_LOCAL = '.claude/settings.local.json'`.
- `deps` (all optional): `{ git, env, now, config, claudeJson, trustWrite, trust, untrust, run, log, platform }` — tests and L1 inject `claudeJson`, `now`, `run`, `env`.

**Trust (`lib/trust.mjs`)**
- `trustSlot(dir, { file, platform, write = true, run = {}, lang = 'en', now, sleep, rename, read } = {}) → TrustResult`, `TrustResult = { status: 'already'|'trusted'|'manual', key, backup?, why?, line? }`.
- `untrustSlot(dir, same options) → { status: 'absent'|'removed'|'manual', key, backup?, why?, line? }`.
- `trustState(dir, { file, platform, read } = {}) → 'trusted'|'untrusted'|'unknown'` — L1 checks it before launching into a slot; `'untrusted'`/`'unknown'` → the lane waits and the owner gets `trustLine(dir, lang)`.
- `trustLine(dir, lang = 'en') → string`; `trustKey(dir, platform) → string`; `claudeJsonPath(env, home) → string`.

**Answers and the merge lock**
- `withMergeLock(root, fn, { waitMs = 30000, staleMs = 1800000, platform } = {}) → ReturnType<fn>`; throws `MergeLocked` when the lock stays held (`lib/merge-lock.mjs`). L2's merge (§7.2), L3's prep/annotate merges and `commitAnswerPaths` all take it.
- `withFileLock(file, fn, { waitMs, staleMs, platform, locked }) → ReturnType<fn>` (`lib/questions.mjs`) — for L1's `turbo-run lock/unlock` mutexes in `locks/`.
- `commitAnswerPaths(root, paths, message, { lock = true, waitMs } = {}) → { committed, reason? }` and `commitPendingAnswers(root, { lock = false, message } = {}) → { committed, reason? }` (`lib/answers.mjs`). L2 calls `commitPendingAnswers(root)` inside its `withMergeLock`, before checking that `main` is clean.
- `answerQuestion({ …, laneRunning })`: `laneRunning` means "a lane commits in this same checkout" (checkout mode). L1 passes `false` while all lanes are in slots; `laneRuns` in `lib/cli-phase.mjs` (reads `supervisor.json.lane`) is L1's to update when `lane` becomes `lanes`.

**Config (`lib/config.mjs`)**
- `lanesSettings(raw = DEFAULTS.lanes) → { mode: 'slots'|'checkout', dir: string, copy: string[], install: string, trust_write: boolean }`; `LANE_MODES`. L1 adds `lanes.gates`, `max_prep`, `merge_rounds` next to these (unknown `lanes.*` keys pass through `lanesSettings` untouched).

**CLI**
- `turbo-run lanes setup [--no-trust-write] | lanes trust [--no-trust-write] | lanes remove [<k>]` (`runLanesCommand(args, { root, out, err, env, deps })`, `lib/cli-lanes.mjs`): exit 0 ready, 1 refused, 2 usage, 3 a slot waits for the owner's trust. L1's `start` calls `setupSlots` directly, not the CLI.

**Owned by L1, not written by L0** — `supervisor.json.lanes` (documented here so L0's records line up): `lanes: { [key]: { key, job: 'phase'|'prep'|'annotate', phase: string|null, slot: number, slotPath: string, branch: string, sessionId: string|null, launchedAt: string, restarts: number, notified: object, mode: 'full'|'safe' } }`, with `key` = `<N>` for a phase job, `prep-<N>` for prep, `annotate` for annotate. Invariant: an entry exists only while `slotForPhase(root, config, phase, { kind: job })` returns its `slot`; L0's slot record wins on conflict. L4 reads `supervisor.json.lanes` and `listSlots` (read-only) for the view.
