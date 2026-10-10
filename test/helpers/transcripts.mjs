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
