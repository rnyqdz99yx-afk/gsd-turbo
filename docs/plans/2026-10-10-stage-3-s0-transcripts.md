# gsd-turbo Stage 3 S0 — transcript data layer and `turbo-run view` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give turbo a read-only view of its lanes' subagents from Claude Code's transcripts (`lib/transcripts.mjs`) and a `turbo-run view [--json]` command that shows supervisor, range, lanes with their `/turbo-phase` step, each lane's subagents (type, plan, current action, time, tokens, state), open owner questions and the last five commits. This is the data S1 (same-agent delivery), S3 (the live-view mod) and the liveness check build on. One shared transcript finder serves `view`, S1 and `turbo-run context`.

**Architecture:** `lib/transcripts.mjs` is a pure, read-only layer over `<claude-home>/projects/` and `<claude-home>/jobs/`. It finds a session's transcript by the most exact source first: the background job's `state.json` for a lane, `CLAUDE_CODE_SESSION_ID` for the calling session, then a cwd fallback. It finds subagents across every session directory, because a fork moves them. It indexes the lane transcript incrementally for harness notifications and launched agents, reads at most a 256 KB tail of each subagent transcript, and decides each subagent's state. `lib/view.mjs` assembles one JSON-ready object from that layer, turbo's run files and git, and keeps a per-file cache in the git-ignored `.planning/turbo/run/view-cache.json`. `bin/turbo-run.mjs` routes `view` next to `status`. The secret patterns move from `lib/uat.mjs` to a shared `lib/secrets.mjs`, whose `maskSecrets` masks everything `view` prints. The last task switches `turbo-run context` to the shared finder.

**Tech Stack:** Node ≥ 20 (ESM `.mjs`, `node:test`, zero npm dependencies), git, Claude Code transcripts and job state (2.1.29x layout).

**Spec:** `docs/specs/2026-10-10-stage-3-design.md` — §4 (S0) is the scope; §1–3, §5.5 (amended in `28cfa51` after the spikes), §7, §9 and §11 define how S1 and S3 consume it.

**Base:** `main` after `fix-0.2.2-defects` and `fix-0.2.2-tests` are merged into it (the spec as of `28cfa51`; `lib/context.mjs` as of `e2184c2` on `fix-0.2.2-defects`). Existing code is referenced by function name and by anchor text, never by line number. If an anchor has moved, apply the same change next to the named code.

The code was dry-run in two scratch copies on Windows / Node 24:
- `28cfa51` with Tasks 1–8 applied: the 42 new tests passed, and so did the existing `test/uat-record.test.mjs`, `test/config.test.mjs` and `test/cli.test.mjs`. A warm `buildView` of 20 subagents in a project with 300 sessions took 25–55 ms.
- `fix-0.2.2-defects` (`40cf4a7`) with `lib/transcripts.mjs` and Task 9 applied: the 9 existing tests of `test/context.test.mjs` passed unchanged.

No Linux runner was available, so CI (Linux / Node 22) is the first Linux check.

## Transcript and job facts this plan relies on

Verified in October 2026 on Claude Code 2.1.29x transcripts and job directories. Fixtures here are synthetic and follow these shapes; no real transcript content is used anywhere.

- **T1 Layout.** A session transcript is `<claude-home>/projects/<key>/<sessionId>.jsonl`, where `<claude-home>` is `${CLAUDE_CONFIG_DIR:-~/.claude}` (`claudeHome()` in `lib/paths.mjs`). A session directory `<key>/<sessionId>/` (full UUID) holds `subagents/agent-<agentId>.jsonl` + `agent-<agentId>.meta.json` and `tool-results/`. `<key>/` also holds non-session directories such as `memory/`.
- **T2 Key.** `<key>` is the session's start directory with every character other than an ASCII letter or digit replaced by `-` (`D:\work\my project` → `D--work-my-project`; non-ASCII letters become `-` too). Claude Code cuts names above 200 characters and appends a hash of its own.
- **T3 Lane id.** `supervisor.json` `lane.sessionId` is the 8-hex background **job id** that `claude --bg` printed (`parseBgLaunch` in `lib/claude.mjs`), not a transcript UUID. The job's first transcript is named `<jobId>-….jsonl`.
- **T4 Job state.** `<claude-home>/jobs/<jobId>/state.json` holds `{ daemonShort: <jobId>, sessionId, resumeSessionId, linkScanPath, cwd, state, … }`. `sessionId` starts with the job id. Once a job has run on another transcript, `resumeSessionId` names it and `linkScanPath` is its absolute path under `<claude-home>/projects/`, while the old `<jobId>-….jsonl` stays on disk and can even look newer (one live job of seven showed this). A prefix lookup alone then reads a stale file. A job woken with `claude stop` plus a flagless `claude --bg --resume` keeps its transcript (spec §5.5.1). Right after a wake, `claude agents --json` briefly shows another session id (S1's concern, not read here).
- **T5 Calling session.** Inside a session's Bash tool, `CLAUDE_CODE_SESSION_ID` is that session's transcript UUID, and `CLAUDE_JOB_DIR` is its job directory (with `state.json`) when it runs as a background job.
- **T6 cwd.** Main-chain entries carry `cwd`. On Windows it can be in the Git Bash form `/c/Users/…/project`, and after a `cd` it can be a subdirectory of the root. A strict "cwd equals root" filter drops the session's own transcript.
- **T7 Dispatch.** An Agent call is an assistant `tool_use` block `{ type: 'tool_use', id: 'toolu_…', name: 'Agent', input: { subagent_type, description, prompt, … } }`. Its result is a `type: 'user'` entry whose top-level `toolUseResult` is `{ isAsync: true, status: 'async_launched', agentId, description, resolvedModel, prompt, outputFile, … }`. This holds for every Agent call, with or without `run_in_background`.
- **T8 Notification.** `<task-notification>\n<task-id>ID</task-id>\n<tool-use-id>…</tool-use-id>\n<output-file>…</output-file>\n<status>S</status>\n<summary>…</summary>\n[<result>…</result><usage>…</usage>]\n</task-notification>`. Status values seen: `completed`, `failed`, `killed`, `stopped`. A subagent's task id is its agentId. Background shells use short ids (for example 9 characters starting with `b`) and also send progress notifications with `<event>` and no `<status>`.
- **T9 Where the harness writes it.**
  - (a) A `type: 'user'` entry whose `message.content` is a string starting with the block and whose `origin` is `{ kind: 'task-notification', … }` (the session was idle).
  - (b) A `type: 'attachment'` entry with `attachment: { type: 'queued_command', commandMode: 'task-notification', origin: { kind: 'task-notification' }, prompt: <block> }` (delivered mid-turn; the most common form).
  - (c) `type: 'queue-operation'` lines (`operation: enqueue | remove`, `content`). These are queue bookkeeping: every enqueued notification was later delivered as (a) or (b).

  The same text also appears where the harness did not write it: assistant text, a dispatch prompt (`tool_use` input), tool results (a grep that prints a transcript) and system-prompt snapshots (`attachment.type: 'prompt_snapshot'`).
- **T10 Order.** The notification entry's `timestamp` is 100–200 ms after the subagent transcript's last entry. A `SendMessage` resume appends to the same `agent-<id>.jsonl` (spec §5.5.2).
- **T11 Subagent transcript.**
  - Entries carry `isSidechain: true`, `agentId` and `timestamp`. The first entry is the prompt (`type: 'user'`, usually 5–15 KB).
  - Assistant entries carry `message.usage` (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, …) and `message.content` blocks, `tool_use` among them (`input.file_path`, `command`, `pattern`, …).
  - The meta file has `agentType`, `description`, `toolUseId`, `spawnDepth` (1 for the session's own agents, 2+ for agents spawned by agents), `requestShape` and `model`, plus `worktreeBranch` for isolated agents. It can be rewritten later with fewer keys (`{ agentType, stoppedByUser: true }`).
- **T12 Fork.** A session fork moved a running subagent's transcript into the new session's directory; the old output file stayed empty (observed live 2026-10-10). GSD's dispatch descriptions name plans as `Execute plan 07 of phase 32` or `Continue plan 32-07 from Task 2`.

## Decisions this plan makes where the spec is open

- **D1 Harness-written notifications** (spec §4 "user record the harness generated"): T9 (a) and (b) count; (c) does not. (b) is the most common delivery: without it, most finished agents would stay `running` or `quiet`.
- **D2 Reading budget** (spec §4 "tails ≤ 256 KB per file"): every subagent transcript is read from its tail, at most 256 KB per refresh. The lane transcript is indexed incrementally instead: each byte is read once per cache lifetime, and only lines that carry a marker are parsed. A tail alone would miss completions older than its last 256 KB, and those agents would show `quiet`. The first view with an empty cache reads a lane transcript once in full.
- **D3 Resumed agents:** a notification stops counting when the agent's transcript has an entry more than 2 s after it (a `SendMessage` resume, T10). The agent then reads `running` or `quiet` again.
- **D4 Lane subagents:** the agents in the lane session's own `subagents/` directory, plus every agent its transcript launched (T7). Each is read from its newest transcript in any session directory (T12). Nested agents (`spawnDepth` > 1) report to their parent agent, never to the lane, so they are left out; a nested tree is S3's call.
- **D5 Finding a transcript** (T3–T6). One shared finder in `lib/transcripts.mjs`:
  - `laneTranscript` serves a lane read from outside it (the supervisor, `view`, S1). It tries the job's `state.json` first: `linkScanPath` (only under `<claude-home>/projects/`), then `resumeSessionId`, then `sessionId`. After that it takes the newest transcript whose name starts with the job id, first in the project's directories and then in every project directory, which covers a root reached under another spelling.
  - `findTranscript` serves the calling session, in this order: `CLAUDE_CODE_SESSION_ID` (exact id) → the job in `CLAUDE_JOB_DIR` → the given lane → the newest transcript whose newest main-chain cwd is the root or inside it (Git Bash form normalised on win32).

  A transcript found by an id is taken whatever its cwd. `view` uses `laneTranscript` only, never the environment: the mod runs `view` inside the owner's session, whose `CLAUDE_CODE_SESSION_ID` is the owner's.
- **D6 The same order as `turbo-run context`:** `findTranscript` reproduces the lookup that `fix-0.2.2-defects` (`e2184c2`) built into `lib/context.mjs`, with the same source names (`session`, `job`, `lane`, `newest`). Task 9 switches `context` to it, and its tests pass unchanged.
- **D7 Questions (contract for S1):** S1 writes `run/p<N>-questions.json` as a JSON array of the §5.1 question objects, with `state: "open"` until answered. `view` lists the open ones unchanged, in phase order.
- **D8 Lanes:** `lanes` is an array built from `supervisor.json` `lane` (one lane today; ready for more).
- **D9 Lane status:** the lane record's status when it was written since the lane launched (as the supervisor reads it), else `running`, plus a `quiet` flag from the lane transcript's mtime. `view` never runs `claude agents`: it is too slow for the budget.
- **D10 Plan and task** of a subagent come from its meta `description` (T12). They are `null` when it names none.
- **D11 Shared secret module:** spec §6 has S2 move the patterns into a shared module. S0 runs in parallel with S2 and needs masking first, so S0's Task 1 moves them: `SECRET_RULES` and `maskSecrets` go to `lib/secrets.mjs`, and `scanSecrets` stays in `lib/uat.mjs`. The S2 plan (`docs/plans/2026-10-10-stage-3-s2-push-ci.md`, Task 1) writes the same three files byte for byte, so the branches merge without a conflict whichever lands first. S2's additions (URL credentials, forbidden names) live in its own `lib/push-guard.mjs`. S0's other tests never hard-code the marker: they compare with `maskSecrets(value)`.
- **D12 Placement:** `view` lives in `bin/turbo-run.mjs` next to `status` and `context`, because it needs the daemon heartbeat check (`supAlive`) that lives there. This is an exception to stage 2's "new subcommands in `lib/cli-phase.mjs`".
- **D13 Cache:** `.planning/turbo/run/view-cache.json`, written only when `run/` already exists, so `view` never creates turbo directories in a project. A failed write is ignored.
- **D14 Budget:** the 300 ms in spec §4 is measured in-process (`buildView` with a warm cache, 20 subagents). Node start-up is outside it.
- **D15 Out of S0:**
  - Recording a new `lane.sessionId`, the supervisor half of spec §4 "sessionId change", is part of S1's wake path (§5.5.1: a woken job keeps its id; a copy is removed). S0 only finds agents across every session they appeared in.
  - `view.refresh_seconds` (spec §10) belongs to S3, which reads it for the mod and `status --watch`.

## Global Constraints

- Node ≥ 20, ESM `.mjs` only, **zero runtime npm dependencies**; tests use `node:test` and `node:assert/strict`.
- Windows and Linux (CI: Linux / Node 22; dev: Windows / Node 24):
  - build paths with `path.join` and `path.resolve`, and show them with forward slashes;
  - run child processes only with `execFileSync` and an argument array (`windowsHide: true`, a timeout), never through a shell.
- Public repository:
  - no personal names, paths, hosts, emails, private-project details or real transcript content in code, tests, fixtures or commits;
  - fixtures come from `test/helpers/transcripts.mjs`;
  - token-shaped test values are built at run time (`` `ghp_${'a'.repeat(36)}` ``), never written as literals.
- Read-only toward Claude Code:
  - nothing under `<claude-home>` is ever written, moved or deleted;
  - the `output-file` path a notification names is never used (spec §4);
  - a `linkScanPath` outside `<claude-home>/projects/` is never read;
  - `view` never runs `claude`.
- Spec values:
  - tail ≤ 256 KB per file per refresh;
  - action detail ≤ 80 characters;
  - tokens = `input + cache_creation + cache_read` of the last answer;
  - `stall_minutes` default 15;
  - ≤ 300 ms for one lane with 20 subagents (warm cache);
  - the last 5 commits.
- Every free text `view` prints (tool detail, agent description, lane reason, step notes, commit subjects) goes through `maskSecrets` from `lib/secrets.mjs`.
- `quiet` is a mark only: S0 never stops, kills or relaunches anything.
- State files are written with `writeJsonAtomic` (`lib/fsx.mjs`). `view` writes only `.planning/turbo/run/view-cache.json`.
- Testing discipline: each task runs only the test files it names. Never run the full suite (`npm test`): the controller runs it once at merge.
- Commits: one commit per task, conventional style (`feat:`, `refactor:`, `docs:`), the repository's configured identity. Never push, merge, tag or install.

## Review Focus

1. **The project root spelled differently from the path the lane session started in** (a junction or symlink, a redirected Desktop folder, another drive-letter case). Expected: the lane transcript and its subagents are still found. Pinned in Task 4 (junction fixture; lower-case spelling on Windows).
2. **Non-ASCII text (a Russian prompt, an emoji) where the 256 KB tail window or the 1 MB scan chunk splits a multibyte character.** Expected: every whole line after the split parses, and no notification or launch is missed. Pinned in Task 3 (tail) and Task 5 (scan).
3. **A long-lived project with hundreds of session directories.** Expected: a warm `view` of a lane with 20 subagents stays within 300 ms. Pinned in Task 7.
4. **Background shell tasks (`run_in_background` Bash) and their progress events in the lane transcript.** Expected: they are never listed as subagents and never change an agent's state. Pinned in Task 6.
5. **A broken `.planning/turbo/config.json` while the mod polls `view --json`.** Expected: exit 1 with a one-line error and no stack trace, so the mod can show it. Pinned in Task 8.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/secrets.mjs` | create | `SECRET_RULES` (moved from `lib/uat.mjs`), `MASK`, `maskSecrets` (S2's plan writes the same file) |
| `lib/uat.mjs` | modify | imports `SECRET_RULES`; `scanSecrets` unchanged |
| `lib/transcripts.mjs` | create | locations (keys, project and session directories, agent index); reading (tail, head, tokens, action, plan); the shared transcript finder (job state, calling session, cwd fallback); notifications and the incremental lane index; subagent snapshot and state; `laneAgents` |
| `lib/view.mjs` | create | `buildView`, `openQuestions`, `recentCommits`, `stallMs`, `formatView`, `fmtDuration`, `fmtTokens`; owns `view-cache.json` |
| `lib/config.mjs` | modify | `stall_minutes: 15` |
| `lib/context.mjs` | modify (Task 9) | its transcript lookup replaced by `findTranscript` |
| `bin/turbo-run.mjs` | modify | `view [--json]` |
| `README.md` | modify | `view` in Use, `stall_minutes` in Config |
| `test/helpers/transcripts.mjs` | create | synthetic transcript, subagent and job-state builders |
| `test/secrets.test.mjs`, `test/transcripts.test.mjs`, `test/view.test.mjs`, `test/cli-view.test.mjs` | create | tests |

## The `view --json` contract (for S1, S3 and S2)

One JSON object. Later sub-projects add keys and never change or remove these; `v` stays `1` while changes are additive.

```json
{
  "v": 1,
  "at": "2026-01-01T11:00:00.000Z",
  "supervisor": { "running": true, "pid": 4242, "finished": false, "halted": false, "failingSince": null, "updatedAt": "2026-01-01T10:59:40.000Z" },
  "range": { "from": "32", "to": "34" },
  "lanes": [{
    "phase": "32",
    "step": "execute",
    "done": ["freshness", "discuss", "prologue", "plan", "gates-off"],
    "notes": { "plan": "9 plans in 3 waves" },
    "status": "running",
    "reason": "",
    "sessionId": "1a2b3c4d",
    "mode": "full",
    "launchedAt": "2026-01-01T09:48:00.000Z",
    "elapsedMs": 4320000,
    "transcript": "/home/dev/.claude/projects/-home-dev-app/1a2b3c4d-2222-4333-8444-555555555555.jsonl",
    "lastAt": "2026-01-01T10:59:58.000Z",
    "quiet": false,
    "agents": [{
      "agentId": "a0123456789abcdef",
      "type": "gsd-executor",
      "description": "Execute plan 07 of phase 32",
      "plan": "32-07",
      "task": null,
      "model": "opus",
      "worktreeBranch": null,
      "state": "running",
      "action": { "tool": "Edit", "detail": "lib/x.mjs" },
      "startedAt": "2026-01-01T10:54:00.000Z",
      "lastAt": "2026-01-01T10:59:50.000Z",
      "elapsedMs": 360000,
      "tokens": 166000,
      "sessionId": "1a2b3c4d-2222-4333-8444-555555555555",
      "transcript": "/home/dev/.claude/projects/-home-dev-app/1a2b3c4d-2222-4333-8444-555555555555/subagents/agent-a0123456789abcdef.jsonl"
    }]
  }],
  "questions": [{ "id": "q1", "phase": "32", "plan": "32-09", "task": "3", "kind": "decision", "header": "Deploy", "question": "Deploy after green CI?", "options": [], "state": "open" }],
  "commits": [{ "sha": "a1b2c3d", "subject": "fix: lane record keeps the reason" }]
}
```

- `supervisor` is `null` without `supervisor.json`. `pid` is `null` unless the daemon is alive.
- `range` is `null` without a range.
- Lane fields:
  - `sessionId` is the job id from `supervisor.json`.
  - `transcript` is the file `laneTranscript` resolved (job state first).
  - `step` is the next `/turbo-phase` step (`nextStep`), `null` when all are done.
  - `notes` holds the `phase-step --note` texts per step; S1 writes the delivery path there.
  - `status` is the lane record's status (`running | paused-context | needs-owner | done | failed`) when written since `launchedAt`, else `running`.
  - `quiet` means the lane transcript has not been written for `stall_minutes`.
- `agents[]` lists the active ones (`running`, `quiet`) first, then the finished ones (`completed`, `stopped`, `failed`), each group newest `lastAt` first.
  - `elapsedMs` runs from the first entry to the last (finished) or to now (active).
  - `tokens` is the last answer's context.
  - `action` is the last tool call, also for finished agents.
  - `sessionId` and `transcript` name the session directory and the file the agent was found in.
- What S1 reuses from this layer:
  - its `turbo-run agent-tail <agentId>` uses `findAgentTranscript([...projectDirs(home, root), path.dirname(laneTranscript(...).file)], agentId)` and `tailEntries`;
  - its liveness check (§5.5.6) uses `laneTranscript` and the file's mtime.

---

### Task 1: Shared secret rules and masking

**Files:**
- Create: `lib/secrets.mjs`
- Modify: `lib/uat.mjs` (the `SECRET_RULES` constant and the import block)
- Test: `test/secrets.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `SECRET_RULES: Array<[rule: string, re: RegExp]>` (same entries and order as before);
  - `MASK = '[secret]'`;
  - `maskSecrets(text: unknown): string` (every match of every rule becomes `[secret]`; anything but a string reads as `''`).

  `scanSecrets` stays in `lib/uat.mjs` with its signature and behaviour.

The S2 plan (`docs/plans/2026-10-10-stage-3-s2-push-ci.md`, Task 1) writes these three files byte for byte as this task does (D11), so whichever branch lands first creates them and the other merges without a conflict. **Do not reformat, rename or reword anything in this task.** If `git ls-files lib/secrets.mjs test/secrets.test.mjs` already lists both files (S2 landed first), check that `lib/secrets.mjs` exports `SECRET_RULES`, `MASK` and `maskSecrets`, then skip to Task 2.

- [ ] **Step 1: Write the failing test**

Create `test/secrets.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASK, SECRET_RULES, maskSecrets } from '../lib/secrets.mjs';
import { scanSecrets } from '../lib/uat.mjs';

// One sample per rule, built at run time so the source holds no token-shaped literal.
const SAMPLES = {
  'private key': '-----BEGIN RSA PRIVATE KEY-----',
  'aws access key': `AKIA${'ABCDEFGHIJKLMNOP'}`,
  'github token': `ghp_${'a'.repeat(36)}`,
  'slack token': `xoxb-${'1234567890'}-abc`,
  'api key': `sk-${'A'.repeat(24)}`,
  jwt: `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`,
  'bot token': `123456789:${'A'.repeat(35)}`,
  'bearer token': `Bearer ${'x'.repeat(24)}`,
  'credential assignment': 'password=hunter2hunter2',
};

test('every secret rule has a sample, and maskSecrets replaces each match of each rule', () => {
  assert.deepEqual(SECRET_RULES.map(([rule]) => rule).sort(), Object.keys(SAMPLES).sort());
  for (const [rule, value] of Object.entries(SAMPLES)) {
    const out = maskSecrets(`before ${value} after ${value} end`);
    assert.equal(out.includes(value), false, rule);
    assert.equal(out, `before ${MASK} after ${MASK} end`, rule);
  }
});

test('maskSecrets keeps plain text and reads anything but a string as empty', () => {
  assert.equal(maskSecrets('Edit lib/x.mjs'), 'Edit lib/x.mjs');
  assert.equal(maskSecrets(undefined), '');
  assert.equal(maskSecrets(42), '');
});

test('the UAT scan still uses the shared rules', () => {
  const f = scanSecrets(['ok', SAMPLES['github token']].join('\n'));
  assert.deepEqual(f, [{ rule: 'github token', line: 2 }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/secrets.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/secrets.mjs`.

- [ ] **Step 3: Create `lib/secrets.mjs` and point `lib/uat.mjs` at it**

Create `lib/secrets.mjs`:

```js
// Secret patterns shared by every scan and mask: the UAT evidence and record scans (lib/uat.mjs) and the
// masking of what turbo-run view shows from transcripts (lib/transcripts.mjs).
export const SECRET_RULES = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['aws access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['api key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['bearer token', /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/i],
  ['credential assignment', /\b(pass(word|wd)?|secret|token|api[_-]?key)\b\s*[:=]\s*["']?[^\s"'<>]{6,}/i],
];

export const MASK = '[secret]';
// replace() with a non-global pattern replaces only the first match: global copies, built once.
const GLOBAL_RULES = SECRET_RULES.map(([, re]) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`));

