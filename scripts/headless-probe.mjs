#!/usr/bin/env node
// Live probe of the `claude -p` behaviours lib/headless.mjs relies on (Stage 6 B1, spec §6.2, §8): stream-json events,
// --effort, --agent, the --settings write guard, --resume after -p, the transcript path, GSD's hooks in -p, the tree
// kill and --append-system-prompt-file. It runs the real claude (about 10 small Opus calls at effort low) in a throwaway
// git repository, with the module's own argv, environment and settings, so a PASS validates exactly what the build path
// launches. Not installed (install.mjs copies bin/ and lib/ only): run it from a clone.
// Usage: node scripts/headless-probe.mjs [--dry-run] [--only P1,P4] [--keep]
// Prints PASS|FAIL P<n> <name>: <detail> per item, then PROBE_SUMMARY <json>; exit 0 only when every item passed.
// It never writes under the owner's turbo directory: the session's settings and temp directory go to a turbo home inside
// the probe's own temp directory (the child still runs with the real Claude config directory: login, agents, hooks).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildHeadlessArgs, headlessEnv, sessionSettings, killTree } from '../lib/headless.mjs';
import { resolveBin } from '../lib/claude.mjs';
import { claudeHome } from '../lib/paths.mjs';
import { removeLaneTmp } from '../lib/lane-tmp.mjs';
import { sessionById, projectKey, projectDirs } from '../lib/transcripts.mjs';
import { processTable } from '../lib/daemon-probe.mjs';

const SELF = fileURLToPath(import.meta.url);
const CALL_CAP_MS = 5 * 60000;
const AGENT = 'gsd-code-reviewer';
const USAGE_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];

export const PROBE_ITEMS = Object.freeze([
  { id: 'P1', name: 'stream-json' },
  { id: 'P2', name: '--effort' },
  { id: 'P3', name: '--agent' },
  { id: 'P4', name: 'write guard' },
  { id: 'P5', name: '--resume' },
  { id: 'P6', name: 'transcript' },
  { id: 'P7', name: 'GSD hooks' },
  { id: 'P8', name: 'tree kill' },
  { id: 'P9', name: '--append-system-prompt-file' },
]);

// The argv of an item's call. ctx: { settingsFile, session, file }. P2 is P1's run plus a call with --effort bogus (here);
// P6 reads P1's run; P5 is its resume call (its first call is P1's argv).
export function probeArgs(id, { settingsFile, session, file } = {}) {
  const base = { effort: 'low', settingsFile };
  switch (id) {
    case 'P1': case 'P4': case 'P6': case 'P8': return buildHeadlessArgs(base);
    case 'P2': return buildHeadlessArgs(base).map((a, i, all) => (all[i - 1] === '--effort' ? 'bogus' : a));
    case 'P3': return buildHeadlessArgs({ ...base, agent: AGENT });
    case 'P5': return buildHeadlessArgs({ ...base, resume: session });
    case 'P7': return [...buildHeadlessArgs(base), '--include-hook-events'];
    // always the file flag: this item probes it, whatever HEADLESS.appendViaFile says
    case 'P9': return [...buildHeadlessArgs(base), '--append-system-prompt-file', String(file)];
    default: throw new Error(`unknown probe item ${id}`);
  }
}

function dryRun(ids) {
  // a session id must pass the module's check: a valid stand-in, printed as <session>
  const SESSION = 'probe-session-placeholder';
  const ctx = { settingsFile: '<settings>', session: SESSION, file: '<file>' };
  for (const { id } of PROBE_ITEMS.filter((p) => ids.has(p.id))) {
    if (id === 'P2') console.log('P2 (from P1) + --effort bogus');
    else if (id === 'P6') console.log('P6 (from P1)');
    else console.log(`${id} claude ${probeArgs(id, ctx).map((a) => (a === SESSION ? '<session>' : a)).join(' ')}`);
  }
}

const hex = () => randomBytes(3).toString('hex');
const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const lineCount = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return null; } };

// Every tool_result text of the user events.
function toolResults(events) {
  const out = [];
  for (const e of events) {
    if (e.type !== 'user' || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) {
      if (c?.type !== 'tool_result') continue;
      out.push(typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x?.text ?? '').join('\n') : JSON.stringify(c.content ?? ''));
    }
  }
  return out;
}

