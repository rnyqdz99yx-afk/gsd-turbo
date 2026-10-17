import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { fakeClaude } from './helpers/fake-claude.mjs';
import { buildProject, buildAct, summaryText, claudeShim } from './helpers/build-fake.mjs';
import { compactPlan } from './helpers/slices.mjs';
import { runGsdJson } from '../lib/gsd.mjs';
import { gsdCoreDir } from '../lib/paths.mjs';
import { runSession, resumeSession } from '../lib/headless.mjs';
import { resolveBin } from '../lib/claude.mjs';

test('the fake gsd answers the build path\'s verbs', () => {
  const p = buildProject();
  const core = gsdCoreDir(p.root);
  const gsd = (...args) => runGsdJson(core, args, { cwd: p.root });
  const init = gsd('init', 'phase-op', '5');
  assert.deepEqual([init.phase_dir, init.phase_name, init.padded_phase, init.has_context], ['.planning/phases/05-demo', 'Demo Feature', '05', true]);
  assert.equal(gsd('query', 'state.begin-phase', '--phase', '5', '--name', 'x', '--plans', '0').updated, true);
  assert.equal(gsd('query', 'phase.complete', '5').completed, true);
  assert.match(fs.readFileSync(path.join(p.root, '.planning', 'ROADMAP.md'), 'utf8'), /^- \[x\] \*\*Phase 5: Demo Feature\*\*/m);
  p.write('a.txt', 'a\n');
  assert.equal(gsd('commit', 'docs: x', '--files', 'a.txt').committed, true);
  assert.equal(p.git('log', '-1', '--format=%s'), 'docs: x');
  assert.equal(gsd('commit', 'docs: x', '--files', 'a.txt').committed, false);
  p.write(`${p.rel}/05-01-PLAN.md`, compactPlan({ id: '05-01', tasks: 2 }));
  assert.deepEqual(gsd('verify', 'plan-structure', `${p.rel}/05-01-PLAN.md`), { valid: true, errors: [], warnings: [], task_count: 2 });
  assert.equal(gsd('check', 'decision-coverage-plan', p.rel, `${p.rel}/05-CONTEXT.md`).passed, true);
  assert.equal(gsd('check', 'ui-plan-gate', '5').frontend, false);
});

test('the fake claude runs an act and takes its session id', async () => {
  const dir = tmpDir('act');
  const cwd = tmpGitRepo();
  const a = buildAct(dir, {});
  const f = fakeClaude(dir, { act: a.act });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: f.home };
  const opts = { cwd, role: 'slicer', prompt: 'You are the slicer of gsd-turbo\'s build path for phase 5.', env };
  const r1 = await runSession(opts, { bin: f.bin, pollMs: 100 });
  assert.equal(r1.sessionId, 'b4000000-0000-4000-8000-000000000001');
  const r2 = await runSession(opts, { bin: f.bin, pollMs: 100 });
  assert.equal(r2.sessionId, 'b4000000-0000-4000-8000-000000000002');
  const r3 = await resumeSession(r1.sessionId, 'x', { cwd, role: 'slicer', env }, { bin: f.bin, pollMs: 100 });
  assert.equal(r3.sessionId, r1.sessionId);
  assert.deepEqual(a.acts().map(({ role, resume }) => ({ role, resume })), [
    { role: 'slicer', resume: null }, { role: 'slicer', resume: null }, { role: 'slicer', resume: r1.sessionId },
  ]);
});

test('a builder act commits its files and its SUMMARY; ask, fail and a throw', async () => {
  const p = buildProject();
  const dir = tmpDir('act');
  const a = buildAct(dir, { slices: { '05-01': { files: { 'src/a.js': 'module.exports = 1;\n' }, fail: 1 }, '05-02': { ask: 'Need you.' } } });
  const f = fakeClaude(dir, { act: a.act });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: f.home };
  const prompt = (id) => `You are a builder in gsd-turbo's build path. You implement exactly one slice of phase 5: plan ${id}, in this git worktree.\nWhen the tasks are done, write ${p.rel}/${id}-SUMMARY.md:\n`;
  const run = (id) => runSession({ cwd: p.root, role: 'builder', prompt: prompt(id), env }, { bin: f.bin, pollMs: 100 });
  const failed = await run('05-01');
  assert.deepEqual([failed.exitCode, failed.isError], [1, true]);
  const ok = await run('05-01');
  assert.equal(ok.exitCode, 0);
  assert.deepEqual(p.git('log', '-2', '--format=%s').split('\n'), ['docs(05-01): complete', 'feat(05-01): build']);
  assert.equal(fs.readFileSync(path.join(p.phaseDir, '05-01-SUMMARY.md'), 'utf8'), summaryText({ phaseSlug: '05-demo', plan: '05-01' }));
  const asked = await run('05-02');
  assert.equal(asked.result, 'Need you.');
  assert.equal(fs.existsSync(path.join(p.phaseDir, '05-02-SUMMARY.md')), false);
  const resumed = await resumeSession(asked.sessionId, 'yes', { cwd: p.root, role: 'builder', env }, { bin: f.bin, pollMs: 100 });
  assert.equal(resumed.result, 'slice 05-02 built');
  assert.ok(fs.existsSync(path.join(p.phaseDir, '05-02-SUMMARY.md')));
  fs.writeFileSync(path.join(dir, 'throw.cjs'), "module.exports = () => { throw new Error('act broke'); };\n");
  f.set({ act: path.join(dir, 'throw.cjs') });
  const broke = await run('05-01');
  assert.deepEqual([broke.exitCode, broke.result], [1, null]);
  assert.match(broke.stderrTail, /act broke/);
});

test('claudeShim puts a claude on PATH that runs the fake', () => {
  const dir = tmpDir('shim');
  fakeClaude(dir, {});
  const bin = claudeShim(dir);
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const saved = process.env[key];
  process.env[key] = `${bin}${path.delimiter}${saved}`;
  try {
    const r = resolveBin();
    assert.equal(r.unsupported, undefined);
    // where prints long paths; a temp directory may come as an 8.3 short one (RUNNER~1): compared by their real paths
    if (process.platform === 'win32') assert.deepEqual([r.cmd, r.prefix.map((p) => fs.realpathSync.native(p))], [process.execPath, [fs.realpathSync.native(path.join(dir, 'fake-claude.cjs'))]]);
    else assert.equal(r.cmd, path.join(bin, 'claude'));
  } finally {
    process.env[key] = saved;
  }
});
