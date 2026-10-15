// A lane session's PreToolUse hook (lib/lane-guard.mjs): Claude Code runs it before each Write, Edit, MultiEdit and
// NotebookEdit of the lane and its subagents, with the call as JSON on stdin and the guard's settings as the argument.
// It always exits 0: no output allows, a deny prints Claude Code's PreToolUse JSON; a stdin it cannot read allows with
// one line on stderr.
import { hookOutput, readStdin } from './lane-guard.mjs';

let out = '';
try {
  out = hookOutput(readStdin(), process.argv[2]);
} catch (err) {
  process.stderr.write(`lane guard: stdin unreadable (${err?.code || 'error'}), allowing\n`);
}
if (out) process.stdout.write(`${out}\n`);