const initOf = (events) => events.find((e) => e.type === 'system' && e.subtype === 'init') ?? null;
const resultOf = (events) => events.findLast((e) => e.type === 'result') ?? null;

// The last usage of each distinct assistant message id, summed.
function streamUsage(events) {
  const last = new Map();
  for (const e of events) if (e.type === 'assistant' && e.message?.id && e.message?.usage) last.set(e.message.id, e.message.usage);
  const sum = Object.fromEntries(USAGE_KEYS.map((k) => [k, 0]));
  for (const u of last.values()) for (const k of USAGE_KEYS) sum[k] += Number.isFinite(u[k]) ? u[k] : 0;
  return sum;
}

function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '';
  const ids = new Set(only ? only.split(',').map((s) => s.trim().toUpperCase()) : PROBE_ITEMS.map((p) => p.id));
  for (const id of ids) if (!PROBE_ITEMS.some((p) => p.id === id)) throw new Error(`unknown probe item ${id}`);
  if (argv.includes('--dry-run')) return dryRun(ids);
  return live(ids, { keep: argv.includes('--keep') }).then((ok) => { process.exitCode = ok ? 0 : 1; });
}

async function live(ids, { keep }) {
  const bin = resolveBin();
  if (bin.unsupported) throw new Error(bin.unsupported);
  const version = String(execFileSync(bin.cmd, [...bin.prefix, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 60000 })).trim();
  const ownEnv = { ...process.env };
  const env = headlessEnv(ownEnv);
  const home = claudeHome(env);
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-probe-')));
  const repo = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(repo, '.planning'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(repo, 'README.md'), '# probe\n');
  fs.writeFileSync(path.join(repo, '.planning', 'STATE.md'), '# State: probe project\n');
  fs.writeFileSync(path.join(repo, '.planning', 'config.json'), '{}\n');
  const git = (...a) => String(execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'probe');
  git('config', 'user.email', 'probe@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  // sessionSettings under a turbo home of the probe's own (see the header)
  const sandbox = path.join(base, 'claude-home');
  const inSandbox = (fn) => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = sandbox;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  };
  const { settingsFile } = inSandbox(() => sessionSettings({ root: repo, key: 'probe', cwd: repo }));
  const appendFile = path.join(base, 'role.md');
  const ctx = { settingsFile, file: appendFile };

  // One claude call: the prompt on stdin, stream-json lines collected, the whole tree killed after CALL_CAP_MS.
  const run = (args, prompt, { onSpawn } = {}) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(bin.cmd, [...bin.prefix, ...args], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32' });
    const events = [];
    let tail = '';
    let stderr = '';
    let exitCode = null;
    let done = false;
    const cap = setTimeout(() => killTree(child.pid), CALL_CAP_MS);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(cap);
      if (tail.trim()) { try { events.push(JSON.parse(tail)); } catch { /* not an event */ } }
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code: exitCode, events, stderr, ms: Date.now() - t0, pid: child.pid });
    };
    child.on('error', (e) => { clearTimeout(cap); reject(new Error(`claude failed to start: ${e.code || e.message}`)); });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(prompt, 'utf8'));
    child.stdout.on('data', (d) => {
      const lines = (tail + d).split('\n');
      tail = lines.pop();
      for (const l of lines) {
        const s = l.replace(/\r$/, '');
        if (!s.trim()) continue;
        try { events.push(JSON.parse(s)); } catch { /* not an event */ }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => { exitCode = code; setTimeout(finish, 2000); });
    child.on('close', finish);
    onSpawn?.(child);
  });

  const report = [];
  const summary = { version, platform: process.platform, items: {} };
  const record = (id, ok, detail) => {
    const name = PROBE_ITEMS.find((p) => p.id === id).name;
    report.push(ok);
    summary.items[id] = ok ? 'PASS' : 'FAIL';
    console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}: ${detail}`);
  };
  const guarded = async (id, fn) => {
    try {
      await fn();
    } catch (e) {
      record(id, false, `probe error: ${e.message}`);
    }
  };

  let p1 = null;
  try {
    if (ids.has('P1') || ids.has('P2') || ids.has('P6')) p1 = await run(probeArgs('P1', ctx), 'Use the Read tool on README.md, then reply with the single word PONG.');

    if (ids.has('P1')) await guarded('P1', () => {
      const ev = p1.events;
      const init = initOf(ev);
      const result = resultOf(ev);
      const assistants = ev.filter((e) => e.type === 'assistant' && e.message?.id && e.message?.usage);
      const types = ev.map((e) => (e.subtype ? `${e.type}/${e.subtype}` : e.type));
      // SessionStart hook events (system/hook_started, system/hook_response) come before init even without
      // --include-hook-events (probe 2026-10-17): init is the first event of any other kind
      const first = ev.find((e) => !(e.type === 'system' && /^hook_/.test(String(e.subtype))));
      const ownSocket = String(ownEnv.CLAUDE_CODE_MESSAGING_SOCKET ?? '');
      const socketLeak = Boolean(ownSocket) && String(first?.messaging_socket_path ?? '') === ownSocket;
      const initOk = first?.type === 'system' && first?.subtype === 'init' && typeof first.session_id === 'string' && first.permissionMode === 'bypassPermissions' && Array.isArray(first.tools) && !first.tools.includes('AskUserQuestion') && !socketLeak;
      const resultOk = ev.at(-1)?.type === 'result' && result?.is_error === false && String(result?.result ?? '').includes('PONG') && USAGE_KEYS.every((k) => typeof result?.usage?.[k] === 'number');
      const usagePair = { result: result?.usage ? Object.fromEntries(USAGE_KEYS.map((k) => [k, result.usage[k]])) : null, stream: streamUsage(ev) };
      Object.assign(summary, { p1Types: [...new Set(types)], initKeys: init ? Object.keys(init) : null, resultKeys: result ? Object.keys(result) : null, initModel: init?.model ?? null, usage: usagePair, initIndex: ev.indexOf(init) });
      record('P1', p1.code === 0 && initOk && assistants.length >= 1 && resultOk,
        `exit ${p1.code}; events ${types.join(',')}; init at ${ev.indexOf(init)}, permissionMode ${init?.permissionMode}, AskUserQuestion ${init?.tools?.includes('AskUserQuestion') ? 'offered' : 'absent'}, messaging socket ${socketLeak ? 'THE CALLER\'S' : 'own'}; result ${JSON.stringify(String(result?.result ?? '').slice(0, 40))}; init keys [${init ? Object.keys(init).join(',') : '-'}]; result keys [${result ? Object.keys(result).join(',') : '-'}]; init.model ${init?.model}; result.usage ${JSON.stringify(usagePair.result)} vs stream ${JSON.stringify(usagePair.stream)}`);
    });

    if (ids.has('P2')) await guarded('P2', async () => {
      const bogus = await run(probeArgs('P2', ctx), 'x');
      const init = initOf(p1.events);
      const effortKeys = init ? Object.keys(init).filter((k) => /effort/i.test(k)).map((k) => `${k}=${JSON.stringify(init[k])}`) : [];
      const rejected = bogus.code !== 0 && !resultOf(bogus.events);
      summary.effort = { bogusRejected: rejected, bogusExit: bogus.code, bogusStderr: bogus.stderr.trim().slice(0, 200), initEffort: effortKeys };
      record('P2', p1.code === 0 && !/unknown option/i.test(p1.stderr),
        `P1 exit ${p1.code}, stderr ${p1.stderr.trim() ? JSON.stringify(p1.stderr.trim().slice(0, 200)) : 'empty'}; INFO bogus ${rejected ? 'rejected' : 'accepted'} (exit ${bogus.code}, ${JSON.stringify(bogus.stderr.trim().slice(0, 160))}); init effort fields [${effortKeys.join(',')}]`);
    });

    if (ids.has('P3')) await guarded('P3', async () => {
      const agentFile = path.join(home, 'agents', `${AGENT}.md`);
      if (!fs.existsSync(agentFile)) return record('P3', false, `${agentFile} missing`);
      const toolsLine = /^tools:\s*(.+)$/m.exec(fs.readFileSync(agentFile, 'utf8'))?.[1] ?? '';
      const want = toolsLine.split(',').map((s) => s.trim()).filter(Boolean);
      const r = await run(probeArgs('P3', ctx), 'Reply with the single word READY.');
      const init = initOf(r.events);
      const result = resultOf(r.events);
      const tools = Array.isArray(init?.tools) ? init.tools : [];
      const byName = init?.agent === AGENT;
      const byTools = want.length > 0 && want.every((t) => tools.includes(t)) && !tools.includes('Edit');
      summary.agent = { initAgent: init?.agent ?? null, byName, byTools, tools };
      record('P3', r.code === 0 && String(result?.result ?? '').includes('READY') && (byName || byTools),
        `exit ${r.code}; init.agent ${JSON.stringify(init?.agent ?? null)}; agent tools [${want.join(',')}]; init.tools [${tools.join(',')}]; result ${JSON.stringify(String(result?.result ?? '').slice(0, 80))}`);
    });

    if (ids.has('P4')) await guarded('P4', async () => {
      const out = path.join(outside, 'probe-outside.txt');
      const inside = path.join(repo, 'inside.txt');
      const prompt = [
        'Do these three steps in order. If a step fails, note the error and go on with the next one.',
        `1. Use the Write tool to create the file ${out} with the content x`,
        `2. Use the Write tool to create the file ${inside} with the content y`,
        '3. Run this command with your shell tool: node -e "console.log(\'LANE=\'+process.env.TURBO_LANE)"',
        'Then report in one short line what happened in each step.',
      ].join('\n');
      const r = await run(probeArgs('P4', ctx), prompt);
      const texts = toolResults(r.events);
      const denied = texts.some((t) => t.includes('gsd-turbo lane guard'));
      const lane = texts.some((t) => t.includes('LANE=1'));
      summary.guard = { outsideWritten: fs.existsSync(out), insideWritten: fs.existsSync(inside), denied, lane };
      record('P4', !fs.existsSync(out) && fs.existsSync(inside) && denied && lane,
        `exit ${r.code}; outside file ${fs.existsSync(out) ? 'WRITTEN' : 'absent'}; inside file ${fs.existsSync(inside) ? 'present' : 'absent'}; guard denial ${denied ? 'seen' : 'not seen'}; LANE=1 ${lane ? 'seen' : 'not seen'}`);
    });

    if (ids.has('P5')) await guarded('P5', async () => {
      const token = `ТУРБО-${hex()}`;
      const a = await run(probeArgs('P1', ctx), `Remember the token ${token}. Reply with OK only.`);
      const s = initOf(a.events)?.session_id ?? resultOf(a.events)?.session_id;
      if (!s) return record('P5', false, `first call gave no session id (exit ${a.code})`);
      const tA = sessionById({ home, root: repo, sessionId: s });
      const linesA = tA ? lineCount(tA.file) : null;
      const b = await run(probeArgs('P5', { ...ctx, session: s }), 'Repeat the token I gave you, nothing else.');
      const bInit = initOf(b.events);
      const bResult = String(resultOf(b.events)?.result ?? '');
      const keeps = bInit?.session_id === s;
      const linesB = tA ? lineCount(tA.file) : null;
      const bFile = !keeps && bInit?.session_id ? sessionById({ home, root: repo, sessionId: bInit.session_id }) : null;
      summary.resume = { resumeKeepsId: keeps, linesAfterA: linesA, linesAfterB: linesB, newSessionLines: bFile ? lineCount(bFile.file) : null };
      summary.resumeKeepsId = keeps;
      record('P5', b.code === 0 && bResult.includes(token),
        `exit ${b.code}; result ${JSON.stringify(bResult.slice(0, 80))}; INFO resumeKeepsId ${keeps} (B init ${bInit?.session_id ?? '-'}); transcript lines after A ${linesA}, after B ${linesB}${bFile ? `, B's own ${lineCount(bFile.file)}` : ''}`);
    });

    if (ids.has('P6')) await guarded('P6', () => {
      const id = initOf(p1.events)?.session_id;
      const want = id ? path.join(home, 'projects', projectKey(repo), `${id}.jsonl`) : null;
      const hit = id ? sessionById({ home, root: repo, sessionId: id }) : null;
      summary.transcript = { expected: want, found: hit?.file ?? null };
      record('P6', Boolean(hit && want && sameFile(hit.file, want)), `expected ${want}; found ${hit?.file ?? 'nothing'}`);
    });

    if (ids.has('P7')) await guarded('P7', async () => {
      const prompt = [
        'Do these steps in order:',
        '1. Use the Write tool to create notes.md in the current directory with the content a',
        '2. Use the Read tool to read notes.md',
        '3. Use the Edit tool to change a to b in notes.md',
        '4. Run with your shell tool: git add notes.md && git commit -m "test: probe"',
        'Then reply with DONE.',
      ].join('\n');
      const r = await run(probeArgs('P7', ctx), prompt);
      const notes = (() => { try { return fs.readFileSync(path.join(repo, 'notes.md'), 'utf8').trim(); } catch { return null; } })();
      const subject = (() => { try { return git('log', '-1', '--format=%s'); } catch { return null; } })();
      const result = resultOf(r.events);
      const hooks = r.events.filter((e) => e.type === 'system' && /hook/i.test(String(e.subtype)));
      const seen = [...new Set(hooks.map((e) => `${e.hook_name ?? e.hook_event ?? '?'}:${e.subtype}${e.outcome ? `=${e.outcome}` : ''}${e.exit_code !== undefined ? `(${e.exit_code})` : ''}`))];
      summary.hooks = seen;
      record('P7', notes === 'b' && subject === 'test: probe' && result?.is_error === false,
        `exit ${r.code}; notes.md ${JSON.stringify(notes)}; last commit ${JSON.stringify(subject)}; result error ${result?.is_error}; INFO hook events ${hooks.length}: ${seen.join(', ') || 'none'}`);
    });

    if (ids.has('P8')) await guarded('P8', async () => {
      const marker = `turbo-probe-${hex()}`;
      const prompt = `Run this command with your shell tool in the foreground (not in the background) and wait for it to finish: node -e "setTimeout(()=>{},600000)" ${marker}`;
      let child = null;
      const pending = run(probeArgs('P8', ctx), prompt, { onSpawn: (c) => { child = c; } });
      let exitedAt = null;
      child.on('exit', () => { exitedAt = Date.now(); });
      const marked = () => (processTable()?.rows ?? []).filter((row) => row.cmd.includes(marker) && row.pid !== process.pid);
      let rows = [];
      for (let t0 = Date.now(); Date.now() - t0 < 120000 && exitedAt === null; await sleep(1000)) {
        rows = marked();
        if (rows.length) break;
      }
      if (!rows.length) {
        killTree(child.pid);
        await pending;
        return record('P8', false, `the marker process never appeared (claude ${exitedAt === null ? 'killed' : 'exited on its own'})`);
      }
      const killedAt = Date.now();
      killTree(child.pid);
      while (exitedAt === null && Date.now() - killedAt < 15000) await sleep(100);
      const exitMs = exitedAt === null ? null : exitedAt - killedAt;
      await pending;
      await sleep(3000);
      const left = marked();
      summary.treeKillMs = exitMs;
      record('P8', exitMs !== null && left.length === 0,
        `marker rows before ${rows.length} (${rows.map((r) => r.pid).join(',')}); kill-to-exit ${exitMs === null ? '>15000' : exitMs} ms; rows 3 s later ${left.length}${left.length ? ` (${left.map((r) => `${r.pid} ${r.cmd.slice(0, 60)}`).join('; ')})` : ''}`);
    });

    if (ids.has('P9')) await guarded('P9', async () => {
      const code = `ZEBRA-${hex()}`;
      fs.writeFileSync(appendFile, `When asked for the codeword, reply with ${code} and nothing else.\n`);
      const r = await run(probeArgs('P9', ctx), 'What is the codeword?');
      const text = String(resultOf(r.events)?.result ?? '');
      summary.appendFile = { exit: r.code, known: !/unknown option/i.test(r.stderr) };
      record('P9', r.code === 0 && text.includes(code), `exit ${r.code}; result ${JSON.stringify(text.slice(0, 80))}${r.stderr.trim() ? `; stderr ${JSON.stringify(r.stderr.trim().slice(0, 160))}` : ''}`);
    });
  } finally {
    console.log(`PROBE_SUMMARY ${JSON.stringify(summary)}`);
    if (keep) {
      console.log(`kept: ${base}`);
    } else {
      try { inSandbox(() => removeLaneTmp(repo, 'probe')); } catch { /* removed with the base */ }
      fs.rmSync(settingsFile, { force: true });
      for (const dir of projectDirs(home, repo)) fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
  return report.length > 0 && report.every(Boolean);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try {
    const r = main();
    if (r instanceof Promise) r.catch((e) => { console.error(`probe: ${e.message}`); process.exitCode = 1; });
  } catch (e) {
    console.error(`probe: ${e.message}`);
    process.exitCode = 1;
  }
}
