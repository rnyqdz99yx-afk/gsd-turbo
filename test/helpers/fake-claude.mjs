import fs from 'node:fs';
import path from 'node:path';
import { SESSION, usage } from './transcripts.mjs';

// A stand-in for `claude -p --output-format stream-json` (lib/headless.mjs), in the event shapes the live probe printed
// (Claude Code 2.1.302): SessionStart hook events, init, assistant events (one message repeated per content block), the
// result. It reads all of stdin, records the call in <dir>/calls.jsonl, writes a transcript line under
// <CLAUDE_CONFIG_DIR>/projects/<projectKey(cwd)>/<id>.jsonl, then prints. Behavior: <dir>/behavior.json, re-read per run.
//   sessionId (SESSION; with --resume <id> it reports <id> unless resumeNewId), result ('done'), isError (false),
//   exitCode (0), resultUsage (usage(20, 200, 2000)), messages ([[id, usage], …], FAKE_MESSAGES), noResult,
//   hang (after init: silent, alive), chatter (after init: an assistant event every 100 ms, forever),
//   transcriptTicks + tickMs + tickSubagent (after init: that many transcript lines, in <id>/subagents/agent-a1.jsonl
//   when tickSubagent, no stdout, then the result), grandchild: 'ignore' | 'inherit' (a node child with that stdout,
//   its pid in <dir>/grandchild.pid; detached off Windows, as Claude Code starts its shell-tool commands),
//   transcriptKey (the project directory's name instead of projectKey(cwd)), transcriptLateMs (the transcript's first
//   line written that long after init instead of before it).
export const FAKE_MESSAGES = [
  ['msg_1', { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 1 }],
  ['msg_1', { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 }],
  ['msg_2', { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 }],
];

const SCRIPT = `'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dir = __dirname;
const B = JSON.parse(fs.readFileSync(path.join(dir, 'behavior.json'), 'utf8'));
const argv = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString('utf8');
  const envOf = (k) => (process.env[k] === undefined ? null : process.env[k]);
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ argv, stdin, env: { CLAUDECODE: envOf('CLAUDECODE'), CLAUDE_CODE_SESSION_ID: envOf('CLAUDE_CODE_SESSION_ID'), CLAUDE_CONFIG_DIR: envOf('CLAUDE_CONFIG_DIR') } }) + '\\n');
  const ri = argv.indexOf('--resume');
  const id = ri >= 0 && !B.resumeNewId ? argv[ri + 1] : B.sessionId;
  const tdir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', B.transcriptKey || process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
  const tfile = path.join(tdir, id + '.jsonl');
  const firstLine = () => {
    fs.mkdirSync(tdir, { recursive: true });
    fs.appendFileSync(tfile, JSON.stringify({ type: 'user', sessionId: id, message: { role: 'user', content: stdin } }) + '\\n');
  };
  if (B.transcriptLateMs) setTimeout(firstLine, B.transcriptLateMs);
  else firstLine();
  const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
  if (B.grandchild) {
    const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', B.grandchild === 'inherit' ? 'inherit' : 'ignore', 'ignore'], detached: process.platform !== 'win32' });
    g.unref();
    fs.writeFileSync(path.join(dir, 'grandchild.pid'), String(g.pid));
  }
  out({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' });
  out({ type: 'system', subtype: 'init', session_id: id, model: 'claude-opus-5-5', tools: ['Read'], permissionMode: 'bypassPermissions' });
  const finish = () => {
    for (const [mid, u] of B.messages) out({ type: 'assistant', session_id: id, parent_tool_use_id: null, message: { id: mid, usage: u } });
    if (!B.noResult) out({ type: 'result', subtype: B.isError ? 'error_during_execution' : 'success', is_error: Boolean(B.isError), result: B.result, session_id: id, usage: B.resultUsage });
    process.exitCode = B.exitCode;
  };
  if (B.hang) return void setInterval(() => {}, 1000);
  if (B.chatter) return void setInterval(() => out({ type: 'assistant', session_id: id, message: { id: 'msg_chatter', usage: B.messages[0][1] } }), 100);
  if (B.transcriptTicks) {
    const file = B.tickSubagent ? path.join(tdir, id, 'subagents', 'agent-a1.jsonl') : tfile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let n = 0;
    const tick = () => {
      fs.appendFileSync(file, JSON.stringify({ type: 'assistant', sessionId: id, tick: n }) + '\\n');
      if (++n < B.transcriptTicks) setTimeout(tick, B.tickMs);
      else finish();
    };
    return void setTimeout(tick, B.tickMs);
  }
  finish();
});
`;

const DEFAULTS = { sessionId: SESSION, result: 'done', isError: false, exitCode: 0, resultUsage: usage(20, 200, 2000), messages: FAKE_MESSAGES, noResult: false, hang: false, chatter: false, transcriptTicks: 0, tickMs: 100, tickSubagent: false, grandchild: null, resumeNewId: false, transcriptKey: null, transcriptLateMs: 0 };

export function fakeClaude(dir, behavior = {}) {
  const script = path.join(dir, 'fake-claude.cjs');
  const file = path.join(dir, 'behavior.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(script, SCRIPT);
  let current = { ...DEFAULTS, ...behavior };
  fs.writeFileSync(file, JSON.stringify(current));
  const home = path.join(dir, 'claude-home');
  fs.mkdirSync(home, { recursive: true });
  return {
    bin: { cmd: process.execPath, prefix: [script], shell: false },
    home,
    set(patch) {
      current = { ...current, ...patch };
      fs.writeFileSync(file, JSON.stringify(current));
    },
    calls() {
      try {
        return fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    grandchildPid() {
      try {
        const n = Number(fs.readFileSync(path.join(dir, 'grandchild.pid'), 'utf8'));
        return Number.isInteger(n) && n > 0 ? n : null;
      } catch {
        return null;
      }
    },
  };
}
