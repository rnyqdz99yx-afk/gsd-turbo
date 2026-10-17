import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { rolePrompt } from '../lib/roles.mjs';
import { lintSlices } from '../lib/slice-lint.mjs';
import { gsdCoreDir } from '../lib/paths.mjs';
import { readVersion, versionInRange } from '../lib/gsd.mjs';
import { slicePhase, DEMO_INFO } from './helpers/slices.mjs';

// spec §6.9: the plans and summaries the build path's prompts show are files the installed GSD reads as planned,
// executed and complete. The format is cut out of the rendered prompts, never retyped: a failure here means the role
// copy drifted from GSD — fix the copy (roles/*.md), not this test.
const core = gsdCoreDir(null);
const realGsd = core && versionInRange(readVersion(core) || '');
const SKIP = { skip: !realGsd && 'GSD 1.16/1.17 is not installed', timeout: 300000 };

const REL = '.planning/phases/05-demo';
const NO_SIGNALS = { research: { yes: false, why: '' }, security: { yes: false, why: '' } };

function project(opts) {
  const root = slicePhase(opts);
  const dir = path.join(root, ...REL.split('/'));
  const tool = (...args) => {
    const r = spawnSync(process.execPath, [path.join(core, 'bin', 'gsd-tools.cjs'), ...args, '--cwd', root], { encoding: 'utf8', windowsHide: true });
    const at = r.stdout.search(/[{[]/);
    assert.ok(at >= 0, `gsd-tools ${args.join(' ')}: exit ${r.status}, no JSON: ${r.stdout}${r.stderr}`);
    return JSON.parse(r.stdout.slice(at));
  };
  const commit = (msg) => {
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: root, stdio: 'pipe' });
  };
  const contextPath = path.join(dir, '05-CONTEXT.md');
  return { root, dir, tool, commit, contextPath };
}

// The text between the first two ``` lines of a prompt.
function block(p) {
  const lines = p.split('\n');
  const a = lines.indexOf('```');
  const b = lines.indexOf('```', a + 1);
  assert.ok(a >= 0 && b > a, 'the prompt shows a fenced format');
  return `${lines.slice(a + 1, b).join('\n')}\n`;
}

// The slicer's plan format as two slices: 05-01, and 05-02 depending on it.
function slicePlans({ root, contextPath }) {
  const t = block(rolePrompt('slicer', { root, phase: '5', contextPath, info: DEMO_INFO, signals: NO_SIGNALS, lang: 'en' }));
  assert.ok(t.includes('pattern: "./b.js"') && t.includes('autonomous: true\n'), 'the slicer format has a key link pattern');
  // 05-01 is a spike slice (spike: true, a key GSD ignores)
  const one = t.replace('plan: NN', 'plan: 01').replace('REQ-01', 'DEMO-01').replace('autonomous: true\n', 'autonomous: true\nspike: true\n');
  const two = t.replace('plan: NN', 'plan: 02').replace('REQ-01', 'DEMO-02').replace('wave: 1', 'wave: 2').replace('depends_on: []', 'depends_on: ["05-01"]')
    .replaceAll('src/a.js', 'src/b.js').replaceAll('test/a.test.js', 'test/b.test.js').replaceAll('D-01', 'D-02')
    .replace('to: "src/b.js"', 'to: "src/a.js"').replace('pattern: "./b.js"', 'pattern: "./a.js"').replace('a.js imports greet from b.js', 'b.js imports hi from a.js');
  assert.notEqual(one, t, 'the slicer format has plan: NN and REQ-01');
  assert.match(two, /^plan: 02$/m);
  return [one, two];
}

// The code the two slices' key links describe: a.js imports b.js, b.js imports a.js.
function writeSources(root) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), "import { greet } from './b.js';\nexport const hi = () => greet();\n");
  fs.writeFileSync(path.join(root, 'src', 'b.js'), "import { hi } from './a.js';\nexport const greet = () => 'hi';\nexport const again = () => hi();\n");
}

// The builder's SUMMARY format filled for a plan: the requirements, x for every other placeholder.
function summary({ root, contextPath, dir }, id, req, { status = 'complete', check = 'PASSED' } = {}) {
  const t = block(rolePrompt('builder', { root, phase: '5', contextPath, planPath: path.join(dir, `${id}-PLAN.md`), lang: 'en' }));
  assert.ok(t.includes("<every id of the plan's requirements>"));
  assert.ok(t.includes('status: complete'));
  const text = t.replace("<every id of the plan's requirements>", req).replace(/<[^>\n]*>/g, 'x').replace('status: complete', `status: ${status}`);
  return `${text}\n## Self-Check: ${check}\n`;
}

