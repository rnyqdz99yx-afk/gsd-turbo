import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SLICE_MAX_BYTES, SLICE_MAX_TASKS, LINT_KINDS, gsdVerdict, lintSlices, formatProblems } from '../lib/slice-lint.mjs';
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
    ['src/../x.js', 'write it as x.js'],
    ['src//b.js', 'write it as src/b.js'],
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
  const said = lint(root, { structure: { '05-01': { code: 2, json: { message: 'bad\n input' } }, '05-02': { code: -1, json: null, error: 'ETIMEDOUT' } } }).r;
  assert.deepEqual(said.problems, [
    { plan: '05-01', kind: 'gsd', detail: 'gsd-tools verify plan-structure: exit 2: bad input' },
    { plan: '05-02', kind: 'gsd', detail: 'gsd-tools verify plan-structure: exit -1: ETIMEDOUT' },
  ]);
  const early = lint(root, { structure: { '05-01': { code: 1, json: { valid: false, errors: ['Plan file is not valid UTF-8'] } } } }).r;
  assert.deepEqual(early.problems, [{ plan: '05-01', kind: 'structure', detail: 'Plan file is not valid UTF-8' }], 'no task count, no task problem');
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
  const missing = gsdVerdict(tmpDir('nocore'), ['verify', 'plan-structure', 'p'], { cwd });
  assert.equal(missing.json, null);
  assert.match(missing.error, /Cannot find module/, 'the reason it could not run');
});

test('every phase requirement is in some slice\'s requirements', () => {
  const r = lint(phase({ p2: { reqs: ['DEMO-01'] } })).r;
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, [{ plan: null, kind: 'coverage', detail: "DEMO-02 is in no slice's requirements" }]);
  const root = phase({ p2: { reqs: ['DEMO-01'] } });
  const file = path.join(root, '.planning', 'phases', '05-demo', '05-02-PLAN.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('requirements: [DEMO-01]', 'requirements:\n  - DEMO-02'));
  assert.deepEqual(lint(root).r.problems, [], 'a block list counts');
});

test('decisions come from GSD\'s decision-coverage gate', () => {
  const root = phase();
  const uncovered = { passed: false, skipped: false, total: 3, covered: 2, uncovered: [{ id: 'D-03', text: 'logs nothing', category: '' }] };
  assert.deepEqual(lint(root, { decision: uncovered }).r.problems, [{ plan: null, kind: 'decisions', detail: 'D-03 (logs nothing) is cited by no slice' }]);
  const unparsed = { passed: false, reason: 'could-not-parse', message: 'Decision coverage gate: could not parse decisions' };
  assert.deepEqual(lint(root, { decision: unparsed }).r.problems, [{ plan: null, kind: 'decisions', detail: 'Decision coverage gate: could not parse decisions' }]);
  assert.deepEqual(lint(root, { decision: { passed: true, skipped: true } }).r.problems, []);
  assert.deepEqual(lint(root, { decision: { passed: false, skipped: true, reason: 'gate disabled' } }).r.problems, [], 'GSD skipped the gate');
  const { r, calls } = lint(phase({ context: false }));
  assert.equal(r.ok, true);
  assert.ok(!calls.some((c) => c[0] === 'check'), 'no CONTEXT.md, no decision check');
});

test('depends_on that names no slice, and cycles', () => {
  assert.deepEqual(lint(phase({ p2: { deps: ['05-09'] } })).r.problems, [{ plan: '05-02', kind: 'depends', detail: 'depends_on names 05-09, no slice of phase 5' }]);
  assert.deepEqual(lint(phase({ p1: { deps: ['05-01'] } })).r.problems, [{ plan: '05-01', kind: 'depends', detail: 'depends_on names the slice itself' }]);
  const r = lint(phase({ p1: { deps: ['05-02'] } })).r;
  assert.deepEqual(r, { ok: false, problems: [{ plan: null, kind: 'cycle', detail: 'depends_on cycle among: 05-01, 05-02' }], edges: [] });
});

test('shared files become edges, not problems', () => {
  const root = phase();
  writePlan(root, '05-03', compactPlan({ id: '05-03', files: ['src/a.js', 'test/c.test.js'] }));
  const r = lint(root).r;
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.ok(r.edges.some((e) => e.from === '05-01' && e.to === '05-03' && e.kind === 'files' && e.why === 'src/a.js'), JSON.stringify(r.edges));
});

test('problems come in order: per slice, then depends_on, coverage, decisions, cycle', () => {
  const root = phase({ p1: { tasks: 0 }, p2: { deps: ['05-09'], reqs: ['DEMO-01'] } });
  const decision = { passed: false, skipped: false, total: 3, covered: 2, uncovered: [{ id: 'D-03', text: 'logs nothing', category: '' }] };
  assert.deepEqual(lint(root, { decision }).r.problems.map((p) => p.kind), ['tasks', 'depends', 'coverage', 'decisions']);
});

test('formatProblems', () => {
  assert.equal(formatProblems([
    { plan: '05-01', kind: 'size', detail: '9000 bytes, more than 8192' },
    { plan: null, kind: 'coverage', detail: "DEMO-02 is in no slice's requirements" },
  ]), "The code check of your slice plans found these problems. Fix exactly these in the plan files, change nothing else, and end with your one-line-per-plan list again:\n- 05-01 size: 9000 bytes, more than 8192\n- phase coverage: DEMO-02 is in no slice's requirements\n");
  assert.throws(() => formatProblems([{ plan: null, kind: 'gsd', detail: 'GSD core not found' }]), /never send them to the slicer/);
});
