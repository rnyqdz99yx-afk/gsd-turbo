import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SLICE_MAX_BYTES, SLICE_MAX_TASKS, LINT_KINDS, gsdVerdict, lintSlices } from '../lib/slice-lint.mjs';
import { tmpDir } from './helpers/tmp.mjs';
import { slicePhase, compactPlan, writePlan, fakeLintGsd, DEMO_INFO } from './helpers/slices.mjs';

const PLAN2 = { id: '05-02', wave: 2, deps: ['05-01'], files: ['src/b.js', 'test/b.test.js'], reqs: ['DEMO-02'], decisions: ['D-02'] };

// slicePhase() with plans 05-01 and 05-02; p1/p2 change their compactPlan options (null leaves the plan out)
function phase({ p1 = {}, p2 = {}, ...opts } = {}) {
  const root = slicePhase(opts);
  if (p1) writePlan(root, '05-01', compactPlan(p1));
  if (p2) writePlan(root, '05-02', compactPlan({ ...PLAN2, ...p2 }));
  return root;
}
const lint = (root, gsdOpts = {}, opts = {}) => {
  const { gsd, calls } = fakeLintGsd(root, gsdOpts);
  return { r: lintSlices(root, '5', { gsd, info: DEMO_INFO, ...opts }), calls };
};

test('the limits and the kinds of problem', () => {
  assert.equal(SLICE_MAX_BYTES, 8192);
  assert.equal(SLICE_MAX_TASKS, 5);
  assert.deepEqual([...LINT_KINDS], ['phase', 'empty', 'size', 'structure', 'tasks', 'files', 'depends', 'coverage', 'decisions', 'cycle', 'gsd']);
});

test('two clean slices pass, and the gsd-tools arguments are relative paths without --raw', () => {
  const { r, calls } = lint(phase());
  assert.deepEqual(r, { ok: true, problems: [], edges: [{ from: '05-01', to: '05-02', kind: 'depends', why: '' }] });
  assert.deepEqual(calls, [
    ['verify', 'plan-structure', '.planning/phases/05-demo/05-01-PLAN.md'],
    ['verify', 'plan-structure', '.planning/phases/05-demo/05-02-PLAN.md'],
    ['check', 'decision-coverage-plan', '.planning/phases/05-demo', '.planning/phases/05-demo/05-CONTEXT.md'],
  ]);
});

test('size, structure and tasks', () => {
  const pad = (bytes) => {
    const base = Buffer.byteLength(compactPlan({ extra: ['# '] }));
    return { extra: [`# ${'p'.repeat(bytes - base)}`] };
  };
  assert.equal(Buffer.byteLength(compactPlan(pad(8193))), 8193);
  assert.deepEqual(lint(phase({ p1: pad(8193) })).r.problems, [{ plan: '05-01', kind: 'size', detail: '8193 bytes, more than 8192' }]);
  assert.deepEqual(lint(phase({ p1: pad(8192) })).r.problems, []);

  const structure = { '05-02': { code: 1, json: { valid: false, errors: ['Missing required frontmatter field: must_haves'], task_count: 1 } } };
  const s = lint(phase(), { structure }).r;
  assert.equal(s.ok, false);
  assert.deepEqual(s.problems, [{ plan: '05-02', kind: 'structure', detail: 'Missing required frontmatter field: must_haves' }]);

  assert.deepEqual(lint(phase({ p1: { tasks: 6 } })).r.problems, [{ plan: '05-01', kind: 'tasks', detail: '6 tasks, more than 5' }]);
  assert.deepEqual(lint(phase({ p1: { tasks: 5 } })).r.problems, []);
  assert.deepEqual(lint(phase({ p1: { tasks: 0 } })).r.problems, [{ plan: '05-01', kind: 'tasks', detail: 'no tasks' }]);
});

test('files are exact paths inside the project, outside .planning', () => {
  const files = (p1) => lint(phase({ p1 })).r.problems;
  assert.deepEqual(files({ files: [], deleted: [] }), [{ plan: '05-01', kind: 'files', detail: 'lists no files' }]);
  assert.deepEqual(files({ files: [], deleted: ['old.js'] }), [], 'a slice that only deletes lists its files');
  for (const [p, why] of [
    ['src/*.js', 'a glob or a directory, not an exact path'],
    ['src/', 'a glob or a directory, not an exact path'],
    ['.planning/notes.md', 'under .planning/'],
    ['.planning', 'under .planning/'],
    ['../x.js', 'outside the project'],
    ['src/../../x.js', 'outside the project'],
    ['/x.js', 'outside the project'],
    ['C:/x.js', 'outside the project'],
  ]) assert.deepEqual(files({ files: ['src/a.js', p] }), [{ plan: '05-01', kind: 'files', detail: `${p}: ${why}` }], p);
  assert.deepEqual(files({ files: ['src/a.js'], deleted: ['src/old/'] }), [{ plan: '05-01', kind: 'files', detail: 'src/old/: a glob or a directory, not an exact path' }]);
});

test('no phase directory, no plans, no GSD', () => {
  const root = phase();
  const { gsd } = fakeLintGsd(root);
  assert.deepEqual(lintSlices(root, '7', { gsd, info: DEMO_INFO }), { ok: false, problems: [{ plan: null, kind: 'phase', detail: 'no directory for phase 7' }], edges: [] });
  assert.deepEqual(lint(phase({ p1: null, p2: null })).r, { ok: false, problems: [{ plan: null, kind: 'empty', detail: 'no slice plans in .planning/phases/05-demo' }], edges: [] });

  const none = lintSlices(root, '5', { core: null, info: DEMO_INFO });
  assert.deepEqual(none.problems, [{ plan: null, kind: 'gsd', detail: 'GSD core not found' }]);
  assert.equal(none.ok, false);

  const r = lint(root, { structure: { '05-01': { code: 69, json: { error: 'File not found' } } } }).r;
  assert.deepEqual(r.problems, [{ plan: '05-01', kind: 'gsd', detail: 'gsd-tools verify plan-structure: exit 69: File not found' }]);
  const silent = lint(root, { structure: { '05-02': { code: 0, json: null } } }).r;
  assert.deepEqual(silent.problems, [{ plan: '05-02', kind: 'gsd', detail: 'gsd-tools verify plan-structure: exit 0' }]);
});

test('gsdVerdict: exit 0 and 1 are verdicts, any other exit is not', () => {
  const core = tmpDir('core');
  fs.writeFileSync(path.join(core, 'VERSION'), '1.17.0\n');
  fs.mkdirSync(path.join(core, 'bin'));
  fs.writeFileSync(path.join(core, 'bin', 'gsd-tools.cjs'), [
    'if (process.env.STUB_SILENT) process.stdout.write("valid\\n");',
    'else process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");',
    'process.exit(Number(process.env.STUB_EXIT || 0));',
  ].join('\n'));
  const cwd = tmpDir('cwd');
  const run = (env = {}) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      return gsdVerdict(core, ['verify', 'plan-structure', 'p'], { cwd });
    } finally {
      for (const k of Object.keys(env)) if (saved[k] === undefined) delete process.env[k];
    }
  };
  const argv = ['verify', 'plan-structure', 'p', '--cwd', cwd];
  assert.deepEqual(run(), { code: 0, json: { argv } });
  assert.deepEqual(run({ STUB_EXIT: '1' }), { code: 1, json: { argv } });
  assert.equal(run({ STUB_EXIT: '69' }).code, 69);
  assert.deepEqual(run({ STUB_SILENT: '1' }), { code: 0, json: null });
});