test('slices and summaries in the prompts\' format read as planned, executed and complete in the installed GSD', SKIP, () => {
  const p = project();
  const { root, dir, tool, commit } = p;
  const [one, two] = slicePlans(p);
  fs.writeFileSync(path.join(dir, '05-01-PLAN.md'), one);
  fs.writeFileSync(path.join(dir, '05-02-PLAN.md'), two);
  commit('docs(05): slice plans');

  for (const id of ['05-01', '05-02']) {
    const s = tool('verify', 'plan-structure', `${REL}/${id}-PLAN.md`);
    assert.deepEqual([s.valid, s.task_count, s.errors], [true, 1, []], `${id}: ${JSON.stringify(s)}`);
    const v = tool('frontmatter', 'validate', `${REL}/${id}-PLAN.md`, '--schema', 'plan');
    assert.equal(v.valid, true, `${id}: ${JSON.stringify(v)}`);
  }
  const d = tool('check', 'decision-coverage-plan', REL, `${REL}/05-CONTEXT.md`);
  assert.deepEqual([d.passed, d.covered], [true, 2], JSON.stringify(d));
  assert.deepEqual(lintSlices(root, '5', { info: DEMO_INFO }), { ok: true, problems: [], edges: [{ from: '05-01', to: '05-02', kind: 'depends', why: '' }] });

  const L = () => [tool('init', 'manager').phases[0].disk_status, tool('progress').phases[0].status, tool('verification', 'status', REL).status];
  assert.deepEqual(L(), ['planned', 'Planned', 'missing']);

  // the verifier's checks of must_haves pass on code that does what the slices say
  writeSources(root);
  commit('feat(05): sources');
  for (const id of ['05-01', '05-02']) {
    const k = tool('verify', 'key-links', `${REL}/${id}-PLAN.md`);
    assert.deepEqual([k.all_verified, k.total], [true, 1], `${id}: ${JSON.stringify(k)}`);
    const a = tool('verify', 'artifacts', `${REL}/${id}-PLAN.md`);
    assert.deepEqual([a.all_passed, a.total], [true, 1], `${id}: ${JSON.stringify(a)}`);
  }

  const s1 = summary(p, '05-01', 'DEMO-01');
  fs.writeFileSync(path.join(dir, '05-01-SUMMARY.md'), s1);
  const sv = tool('frontmatter', 'validate', `${REL}/05-01-SUMMARY.md`, '--schema', 'summary');
  assert.equal(sv.valid, true, JSON.stringify(sv));
  commit('docs(05-01): complete plan');
  const up = tool('roadmap', 'update-plan-progress', '5');
  assert.deepEqual([up.updated, up.summary_count], [true, 1], JSON.stringify(up));
  assert.deepEqual(L(), ['partial', 'In Progress', 'missing']);

  fs.writeFileSync(path.join(dir, '05-02-SUMMARY.md'), summary(p, '05-02', 'DEMO-02', { status: 'blocked', check: 'FAILED' }));
  commit('docs(05-02): blocked');
  assert.equal(L()[0], 'partial', 'a blocked SUMMARY is not counted');
  fs.writeFileSync(path.join(dir, '05-02-SUMMARY.md'), summary(p, '05-02', 'DEMO-02'));
  commit('docs(05-02): complete plan');
  assert.deepEqual(L(), ['executed', 'Executed', 'missing']);
  assert.equal(tool('init', 'progress').phases[0].status, 'executed');

  fs.writeFileSync(path.join(dir, '05-VERIFICATION.md'), ['---', 'phase: 05-demo', 'verified: 2026-01-02T00:00:00Z', 'status: passed', 'score: 2/2 must-haves verified', '---', '', '# Phase 5: Verification', ''].join('\n'));
  commit('docs(05): verification');
  assert.deepEqual(L(), ['complete', 'Complete', 'passed']);
  assert.equal(tool('phase', 'complete', '5').roadmap_updated, true);
  assert.equal(tool('init', 'manager').phases[0].roadmap_complete, true);
  assert.match(fs.readFileSync(path.join(root, '.planning', 'ROADMAP.md'), 'utf8'), /^- \[x\] \*\*Phase 5: Demo Feature\*\*/m);
  // GSD's own phase complete leaves STATE.md at "All phases complete" for the last phase, which its drift guard cannot
  // rank; what matters is that STATE.md and ROADMAP.md never contradict each other
  const drift = tool('drift-guard', 'phase-status', '--phase', '5');
  assert.ok(['consistent', 'uncheckable'].includes(drift.verdict) && drift.roadmapStatus === 'Complete', JSON.stringify(drift));
});

test('lintSlices with the installed GSD names an uncited decision and a plan GSD rejects', SKIP, () => {
  const p = project({ decisions: ['D-01: greet takes a name', 'D-02: farewell prints bye', 'D-03: logs nothing'] });
  const [one, two] = slicePlans(p);
  const noMustHaves = two.replace(/^must_haves:\n[\s\S]*?\n(?=---\n)/m, '');
  assert.ok(!noMustHaves.includes('key_links') && !noMustHaves.includes('must_haves'), noMustHaves);
  fs.writeFileSync(path.join(p.dir, '05-01-PLAN.md'), one);
  fs.writeFileSync(path.join(p.dir, '05-02-PLAN.md'), noMustHaves);
  // a gap round's slice (gap_closure: true, a key GSD reads) after them
  const gap = one.replace('plan: 01', 'plan: 03').replace('spike: true\n', 'gap_closure: true\n').replaceAll('src/a.js', 'src/c.js').replaceAll('test/a.test.js', 'test/c.test.js');
  fs.writeFileSync(path.join(p.dir, '05-03-PLAN.md'), gap);
  const r = lintSlices(p.root, '5', { info: DEMO_INFO });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems.filter((x) => x.plan === '05-01' || x.plan === '05-03'), [], JSON.stringify(r.problems));
  assert.deepEqual(r.problems.filter((x) => x.kind === 'gsd'), [], JSON.stringify(r.problems));
  assert.ok(r.problems.some((x) => x.plan === null && x.kind === 'decisions' && x.detail === 'D-03 (logs nothing) is cited by no slice'), JSON.stringify(r.problems));
  assert.ok(r.problems.some((x) => x.plan === '05-02' && x.kind === 'structure' && x.detail === 'Missing required frontmatter field: must_haves'), JSON.stringify(r.problems));
});
