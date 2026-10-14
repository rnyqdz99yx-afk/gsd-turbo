// A lane session's PreToolUse hook (lib/lane-guard.mjs): Claude Code runs it before each Write, Edit, MultiEdit and
// NotebookEdit of the lane and its subagents, with the call as JSON on stdin and the guard's settings as the argument.
// It always exits 0: no output allows, a deny prints Claude Code's PreToolUse JSON.
import fs from 'node:fs';
import { hookOutput } from './lane-guard.mjs';

let out = '';
try {
  out = hookOutput(fs.readFileSync(0, 'utf8'), process.argv[2]);
} catch {
  // stdin unreadable: allow
}
if (out) process.stdout.write(`${out}\n`);