// The text with every match of every rule replaced by [secret]; anything but a string reads as ''.
export function maskSecrets(text) {
  let s = typeof text === 'string' ? text : '';
  for (const re of GLOBAL_RULES) s = s.replace(re, MASK);
  return s;
}
```

In `lib/uat.mjs`:
1. Delete the whole `const SECRET_RULES = [ … ];` block. It starts with `const SECRET_RULES = [` and ends with the `['credential assignment', …],` entry and `];`, right before the comment `// a known value as written raw, URL-encoded, JSON-escaped and base64-encoded`. The rules now live, unchanged, in `lib/secrets.mjs`.
2. Add this import right after the line `import { runDir } from './paths.mjs';`:

```js
import { SECRET_RULES } from './secrets.mjs';
```

`scanSecrets` keeps using `SECRET_RULES` exactly as before.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/secrets.test.mjs test/uat-record.test.mjs`
Expected: PASS (3 new tests; `test/uat-record.test.mjs` holds the existing `scanSecrets` and `recordUat` tests).

- [ ] **Step 5: Commit**

```bash
git add lib/secrets.mjs lib/uat.mjs test/secrets.test.mjs
git commit -q -m "feat: shared secret rules in lib/secrets.mjs, and maskSecrets"
```

---

### Task 2: Where transcripts live

**Files:**
- Create: `lib/transcripts.mjs`
- Create: `test/helpers/transcripts.mjs`
- Test: `test/transcripts.test.mjs`

**Interfaces:**
- Consumes: `readJson(file, fallback)` from `lib/fsx.mjs`.
- Produces (all in `lib/transcripts.mjs`):
  - `projectKey(dir: string): string` — T2.
  - `projectDirs(home: string, root: string): string[]` — the existing `<home>/projects/<key>` directories for both spellings of the root (resolved and real path), de-duplicated. A key above 200 characters matches by prefix plus `-`.
  - `sessionTranscripts(dirs: string[], sessionId: string): Array<{ file, sessionId, mtimeMs, size }>` — every `<dir>/<name>.jsonl` whose name starts with `sessionId`, newest first. `[]` for an id outside `[A-Za-z0-9_-]{1,64}`.
  - `allProjectDirs(home: string): string[]`.
  - `agentIndex(dirs: string[]): Map<agentId, Array<{ file, sessionId }>>` — every `<dir>/<session>/subagents/agent-<id>.jsonl`.
  - `readMeta(file: string): object` — the `.meta.json` next to an agent transcript, `{}` when absent or broken.
  - `findAgentTranscript(dirs: string[], agentId: string, index?: Map): { file, sessionId, mtimeMs, size, meta } | null` — the newest file for the agent id in any session directory.
- Test helpers (`test/helpers/transcripts.mjs`), used by Tasks 2–8:
  - ids: `SESSION`, `FORK`, `AGENT`, `AGENT2`;
  - entry builders: `jsonl(entries)`, `notification(taskId, status)`, `entry.{user, note, attachedNote, queued, assistant, dispatch, launched, toolResult, agentUser}`, `usage(input, creation, read)`;
  - writers: `projectDirFor(home, root)`, `writeSession(dir, sessionId, entries)`, `DEFAULT_META`, `writeAgent(dir, sessionId, agentId, entries, meta = DEFAULT_META)`, `setMtime(file, date)`, `writeJob(home, jobId, state)`.

- [ ] **Step 1: Write the test helpers and the failing tests**

Create `test/helpers/transcripts.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { projectKey } from '../../lib/transcripts.mjs';

// Synthetic Claude Code transcripts, in the entry shapes of Claude Code 2.1.29x: a session transcript
// <home>/projects/<key>/<session>.jsonl, its subagents in <session>/subagents/agent-<id>.jsonl + .meta.json.
export const SESSION = '11111111-2222-4333-8444-555555555555';
export const FORK = '66666666-7777-4888-9999-000000000000';
export const AGENT = 'a0123456789abcdef';
export const AGENT2 = 'afedcba9876543210';

export const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

// The text the harness delivers when a background task ends.
export function notification(taskId, status) {
  return [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    '<tool-use-id>toolu_01AAAAAAAAAAAAAAAAAAAAAA</tool-use-id>',
    `<output-file>/tmp/claude/tasks/${taskId}.output</output-file>`,
    `<status>${status}</status>`,
    `<summary>Agent "work" ${status}</summary>`,
    '</task-notification>',
  ].join('\n');
}

const base = (type, ts, extra = {}) => ({ type, isSidechain: false, timestamp: ts, sessionId: SESSION, cwd: '/project', ...extra });

export const entry = {
  // a plain prompt (the lane's own prompt, or text the owner typed)
  user: (text, ts) => base('user', ts, { message: { role: 'user', content: text } }),
  // the harness's notification as a user message (the session was idle)
  note: (taskId, status, ts) => base('user', ts, { origin: { kind: 'task-notification' }, message: { role: 'user', content: notification(taskId, status) } }),
  // the harness's notification delivered mid-turn as a queued-command attachment
  attachedNote: (taskId, status, ts) => base('attachment', ts, {
    attachment: { type: 'queued_command', commandMode: 'task-notification', origin: { kind: 'task-notification' }, prompt: notification(taskId, status) },
  }),
  // the queue bookkeeping line the harness writes when it enqueues the notification
  queued: (taskId, status, ts) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, sessionId: SESSION, content: notification(taskId, status) }),
  // an assistant message; tool: { name, input } adds a tool_use block
  assistant: ({ ts, text = '', tool = null, usage = null, sidechain = false }) => base('assistant', ts, {
    isSidechain: sidechain,
    message: {
      role: 'assistant',
      model: 'claude-test',
      content: [...(text ? [{ type: 'text', text }] : []), ...(tool ? [{ type: 'tool_use', id: 'toolu_01BBBBBBBBBBBBBBBBBBBBBB', name: tool.name, input: tool.input }] : [])],
      ...(usage ? { usage } : {}),
    },
  }),
  // the Agent tool call that dispatches a background subagent
  dispatch: (toolUseId, agentType, description, prompt, ts) => base('assistant', ts, {
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { subagent_type: agentType, description, prompt } }] },
  }),
  // the Agent tool result: toolUseResult carries the agent id
  launched: (toolUseId, agentId, ts) => base('user', ts, {
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: `Async agent launched successfully. agentId: ${agentId}` }] }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId, description: 'work' },
  }),
  // any other tool result, for example a grep whose output quotes a notification
  toolResult: (toolUseId, text, ts) => base('user', ts, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } }),
  // a subagent's own entry (its transcript marks every entry as sidechain)
  agentUser: (agentId, text, ts) => base('user', ts, { isSidechain: true, agentId, message: { role: 'user', content: text } }),
};

export const usage = (input, creation, read) => ({ input_tokens: input, cache_creation_input_tokens: creation, cache_read_input_tokens: read, output_tokens: 10 });

// <home>/projects/<key of root>, created.
export function projectDirFor(home, root) {
  const dir = path.join(home, 'projects', projectKey(root));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeSession(dir, sessionId, entries) {
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, jsonl(entries));
  return file;
}

export const DEFAULT_META = { agentType: 'gsd-executor', description: 'Execute plan 07 of phase 32', spawnDepth: 1, requestShape: 'background', model: 'opus' };

