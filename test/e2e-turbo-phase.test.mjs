import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpGitRepo } from './helpers/tmp.mjs';
import { fakeGsdCore } from './helpers/fake-gsd.mjs';
import { UAT } from './fixtures/uat-sample.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { STEPS, readProgress } from '../lib/phase-progress.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';
import { gsdCoreDir } from '../lib/paths.mjs';
import { readVersion, versionInRange } from '../lib/gsd.mjs';

const CONFIG = '{\n  "commit_docs": true,\n  "workflow": {\n    "research": true\n  }\n}\n';
const HOOKS = {
  'verify:post': [{ kind: 'step', capId: 'nyquist' }, { kind: 'step', capId: 'security' }],
  'execute:post': [{ kind: 'step', capId: 'code-review' }],
  'plan:pre': [{ kind: 'step', capId: 'research', ref: { agent: 'gsd-phase-researcher' } }],
};
const BIN = fileURLToPath(new URL('../bin/turbo-run.mjs', import.meta.url));
const GATES_OFF = 'chore(turbo): phase 3 built-in gates off while GSD executes';
const GATES_RESTORED = 'chore(turbo): phase 3 built-in gates restored';

test('a scripted /turbo-phase run drives every deterministic step and leaves GSD config as it was', async (t) => {
  const root = tmpGitRepo();
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  g('config', 'core.autocrlf', 'false');
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
  const commit = (m) => { g('add', '-A'); g('commit', '-q', '-m', m); };
  const dir = '.planning/phases/03-demo';
  write('.gitignore', '.claude/\n');
  write('.planning/config.json', CONFIG);
  write('.planning/turbo/.gitignore', 'run/\nlogs/\nlocks/\n');
  write('.planning/turbo/config.json', JSON.stringify({ lang: 'en', autonomy: 'standard', uat: { base_url: 'http://localhost:3000' } }));
  write(`${dir}/03-CONTEXT.md`, 'Decisions for src/app.js\n');
  write(`${dir}/03-01-PLAN.md`, '---\nfiles_modified: [src/app.js]\n---\nEdit src/app.js\n');
  write('src/app.js', 'export const v = 1;\n');
  commit('phase 3 planned');
  const core = fakeGsdCore(root, { hooks: HOOKS });
  const lines = [];
  const notes = [];
  const run = async (cmd, ...a) => {
    const code = await runPhaseCommand(cmd, a, { root, out: (l) => lines.push(l), err: (l) => lines.push(l), deps: { notify: async (key) => { notes.push(key); } } });
    assert.equal(code, 0, `${cmd} ${a.join(' ')}: ${lines.slice(-3).join(' | ')}`);
    return lines.at(-1);
  };
  const done = (step) => run('phase-step', '3', '--done', step);

  // freshness, discuss, prologue, plan: the artifacts exist and nothing changed since they were written
  assert.ok(JSON.parse(await run('staleness', '3', '--json')).artifacts.every((x) => x.action === 'fresh'));
  await done('freshness');
  await done('discuss');
  assert.deepEqual(JSON.parse(await run('jobs', '3', 'prologue', '--json')), []);
  await done('prologue');
  await run('staleness', '3', '--record-all');
  commit('docs(phase-3): record planning bases');
  await done('plan');

  // gates-off: one commit, clean tree
  await run('gates', 'off', '3');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.planning/config.json'), 'utf8')).workflow.security_enforcement, false);
  assert.equal(g('status', '--porcelain'), '');
  await done('gates-off');

  // execute: what GSD leaves behind for a human_needed phase (G9), including the key its execute-phase sets itself
  execFileSync(process.execPath, [path.join(core, 'bin', 'gsd-tools.cjs'), 'config-set', 'workflow._auto_chain_active', 'false', '--cwd', root]);
  write('src/app.js', 'export const v = 2;\n');
  write(`${dir}/03-01-SUMMARY.md`, 'summary\n');
  write(`${dir}/03-VERIFICATION.md`, '---\nstatus: human_needed\n---\n');
  write(`${dir}/03-UAT.md`, UAT);
  commit('phase 3 executed');
  await done('execute');

  // restore, right after execute: the exact original bytes, clean tree
  await run('gates', 'restore', '3');
  assert.equal(fs.readFileSync(path.join(root, '.planning/config.json'), 'utf8'), CONFIG);
  assert.equal(g('status', '--porcelain'), '');
  await done('restore');

  // fanout: jobs from the active gates the restore kept; docs commits off while workers write; one commit after
  assert.deepEqual(JSON.parse(await run('jobs', '3', 'fanout', '--json')).map((j) => j.id), ['security', 'code-review', 'nyquist']);
  // the CLI exits 0 on a refusal too: check that docs commits really went off
  assert.equal(await run('gates', 'docs-off', '3'), 'gates docs-off 3: done');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.planning/config.json'), 'utf8')).phase_commit_docs['3'], false);
  write(`${dir}/03-SECURITY.md`, '---\nthreats_open: 0\n---\n');
  write(`${dir}/03-REVIEW.md`, '---\nstatus: issues_found\nfindings:\n  critical: 0\n  warning: 1\n---\n');
  write(`${dir}/03-VALIDATION.md`, '---\nstatus: validated\nnyquist_compliant: true\n---\n');
  await run('gates', 'docs-restore', '3');
  assert.equal(g('diff', '--name-only', '--', '.planning/config.json'), '', 'config back to the committed bytes');
  commit('docs(phase-3): gate fan-out');
  assert.equal(JSON.parse(await run('jobs', '3', 'outcome', '--json')).next, 'fix');
  await done('fanout');

  // fix: the fixer left a clean review
  write(`${dir}/03-REVIEW.md`, '---\nstatus: clean\nfindings:\n  critical: 0\n  warning: 0\n---\n');
  commit('fix(03): review finding');
  assert.equal(JSON.parse(await run('jobs', '3', 'outcome', '--json')).next, 'final-gate');
  await done('fix');
  await done('final-gate');

  // uat: plan, stand, net-check, record, owner request, cleanup
  const plan = JSON.parse(await run('uat', 'plan', '3'));
  assert.deepEqual(plan.items.map((i) => i.class), ['A', 'D', 'A', 'C', 'A']);
  const stand = JSON.parse(await run('uat', 'stand', '3', 'prepare'));
  fs.writeFileSync(path.join(stand.evidenceDir, 't1-settings.png'), Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(path.join(stand.evidenceDir, 'requests-t1.log'), 'http://localhost:3000/settings\n');
  fs.writeFileSync(path.join(stand.evidenceDir, 't3-code.png'), Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(path.join(stand.evidenceDir, 't4-download.txt'), 'a CSV file downloaded with 3 rows');
  await run('uat', 'net-check', '3', '--log', path.join(stand.evidenceDir, 'requests-t1.log'));
  const ev = (f) => path.relative(root, path.join(stand.evidenceDir, f)).split(path.sep).join('/');
  const resultsFile = path.join(root, '.planning/turbo/run/uat-p3/results.json');
  fs.writeFileSync(resultsFile, JSON.stringify([
    { test: 1, result: 'pass', class: 'A', checks: ['open /settings'], harness: 'playwright-script', evidence: [ev('t1-settings.png'), ev('requests-t1.log')] },
    { test: 2, result: 'owner', class: 'D' },
    { test: 3, result: 'pass', class: 'A', split: 'hermetic', expected: plan.items[2].expected, harness: 'playwright-script', evidence: [ev('t3-code.png')] },
    { test: 3, result: 'deferred', class: 'C', split: 'live', expected: plan.items[3].expected, reason: 'needs a physical phone' },
    { test: 4, result: 'pass', class: 'A', harness: 'http', evidence: [ev('t4-download.txt')] },
  ]));
  await run('uat', 'record', '3', '--results', resultsFile);
  const req = JSON.parse(await run('uat', 'owner-request', '3', '--json'));
  assert.deepEqual([req.needsOwner, req.counts], [true, { passed: 3, failed: 0, checklist: 1, signoff: 1 }]);
  assert.deepEqual(notes, [], 'D items: the lane reports needs-owner; the supervisor notifies');
  await run('uat', 'stand', '3', 'cleanup');
  assert.ok(!fs.existsSync(path.join(root, '.planning/turbo/run/uat-p3')));

  // the owner signs item 2 through verify-work; then GSD's own predicate must accept the file
  const uatFile = path.join(root, dir, '03-UAT.md');
  const signed = fs.readFileSync(uatFile, 'utf8').replace('expected: the release is signed\nresult: [pending]', 'expected: the release is signed\nresult: pass');
  fs.writeFileSync(uatFile, signed);
  const realCore = gsdCoreDir(null, process.env);
  if (realCore && versionInRange(readVersion(realCore))) {
    write('.planning/ROADMAP.md', '# Roadmap\n\n### Phase 3: Demo\n**Goal**: demo\n');
    // a failing verdict exits 1 (GSD #5170): read the JSON at any exit status so the checks are shown
    const r = spawnSync(process.execPath, [path.join(realCore, 'bin', 'gsd-tools.cjs'), 'phase', 'uat-passed', '3', '--uat-only', '--cwd', root], { encoding: 'utf8', stdio: 'pipe' });
    let res;
    try {
      res = JSON.parse(r.stdout);
    } catch {
      assert.fail(`uat-passed exit ${r.status}: ${r.stdout}${r.stderr}`);
    }
    assert.equal(res.passed, true, JSON.stringify(res.checks));
  } else {
    t.diagnostic('GSD 1.16 not installed: skipped the real uat-passed check');
  }
  await done('uat');

  // close, through the real CLI entry
  assert.match(execFileSync(process.execPath, [BIN, 'phase-step', '3', '--done', 'close', '--project', root], { encoding: 'utf8' }), /next none/);
  execFileSync(process.execPath, [BIN, 'lane-status', '3', 'done', '--reason', 'e2e', '--project', root]);
  assert.equal(readLaneStatus(root, '3').status, 'done');
  assert.equal(readProgress(root, '3').done.length, STEPS.length);
  assert.ok(!fs.existsSync(path.join(root, '.planning/turbo/gates/p3.json')));
  assert.equal(fs.readFileSync(path.join(root, '.planning/config.json'), 'utf8'), CONFIG);

  // one gates-off and one gates-restored commit; the restore lands right after GSD's execute commits, before the fan-out
  const log = g('log', '--reverse', '--format=%s').split('\n');
  assert.deepEqual([log.filter((s) => s === GATES_OFF).length, log.filter((s) => s === GATES_RESTORED).length], [1, 1], log.join(' | '));
  const at = (s) => log.indexOf(s);
  assert.ok(at(GATES_OFF) < at('phase 3 executed'), log.join(' | '));
  assert.equal(at(GATES_RESTORED), at('phase 3 executed') + 1, log.join(' | '));
  assert.ok(at(GATES_RESTORED) < at('docs(phase-3): gate fan-out'), log.join(' | '));
});
