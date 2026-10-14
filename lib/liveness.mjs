// Whether a session is busy, active or silent (spec §5.5.6, Stage 4 liveness), one rule for the view and the supervisor.
// Claude Code writes nothing to a transcript while a tool call runs: the call's tool_use stays the last entry until
// its tool_result comes back. A command (Bash, PowerShell) runs at most its timeout, then Claude Code ends it (or
// moves it to the background) and writes the result. So a session with a command in flight within its timeout is
// busy, never silent; a command past its timeout with nothing written since is silent at once. Pure: no imports.

// The timeout of a command without one in its input: Claude Code 2.1.29x runs such a command up to 600000 ms (seen in
// its transcripts: commands without a timeout ran 523 s, and timed out at 601 s), whatever older docs say (120000).
export const COMMAND_TIMEOUT_MS = 600000;
// BASH_MAX_TIMEOUT_MS can raise Claude Code's 600000 cap; a longer timeout in the input still counts as an hour.
const TIMEOUT_CAP_MS = 3600000;
// Time past a command's timeout for Claude Code to end it and write its result.
export const OVERRUN_MS = 120000;
// A command in flight at least this long is a long command the view names.
export const LONG_CALL_MS = 60000;
const COMMANDS = new Set(['Bash', 'PowerShell']);
// Calls that wait for a helper: the helper's own transcript, in the session's subagents tree, tells whether it lives.
export const HELPER_TOOLS = new Set(['Agent', 'Task']);
// Stall wakes in a row without an answer from the session; then the supervisor tells the owner once and wakes no more.
export const MAX_STALL_WAKES = 2;

const tsOf = (e) => {
  const ms = Date.parse(e?.timestamp);
  return Number.isFinite(ms) ? ms : null;
};

function commandTimeout(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, TIMEOUT_CAP_MS) : COMMAND_TIMEOUT_MS;
}

// The tool calls in flight among a transcript's entries (oldest first, as tailEntries returns them): the tool_use
// blocks of its last assistant message (Claude Code writes each block as an entry of its own, under one message id)
// that no tool_result answers. A run_in_background call is left out: its result comes back at once. A prompt after
// that message (a wake, a message to the session; not a meta entry) means its calls were left: none is in flight.
// Each is { id, tool, startMs, timeoutMs }. startMs is the newest time of the message's own entries and of the results
// after it (no other entry, so a later write never renews it): calls of one message may run one after another, so the
// last result written is the earliest a call still pending started. timeoutMs is a command's timeout (its input's,
// else COMMAND_TIMEOUT_MS) for the first call still pending only: a call after it may wait in line until it ends, so no
// deadline is known for it, nor for a call of another tool.
export function callsInFlight(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let last = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.type === 'assistant') {
      last = i;
      break;
    }
  }
  if (last < 0) return [];
  const mid = list[last].message?.id;
  const ofMessage = (e) => e?.type === 'assistant' && (mid ? e.message?.id === mid : e === list[last]);
  const first = mid ? list.findIndex(ofMessage) : last;
  const answered = new Set();
  let startMs = null;
  const seen = (e) => {
    const t = tsOf(e);
    if (t !== null && (startMs === null || t > startMs)) startMs = t;
  };
  for (let i = first; i < list.length; i++) {
    const e = list[i];
    if (ofMessage(e)) {
      seen(e);
      continue;
    }
    if (e?.type !== 'user' || e.isMeta === true) continue;
    const c = e.message?.content;
    const results = Array.isArray(c) ? c.filter((b) => b?.type === 'tool_result' && typeof b.tool_use_id === 'string') : [];
    if (!results.length) return [];
    for (const b of results) answered.add(b.tool_use_id);
    seen(e);
  }
  if (startMs === null) return [];
  const calls = [];
  for (let i = first; i <= last; i++) {
    const c = ofMessage(list[i]) ? list[i].message?.content : null;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type !== 'tool_use' || typeof b.id !== 'string' || answered.has(b.id)) continue;
      const input = b.input && typeof b.input === 'object' ? b.input : {};
      if (input.run_in_background === true) continue;
      const tool = String(b.name ?? '');
      calls.push({ id: b.id, tool, startMs, timeoutMs: !calls.length && COMMANDS.has(tool) ? commandTimeout(input.timeout) : null });
    }
  }
  return calls;
}

// The liveness of a session, or of its whole tree (its transcript and every subagent's, at any depth), from its
// newest write lastMs and the calls in flight (callsInFlight of each transcript):
// busy: a command runs within its timeout and OVERRUN_MS;
// silent: a command ran past that and nothing was written after its deadline, or nothing was written for stallMs
// (a call of another tool has no deadline: only the write rule counts for it);
// active: anything else, and always when nothing could be read (lastMs null is no proof of silence).
// floorMs (a launch or a wake) restarts the count: silence counts from it, and a command whose deadline passed before
// it is no overrun. Returns { state, call }: busy, the command running longest; silent by an overrun, that command;
// otherwise null.
export function liveness({ lastMs, calls = [], nowMs, stallMs, floorMs = 0 }) {
  const commands = (Array.isArray(calls) ? calls : []).filter((c) => Number.isFinite(c?.startMs) && Number.isFinite(c?.timeoutMs));
  const deadline = (c) => c.startMs + c.timeoutMs + OVERRUN_MS;
  const oldest = (l) => l.reduce((a, b) => (b.startMs < a.startMs ? b : a));
  const busy = commands.filter((c) => nowMs <= deadline(c));
  if (busy.length) return { state: 'busy', call: oldest(busy) };
  if (!Number.isFinite(lastMs)) return { state: 'active', call: null };
  const floor = Number.isFinite(floorMs) ? floorMs : 0;
  const over = commands.filter((c) => deadline(c) > floor && lastMs <= deadline(c));
  if (over.length) return { state: 'silent', call: oldest(over) };
  return { state: nowMs - Math.max(lastMs, floor) >= stallMs ? 'silent' : 'active', call: null };
}

// The command a view names as long: { since (ISO) } while a busy session's command has run LONG_CALL_MS, else null.
export function longCall(live, nowMs) {
  return live?.state === 'busy' && nowMs - live.call.startMs >= LONG_CALL_MS ? { since: new Date(live.call.startMs).toISOString() } : null;
}