// A subagent transcript and its meta file in <dir>/<sessionId>/subagents/; meta null writes none.
export function writeAgent(dir, sessionId, agentId, entries, meta = DEFAULT_META) {
  const sub = path.join(dir, sessionId, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(sub, `agent-${agentId}.jsonl`);
  fs.writeFileSync(file, jsonl(entries));
  if (meta) fs.writeFileSync(path.join(sub, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  return file;
}

export const setMtime = (file, date) => fs.utimesSync(file, date, date);

// A background job's state as Claude Code keeps it, <home>/jobs/<job id>/state.json; returns the job directory.
export function writeJob(home, jobId, state) {
  const dir = path.join(home, 'jobs', jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ daemonShort: jobId, template: 'bg', ...state }));
  return dir;
}
```

Create `test/transcripts.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { AGENT, AGENT2, FORK, SESSION, entry, projectDirFor, setMtime, writeAgent, writeSession } from './helpers/transcripts.mjs';
import { agentIndex, findAgentTranscript, projectDirs, projectKey, sessionTranscripts } from '../lib/transcripts.mjs';

const T0 = '2026-01-01T10:00:00.000Z';

// A project root and a Claude home with the project's transcript directory.
function setup() {
  const base = tmpDir('tr');
  const root = path.join(base, 'my project.v2');
  fs.mkdirSync(root);
  const home = path.join(base, 'home');
  return { root, home, dir: projectDirFor(home, root) };
}

test('projectKey turns every character but ASCII letters and digits into a dash', () => {
  assert.equal(projectKey('D:\\work\\my project.v2'), 'D--work-my-project-v2');
  assert.equal(projectKey('/home/dev/app_x'), '-home-dev-app-x');
  assert.equal(projectKey('/srv/проект'), '-srv-------');
});

test('projectDirs finds the project directory, and only an existing one', () => {
  const { root, home, dir } = setup();
  assert.deepEqual(projectDirs(home, root), [dir]);
  assert.deepEqual(projectDirs(path.join(home, 'missing'), root), []);
});

test('a key longer than 200 characters matches the directories named with its first 200 and a hash suffix', () => {
  const base = tmpDir('trl');
  const root = path.join(base, 'x'.repeat(230));
  fs.mkdirSync(root);
  const home = path.join(base, 'home');
  const long = projectKey(root);
  const hashed = path.join(home, 'projects', `${long.slice(0, 200)}-1a2b3c`);
  fs.mkdirSync(hashed, { recursive: true });
  fs.mkdirSync(path.join(home, 'projects', `${long.slice(0, 199)}`), { recursive: true });
  assert.deepEqual(projectDirs(home, root), [hashed]);
});

test('sessionTranscripts matches the full id or the prefix claude --bg printed, newest first', () => {
  const { dir } = setup();
  const a = writeSession(dir, SESSION, [entry.user('go', T0)]);
  const other = writeSession(dir, FORK, [entry.user('go', T0)]);
  setMtime(a, new Date('2026-01-01T10:00:00Z'));
  setMtime(other, new Date('2026-01-01T11:00:00Z'));
  assert.deepEqual(sessionTranscripts([dir], SESSION).map((t) => t.sessionId), [SESSION]);
  assert.deepEqual(sessionTranscripts([dir], SESSION.slice(0, 8)).map((t) => t.file), [a]);
  assert.equal(sessionTranscripts([dir], '').length, 0);
  assert.equal(sessionTranscripts([dir], '../x').length, 0);
});

test('a forked session moved the subagent: it is found by id in any session directory, newest file first', () => {
  const { dir } = setup();
  const old = writeAgent(dir, SESSION, AGENT, [entry.agentUser(AGENT, 'task', T0)]);
  const moved = writeAgent(dir, FORK, AGENT, [entry.agentUser(AGENT, 'task', T0)], { agentType: 'gsd-executor', description: 'moved' });
  writeAgent(dir, SESSION, AGENT2, [entry.agentUser(AGENT2, 'task', T0)]);
  setMtime(old, new Date('2026-01-01T10:00:00Z'));
  setMtime(moved, new Date('2026-01-01T12:00:00Z'));
  fs.mkdirSync(path.join(dir, 'memory'));
  const index = agentIndex([dir]);
  assert.deepEqual([...index.keys()].sort(), [AGENT, AGENT2].sort());
  const found = findAgentTranscript([dir], AGENT, index);
  assert.equal(found.file, moved);
  assert.equal(found.sessionId, FORK);
  assert.equal(found.meta.description, 'moved');
  assert.equal(findAgentTranscript([dir], 'a-missing'), null);
  assert.equal(findAgentTranscript([dir], '../../etc'), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/transcripts.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/transcripts.mjs`.

- [ ] **Step 3: Create `lib/transcripts.mjs` with the location functions**

```js
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './fsx.mjs';

// Session ids, their prefixes and agent ids only ever name files inside a transcript directory.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Claude Code cuts longer directory names at 200 characters and appends a hash of its own.
const KEY_MAX = 200;

const listNames = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const listDirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };
const statOf = (file) => { try { return fs.statSync(file); } catch { return null; } };

// Claude Code's directory name for a project under <claude-home>/projects: every character other than an
// ASCII letter or digit becomes '-'.
export function projectKey(dir) {
  return String(dir).replace(/[^A-Za-z0-9]/g, '-');
}

// The transcript directories of a project: one per spelling of its root (as resolved, and its real path), each
// only when it exists. A key longer than 200 characters matches every directory named with its first 200 and a
// '-' (Claude Code's hash suffix follows).
export function projectDirs(home, root) {
  const base = path.join(home, 'projects');
  const spellings = new Set([path.resolve(root)]);
  try { spellings.add(fs.realpathSync.native(root)); } catch { /* a missing root keeps its resolved spelling */ }
  const found = new Map();
  const add = (dir) => {
    if (!statOf(dir)?.isDirectory()) return;
    let real = dir;
    try { real = fs.realpathSync.native(dir); } catch { /* keep the joined path */ }
    found.set(process.platform === 'win32' ? real.toLowerCase() : real, dir);
  };
  for (const key of [...spellings].map(projectKey)) {
    if (key.length <= KEY_MAX) add(path.join(base, key));
    else for (const n of listNames(base)) if (n.startsWith(`${key.slice(0, KEY_MAX)}-`)) add(path.join(base, n));
  }
  return [...found.values()];
}

// The transcripts of one session, newest first: <dir>/<id>.jsonl whose name starts with sessionId, the full id or
// the prefix claude --bg printed (supervisor.json lane.sessionId). [{ file, sessionId, mtimeMs, size }].
export function sessionTranscripts(dirs, sessionId) {
  if (!SAFE_ID.test(String(sessionId))) return [];
  const found = [];
  for (const dir of dirs) {
    for (const n of listNames(dir)) {
      if (!n.endsWith('.jsonl') || !n.startsWith(sessionId)) continue;
      const file = path.join(dir, n);
      const st = statOf(file);
      if (st?.isFile()) found.push({ file, sessionId: n.slice(0, -'.jsonl'.length), mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Every project directory under <claude-home>/projects.
export function allProjectDirs(home) {
  const base = path.join(home, 'projects');
  return listDirs(base).map((n) => path.join(base, n));
}

// Every subagent transcript of the project: agentId -> [{ file, sessionId }], from
// <dir>/<session>/subagents/agent-<id>.jsonl in every session directory.
export function agentIndex(dirs) {
  const index = new Map();
  for (const dir of dirs) {
    for (const session of listDirs(dir)) {
      const sub = path.join(dir, session, 'subagents');
      for (const n of listNames(sub)) {
        const m = /^agent-([A-Za-z0-9_-]{1,64})\.jsonl$/.exec(n);
        if (!m) continue;
        if (!index.has(m[1])) index.set(m[1], []);
        index.get(m[1]).push({ file: path.join(sub, n), sessionId: session });
      }
    }
  }
  return index;
}

// The subagent's meta file (agentType, description, model, worktreeBranch, spawnDepth); {} when absent or broken.
export function readMeta(file) {
  const m = readJson(file.replace(/\.jsonl$/, '.meta.json'), null);
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

// The newest transcript of a subagent in any session directory of the project: a session fork moves a running
// subagent's transcript into the new session's directory. The output_file a notification names is never used.
// Returns { file, sessionId, mtimeMs, size, meta } or null.
export function findAgentTranscript(dirs, agentId, index = null) {
  if (!SAFE_ID.test(String(agentId))) return null;
  let best = null;
  for (const c of (index || agentIndex(dirs)).get(agentId) || []) {
    const st = statOf(c.file);
    if (st?.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { ...c, mtimeMs: st.mtimeMs, size: st.size };
  }
  return best && { ...best, meta: readMeta(best.file) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/transcripts.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/transcripts.mjs test/helpers/transcripts.mjs test/transcripts.test.mjs
git commit -q -m "feat: transcripts — project and session directories, subagents found by id in any session"
```

---

### Task 3: Reading a transcript — tail, head, tokens, current action, plan

**Files:**
- Modify: `lib/transcripts.mjs` (an import, then append)
- Test: `test/transcripts.test.mjs` (the two imports at the top, then append)

**Interfaces:**
- Consumes: `maskSecrets` (Task 1); the helpers `jsonl` and `usage` (Task 2).
- Produces:
  - `TAIL_MAX = 262144`.
  - `tailEntries(file, { max = TAIL_MAX } = {}): { entries: object[], read: number }` — the entries of the last `max` bytes, oldest first. The partial first line is dropped and unparsable lines are skipped.
  - `headEntry(file, { max = TAIL_MAX } = {}): object | null` — the first entry, `null` when its line does not end within `max`.
  - `contextTokens(usage): number | null` — `input + cache_creation + cache_read`, `null` when 0 or absent. This is the sum `turbo-run context` also uses (Task 9).
  - `actionOf(toolUse, root = ''): { tool: string, detail: string }` — `detail` is the first describing input field (`file_path`, `notebook_path`, `path`, `command`, `pattern`, `url`, `query`, `skill`, `description`, `prompt`). A path is shown relative to `root` when inside it. Whitespace is collapsed and secrets masked. At most 80 characters: a path keeps its end, anything else its start.
  - `planOf(description): { plan: string | null, task: string | null }`.

- [ ] **Step 1: Write the failing tests**

In `test/transcripts.test.mjs`, replace the two import lines from `./helpers/transcripts.mjs` and `../lib/transcripts.mjs` with:

```js
import { AGENT, AGENT2, FORK, SESSION, entry, jsonl, projectDirFor, setMtime, usage, writeAgent, writeSession } from './helpers/transcripts.mjs';
import { TAIL_MAX, actionOf, agentIndex, contextTokens, findAgentTranscript, headEntry, planOf, projectDirs, projectKey, sessionTranscripts, tailEntries } from '../lib/transcripts.mjs';
```

Append to `test/transcripts.test.mjs`:

```js
test('tailEntries parses at most the last 256 KB and drops the line the window starts inside', () => {
  const { dir } = setup();
  const file = path.join(dir, 'big.jsonl');
  const filler = entry.user('x'.repeat(1000), T0);
  const lines = [entry.user('first', T0)];
  for (let i = 0; i < 400; i++) lines.push(filler);
  lines.push(entry.user('last', '2026-01-01T10:05:00.000Z'));
  fs.writeFileSync(file, jsonl(lines) + '{"broken": ');
  const { entries, read } = tailEntries(file);
  assert.equal(read, TAIL_MAX);
  assert.ok(fs.statSync(file).size > TAIL_MAX);
  assert.equal(entries.at(-1).message.content, 'last');
  assert.ok(entries.every((e) => e.message.content !== 'first'));
  assert.ok(entries.length < 400);
});

test('a tail window that starts inside a multibyte character still parses every whole line after it (Review Focus 2)', () => {
  const { dir } = setup();
  const file = path.join(dir, 'utf8.jsonl');
  for (const pad of ['', 'x']) {
    fs.writeFileSync(file, jsonl([entry.user(`${pad}${'я'.repeat(200000)}`, T0), entry.user('готово ✓', T0), entry.user('ещё строка', T0)]));
    assert.deepEqual(tailEntries(file).entries.map((e) => e.message.content), ['готово ✓', 'ещё строка'], `pad "${pad}"`);
  }
});

test('headEntry reads the first entry; null when the first line does not end within the window', () => {
  const { dir } = setup();
  const file = path.join(dir, 'h.jsonl');
  fs.writeFileSync(file, jsonl([entry.user('first', T0), entry.user('second', '2026-01-01T10:01:00.000Z')]));
  assert.equal(headEntry(file).timestamp, T0);
  fs.writeFileSync(file, jsonl([entry.user('y'.repeat(2000), T0)]));
  assert.equal(headEntry(file, { max: 1024 }), null);
  assert.equal(headEntry(file).timestamp, T0);
});

test('contextTokens adds input, cache creation and cache read; nothing counted is null', () => {
  assert.equal(contextTokens(usage(2, 245, 165000)), 165247);
  assert.equal(contextTokens({ output_tokens: 500 }), null);
  assert.equal(contextTokens(undefined), null);
});

test('actionOf: a path inside the root is relative, a command keeps its start, secrets are masked, 80 characters at most', () => {
  const root = tmpDir('act');
  assert.deepEqual(actionOf({ name: 'Edit', input: { file_path: path.join(root, 'lib', 'x.mjs'), old_string: 'a' } }, root), { tool: 'Edit', detail: 'lib/x.mjs' });
  assert.deepEqual(actionOf({ name: 'Read', input: { file_path: path.join(root, '..', 'elsewhere', 'y.md') } }, root).detail, path.join(root, '..', 'elsewhere', 'y.md').replace(/\\/g, '/'));
  const long = actionOf({ name: 'Bash', input: { command: `node --test   test/a.test.mjs\n${'z'.repeat(200)}`, description: 'run tests' } }, root);
  assert.equal(long.detail.length, 80);
  assert.ok(long.detail.startsWith('node --test test/a.test.mjs z'));
  assert.ok(long.detail.endsWith('…'));
  const deep = actionOf({ name: 'Write', input: { file_path: path.join(root, ...Array(30).fill('dir'), 'end.mjs') } }, root);
  assert.equal(deep.detail.length, 80);
  assert.ok(deep.detail.startsWith('…') && deep.detail.endsWith('dir/end.mjs'));
  const secret = `ghp_${'a'.repeat(36)}`;
  assert.equal(actionOf({ name: 'Bash', input: { command: `curl -H "Authorization: token ${secret}" x` } }, root).detail.includes(secret), false);
  assert.deepEqual(actionOf({ name: 'Skill', input: { skill: 'gsd-execute-phase' } }), { tool: 'Skill', detail: 'gsd-execute-phase' });
  assert.deepEqual(actionOf({ name: 'TodoWrite', input: { todos: [] } }), { tool: 'TodoWrite', detail: '' });
});

test('planOf reads the plan and task GSD dispatch descriptions name', () => {
  assert.deepEqual(planOf('Execute plan 07 of phase 32'), { plan: '32-07', task: null });
  assert.deepEqual(planOf('Execute plan 3 of phase 4.1'), { plan: '4.1-3', task: null });
  assert.deepEqual(planOf('Continue plan 32-07 from Task 2'), { plan: '32-07', task: '2' });
  assert.deepEqual(planOf('Verify phase 32 goal achievement'), { plan: null, task: null });
  assert.deepEqual(planOf(undefined), { plan: null, task: null });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/transcripts.test.mjs`
Expected: FAIL with `SyntaxError: The requested module '../lib/transcripts.mjs' does not provide an export named 'TAIL_MAX'`.

- [ ] **Step 3: Implement the reading functions**

In `lib/transcripts.mjs`, add after `import { readJson } from './fsx.mjs';`:

```js
import { maskSecrets } from './secrets.mjs';
```

Append to `lib/transcripts.mjs`:

```js
// What one refresh parses of a transcript: its tail, at most this many bytes (spec §4).
export const TAIL_MAX = 256 * 1024;
const DETAIL_MAX = 80;
// Input fields that describe a tool call, most telling first: a file path, else the start of a command or pattern.
const DETAIL_KEYS = ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query', 'skill', 'description', 'prompt'];
const PATH_KEYS = new Set(['file_path', 'notebook_path', 'path']);

const parseLine = (line) => {
  if (!line.trim()) return null;
  try {
    const e = JSON.parse(line);
    return e && typeof e === 'object' && !Array.isArray(e) ? e : null;
  } catch {
    return null;
  }
};

function readSlice(file, from, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const got = fs.readSync(fd, buf, 0, length, from);
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

// The entries of the last `max` bytes of a transcript, oldest first: a line the window starts inside is dropped, and
// lines that do not parse are skipped. Returns { entries, read } (read: bytes read).
export function tailEntries(file, { max = TAIL_MAX } = {}) {
  const size = fs.statSync(file).size;
  const n = Math.min(size, max);
  const buf = readSlice(file, size - n, n);
  const lines = buf.toString('utf8').split('\n');
  if (n < size) lines.shift();
  return { entries: lines.map(parseLine).filter(Boolean), read: buf.length };
}

// The first entry of a transcript, read from at most `max` bytes; null when its line is longer or does not parse.
export function headEntry(file, { max = TAIL_MAX } = {}) {
  const buf = readSlice(file, 0, Math.min(fs.statSync(file).size, max));
  const end = buf.indexOf(0x0a);
  if (end < 0 && buf.length === max) return null;
  return parseLine(buf.subarray(0, end < 0 ? buf.length : end).toString('utf8'));
}

// Context in use after an assistant message: the prompt side of its usage, cache included (spec §4); null without.
export function contextTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);
  return n > 0 ? n : null;
}

// A file path relative to the root when it lies inside it, with forward slashes; any other path as written.
function shownPath(p, root) {
  if (!root) return p.replace(/\\/g, '/');
  const rel = path.relative(root, path.resolve(root, p));
  if (!rel) return '.';
  const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return (outside ? p : rel).replace(/\\/g, '/');
}

// A tool call in short (spec §4): { tool, detail }. detail is the first describing input field, whitespace collapsed,
// secrets masked, at most 80 characters (a path keeps its end, anything else its start).
export function actionOf(toolUse, root = '') {
  const input = toolUse?.input && typeof toolUse.input === 'object' ? toolUse.input : {};
  const key = DETAIL_KEYS.find((k) => typeof input[k] === 'string' && input[k].trim());
  const isPath = PATH_KEYS.has(key);
  let detail = key ? input[key] : '';
  if (isPath) detail = shownPath(detail, root);
  detail = maskSecrets(detail.replace(/\s+/g, ' ').trim());
  if (detail.length > DETAIL_MAX) detail = isPath ? `…${detail.slice(-(DETAIL_MAX - 1))}` : `${detail.slice(0, DETAIL_MAX - 1)}…`;
  return { tool: String(toolUse?.name || '?').slice(0, 40), detail };
}

// The plan and task a GSD dispatch description names: "Execute plan 07 of phase 32" -> 32-07, "Continue plan 32-07
// from Task 2" -> 32-07 and task 2. null where it names none.
export function planOf(description) {
  const d = typeof description === 'string' ? description : '';
  const full = /\bplan\s+(\d+(?:\.\d+)*[A-Z]?-\d+[A-Za-z]?)\b/i.exec(d);
  const short = full ? null : /\bplan\s+(\d+[A-Za-z]?)\s+of\s+phase\s+(\d+(?:\.\d+)*[A-Z]?)\b/i.exec(d);
  const task = /\btask\s+(\d+)\b/i.exec(d);
  return { plan: full ? full[1] : short ? `${short[2]}-${short[1]}` : null, task: task ? task[1] : null };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/transcripts.test.mjs`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/transcripts.mjs test/transcripts.test.mjs
git commit -q -m "feat: transcripts — bounded tail and head reads, context tokens, current action, plan of a dispatch"
```

---

### Task 4: Finding a session's transcript — job state, calling session, cwd

**Files:**
- Modify: `lib/transcripts.mjs` (an import, then append)
- Test: `test/transcripts.test.mjs` (the two imports at the top, then append)

**Interfaces:**
- Consumes: `dirKey` (`lib/paths.mjs`); `sessionTranscripts`, `projectDirs`, `allProjectDirs`, `statOf`, `listNames`, `SAFE_ID` (Task 2; the last three are module-private); `tailEntries`, `TAIL_MAX` (Task 3); the helper `writeJob`.
- Produces:
  - `normalCwd(cwd, platform = process.platform): string` — the Git Bash `/c/…` form becomes `C:/…` on win32, and backslashes become slashes.
  - `cwdInside(cwd, root): boolean` — the cwd is the root or below it.
  - `jobState(home, jobId): object | null` — `<home>/jobs/<jobId>/state.json`.
  - `laneTranscript({ home, root, jobId }): { file, sessionId, via: 'job-link' | 'job-session' | 'job-prefix' } | null` — D5.
  - `findTranscript({ home, root, env = process.env, lane = '' }): { file, sessionId, via: 'session' | 'job' | 'lane' | 'newest' } | null` — D5 and D6.

- [ ] **Step 1: Write the failing tests**

In `test/transcripts.test.mjs`, replace the two import lines from `./helpers/transcripts.mjs` and `../lib/transcripts.mjs` with:

```js
import { AGENT, AGENT2, FORK, SESSION, entry, jsonl, projectDirFor, setMtime, usage, writeAgent, writeJob, writeSession } from './helpers/transcripts.mjs';
import { TAIL_MAX, actionOf, agentIndex, contextTokens, cwdInside, findAgentTranscript, findTranscript, headEntry, jobState, laneTranscript, normalCwd, planOf, projectDirs, projectKey, sessionTranscripts, tailEntries } from '../lib/transcripts.mjs';
```

Append to `test/transcripts.test.mjs`:

```js
test('normalCwd turns a Git Bash path into a Windows one on win32 only; cwdInside accepts the root and directories below it', () => {
  assert.equal(normalCwd('/c/work/app', 'win32'), 'C:/work/app');
  assert.equal(normalCwd('/d', 'win32'), 'D:/');
  assert.equal(normalCwd('D:\\work\\app', 'win32'), 'D:/work/app');
  assert.equal(normalCwd('/cache/x', 'win32'), '/cache/x');
  assert.equal(normalCwd('/c/work/app', 'linux'), '/c/work/app');
  const { root } = setup();
  // the spelling Git Bash gives the root on Windows; elsewhere the root as is
  const shell = process.platform === 'win32' ? root.replace(/^([A-Za-z]):\\/, (m, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : root;
  assert.ok(cwdInside(root, root));
  assert.ok(cwdInside(`${shell}/lib/sub`, root));
  assert.equal(cwdInside(`${root}-other`, root), false);
  assert.equal(cwdInside(path.dirname(root), root), false);
  assert.equal(cwdInside(null, root), false);
});

const JOB = '1a2b3c4d';
const STALE = `${JOB}-2222-4333-8444-555555555555`;
const CURRENT = '99999999-8888-4777-8666-555555555555';

test('a lane resumed onto another transcript: the job state wins over the stale file its job id prefixes', () => {
  const { root, home, dir } = setup();
  const stale = writeSession(dir, STALE, [entry.user('first run', T0)]);
  const current = writeSession(dir, CURRENT, [entry.user('resumed', T0)]);
  setMtime(stale, new Date('2026-01-01T12:00:00Z')); // newer than the current one: a prefix lookup alone would pick it
  setMtime(current, new Date('2026-01-01T11:00:00Z'));
  writeJob(home, JOB, { sessionId: STALE, resumeSessionId: CURRENT, linkScanPath: current });
  assert.deepEqual(laneTranscript({ home, root, jobId: JOB }), { file: current, sessionId: CURRENT, via: 'job-link' });
  writeJob(home, JOB, { sessionId: STALE, resumeSessionId: CURRENT, linkScanPath: path.join(dir, 'gone.jsonl') });
  assert.deepEqual(laneTranscript({ home, root, jobId: JOB }), { file: current, sessionId: CURRENT, via: 'job-session' });
  // a linkScanPath outside <claude-home>/projects/ is never read
  const outside = path.join(path.dirname(home), 'elsewhere.jsonl');
  fs.writeFileSync(outside, '');
  writeJob(home, JOB, { sessionId: STALE, resumeSessionId: CURRENT, linkScanPath: outside });
  assert.deepEqual(laneTranscript({ home, root, jobId: JOB }), { file: current, sessionId: CURRENT, via: 'job-session' });
  fs.rmSync(path.join(home, 'jobs'), { recursive: true });
  assert.deepEqual(laneTranscript({ home, root, jobId: JOB }), { file: stale, sessionId: STALE, via: 'job-prefix' });
  assert.equal(laneTranscript({ home, root, jobId: '../x' }), null);
  assert.equal(jobState(home, JOB), null);
});

test('a root spelled differently from the path the lane started in: the lane transcript is still found (Review Focus 1)', () => {
  const base = tmpDir('trj');
  const real = path.join(base, 'real');
  const link = path.join(base, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, 'junction'); // a junction on Windows (no admin needed); the type is ignored elsewhere
  const home = path.join(base, 'home');
  const dir = projectDirFor(home, link); // Claude Code names the directory after the path the session started in
  const file = writeSession(dir, STALE, [entry.user('go', T0)]);
  assert.deepEqual(projectDirs(home, real), []);
  assert.deepEqual(laneTranscript({ home, root: real, jobId: JOB }), { file, sessionId: STALE, via: 'job-prefix' });
  assert.equal(laneTranscript({ home, root: real, jobId: 'feedbeef' }), null);
  assert.deepEqual(projectDirs(home, link), [dir]);
  if (process.platform === 'win32') assert.equal(projectDirs(home, link.toLowerCase()).length, 1);
});

test('findTranscript: the calling session (CLAUDE_CODE_SESSION_ID), its job (CLAUDE_JOB_DIR), the lane, then the newest transcript whose cwd is in the root', () => {
  const { root, home, dir } = setup();
  const otherRoot = path.join(path.dirname(root), 'other project');
  const other = projectDirFor(home, otherRoot);
  // Git Bash spells the root /c/… on Windows, and Bash may have moved into a subfolder
  const shell = process.platform === 'win32' ? root.replace(/^([A-Za-z]):\\/, (m, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : root;
  const mine = writeSession(dir, CURRENT, [{ ...entry.user('hi', T0), cwd: `${shell}/lib` }]);
  const laneFile = writeSession(dir, STALE, [entry.user('lane', T0)]);
  const foreign = writeSession(other, FORK, [{ ...entry.user('hi', T0), cwd: otherRoot }]);
  setMtime(mine, new Date('2026-01-01T10:00:00Z'));
  setMtime(laneFile, new Date('2026-01-01T09:00:00Z'));
  setMtime(foreign, new Date('2026-01-01T11:00:00Z'));
  // an id needs no cwd check: here it names the other project's transcript, and it comes before a recorded lane
  assert.deepEqual(findTranscript({ home, root, env: { CLAUDE_CODE_SESSION_ID: FORK }, lane: JOB }), { file: foreign, sessionId: FORK, via: 'session' });
  // a session id is exact: a mere prefix of a transcript's name names no session
  assert.deepEqual(findTranscript({ home, root, env: { CLAUDE_CODE_SESSION_ID: '99999999' }, lane: JOB }), { file: laneFile, sessionId: STALE, via: 'lane' });
  const jobDir = writeJob(home, 'feedbeef', { sessionId: 'feedbeef-0000-4000-8000-000000000000', resumeSessionId: CURRENT, linkScanPath: mine });
  assert.deepEqual(findTranscript({ home, root, env: { CLAUDE_JOB_DIR: jobDir }, lane: JOB }), { file: mine, sessionId: CURRENT, via: 'job' });
  assert.deepEqual(findTranscript({ home, root, env: {} }), { file: mine, sessionId: CURRENT, via: 'newest' });
  assert.equal(findTranscript({ home, root: path.join(path.dirname(root), 'third'), env: {} }), null);
});

test('the newest-transcript fallback reads past a last line longer than the tail window', () => {
  const { root, home, dir } = setup();
  const file = writeSession(dir, CURRENT, [{ ...entry.user('hi', T0), cwd: root }, { ...entry.user('z'.repeat(600 * 1024), T0), cwd: undefined }]);
  assert.deepEqual(findTranscript({ home, root, env: {} }), { file, sessionId: CURRENT, via: 'newest' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/transcripts.test.mjs`
Expected: FAIL with `SyntaxError: The requested module '../lib/transcripts.mjs' does not provide an export named …` (one of `cwdInside`, `findTranscript`, `jobState`, `laneTranscript`, `normalCwd`).

- [ ] **Step 3: Implement the finder**

In `lib/transcripts.mjs`, add after `import { readJson } from './fsx.mjs';`:

```js
import { dirKey } from './paths.mjs';
```

Append to `lib/transcripts.mjs`:

```js
// The newest-transcript fallback of findTranscript: how many transcripts it looks at, newest first, and how far back it
// reads one for a cwd (the window grows past a long last line).
const CWD_SCAN_MAX = 50;
const CWD_TAIL_MAX = 16 * 1024 * 1024;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Git Bash spells a Windows path /c/Users/…; on win32 that is C:/Users/…. Backslashes become slashes.
export function normalCwd(cwd, platform = process.platform) {
  const s = String(cwd ?? '').replace(/\\/g, '/');
  return platform === 'win32' ? s.replace(/^\/([A-Za-z])(\/|$)/, (m, d) => `${d.toUpperCase()}:/`) : s;
}

// True when a transcript's cwd is the root or a directory inside it: Bash in a session may have moved below the root.
export function cwdInside(cwd, root) {
  if (typeof cwd !== 'string' || !cwd) return false;
  const c = dirKey(normalCwd(cwd));
  const r = dirKey(root);
  return c === r || c.startsWith(r.endsWith('/') ? r : `${r}/`);
}

// A background job's state as Claude Code keeps it: <claude-home>/jobs/<job id>/state.json; null when absent.
export function jobState(home, jobId) {
  if (!SAFE_ID.test(String(jobId))) return null;
  const s = readJson(path.join(home, 'jobs', String(jobId), 'state.json'), null);
  return isObj(s) ? s : null;
}

// A session's transcript by its id (exact: <id>.jsonl) or, for a job id, by prefix: the project's own directories
// first, then every project directory. { file, sessionId, mtimeMs, size } or null.
function bySession(home, root, id, { prefix = false } = {}) {
  const pick = (dirs) => sessionTranscripts(dirs, id).find((t) => prefix || t.sessionId === id) || null;
  return pick(projectDirs(home, root)) || pick(allProjectDirs(home));
}

// The transcript a job's state names: its linkScanPath when that is an existing file under <claude-home>/projects/,
// else the transcript of its resumeSessionId, else of its sessionId. A job woken or resumed may write another
// transcript than the one its id prefixes; that older file stays on disk.
function jobTranscript(state, home, root) {
  const projects = `${path.resolve(home, 'projects')}${path.sep}`;
  const under = (p) => (process.platform === 'win32' ? p.toLowerCase().startsWith(projects.toLowerCase()) : p.startsWith(projects));
  const link = typeof state.linkScanPath === 'string' ? path.resolve(state.linkScanPath) : '';
  if (link.endsWith('.jsonl') && under(link) && statOf(link)?.isFile()) return { file: link, sessionId: path.basename(link, '.jsonl'), via: 'job-link' };
  for (const id of [state.resumeSessionId, state.sessionId]) {
    const hit = typeof id === 'string' && SAFE_ID.test(id) ? bySession(home, root, id) : null;
    if (hit) return { file: hit.file, sessionId: hit.sessionId, via: 'job-session' };
  }
  return null;
}

// A lane's transcript, read from outside the lane (supervisor, view). jobId is supervisor.json lane.sessionId: the
// background job id claude --bg printed. The job's state.json decides first; without one, the newest transcript whose
// name starts with the job id. No cwd check: an id decides. { file, sessionId, via } (via: job-link, job-session or
// job-prefix) or null.
export function laneTranscript({ home, root, jobId }) {
  if (!SAFE_ID.test(String(jobId))) return null;
  const state = jobState(home, jobId);
  const fromJob = state ? jobTranscript(state, home, root) : null;
  if (fromJob) return fromJob;
  const hit = bySession(home, root, String(jobId), { prefix: true });
  return hit ? { file: hit.file, sessionId: hit.sessionId, via: 'job-prefix' } : null;
}

// The newest main-chain cwd of a transcript, read from its end; null when none lies within CWD_TAIL_MAX.
function lastCwd(file) {
  const size = fs.statSync(file).size;
  for (let max = TAIL_MAX; ; max *= 4) {
    const { entries } = tailEntries(file, { max });
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.isSidechain !== true && typeof e.cwd === 'string' && e.cwd) return e.cwd;
    }
    if (max >= size || max >= CWD_TAIL_MAX) return null;
  }
}

// The transcript to read for the calling session or for a lane, the most exact source first:
// session: CLAUDE_CODE_SESSION_ID, which Claude Code sets in a session's Bash tool to its transcript's id;
// job: the state of the background job in CLAUDE_JOB_DIR (the calling job's current transcript);
// lane: laneTranscript of the given job id (supervisor.json lane.sessionId);
// newest: the newest transcript whose newest main-chain cwd is the root or inside it.
// A transcript found by an id is taken whatever its cwd. { file, sessionId, via } (via: the source's name) or null.
export function findTranscript({ home, root, env = process.env, lane = '' }) {
  const own = String(env.CLAUDE_CODE_SESSION_ID ?? '');
  const mine = SAFE_ID.test(own) ? bySession(home, root, own) : null;
  if (mine) return { file: mine.file, sessionId: mine.sessionId, via: 'session' };
  if (env.CLAUDE_JOB_DIR) {
    const state = readJson(path.join(path.resolve(String(env.CLAUDE_JOB_DIR)), 'state.json'), null);
    const fromJob = isObj(state) ? jobTranscript(state, home, root) : null;
    if (fromJob) return { file: fromJob.file, sessionId: fromJob.sessionId, via: 'job' };
  }
  const fromLane = lane ? laneTranscript({ home, root, jobId: lane }) : null;
  if (fromLane) return { file: fromLane.file, sessionId: fromLane.sessionId, via: 'lane' };
  const files = allProjectDirs(home).flatMap((dir) => listNames(dir).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n)));
  const newest = files.map((file) => ({ file, st: statOf(file) })).filter((f) => f.st?.isFile()).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, CWD_SCAN_MAX);
  for (const { file } of newest) {
    let cwd = null;
    try {
      cwd = lastCwd(file);
    } catch {
      continue; // gone meanwhile
    }
    if (cwdInside(cwd, root)) return { file, sessionId: path.basename(file, '.jsonl'), via: 'newest' };
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/transcripts.test.mjs`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/transcripts.mjs test/transcripts.test.mjs
git commit -q -m "feat: transcripts — one finder: a lane by its job state, the calling session by its id, else by cwd"
```

---

### Task 5: Harness notifications and the incremental lane index

**Files:**
- Modify: `lib/transcripts.mjs` (append)
- Test: `test/transcripts.test.mjs` (the two imports at the top, then append)

**Interfaces:**
- Consumes: `SAFE_ID` (module-private, Task 2); `parseLine` and `readSlice` (module-private, Task 3); the helpers `notification`, `entry.note`, `entry.attachedNote`, `entry.queued`, `entry.dispatch`, `entry.launched`, `entry.toolResult` and `entry.assistant`.
- Produces:
  - `parseNotifications(text): Array<{ taskId, status: 'completed' | 'stopped' | 'failed' }>` — `killed` reads as `stopped`; blocks without a final status are skipped.
  - `harnessNotificationText(entry): string | null` — D1 / T9.
  - `launchedAgentId(entry): string | null` — the `toolUseResult.agentId` of a non-sidechain user entry.
  - `scanLaneTranscript(file, prev = null): { size, scanned, notes: { [taskId]: { status, at } }, launched: string[], read }` — reads incrementally from `prev.scanned`. A shrunk file or an invalid `prev` is read again from 0, and a last line without its newline stays unread.

- [ ] **Step 1: Write the failing tests**

In `test/transcripts.test.mjs`, replace the two import lines from `./helpers/transcripts.mjs` and `../lib/transcripts.mjs` with:

```js
import { AGENT, AGENT2, FORK, SESSION, entry, jsonl, notification, projectDirFor, setMtime, usage, writeAgent, writeJob, writeSession } from './helpers/transcripts.mjs';
import { TAIL_MAX, actionOf, agentIndex, contextTokens, cwdInside, findAgentTranscript, findTranscript, harnessNotificationText, headEntry, jobState, laneTranscript, launchedAgentId, normalCwd, parseNotifications, planOf, projectDirs, projectKey, scanLaneTranscript, sessionTranscripts, tailEntries } from '../lib/transcripts.mjs';
```

Append to `test/transcripts.test.mjs`:

```js
test('parseNotifications keeps final statuses (killed reads as stopped) and skips progress events', () => {
  const text = [notification(AGENT, 'completed'), notification(AGENT2, 'killed'), notification('b1x2y3z4w', 'failed'),
    '<task-notification>\n<task-id>b9q8r7s6t</task-id>\n<summary>shell printed a line</summary>\n<event>output</event>\n</task-notification>'].join('\n');
  assert.deepEqual(parseNotifications(text), [
    { taskId: AGENT, status: 'completed' }, { taskId: AGENT2, status: 'stopped' }, { taskId: 'b1x2y3z4w', status: 'failed' },
  ]);
});

test('only entries the harness wrote carry a notification: never a quote in a dispatch prompt, a tool result or assistant text', () => {
  assert.ok(harnessNotificationText(entry.note(AGENT, 'completed', T0)));
  assert.ok(harnessNotificationText(entry.attachedNote(AGENT, 'completed', T0)));
  const quote = notification(AGENT, 'completed');
  assert.equal(harnessNotificationText(entry.dispatch('toolu_q', 'gsd-executor', 'Execute plan 07 of phase 32', `wait for ${quote}`, T0)), null);
  assert.equal(harnessNotificationText(entry.toolResult('toolu_g', `log.jsonl:12: ${quote}`, T0)), null);
  assert.equal(harnessNotificationText(entry.assistant({ ts: T0, text: quote })), null);
  assert.equal(harnessNotificationText(entry.user(`the owner pasted: ${quote}`, T0)), null);
  assert.equal(harnessNotificationText(entry.queued(AGENT, 'completed', T0)), null);
  assert.equal(harnessNotificationText({ ...entry.note(AGENT, 'completed', T0), isSidechain: true }), null);
  assert.equal(launchedAgentId(entry.launched('toolu_l', AGENT, T0)), AGENT);
  assert.equal(launchedAgentId(entry.toolResult('toolu_g', AGENT, T0)), null);
});

test('scanLaneTranscript indexes notifications and launched agents, the newest notification per agent winning', () => {
  const { dir } = setup();
  const quote = notification(AGENT2, 'completed');
  const file = writeSession(dir, SESSION, [
    entry.user('run phase 32', T0),
    entry.dispatch('toolu_1', 'gsd-executor', 'Execute plan 07 of phase 32', 'do it', T0),
    entry.launched('toolu_1', AGENT, T0),
    entry.dispatch('toolu_2', 'gsd-executor', 'Execute plan 08 of phase 32', `report ${quote} when done`, T0),
    entry.launched('toolu_2', AGENT2, T0),
    entry.attachedNote(AGENT, 'stopped', '2026-01-01T10:10:00.000Z'),
    entry.note(AGENT, 'completed', '2026-01-01T10:20:00.000Z'),
  ]);
  const s = scanLaneTranscript(file);
  assert.deepEqual(s.launched, [AGENT, AGENT2]);
  assert.deepEqual(s.notes, { [AGENT]: { status: 'completed', at: '2026-01-01T10:20:00.000Z' } });
  assert.equal(s.scanned, fs.statSync(file).size);
});

test('scanLaneTranscript reads a transcript larger than one chunk whose chunk boundary splits a multibyte character (Review Focus 2)', () => {
  const { dir } = setup();
  for (const pad of ['', 'x']) {
    const file = writeSession(dir, SESSION, [
      entry.user(`${pad}${'я'.repeat(600000)}`, T0),
      entry.launched('toolu_1', AGENT, T0),
      entry.note(AGENT, 'completed', '2026-01-01T10:40:00.000Z'),
    ]);
    const s = scanLaneTranscript(file);
    assert.ok(fs.statSync(file).size > 1024 * 1024);
    assert.equal(s.scanned, fs.statSync(file).size, `pad "${pad}"`);
    assert.deepEqual(s.launched, [AGENT]);
    assert.deepEqual(s.notes[AGENT], { status: 'completed', at: '2026-01-01T10:40:00.000Z' });
  }
});

test('scanLaneTranscript reads only what was appended, keeps a line without its newline for later, and rereads a file that shrank', () => {
  const { dir } = setup();
  const file = writeSession(dir, SESSION, [entry.user('x'.repeat(5000), T0), entry.launched('toolu_1', AGENT, T0)]);
  const first = scanLaneTranscript(file);
  assert.equal(first.read, fs.statSync(file).size);
  assert.equal(scanLaneTranscript(file, first).read, 0);
  const half = JSON.stringify(entry.note(AGENT, 'completed', '2026-01-01T10:30:00.000Z'));
  fs.appendFileSync(file, half.slice(0, 40));
  const partial = scanLaneTranscript(file, first);
  assert.equal(partial.read, 40);
  assert.equal(partial.scanned, first.scanned);
  assert.deepEqual(partial.notes, {});
  fs.appendFileSync(file, `${half.slice(40)}\n`);
  const done = scanLaneTranscript(file, partial);
  assert.equal(done.read, half.length + 1);
  assert.deepEqual(done.notes[AGENT], { status: 'completed', at: '2026-01-01T10:30:00.000Z' });
  writeSession(dir, SESSION, [entry.launched('toolu_9', AGENT2, T0)]);
  assert.deepEqual(scanLaneTranscript(file, done).launched, [AGENT2]);
  assert.deepEqual(scanLaneTranscript(file, { scanned: 'bad' }).launched, [AGENT2]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/transcripts.test.mjs`
Expected: FAIL with `SyntaxError: The requested module '../lib/transcripts.mjs' does not provide an export named …` (one of `harnessNotificationText`, `launchedAgentId`, `parseNotifications`, `scanLaneTranscript`).

- [ ] **Step 3: Implement notifications and the lane index**

Append to `lib/transcripts.mjs`:

```js
// Lane transcripts are indexed incrementally: each call reads only the bytes appended since the last one.
const SCAN_CHUNK = 1024 * 1024;
const NOTE_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
// A killed task (TaskStop) counts as stopped.
const NOTE_STATUS = { completed: 'completed', stopped: 'stopped', killed: 'stopped', failed: 'failed' };

// Every <task-notification> block of a text that names a task and a final status: [{ taskId, status }] with status
// completed, stopped or failed. Other blocks (a background shell's progress event) are skipped.
export function parseNotifications(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(NOTE_RE)) {
    const taskId = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(m[1])?.[1];
    const status = /<status>\s*([A-Za-z_]+)\s*<\/status>/.exec(m[1])?.[1]?.toLowerCase();
    if (taskId && status && Object.hasOwn(NOTE_STATUS, status)) out.push({ taskId, status: NOTE_STATUS[status] });
  }
  return out;
}

// The notification text of a transcript entry the harness wrote, else null (spec §4): a user message it generated
// (origin task-notification, or a plain-text message that is the notification) or a notification it queued and
// delivered mid-turn as an attachment. Assistant text and tool calls (a dispatch prompt that quotes the marker),
// tool results (a grep that prints it) and sidechain entries never count.
export function harnessNotificationText(e) {
  if (!e || typeof e !== 'object' || e.isSidechain === true) return null;
  if (e.type === 'user') {
    const c = e.message?.content;
    const generated = e.origin?.kind === 'task-notification';
    if (typeof c === 'string') return generated || c.trimStart().startsWith('<task-notification>') ? c : null;
    if (generated && Array.isArray(c) && c.every((b) => b?.type === 'text')) return c.map((b) => String(b.text ?? '')).join('\n');
    return null;
  }
  if (e.type === 'attachment') {
    const a = e.attachment;
    const queued = a?.type === 'queued_command' && (a.commandMode === 'task-notification' || a.origin?.kind === 'task-notification');
    return queued && typeof a.prompt === 'string' ? a.prompt : null;
  }
  return null;
}

// The subagent an Agent tool result launched: its toolUseResult carries the agent id.
export function launchedAgentId(e) {
  if (e?.type !== 'user' || e.isSidechain === true) return null;
  const id = e.toolUseResult?.agentId;
  return typeof id === 'string' && SAFE_ID.test(id) ? id : null;
}

const isScan = (s) => s && typeof s === 'object' && Number.isInteger(s.scanned) && s.scanned >= 0 && s.notes && typeof s.notes === 'object' && Array.isArray(s.launched);

// Indexes a lane transcript: per task id the newest harness notification { status, at }, and every subagent it
// launched. prev is this function's earlier result for the same file: only the bytes after prev.scanned are read
// (a file that shrank is read again from its start). Only lines that carry a marker are parsed, and a last line
// without its newline is left for the next call. Returns { size, scanned, notes, launched, read }.
export function scanLaneTranscript(file, prev = null) {
  const size = fs.statSync(file).size;
  const from = isScan(prev) && prev.scanned <= size ? prev : null;
  const notes = { ...(from?.notes || {}) };
  const launched = new Set(from?.launched || []);
  let scanned = from ? from.scanned : 0;
  let read = 0;
  let carry = Buffer.alloc(0);
  while (scanned + carry.length < size) {
    const chunk = readSlice(file, scanned + carry.length, Math.min(SCAN_CHUNK, size - scanned - carry.length));
    if (!chunk.length) break;
    read += chunk.length;
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) {
      carry = buf;
      continue;
    }
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.includes('<task-notification>') && !line.includes('"agentId"')) continue;
      const e = parseLine(line);
      const id = launchedAgentId(e);
      if (id) launched.add(id);
      const text = harnessNotificationText(e);
      if (!text) continue;
      for (const n of parseNotifications(text)) notes[n.taskId] = { status: n.status, at: typeof e.timestamp === 'string' ? e.timestamp : null };
    }
    scanned += end + 1;
    carry = buf.subarray(end + 1);
  }
  return { size, scanned, notes, launched: [...launched], read };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/transcripts.test.mjs`
Expected: PASS (21 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/transcripts.mjs test/transcripts.test.mjs
git commit -q -m "feat: transcripts — harness notifications only, incremental lane index of launched agents"
```

---

### Task 6: Subagent state and a lane's subagents

**Files:**
- Modify: `lib/transcripts.mjs` (append)
- Test: `test/transcripts.test.mjs` (the import from `../lib/transcripts.mjs`, then append)

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces:
  - `agentSnapshot(file, root, prev = null): { size, mtimeMs, firstAt, lastAt, action, tokens }` — returns `prev` itself while size and mtime are unchanged, and keeps `prev.firstAt` while the file only grew.
  - `agentState({ note, lastAt, writtenMs, nowMs, stallMs }): 'completed' | 'stopped' | 'failed' | 'running' | 'quiet'` — D3.
  - `laneAgents({ dirs, main, root, now = new Date(), stallMs, cache = {}, used = {} }): { transcript: string | null, sessionId: string | null, lastAt: string | null, agents: Agent[] }`:
    - `main` is `laneTranscript`'s result (or `null`);
    - `dirs` is the project's directories (`main`'s own directory is added);
    - `Agent` is the shape in the `view --json` contract above;
    - `cache` maps a file path to an earlier result of `scanLaneTranscript` or `agentSnapshot` for it, and every result used is stored in `used` under its file path.

- [ ] **Step 1: Write the failing tests**

In `test/transcripts.test.mjs`, replace the import line from `../lib/transcripts.mjs` with:

```js
import { TAIL_MAX, actionOf, agentIndex, agentSnapshot, agentState, contextTokens, cwdInside, findAgentTranscript, findTranscript, harnessNotificationText, headEntry, jobState, laneAgents, laneTranscript, launchedAgentId, normalCwd, parseNotifications, planOf, projectDirs, projectKey, scanLaneTranscript, sessionTranscripts, tailEntries } from '../lib/transcripts.mjs';
```

Append to `test/transcripts.test.mjs`:

```js
const NOW = new Date('2026-01-01T11:00:00.000Z');
const STALL = 15 * 60000;
const at = (hhmm) => `2026-01-01T${hhmm}:00.000Z`;
// A subagent transcript: its prompt at `from`, then one tool call at `to` with the given usage.
const agentEntries = (id, from, to, tool = { name: 'Bash', input: { command: 'node --test test/a.test.mjs' } }) => [
  entry.agentUser(id, 'Execute the plan', at(from)),
  entry.assistant({ ts: at(to), tool, usage: usage(1, 1000, 40000), sidechain: true }),
];

test('agentState: a notification the agent did not outlive decides; else running within the stall window, else quiet', () => {
  const base = { lastAt: at('10:20'), writtenMs: Date.parse(at('10:20')), nowMs: NOW.getTime(), stallMs: STALL };
  assert.equal(agentState({ ...base, note: { status: 'completed', at: at('10:20') } }), 'completed');
  assert.equal(agentState({ ...base, note: { status: 'stopped', at: at('10:20') } }), 'stopped');
  assert.equal(agentState({ ...base, note: { status: 'failed', at: at('10:20') } }), 'failed');
  assert.equal(agentState({ ...base, note: null }), 'quiet');
  assert.equal(agentState({ ...base, note: null, writtenMs: Date.parse(at('10:50')) }), 'running');
  // resumed with SendMessage after a stop: it wrote again after the notification
  assert.equal(agentState({ ...base, note: { status: 'stopped', at: at('10:10') }, writtenMs: Date.parse(at('10:58')) }), 'running');
});

test('agentSnapshot reads first and last time, the last tool call and the last context; an unchanged file returns the cached snapshot', () => {
  const root = tmpDir('snap');
  const { dir } = setup();
  const file = writeAgent(dir, SESSION, AGENT, agentEntries(AGENT, '10:00', '10:40', { name: 'Edit', input: { file_path: path.join(root, 'lib', 'x.mjs') } }));
  const s = agentSnapshot(file, root);
  assert.equal(s.firstAt, at('10:00'));
  assert.equal(s.lastAt, at('10:40'));
  assert.deepEqual(s.action, { tool: 'Edit', detail: 'lib/x.mjs' });
  assert.equal(s.tokens, 41001);
  assert.equal(agentSnapshot(file, root, s), s);
  fs.appendFileSync(file, jsonl([entry.assistant({ ts: at('10:45'), text: 'done', sidechain: true })]));
  const grown = agentSnapshot(file, root, s);
  assert.notEqual(grown, s);
  assert.equal(grown.lastAt, at('10:45'));
  assert.deepEqual(grown.action, { tool: 'Edit', detail: 'lib/x.mjs' });
  assert.equal(agentSnapshot(file, root, { size: 'x' }).firstAt, at('10:00'));
});

test('laneAgents: states from the lane transcript, nested agents left out, active ones first', () => {
  const root = tmpDir('lane');
  const { dir } = setup();
  const ids = { done: 'a1000000000000001', run: 'a1000000000000002', quiet: 'a1000000000000003', killed: 'a1000000000000004', failed: 'a1000000000000005', resumed: 'a1000000000000006', nested: 'a1000000000000007' };
  const laneFile = writeSession(dir, SESSION, [
    entry.user('run phase 32', at('09:59')),
    ...Object.values(ids).filter((id) => id !== ids.nested).map((id, i) => entry.launched(`toolu_${i}`, id, at('10:00'))),
    entry.note(ids.done, 'completed', at('10:30')),
    entry.attachedNote(ids.killed, 'killed', at('10:31')),
    entry.note(ids.failed, 'failed', at('10:32')),
    entry.note(ids.resumed, 'stopped', at('10:20')),
  ]);
  const write = (id, from, to, mtime, meta) => setMtime(writeAgent(dir, SESSION, id, agentEntries(id, from, to), meta), new Date(at(mtime)));
  write(ids.done, '10:00', '10:30', '10:30');
  write(ids.run, '10:00', '10:50', '10:50');
  write(ids.quiet, '10:00', '10:30', '10:30');
  write(ids.killed, '10:00', '10:31', '10:31');
  write(ids.failed, '10:00', '10:32', '10:32');
  write(ids.resumed, '10:00', '10:55', '10:55');
  write(ids.nested, '10:00', '10:58', '10:58', { agentType: 'gsd-code-reviewer', spawnDepth: 2 });
  const used = {};
  const r = laneAgents({ dirs: [dir], main: { file: laneFile, sessionId: SESSION }, root, now: NOW, stallMs: STALL, used });
  const byId = Object.fromEntries(r.agents.map((a) => [a.agentId, a]));
  assert.deepEqual([r.transcript, r.sessionId], [laneFile, SESSION]);
  assert.equal(byId[ids.done].state, 'completed');
  assert.equal(byId[ids.run].state, 'running');
  assert.equal(byId[ids.quiet].state, 'quiet');
  assert.equal(byId[ids.killed].state, 'stopped');
  assert.equal(byId[ids.failed].state, 'failed');
  assert.equal(byId[ids.resumed].state, 'running');
  assert.equal(byId[ids.nested], undefined);
  assert.deepEqual(r.agents.slice(0, 3).map((a) => a.state).sort(), ['quiet', 'running', 'running']);
  const done = byId[ids.done];
  assert.equal(done.elapsedMs, 30 * 60000);
  assert.equal(byId[ids.run].elapsedMs, 60 * 60000);
  assert.deepEqual([done.type, done.plan, done.task, done.model, done.tokens], ['gsd-executor', '32-07', null, 'opus', 41001]);
  assert.deepEqual(done.action, { tool: 'Bash', detail: 'node --test test/a.test.mjs' });
  assert.ok(used[r.transcript] && used[done.transcript]);
});

test('background shell tasks and progress events in the lane transcript are never agents and never change one (Review Focus 4)', () => {
  const { root, dir } = setup();
  const event = { ...entry.attachedNote('b9q8r7s6t', 'completed', at('10:41')) };
  event.attachment = { ...event.attachment, prompt: '<task-notification>\n<task-id>b9q8r7s6t</task-id>\n<summary>printed a line</summary>\n<event>output</event>\n</task-notification>' };
  const laneFile = writeSession(dir, SESSION, [
    entry.launched('toolu_1', AGENT, at('10:00')),
    entry.note('b1x2y3z4w', 'completed', at('10:40')),
    event,
    { ...entry.toolResult('toolu_b', 'Command running in background with ID: b1x2y3z4w', at('10:39')), toolUseResult: { backgroundTaskId: 'b1x2y3z4w' } },
  ]);
  setMtime(writeAgent(dir, SESSION, AGENT, agentEntries(AGENT, '10:00', '10:55')), new Date(at('10:55')));
  const r = laneAgents({ dirs: [dir], main: { file: laneFile, sessionId: SESSION }, root, now: NOW, stallMs: STALL });
  assert.deepEqual(r.agents.map((a) => [a.agentId, a.state]), [[AGENT, 'running']]);
});

test('laneAgents after a fork: the current session finds agents launched before the fork in the old session directory', () => {
  const { root, dir } = setup();
  const laneFile = writeSession(dir, FORK, [entry.launched('toolu_1', AGENT, at('10:00')), entry.launched('toolu_2', AGENT2, at('10:01'))]);
  writeAgent(dir, SESSION, AGENT, agentEntries(AGENT, '10:00', '10:58'));
  writeAgent(dir, FORK, AGENT2, agentEntries(AGENT2, '10:01', '10:59'));
  const r = laneAgents({ dirs: [dir], main: { file: laneFile, sessionId: FORK }, root, now: NOW, stallMs: STALL });
  assert.deepEqual(r.agents.map((a) => [a.agentId, a.sessionId]).sort(), [[AGENT, SESSION], [AGENT2, FORK]].sort());
  assert.deepEqual(laneAgents({ dirs: [dir], main: null, root, now: NOW, stallMs: STALL }), { transcript: null, sessionId: null, lastAt: null, agents: [] });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/transcripts.test.mjs`
Expected: FAIL with `SyntaxError: The requested module '../lib/transcripts.mjs' does not provide an export named …` (one of `agentSnapshot`, `agentState`, `laneAgents`).

- [ ] **Step 3: Implement the snapshot, the state and the lane's subagents**

Append to `lib/transcripts.mjs`:

```js
// A notification counts unless the agent wrote again more than this after it (a SendMessage resume).
const RESUME_GRACE_MS = 2000;
const FINISHED = new Set(['completed', 'stopped', 'failed']);
const iso = (ms) => new Date(ms).toISOString();
const str = (v) => (typeof v === 'string' ? v : '');

const isSnapshot = (s) => s && typeof s === 'object' && Number.isFinite(s.size) && Number.isFinite(s.mtimeMs);

// What view shows of one subagent transcript: { size, mtimeMs, firstAt, lastAt, action, tokens }. firstAt is the
// first entry's time, lastAt the last one's, action the last tool call (actionOf), tokens the context of the last
// answer. prev, this function's earlier result for the same file, is returned unchanged while the file's size and
// mtime are; firstAt is kept while the file only grew.
export function agentSnapshot(file, root, prev = null) {
  const st = fs.statSync(file);
  const old = isSnapshot(prev) ? prev : null;
  if (old && old.size === st.size && old.mtimeMs === st.mtimeMs) return old;
  const firstAt = (old && st.size >= old.size && old.firstAt) || headEntry(file)?.timestamp || (st.birthtimeMs > 0 ? iso(st.birthtimeMs) : null);
  const { entries } = tailEntries(file);
  let lastAt = null;
  let action = null;
  let tokens = null;
  for (let i = entries.length - 1; i >= 0 && (lastAt === null || action === null || tokens === null); i--) {
    const e = entries[i];
    if (lastAt === null && typeof e.timestamp === 'string') lastAt = e.timestamp;
    if (e.type !== 'assistant') continue;
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    if (action === null) {
      const call = content.findLast((b) => b?.type === 'tool_use');
      if (call) action = actionOf(call, root);
    }
    if (tokens === null && e.message?.model !== '<synthetic>') tokens = contextTokens(e.message?.usage);
  }
  return { size: st.size, mtimeMs: st.mtimeMs, firstAt, lastAt: lastAt ?? iso(st.mtimeMs), action, tokens };
}

// A subagent's state (spec §4): completed, stopped or failed only by a harness notification in the lane transcript
// that the agent did not outlive (a SendMessage resume writes after it); otherwise running while its transcript was
// written within stallMs, else quiet. quiet is a mark only: nothing is stopped or restarted because of it.
export function agentState({ note, lastAt, writtenMs, nowMs, stallMs }) {
  if (note && FINISHED.has(note.status) && !(Date.parse(lastAt) > Date.parse(note.at) + RESUME_GRACE_MS)) return note.status;
  return nowMs - writtenMs <= stallMs ? 'running' : 'quiet';
}

const ACTIVE_FIRST = (a, b) => (FINISHED.has(a.state) - FINISHED.has(b.state)) || String(b.lastAt).localeCompare(String(a.lastAt));

// The subagents of a lane session. main is the lane's transcript ({ file, sessionId }, from laneTranscript; null when
// none was found). They are the direct ones in its own subagents directory and every one its transcript launched,
// each read from its newest transcript in any session directory of `dirs` and of main's directory (a fork moves
// them). Nested agents (spawnDepth above 1) report to their parent agent, not to the lane, and are left out. cache
// maps a file to this module's earlier result for it (scanLaneTranscript, agentSnapshot); every result used is put
// into `used`. Returns { transcript, sessionId, lastAt, agents } (lastAt: the lane transcript's mtime).
export function laneAgents({ dirs, main, root, now = new Date(), stallMs, cache = {}, used = {} }) {
  if (!main) return { transcript: null, sessionId: null, lastAt: null, agents: [] };
  let scan = null;
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(main.file).mtimeMs;
    scan = scanLaneTranscript(main.file, cache[main.file]);
    used[main.file] = scan;
  } catch { /* gone meanwhile: no notifications */ }
  const own = path.dirname(main.file);
  const index = agentIndex(dirs.includes(own) ? dirs : [...dirs, own]);
  const ids = new Set(scan?.launched || []);
  for (const [id, list] of index) if (list.some((c) => c.sessionId === main.sessionId)) ids.add(id);
  const nowMs = now.getTime();
  const agents = [];
  for (const id of ids) {
    const found = findAgentTranscript([], id, index);
    if (!found || Number(found.meta.spawnDepth) > 1) continue;
    let snap;
    try {
      snap = agentSnapshot(found.file, root, cache[found.file]);
    } catch {
      continue; // gone meanwhile
    }
    used[found.file] = snap;
    const state = agentState({ note: scan?.notes[id] || null, lastAt: snap.lastAt, writtenMs: snap.mtimeMs, nowMs, stallMs });
    const started = Date.parse(snap.firstAt);
    const end = FINISHED.has(state) ? Date.parse(snap.lastAt) : nowMs;
    const description = maskSecrets(str(found.meta.description)).slice(0, 200);
    agents.push({
      agentId: id,
      type: str(found.meta.agentType) || null,
      description,
      ...planOf(description),
      model: str(found.meta.model) || null,
      worktreeBranch: str(found.meta.worktreeBranch) || null,
      state,
      action: snap.action,
      startedAt: snap.firstAt,
      lastAt: snap.lastAt,
      elapsedMs: Number.isFinite(started) && Number.isFinite(end) ? Math.max(0, end - started) : null,
      tokens: snap.tokens,
      sessionId: found.sessionId,
      transcript: found.file,
    });
  }
  return { transcript: main.file, sessionId: main.sessionId, lastAt: mtimeMs === null ? null : iso(mtimeMs), agents: agents.sort(ACTIVE_FIRST) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/transcripts.test.mjs`
Expected: PASS (26 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/transcripts.mjs test/transcripts.test.mjs
git commit -q -m "feat: transcripts — subagent snapshot and state, a lane's subagents across forked sessions"
```

---

### Task 7: The view object

**Files:**
- Modify: `lib/config.mjs` (`DEFAULTS`)
- Create: `lib/view.mjs`
- Test: `test/view.test.mjs`

**Interfaces:**
- Consumes:
  - from this plan: `laneAgents`, `laneTranscript`, `projectDirs` (Tasks 2, 4, 6); `maskSecrets` (Task 1);
  - existing: `claudeHome` and `runDir` (`lib/paths.mjs`); `readJson` and `writeJsonAtomic` (`lib/fsx.mjs`); `readProgress` and `nextStep` (`lib/phase-progress.mjs`); `readLaneStatus` (`lib/run-status.mjs`); `comparePhase` (`lib/scheduler.mjs`); `DEFAULTS` (`lib/config.mjs`).
- Produces (in `lib/view.mjs`):
  - `stallMs(config): number` — `stall_minutes` (an integer ≥ 1, else the default 15) in ms.
  - `openQuestions(root): object[]` — D7.
  - `recentCommits(root, n = 5): Array<{ sha, subject }>` — `[]` outside a repository; subjects are masked, ≤ 200 characters.
  - `buildView({ root, sup, running = false, config = {}, env = process.env, now = new Date(), commits = recentCommits }): View` — the object in the `view --json` contract above. `env` only locates `<claude-home>` (`CLAUDE_CONFIG_DIR`). It reads and writes `.planning/turbo/run/view-cache.json` (D13).
  - `DEFAULTS.stall_minutes = 15` in `lib/config.mjs`.

- [ ] **Step 1: Write the failing tests**

Create `test/view.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { SESSION, entry, jsonl, projectDirFor, setMtime, usage, writeAgent, writeJob, writeSession } from './helpers/transcripts.mjs';
import { completeStep } from '../lib/phase-progress.mjs';
import { writeLaneStatus } from '../lib/run-status.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';
import { maskSecrets } from '../lib/secrets.mjs';
import { buildView, openQuestions, recentCommits, stallMs } from '../lib/view.mjs';

const NOW = new Date('2026-01-01T11:00:00.000Z');
const at = (hhmm) => `2026-01-01T${hhmm}:00.000Z`;
const COMMITS = () => [{ sha: 'abc1234', subject: 'feat: something' }];
const runDirOf = (root) => path.join(root, '.planning', 'turbo', 'run');
const SECRET = `ghp_${'s'.repeat(36)}`;

// A project with a supervisor lane for phase 32 and its transcripts in a separate Claude home.
function laneProject({ run = true } = {}) {
  const root = tmpDir('view');
  fs.mkdirSync(path.join(root, '.planning'));
  if (run) fs.mkdirSync(runDirOf(root), { recursive: true });
  const home = tmpDir('home');
  const dir = projectDirFor(home, root);
  const sup = { pid: 4242, updatedAt: at('10:59'), finished: false, halted: false, range: { from: '32', to: '34' }, lane: { phase: '32', sessionId: SESSION.slice(0, 8), launchedAt: at('09:48'), mode: 'full', restarts: 0 } };
  return { root, home, dir, sup, env: { CLAUDE_CONFIG_DIR: home } };
}

const agentEntries = (id, from, to, tokens = 166000) => [
  entry.agentUser(id, 'Execute the plan', at(from)),
  entry.assistant({ ts: at(to), tool: { name: 'Bash', input: { command: 'node --test test/x.test.mjs' } }, usage: usage(0, 0, tokens), sidechain: true }),
];

test('without supervisor.json the view has no supervisor and no lanes, and still lists questions and commits', () => {
  const { root, env } = laneProject();
  const v = buildView({ root, sup: null, env, now: NOW, commits: COMMITS });
  assert.deepEqual(v, { v: 1, at: NOW.toISOString(), supervisor: null, range: null, lanes: [], questions: [], commits: COMMITS() });
});

test('the view shows supervisor, range, the lane with its step, record and subagents, open questions and commits', () => {
  const { root, dir, sup, env } = laneProject();
  for (const s of ['freshness', 'discuss', 'prologue', 'plan', 'gates-off']) completeStep(root, '32', s, { note: s === 'plan' ? `path same-agent ${SECRET}` : '' });
  writeLaneStatus(root, '32', 'needs-owner', { reason: `checkpoint 32-09 (${SECRET})`, at: at('10:40') });
  writeSession(dir, SESSION, [entry.user('run phase 32', at('09:48')), entry.launched('toolu_1', 'a2000000000000001', at('10:00')), entry.launched('toolu_2', 'a2000000000000002', at('10:20')), entry.note('a2000000000000001', 'completed', at('10:30'))]);
  setMtime(writeAgent(dir, SESSION, 'a2000000000000001', agentEntries('a2000000000000001', '10:00', '10:30')), new Date(at('10:30')));
  setMtime(writeAgent(dir, SESSION, 'a2000000000000002', agentEntries('a2000000000000002', '10:20', '10:58', 41000), { agentType: 'gsd-executor', description: 'Continue plan 32-08 from Task 2', spawnDepth: 1 }), new Date(at('10:58')));
  writeJsonAtomic(path.join(runDirOf(root), 'p32-questions.json'), [
    { id: 'q1', phase: '32', plan: '32-09', task: '3', kind: 'decision', header: 'Deploy', question: 'Deploy after green CI?', options: [], state: 'open' },
    { id: 'q2', phase: '32', plan: '32-10', task: '1', kind: 'verify', header: 'Check', question: 'Looks right?', options: [], state: 'answered' },
  ]);
  const v = buildView({ root, sup, running: true, config: { stall_minutes: 15 }, env, now: NOW, commits: COMMITS });
  assert.deepEqual(v.supervisor, { running: true, pid: 4242, finished: false, halted: false, failingSince: null, updatedAt: at('10:59') });
  assert.deepEqual(v.range, { from: '32', to: '34' });
  const [lane] = v.lanes;
  assert.deepEqual([lane.phase, lane.step, lane.status, lane.mode, lane.sessionId, lane.elapsedMs], ['32', 'execute', 'needs-owner', 'full', SESSION.slice(0, 8), 72 * 60000]);
  assert.equal(lane.reason, `checkpoint 32-09 (${maskSecrets(SECRET)})`);
  assert.equal(lane.notes.plan, `path same-agent ${maskSecrets(SECRET)}`);
  assert.deepEqual(lane.agents.map((a) => [a.agentId, a.state, a.plan, a.task, a.tokens]), [['a2000000000000002', 'running', '32-08', '2', 41000], ['a2000000000000001', 'completed', '32-07', null, 166000]]);
  assert.deepEqual(v.questions.map((q) => q.id), ['q1']);
  assert.deepEqual(v.commits, COMMITS());
  assert.equal(JSON.stringify(v).includes(SECRET), false);
});

test('a lane record from before the lane launched does not count; a lane without its transcript has no agents', () => {
  const { root, sup, env } = laneProject();
  writeLaneStatus(root, '32', 'failed', { at: at('09:00') });
  const [lane] = buildView({ root, sup, env, now: NOW, commits: COMMITS }).lanes;
  assert.deepEqual([lane.status, lane.reason, lane.transcript, lane.agents, lane.quiet], ['running', '', null, [], false]);
});

test('a woken or resumed lane: the view follows the job state to the transcript the job runs on, not the stale file its id prefixes', () => {
  const { root, home, dir, sup, env } = laneProject();
  const current = '99999999-8888-4777-8666-555555555555';
  setMtime(writeSession(dir, SESSION, [entry.launched('toolu_1', 'a2000000000000001', at('10:00'))]), new Date(at('10:59')));
  const file = writeSession(dir, current, [entry.launched('toolu_2', 'a2000000000000002', at('10:40'))]);
  setMtime(file, new Date(at('10:50')));
  writeAgent(dir, SESSION, 'a2000000000000001', agentEntries('a2000000000000001', '10:00', '10:30'));
  writeAgent(dir, current, 'a2000000000000002', agentEntries('a2000000000000002', '10:40', '10:50'));
  writeJob(home, SESSION.slice(0, 8), { sessionId: SESSION, resumeSessionId: current, linkScanPath: file });
  const [lane] = buildView({ root, sup, env, now: NOW, commits: COMMITS }).lanes;
  assert.equal(lane.transcript, file);
  assert.deepEqual(lane.agents.map((a) => a.agentId), ['a2000000000000002']);
});

test('the cache lets the next view read only what was appended; it is written only into an existing run directory and a corrupt one is ignored', () => {
  const { root, dir, sup, env } = laneProject();
  const laneFile = writeSession(dir, SESSION, [entry.launched('toolu_1', 'a2000000000000001', at('10:00'))]);
  writeAgent(dir, SESSION, 'a2000000000000001', agentEntries('a2000000000000001', '10:00', '10:30'));
  const cacheFile = path.join(runDirOf(root), 'view-cache.json');
  buildView({ root, sup, env, now: NOW, commits: COMMITS });
  const first = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(first.files[laneFile].read, fs.statSync(laneFile).size);
  fs.appendFileSync(laneFile, jsonl([entry.note('a2000000000000001', 'completed', at('10:31'))]));
  const v = buildView({ root, sup, env, now: NOW, commits: COMMITS });
  assert.equal(v.lanes[0].agents[0].state, 'completed');
  const second = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(second.files[laneFile].read, fs.statSync(laneFile).size - first.files[laneFile].size);
  fs.writeFileSync(cacheFile, '{"v":1,"files":{"x":');
  assert.equal(buildView({ root, sup, env, now: NOW, commits: COMMITS }).lanes[0].agents[0].state, 'completed');
  const bare = laneProject({ run: false });
  writeSession(bare.dir, SESSION, [entry.user('go', at('10:00'))]);
  buildView({ root: bare.root, sup: bare.sup, env: bare.env, now: NOW, commits: COMMITS });
  assert.equal(fs.existsSync(path.join(bare.root, '.planning', 'turbo')), false);
});

test('stall_minutes sets the quiet threshold; a value below 1 or not a number takes the default 15', () => {
  assert.equal(stallMs({ stall_minutes: 1 }), 60000);
  assert.equal(stallMs({ stall_minutes: 0 }), 15 * 60000);
  assert.equal(stallMs({ stall_minutes: 'x' }), 15 * 60000);
  assert.equal(stallMs({}), 15 * 60000);
  const { root, dir, sup, env } = laneProject();
  writeSession(dir, SESSION, [entry.launched('toolu_1', 'a2000000000000001', at('10:00'))]);
  setMtime(writeAgent(dir, SESSION, 'a2000000000000001', agentEntries('a2000000000000001', '10:00', '10:55')), new Date(at('10:55')));
  assert.equal(buildView({ root, sup, config: { stall_minutes: 15 }, env, now: NOW, commits: COMMITS }).lanes[0].agents[0].state, 'running');
  assert.equal(buildView({ root, sup, config: { stall_minutes: 2 }, env, now: NOW, commits: COMMITS }).lanes[0].agents[0].state, 'quiet');
});

test('openQuestions reads every phase file in phase order and skips files that are not a list', () => {
  const root = tmpDir('q');
  const run = runDirOf(root);
  fs.mkdirSync(run, { recursive: true });
  writeJsonAtomic(path.join(run, 'p10-questions.json'), [{ id: 'b', state: 'open' }]);
  writeJsonAtomic(path.join(run, 'p9-questions.json'), [{ id: 'a', state: 'open' }, { id: 'n', state: 'answered' }, null, { state: 'open' }]);
  writeJsonAtomic(path.join(run, 'p11-questions.json'), { questions: [] });
  assert.deepEqual(openQuestions(root).map((q) => q.id), ['a', 'b']);
  assert.deepEqual(openQuestions(tmpDir('none')), []);
});

test('recentCommits lists the last five subjects with secrets masked; none outside a repository', () => {
  const repo = tmpGitRepo();
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  for (let i = 1; i <= 6; i++) git('commit', '-q', '--allow-empty', '-m', i === 6 ? `fix: rotate ${SECRET}` : `feat: step ${i}`);
  const c = recentCommits(repo);
  assert.equal(c.length, 5);
  assert.equal(c[0].subject, `fix: rotate ${maskSecrets(SECRET)}`);
  assert.equal(c[4].subject, 'feat: step 2');
  assert.match(c[0].sha, /^[0-9a-f]{7,}$/);
  assert.deepEqual(recentCommits(tmpDir('nogit')), []);
});

test('a warm view of a lane with 20 subagents and large transcripts, in a project with 300 older sessions, answers within 300 ms (Review Focus 3)', () => {
  const { root, dir, sup, env } = laneProject();
  const pad = entry.user('p'.repeat(4000), at('10:00'));
  const ids = Array.from({ length: 20 }, (_, i) => `a3${String(i).padStart(15, '0')}`);
  writeSession(dir, SESSION, [...Array(1200).fill(pad), ...ids.map((id, i) => entry.launched(`toolu_${i}`, id, at('10:00')))]);
  for (const id of ids) writeAgent(dir, SESSION, id, [...Array(250).fill(entry.agentUser(id, 'q'.repeat(4000), at('10:00'))), ...agentEntries(id, '10:00', '10:50')]);
  for (let i = 0; i < 300; i++) {
    const old = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    writeSession(dir, old, [entry.user('old', at('08:00'))]);
    writeAgent(dir, old, `a5${String(i).padStart(15, '0')}`, agentEntries('a5', '08:00', '08:30'));
  }
  buildView({ root, sup, env, now: NOW, commits: COMMITS });
  const t0 = process.hrtime.bigint();
  const v = buildView({ root, sup, env, now: NOW, commits: COMMITS });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(v.lanes[0].agents.length, 20);
  assert.ok(ms < 300, `warm view took ${ms.toFixed(0)} ms`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/view.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/view.mjs`.

- [ ] **Step 3: Add the config key and create `lib/view.mjs`**

In `lib/config.mjs`, inside `DEFAULTS`, add right after the line `  blocked_minutes_before_notify: 10,`:

```js
  // minutes without a transcript write before turbo-run view marks a subagent or a lane quiet (a mark only)
  stall_minutes: 15,
```

Create `lib/view.mjs`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULTS } from './config.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { claudeHome, runDir } from './paths.mjs';
import { nextStep, readProgress } from './phase-progress.mjs';
import { readLaneStatus } from './run-status.mjs';
import { comparePhase } from './scheduler.mjs';
import { maskSecrets } from './secrets.mjs';
import { laneAgents, laneTranscript, projectDirs } from './transcripts.mjs';

// What view keeps between calls (git-ignored run directory): per transcript file, the transcript layer's last result.
const CACHE_FILE = 'view-cache.json';
const CACHE_VERSION = 1;
const COMMITS = 5;
const GIT_TIMEOUT_MS = 5000;
const QUESTIONS_RE = /^p([A-Za-z0-9._-]+)-questions\.json$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Minutes without a transcript write before a subagent or a lane reads as quiet (config stall_minutes, at least 1).
export function stallMs(config) {
  const n = Math.floor(Number(config?.stall_minutes));
  return (Number.isFinite(n) && n >= 1 ? n : DEFAULTS.stall_minutes) * 60000;
}

// The owner questions still open, in phase order. S1 writes them to run/p<N>-questions.json as a JSON array of
// question objects whose state is "open" until answered; any other file content is skipped.
export function openQuestions(root) {
  let names = [];
  try {
    names = fs.readdirSync(runDir(root));
  } catch {
    return [];
  }
  const files = names.map((n) => QUESTIONS_RE.exec(n)).filter(Boolean).sort((a, b) => comparePhase(a[1], b[1]));
  const out = [];
  for (const m of files) {
    const list = readJson(path.join(runDir(root), m[0]), null);
    if (Array.isArray(list)) for (const q of list) if (isObj(q) && q.state === 'open' && typeof q.id === 'string') out.push(q);
  }
  return out;
}

// The last commits of the checkout, newest first: [{ sha, subject }]; none outside a git repository or before the
// first commit.
export function recentCommits(root, n = COMMITS) {
  let text = '';
  try {
    text = execFileSync('git', ['log', `-${n}`, '--format=%h%x1f%s'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' });
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map((line) => {
    const [sha, ...rest] = line.split('\x1f');
    return { sha, subject: maskSecrets(rest.join(' ')).slice(0, 200) };
  });
}

function loadCache(file) {
  const c = readJson(file, null);
  return isObj(c) && c.v === CACHE_VERSION && isObj(c.files) ? c.files : {};
}

// Written only where the run directory already exists: view never creates turbo's directories in a project. The
// cache is an optimization, so a failed write changes nothing.
function saveCache(file, files, before) {
  if (!fs.existsSync(path.dirname(file)) || JSON.stringify(files) === JSON.stringify(before)) return;
  try {
    writeJsonAtomic(file, { v: CACHE_VERSION, files });
  } catch { /* next call reads the transcripts again */ }
}

function laneView({ root, lane, home, now, stall, cache, used }) {
  const phase = String(lane.phase);
  const progress = readProgress(root, phase);
  const record = readLaneStatus(root, phase);
  // a lane record counts only when written since this lane's launch, as the supervisor reads it
  const fresh = Boolean(record && lane.launchedAt && Date.parse(record.at) >= Date.parse(lane.launchedAt));
  // supervisor.json lane.sessionId is the background job id claude --bg printed; the job state names the transcript
  const sessionId = typeof lane.sessionId === 'string' ? lane.sessionId : '';
  const main = sessionId ? laneTranscript({ home, root, jobId: sessionId }) : null;
  const t = laneAgents({ dirs: projectDirs(home, root), main, root, now, stallMs: stall, cache, used });
  const launched = Date.parse(lane.launchedAt);
  return {
    phase,
    step: nextStep(progress),
    done: progress.done,
    notes: Object.fromEntries(Object.entries(progress.notes).map(([k, v]) => [k, maskSecrets(String(v))])),
    status: fresh ? String(record.status) : 'running',
    reason: fresh ? maskSecrets(String(record.reason || '')) : '',
    sessionId,
    mode: lane.mode === 'full' ? 'full' : 'safe',
    launchedAt: lane.launchedAt || null,
    elapsedMs: Number.isFinite(launched) ? Math.max(0, now.getTime() - launched) : null,
    transcript: t.transcript,
    lastAt: t.lastAt,
    quiet: t.lastAt ? now.getTime() - Date.parse(t.lastAt) > stall : false,
    agents: t.agents,
  };
}

// Everything turbo-run view shows (spec §4) as one JSON-ready object: supervisor, range, lanes with their step and
// subagents, open questions, the last commits. sup is supervisor.json (null when absent); running says whether its
// daemon is alive (the caller owns the heartbeat rules).
export function buildView({ root, sup, running = false, config = {}, env = process.env, now = new Date(), commits = recentCommits }) {
  const home = claudeHome(env);
  const stall = stallMs(config);
  const cacheFile = path.join(runDir(root), CACHE_FILE);
  const cache = loadCache(cacheFile);
  const used = {};
  const lanes = (sup?.lane ? [sup.lane] : []).map((lane) => laneView({ root, lane, home, now, stall, cache, used }));
  saveCache(cacheFile, used, cache);
  return {
    v: 1,
    at: now.toISOString(),
    supervisor: sup ? { running: Boolean(running), pid: running ? sup.pid ?? null : null, finished: Boolean(sup.finished), halted: Boolean(sup.halted), failingSince: sup.failingSince || null, updatedAt: sup.updatedAt || null } : null,
    range: sup?.range ? { from: sup.range.from ?? null, to: sup.range.to ?? null } : null,
    lanes,
    questions: openQuestions(root),
    commits: commits(root),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/view.test.mjs test/config.test.mjs`
Expected: PASS: 9 new tests. `test/config.test.mjs` checks that `loadConfig` without a file equals `DEFAULTS`, which now includes `stall_minutes`.

- [ ] **Step 5: Commit**

```bash
git add lib/config.mjs lib/view.mjs test/view.test.mjs
git commit -q -m "feat: view — supervisor, lanes with step and subagents, open questions and commits, with a per-file cache"
```

---

### Task 8: `turbo-run view [--json]`, its text form and the README

**Files:**
- Modify: `lib/view.mjs` (append)
- Modify: `bin/turbo-run.mjs` (imports, `USAGE`, a `view` case in `main`)
- Modify: `README.md` (Use, Config)
- Test: `test/view.test.mjs` (the import from `../lib/view.mjs`, then append), `test/cli-view.test.mjs` (create)

**Interfaces:**
- Consumes: `buildView` (Task 7); in `bin/turbo-run.mjs`, the existing `runtimeConfig`, `loadConfig`, `readJson`, `supPath`, `supAlive`, `out` and `die`.
- Produces:
  - `fmtDuration(ms): string` (`45s`, `6m`, `1h 12m`, `-`);
  - `fmtTokens(n): string` (`950`, `41k`, `-`);
  - `formatView(view): string`;
  - the command `turbo-run view [--json]`: exit 0; outside a GSD project, or with a broken turbo config, exit 1 and one line on stderr.

- [ ] **Step 1: Write the failing tests**

In `test/view.test.mjs`, replace the import line from `../lib/view.mjs` with:

```js
import { buildView, formatView, openQuestions, recentCommits, stallMs } from '../lib/view.mjs';
```

Append to `test/view.test.mjs`:

```js
test('formatView prints one line per lane, subagent, question and commit', () => {
  const v = {
    v: 1, at: NOW.toISOString(),
    supervisor: { running: true, pid: 4242, finished: false, halted: false, failingSince: null, updatedAt: null },
    range: { from: '32', to: null },
    lanes: [{
      phase: '32', step: 'execute', status: 'running', reason: '', quiet: false, sessionId: '1a2b3c4d', elapsedMs: 72 * 60000,
      agents: [
        { type: 'gsd-executor', plan: '32-07', task: '2', state: 'running', action: { tool: 'Edit', detail: 'lib/x.mjs' }, elapsedMs: 6 * 60000, tokens: 166000 },
        { type: 'gsd-verifier', plan: null, task: null, state: 'quiet', action: { tool: 'Bash', detail: 'npm test' }, elapsedMs: 16 * 60000, tokens: null },
        { type: null, plan: '32-06', task: null, state: 'completed', action: null, elapsedMs: 45000, tokens: 950 },
      ],
    }],
    questions: [{ id: 'q1', plan: '32-09', task: '3', question: 'Deploy after green CI?' }],
    commits: [{ sha: 'a1b2c3d', subject: 'fix: something' }],
  };
  assert.equal(formatView(v), [
    'supervisor: running pid 4242',
    'range: phases 32–end',
    'p32 · execute · lane running · session 1a2b3c4d · 1h 12m',
    '  gsd-executor · 32-07 Task 2 · Edit lib/x.mjs · 6m · 166k',
    '  gsd-verifier · - · quiet · 16m · -',
    '  agent · 32-06 · completed · 45s · 950',
    'questions: 1 open',
    '  q1 · 32-09 Task 3 · Deploy after green CI?',
    'commits:',
    '  a1b2c3d fix: something',
  ].join('\n'));
  assert.equal(formatView({ supervisor: null, range: null, lanes: [], questions: [], commits: [] }), 'supervisor: not running (never started)');
});
```

Create `test/cli-view.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { SESSION, entry, projectDirFor, usage, writeAgent, writeSession } from './helpers/transcripts.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const run = (args, cwd, env) => execFileSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

test('turbo-run view prints the lane and its subagents; --json prints the same view as one JSON object', () => {
  const root = tmpGitRepo();
  const run_ = path.join(root, '.planning', 'turbo', 'run');
  fs.mkdirSync(run_, { recursive: true });
  // a dead pid without a recent heartbeat: not running
  fs.writeFileSync(path.join(run_, 'supervisor.json'), JSON.stringify({ pid: 2147483644, updatedAt: ago(120), lane: { phase: '32', sessionId: SESSION.slice(0, 8), launchedAt: ago(30), mode: 'full' } }));
  const home = tmpDir('home');
  const dir = projectDirFor(home, root);
  writeSession(dir, SESSION, [entry.user('run phase 32', ago(30)), entry.launched('toolu_1', 'a4000000000000001', ago(20))]);
  writeAgent(dir, SESSION, 'a4000000000000001', [
    entry.agentUser('a4000000000000001', 'Execute the plan', ago(20)),
    entry.assistant({ ts: ago(1), tool: { name: 'Edit', input: { file_path: path.join(root, 'lib', 'x.mjs') } }, usage: usage(0, 0, 166000), sidechain: true }),
  ]);
  const env = { CLAUDE_CONFIG_DIR: home };
  const text = run(['view'], root, env);
  assert.match(text, /^supervisor: not running$/m);
  assert.match(text, /^p32 · freshness · lane running · session 11111111 · 30m$/m);
  assert.match(text, /^ {2}gsd-executor · 32-07 · Edit lib\/x\.mjs · 20m · 166k$/m);
  assert.match(text, /^commits:\n {2}[0-9a-f]{7,} init$/m);
  const v = JSON.parse(run(['view', '--json'], root, env));
  assert.equal(v.supervisor.running, false);
  assert.equal(v.lanes[0].agents[0].agentId, 'a4000000000000001');
  assert.equal(v.lanes[0].agents[0].state, 'running');
});

// The exit status and stderr of a failing CLI call.
function failure(args, cwd) {
  try {
    run(args, cwd, { CLAUDE_CONFIG_DIR: tmpDir('home') });
  } catch (e) {
    return { status: e.status, stderr: e.stderr };
  }
  return { status: 0, stderr: '' };
}

test('turbo-run view outside a GSD project exits 1 with one line', () => {
  const r = failure(['view'], tmpDir('noplan'));
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'no .planning directory found');
});

test('turbo-run view with a broken turbo config exits 1 with a one-line error, never a stack trace (Review Focus 5)', () => {
  const root = tmpDir('badcfg');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), '{"stall_minutes": ');
  const r = failure(['view', '--json'], root);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  assert.match(r.stderr, /^invalid turbo config .*config\.json: /);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/view.test.mjs test/cli-view.test.mjs`
Expected: FAIL. `test/view.test.mjs` fails with `does not provide an export named 'formatView'`. The first CLI test fails because `turbo-run view` prints the usage and exits 1.

- [ ] **Step 3: Implement the text form and the command**

Append to `lib/view.mjs`:

```js
// 45s, 6m, 1h 12m; '-' when unknown.
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// 950, 41k, 166k; '-' when unknown.
export const fmtTokens = (n) => (!Number.isFinite(n) ? '-' : n < 1000 ? String(n) : `${Math.round(n / 1000)}k`);

const planLabel = (x) => (x.plan ? `${x.plan}${x.task ? ` Task ${x.task}` : ''}` : '-');

function agentLine(a) {
  const doing = a.state === 'running' && a.action ? `${a.action.tool} ${a.action.detail}`.trim() : a.state;
  return `  ${a.type || 'agent'} · ${planLabel(a)} · ${doing} · ${fmtDuration(a.elapsedMs)} · ${fmtTokens(a.tokens)}`;
}

// The text form of buildView's result: what turbo-run view prints without --json.
export function formatView(v) {
  const sup = v.supervisor;
  const lines = [`supervisor: ${!sup ? 'not running (never started)' : sup.running ? `running pid ${sup.pid}` : 'not running'}${sup?.finished ? ' · finished' : ''}${sup?.halted ? ' · halted' : ''}`];
  if (v.range) lines.push(`range: phases ${v.range.from ?? 'start'}–${v.range.to ?? 'end'}`);
  for (const l of v.lanes) {
    lines.push(`p${l.phase} · ${l.step ?? 'all steps done'} · lane ${l.status}${l.quiet ? ' (quiet)' : ''} · session ${l.sessionId || '-'} · ${fmtDuration(l.elapsedMs)}`);
    if (l.reason) lines.push(`  reason: ${l.reason}`);
    for (const a of l.agents) lines.push(agentLine(a));
  }
  if (v.questions.length) {
    lines.push(`questions: ${v.questions.length} open`);
    for (const q of v.questions) lines.push(`  ${q.id} · ${planLabel(q)} · ${String(q.question ?? '').slice(0, 100)}`);
  }
  if (v.commits.length) {
    lines.push('commits:');
    for (const c of v.commits) lines.push(`  ${c.sha} ${c.subject}`);
  }
  return lines.join('\n');
}
```

In `bin/turbo-run.mjs`:

1. Add a new import line after the last `../lib/` import (keep the others as they are):

```js
import { buildView, formatView } from '../lib/view.mjs';
```

2. In the `USAGE` constant, insert `view|` right after `status|` (the command list then reads `…|status|view|stop|…`).

3. In `main()`'s `switch (cmd)`, add this case right before the line `    case 'stop': {`:

```js
    case 'view': {
      if (!root) die('no .planning directory found');
      const config = runtimeConfig(loadConfig(root));
      const sup = readJson(supPath(root), null);
      const view = buildView({ root, sup, running: supAlive(sup, config.poll_seconds), config });
      out(args.includes('--json') ? JSON.stringify(view) : formatView(view));
      return 0;
    }
```

A broken config throws `invalid turbo config …` from `loadConfig`. `main()`'s existing error handler prints it as one line and exits 1.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/view.test.mjs test/cli-view.test.mjs`
Expected: PASS (10 + 3 tests).

Run: `node --test --test-name-pattern="unknown command" test/cli.test.mjs`
Expected: PASS (the existing usage test; the flag must come before the file).

- [ ] **Step 5: Document the command and the key in the README**

In `README.md`, section `## Use`:

1. In the `sh` line that starts with `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" doctor   # also:`, change `status, stop,` to `status, view [--json], stop,`.
2. After the paragraph that starts with ``Below, `turbo-run` stands for this`` insert this paragraph:

```markdown
To see a run at a glance, run `turbo-run view`. It shows the supervisor and its range; for each lane, its phase, its current `/turbo-phase` step, its status, session id and running time; the lane's subagents with their type, plan, current action, time and context tokens; open owner questions; and the last five commits. A subagent counts as `completed`, `stopped` or `failed` only once Claude Code has reported this to the lane session. Until then it is `running` while its transcript keeps being written, and `quiet` after `stall_minutes` without a write. `quiet` is only a mark: nothing is stopped or restarted because of it. `turbo-run view --json` prints the same information as one JSON object. The command reads Claude Code's transcripts and job state under `${CLAUDE_CONFIG_DIR:-~/.claude}` and turbo's run files, and changes none of them. It keeps a cache in `.planning/turbo/run/view-cache.json` and masks secrets in everything it prints.
```

In the `## Config` table, insert this row right after the `blocked_minutes_before_notify` row:

```markdown
| `stall_minutes` | `15` | Minutes without a transcript write after which `turbo-run view` shows a subagent or a lane as `quiet` (at least 1). Only a mark: nothing is stopped or restarted because of it. |
```

- [ ] **Step 6: Commit**

```bash
git add lib/view.mjs bin/turbo-run.mjs README.md test/view.test.mjs test/cli-view.test.mjs
git commit -q -m "feat: turbo-run view [--json] — lanes, subagents, questions and commits at a glance"
```

---

### Task 9: `turbo-run context` on the shared finder

A refactor under green tests. `fix-0.2.2-defects` gave `lib/context.mjs` its own copy of the lookup order (D6). This task replaces that copy with `findTranscript`, and the token sum with `contextTokens`, so the order lives in one place. The behaviour does not change, and the existing `test/context.test.mjs` is the safety net.

**Files:**
- Modify: `lib/context.mjs`
- Test: `test/context.test.mjs` (unchanged)

**Interfaces:**
- Consumes: `findTranscript` (Task 4) and `contextTokens` (Task 3).
- Produces: `measureContext({ root, phase = null, window, env = process.env })` with the same signature and the same result (`{ used, window, pct, sessionId, transcript, source }` or `{ unknown }`), and `lastUsage(file, foreign)` unchanged. The module-private lookup helpers (`transcripts`, `transcriptById`, `jobTranscript`, `cwdKey`, `measureFile`) and the export `findUsage` are removed; nothing outside `lib/context.mjs` uses them.

- [ ] **Step 1: Confirm the base and the green baseline**

Run: `git grep -n "findUsage" -- lib bin test skills agents`
Expected: matches only in `lib/context.mjs`. If anything else uses `findUsage`, stop and report: the switch would break it.

Run: `node --test test/context.test.mjs`
Expected: PASS (9 tests at `e2184c2`).

- [ ] **Step 2: Replace `lib/context.mjs`**

The file below is `lib/context.mjs` as of `e2184c2`, with the lookup replaced:
- `readTail` and `lastUsage` are kept as they were;
- `usedTokens` keeps its guards and sums with `contextTokens`;
- `measureContext` asks `findTranscript` for the file.

If `lib/context.mjs` in the base differs from `e2184c2`, keep its usage reader (`lastUsage` and whatever it calls) and apply the same replacement of the lookup.

```js
import fs from 'node:fs';
import path from 'node:path';
import { claudeHome, runDir } from './paths.mjs';
import { readJson } from './fsx.mjs';
import { contextTokens, findTranscript } from './transcripts.mjs';

// Transcripts reach hundreds of MB: only their tail is read, growing until a usage is found.
const FIRST_TAIL = 256 * 1024;
const MAX_TAIL = 16 * 1024 * 1024;

function readTail(file, size, n) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8', 0, got);
  } finally {
    fs.closeSync(fd);
  }
}

// Context in use after the last main-chain assistant message: its prompt side, cache included.
function usedTokens(e) {
  const u = e?.message?.usage;
  if (e?.type !== 'assistant' || e.isSidechain === true || !u || e.message.model === '<synthetic>') return null;
  return contextTokens(u);
}

// Reads a transcript from its end. Returns { used, cwd, sessionId, read }: used null when no main-chain
// assistant usage lies within MAX_TAIL, or once a cwd for which foreign(cwd) is true was seen (another
// project's transcript is not read any further); cwd is the newest main-chain cwd seen (null when none).
export function lastUsage(file, foreign = () => false) {
  const size = fs.statSync(file).size;
  let cwd = null;
  for (let n = Math.min(size, FIRST_TAIL); ; n = Math.min(size, n * 4)) {
    const lines = readTail(file, size, n).split('\n');
    if (n < size) lines.shift(); // starts inside a line
    cwd = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let e;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (!e || typeof e !== 'object' || e.isSidechain === true) continue;
      if (cwd === null && typeof e.cwd === 'string' && e.cwd) cwd = e.cwd;
      const used = usedTokens(e);
      if (used !== null) return { used, cwd: cwd ?? e.cwd ?? null, sessionId: e.sessionId || null, read: n };
    }
    if (n >= size || n >= MAX_TAIL || (cwd && foreign(cwd))) return { used: null, cwd, sessionId: null, read: n };
  }
}

// { used, window, pct, sessionId, transcript, source } or { unknown: why }. phase: a normalized id; the lane
// supervisor.json records for it is the third way to find the transcript. The order (session, job, lane, newest)
// is findTranscript's in lib/transcripts.mjs, and source names the way that found it.
export function measureContext({ root, phase = null, window, env = process.env }) {
  const w = Number(window);
  if (!Number.isFinite(w) || w <= 0) return { unknown: 'context_window in .planning/turbo/config.json is not a positive number' };
  const home = claudeHome(env);
  const rec = phase ? readJson(path.join(runDir(root), 'supervisor.json'), null)?.lane : null;
  const lane = rec && String(rec.phase) === String(phase) && typeof rec.sessionId === 'string' ? rec.sessionId : '';
  const t = findTranscript({ home, root, env, lane });
  if (!t) return { unknown: `no transcript of ${root} under ${path.join(home, 'projects')}` };
  let r;
  try {
    r = lastUsage(t.file);
  } catch (e) {
    return { unknown: `cannot read ${t.file}: ${e.code || e.message}` };
  }
  if (r.used === null) return { unknown: `no assistant message with token usage in the last ${Math.round(r.read / 1024)} KB of ${t.file}` };
  return { used: r.used, window: w, pct: Math.floor((r.used * 100) / w), sessionId: r.sessionId, transcript: t.file, source: t.via };
}
```

- [ ] **Step 3: Run the tests to verify they still pass**

Run: `node --test test/context.test.mjs test/transcripts.test.mjs`
Expected: PASS (9 + 26 tests). The context tests pin the order (`session`, `job`, `lane`, `newest`), the job state over the stale `<jobId>-…` file, a `linkScanPath` outside `projects/`, the cwd fallback with subfolders and the Git Bash form, the growing tail, the unknown reasons and the CLI.

- [ ] **Step 4: Commit**

```bash
git add lib/context.mjs
git commit -q -m "refactor: turbo-run context finds its transcript with the shared finder in lib/transcripts.mjs"
```

---

## After the last task

The controller runs the full suite once (`npm test`) before merging, as the Global Constraints require. Nothing in this plan pushes, merges, tags or installs.

Follow-ups that belong to other sub-projects:
- **S1:**
  - `agent-tail` on `findAgentTranscript` and `tailEntries`;
  - the liveness check (§5.5.6) on `laneTranscript` and its mtime;
  - recording `lane.sessionId` after a wake (D15);
  - writing `state: "open"` questions (D7).
- **S2:** the `push` and `ci` keys in the view; its Task 1 writes `lib/secrets.mjs` byte for byte as Task 1 here does (D11).
- **S3:** `render(view)` over this contract.
