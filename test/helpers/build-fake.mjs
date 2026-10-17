import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { slicePhase } from './slices.mjs';
import { fakeGsdCore } from './fake-gsd.mjs';
import { tmpDir } from './tmp.mjs';

// Stage 6 B4: the build path's test project and a scripted claude for it (fake-claude.mjs's act hook).

// A GSD project at phase 5 (B3's slicePhase) with the fake gsd-tools, turbo's config (build.enabled, slice worktrees
// under a temp lanes.dir, test.full node --test) and its run/logs/locks ignored, all committed.
// config: merged into turbo's config; its build section merges with { enabled: true }.
// -> { root, phaseDir, rel, git(...args), write(rel, text), commit(msg) -> sha }
export function buildProject({ slug = 'demo', context = true, config = {} } = {}) {
  const root = slicePhase({ slug, context });
  fakeGsdCore(root);
  const rel = `.planning/phases/05-${slug}`;
  const git = (...a) => String(execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).replace(/\r?\n$/, '');
  const write = (f, text) => {
    const abs = path.join(root, ...f.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const { build = {}, ...rest } = config;
  write('.gitignore', 'node_modules/\n.claude/\n');
  write('.planning/turbo/.gitignore', 'run/\nlogs/\nlocks/\n');
  write('.planning/turbo/config.json', `${JSON.stringify({ lang: 'en', lanes: { dir: path.join(tmpDir('lanes'), 'app.turbo') }, test: { full: 'node --test' }, build: { enabled: true, ...build }, ...rest }, null, 2)}\n`);
  write('package.json', `${JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } })}\n`);
  commit('chore: turbo build project');
  return { root, phaseDir: path.join(root, ...rel.split('/')), rel, git, write, commit };
}

// B3's SUMMARY skeleton (roles/builder.md) for plan <id> ('05-01'), ending with its self-check.
export function summaryText({ phaseSlug, plan, reqs = [], status = 'complete', check = 'PASSED' }) {
  const nn = String(plan).slice(String(plan).lastIndexOf('-') + 1);
  const n = String(Number(String(plan).split('-')[0]));
  return [
    '---', `phase: ${phaseSlug}`, `plan: ${nn}`, 'subsystem: api', 'tags: [node]', 'key-files:', '  created: []', '  modified: []',
    'key-decisions: []', `requirements-completed: [${reqs.join(', ')}]`, 'duration: 1min', 'completed: 2026-10-17', `status: ${status}`, '---', '',
    `# Phase ${n} Plan ${nn}: slice ${plan} Summary`, '', `**slice ${plan} is built**`, '', '## Task Commits', '1. **Task 1: build** - `0000000` (feat)', '',
    '## Deviations from Plan', 'None', '', `## Self-Check: ${check}`, '',
  ].join('\n');
}

// The act (run inside the fake claude, CommonJS; see buildAct). Kept free of outer names: it is written out as text.
function actMain({ argv, stdin, cwd, resume }) {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const dir = __dirname;
  const scriptFile = path.join(dir, 'script.json');
  const script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
  const shift = (key) => {
    const list = Array.isArray(script[key]) ? script[key] : [];
    const one = list.shift();
    script[key] = list;
    fs.writeFileSync(scriptFile, JSON.stringify(script, null, 2));
    return one;
  };
  const stateFile = path.join(dir, 'act-state.json');
  let st = { counter: 0, sessions: {}, calls: {} };
  try {
    st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (e) { /* the first call */ }
  const git = (...a) => String(execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const write = (rel, text) => {
    const abs = path.join(cwd, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  const commit = (files, message) => {
    for (const f of files) git('add', '-A', '--', f);
    try {
      git('diff', '--cached', '--quiet');
    } catch (e) {
      git('commit', '-q', '-m', message);
    }
  };
  const writeAll = (map) => {
    const files = Object.keys(map || {});
    for (const f of files) write(f, map[f]);
    return files;
  };
  const ai = argv.indexOf('--agent');
  let who = resume ? st.sessions[resume] : null;
  if (!who) {
    who = { role: 'other', plan: null, summaryPath: null };
    if (ai >= 0) who.role = argv[ai + 1];
    else if (/^You are the slicer/.test(stdin)) who.role = 'slicer';
    else if (/^You are a builder/.test(stdin)) {
      who.role = 'builder';
      who.plan = (/plan ([^,\s]+),/.exec(stdin) || [])[1] || null;
      who.summaryPath = (/write (\S+-SUMMARY\.md):/.exec(stdin) || [])[1] || null;
    } else if (/^You are the fixer/.test(stdin)) who.role = 'fixer';
    else if (/^Read and execute/.test(stdin) && stdin.includes('discuss-phase-assumptions')) who.role = 'discuss';
    else if (stdin.includes('Skill(skill="gsd-verify-work"')) who.role = 'verify-work';
    else if (/^The merge of the main branch/.test(stdin)) who.role = 'integrate';
  }
  let id = resume;
  if (!resume) {
    st.counter += 1;
    id = `b4000000-0000-4000-8000-${String(st.counter).padStart(12, '0')}`;
  }
  st.sessions[id] = who;
  const n = who.role === 'builder' ? (st.calls[who.plan] = (st.calls[who.plan] || 0) + 1) : 0;
  fs.writeFileSync(stateFile, JSON.stringify(st));
  fs.appendFileSync(path.join(dir, 'acts.jsonl'), `${JSON.stringify({ role: who.role, plan: who.plan, resume: resume || null, at: new Date().toISOString() })}\n`);
  const answer = (o = {}) => ({ ...(resume ? {} : { sessionId: id }), result: 'done', ...o });
  const times = (v) => (v === true ? 1 : Number(v) || 0);
  const role = who.role;
  if (role === 'slicer') {
    writeAll(script.plans);
    return answer({ result: 'plans written' });
  }
  if (role === 'builder') {
    const cfg = (script.slices || {})[who.plan] || {};
    if (cfg.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, cfg.delayMs);
    if (cfg.ask && !resume) return answer({ result: cfg.ask });
    if (n <= times(cfg.fail)) return answer({ result: 'failed', isError: true, exitCode: 1 });
    commit(writeAll(cfg.files), `feat(${who.plan}): build`);
    writeAll(cfg.extra);
    if (n > times(cfg.noSummary)) {
      const rel = who.summaryPath || `${script.phaseDir || '.planning/phases/05-demo'}/${who.plan}-SUMMARY.md`;
      write(rel, (script.summaries || {})[who.plan] || summaryText({ phaseSlug: path.posix.basename(path.posix.dirname(rel)), plan: who.plan }));
      commit([rel], `docs(${who.plan}): complete`);
    }
    return answer({ result: `slice ${who.plan} built` });
  }
  if (role === 'fixer') {
    const fx = shift('fixes');
    if (!fx) return answer({ result: 'nothing to fix' });
    commit(writeAll(fx.files), fx.message || 'fix: build path fix');
    return answer({ result: fx.result || 'fixed' });
  }
  if (role === 'gsd-code-reviewer' || role === 'gsd-verifier') {
    const doc = shift(role === 'gsd-code-reviewer' ? 'reviews' : 'verifications');
    if (doc) write(doc.path, doc.text);
    return answer({ result: doc ? `wrote ${doc.path}` : 'nothing written' });
  }
  if (role === 'gsd-security-auditor') return answer({ result: shift('audits') || '## SECURED\n**threats_open:** 0' });
  if (role === 'gsd-phase-researcher') {
    if (script.research) write(script.research.path, script.research.text);
    return answer({ result: 'research written' });
  }
  if (role === 'discuss') {
    if (script.context) commit(writeAll({ [script.context.path]: script.context.text }), 'docs(05): capture phase context');
    return answer({ result: script.discuss || 'context written' });
  }
  if (role === 'turbo-uat') return answer({ result: script.uat || 'UAT done' });
  if (role === 'integrate') {
    for (const f of writeAll(script.resolve)) git('add', '-A', '--', f);
    return answer({ result: 'resolved' });
  }
  return answer();
}

// A scripted claude act in dir: <dir>/build-act.cjs (pass it as fakeClaude's behavior act) and <dir>/script.json, read
// again on every call. Each call appends { role, plan, resume, at } to <dir>/acts.jsonl; new sessions are numbered
// b4000000-0000-4000-8000-<12-digit counter>, and a resumed session keeps the role it had. The role: --agent, else the
// prompt's start (slicer, builder with its plan, fixer, discuss, verify-work, integrate), else other. script:
//   plans { rel: text } (the slicer writes them); slices { <id>: { files { rel: text } committed as feat(<id>): build,
//   ask (the result of the first call, nothing written), delayMs, fail (the first n calls end with exit 1; true = 1),
//   noSummary (the first n calls write no SUMMARY), extra { rel: text } written, never staged } }; summaries { <id>:
//   text } (else summaryText); fixes [{ files, message, result }]; reviews / verifications [{ path, text }]; audits
//   [text]; research { path, text }; context { path, text } (committed); uat (text); resolve { rel: text } (git added);
//   phaseDir (when the prompt names no SUMMARY path).
// -> { act, acts(), set(patch) }
export function buildAct(dir, script = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const act = path.join(dir, 'build-act.cjs');
  fs.writeFileSync(act, `'use strict';\nconst summaryText = ${summaryText.toString()};\nmodule.exports = ${actMain.toString()};\n`);
  const file = path.join(dir, 'script.json');
  fs.writeFileSync(file, JSON.stringify(script, null, 2));
  return {
    act,
    acts() {
      try {
        return fs.readFileSync(path.join(dir, 'acts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    set(patch) {
      const now = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...now, ...patch }, null, 2));
    },
  };
}

// <dir>/bin with a claude that runs <dir>/fake-claude.cjs (fakeClaude's script): claude.cmd as an npm shim (resolveBin
// maps it to node + the script on Windows) and a posix node script. -> the bin directory, for PATH.
export function claudeShim(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@"%dp0%\\..\\fake-claude.cjs" %*\r\n');
  fs.writeFileSync(path.join(bin, 'claude'), "#!/usr/bin/env node\nrequire('../fake-claude.cjs');\n", { mode: 0o755 });
  return bin;
}
