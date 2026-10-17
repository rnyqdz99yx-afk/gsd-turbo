import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { STALE_REPORT, MANAGER, adoptProject, closedRow, write } from './helpers/adopt.mjs';
import { initProject } from '../lib/project-init.mjs';
import { ADOPT_REL, adoptPlan, applyAdopt, readRecord, reverifyFile, reverifyResult, scanProject, staleClosedLine } from '../lib/adopt.mjs';

// turbo's run files are ignored once init's .gitignore is in (a revert takes it away again)
const status = (git) => git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter((l) => l && !l.slice(3).startsWith('.planning/turbo/run/')).join('\n');
const headOf = (git) => git(['rev-parse', 'HEAD']).trim();
const shown = (git) => git(['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').filter(Boolean).sort();
const subjectOf = (git) => git(['log', '-1', '--format=%s']).trim();
// Every file of the working tree outside .git and the fake core, with its bytes.
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (rel === '.git' || rel === '.claude' || rel.startsWith('.planning/turbo/run')) continue;
      if (e.isDirectory()) walk(abs);
      else out[rel] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(root);
  return out;
}
const confirm = (root, deps, answers) => adoptPlan(root, { deps, answers }).plan;

test('apply: exactly one commit chore(turbo): adopt with exactly the listed paths; git revert gives the tree back', () => {
  const { root, git, deps } = adoptProject();
  write(root, '.planning/turbo/run/annotate/analysis.json', JSON.stringify({ phases: { 2: { areas: ['src/**'], gates: [], confidence: 'high' }, 3: { areas: ['web/**'], gates: [], confidence: 'high' }, 4: { areas: ['docs/**'], gates: [], confidence: 'high' } }, pairs: [], relax: [{ phase: '4', drop: ['3'], kind: 'prose', reason: 'wording only' }] }));
  const before = snapshot(root);
  const head = headOf(git);
  const answers = { 'stale-closed': 'keep', relax: 'all' };
  const r = applyAdopt(root, { answers, plan: confirm(root, deps, answers), deps, now: new Date('2026-10-14T10:00:00Z') });
  assert.equal(r.refused, undefined, String(r.refused));
  assert.match(r.committed, /^[0-9a-f]{7,}$/);
  assert.equal(git(['rev-list', '--count', `${head}..HEAD`]).trim(), '1');
  assert.equal(subjectOf(git), 'chore(turbo): adopt');
  assert.deepEqual(shown(git), r.paths);
  assert.deepEqual(r.paths, ['.planning/ROADMAP.md', '.planning/config.json', '.planning/turbo/.gitignore', '.planning/turbo/DECISIONS.md', '.planning/turbo/adopt.json', '.planning/turbo/config.json', '.planning/turbo/lanes.json']);
  assert.equal(status(git), '');
  const rec = readRecord(root);
  assert.equal(rec.state, 'applied');
  assert.deepEqual(rec.staleClosed, ['1']);
  assert.deepEqual(rec.answers['stale-closed'], { value: 'keep', set: ['1'] });
  assert.deepEqual(rec.answers.relax.ids, ['r1']);
  assert.deepEqual(rec.paths, r.paths);
  git(['revert', '--no-edit', 'HEAD']);
  assert.equal(status(git), '');
  assert.deepEqual(snapshot(root), before);
});

test('a second adopt with nothing new asks nothing, changes nothing and commits nothing', () => {
  const { root, git, deps } = adoptProject();
  applyAdopt(root, { answers: { 'stale-closed': 'keep' }, plan: confirm(root, deps, { 'stale-closed': 'keep' }), deps });
  const head = headOf(git);
  const p = adoptPlan(root, { deps, answers: {} });
  assert.deepEqual([p.questions, p.changes], [[], []]);
  const r = applyAdopt(root, { answers: {}, plan: p.plan, deps });
  assert.deepEqual([r.committed, r.noChanges], [null, true]);
  assert.ok(r.report.includes('no changes: already adopted'));
  assert.equal(headOf(git), head);
});

test('an adopt cut after applying: the next one is not refused, says so first, and commits once with the paths it had written', () => {
  const { root, git, deps, core } = adoptProject();
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  write(root, ADOPT_REL, JSON.stringify({ v: 1, state: 'applying', at: '2026-10-14T09:00:00.000Z', paths: ['.planning/config.json', '.planning/turbo/.gitignore', '.planning/turbo/config.json', ADOPT_REL] }));
  initProject(root, { core, inherit: false });
  assert.deepEqual(scanProject(root, { deps }).refused, []);
  const head = headOf(git);
  const p = adoptPlan(root, { deps, answers: { 'stale-closed': 'keep' } });
  assert.equal(p.changes[0].kind, 'resume');
  assert.match(p.changes[0].text, /^finish the adopt that stopped before its commit: /);
  const r = applyAdopt(root, { answers: { 'stale-closed': 'keep' }, plan: p.plan, deps });
  assert.ok(r.committed);
  assert.equal(git(['rev-list', '--count', `${head}..HEAD`]).trim(), '1');
  assert.equal(status(git), '', 'nothing left behind');
  assert.equal(readRecord(root).state, 'applied');
});

test('apply refuses a plan that changed since the owner saw it, and anything a refusal names, writing nothing', () => {
  const { root, git, deps } = adoptProject();
  const answers = { 'stale-closed': 'keep' };
  let r = applyAdopt(root, { answers, plan: 'f'.repeat(64), deps });
  assert.match(r.refused[0], /^the plan changed since it was shown \(plan [0-9a-f]{64}\); show it again$/);
  assert.equal(status(git), '');
  // review 3: the refusals run again right before anything is written
  const plan = confirm(root, deps, answers);
  r = applyAdopt(root, { answers, plan, deps: { ...deps, supervisor: () => ({ alive: true, pid: 7, lanes: [], attended: [] }) } });
  assert.match(r.refused.join('\n'), /supervisor is running \(pid 7\)/);
  assert.equal(status(git), '');
  assert.equal(fs.existsSync(path.join(root, ...ADOPT_REL.split('/'))), false);
});

test('the report in Russian: six sections in order, the commit and how to undo it, and plain /turbo-autonomous last', () => {
  const { root, deps } = adoptProject({ config: { lang: 'ru', lanes: { mode: 'checkout' } } });
  const r = applyAdopt(root, { answers: { 'stale-closed': 'keep' }, plan: confirm(root, deps, { 'stale-closed': 'keep' }), deps });
  const text = r.report.join('\n');
  const heads = r.report.filter((l) => l.startsWith('## '));
  assert.deepEqual(heads, ['## Где проект', '## Закрытые фазы без свежей проверки', '## Полосы и критический путь', '## Что изменено', '## Что остаётся вам', '## Запуск']);
  assert.ok(text.includes(`коммит ${r.committed} chore(turbo): adopt; откатить: \`git revert ${r.committed}\``), text);
  assert.match(text, /1: оставлены закрытыми/);
  assert.match(text, /обычный GSD: 3 фаз подряд/);
  assert.equal(r.report.at(-1), '/turbo-autonomous');
});

test('re-check: the digest the owner confirmed holds; the passing report and the other report aside go into the one commit', () => {
  const manager = { ...MANAGER, phases: [MANAGER.phases[0], closedRow('2', ['1']), ...MANAGER.phases.slice(2)] };
  const v2 = '.planning/phases/02-api/02-VERIFICATION.md';
  const { root, git, deps } = adoptProject({ manager, files: { [v2]: STALE_REPORT.replace('01-base', '02-api') } });
  const answers = { 'stale-closed': 'reverify' };
  const p = adoptPlan(root, { deps, answers });
  assert.deepEqual([p.reverify, p.reverifyPending], [['1', '2'], ['1', '2']]);
  // the verifiers (the skill's agents) write their reports; adopt reverify judges each
  write(root, '.planning/phases/01-base/01-VERIFICATION.md', '---\nstatus: passed\n---\nfresh\n');
  write(root, v2, '---\nstatus: gaps_found\n---\ngaps\n');
  assert.equal(reverifyResult(root, '1', { deps }).status, 'passed');
  assert.equal(reverifyResult(root, '2', { deps }).status, 'gaps_found');
  assert.deepEqual(adoptPlan(root, { deps, answers }).reverifyPending, [], 'a rerun of the skill skips the phases already re-checked');
  const r = applyAdopt(root, { answers, plan: p.plan, deps });
  assert.equal(r.refused, undefined, String(r.refused));
  assert.ok(shown(git).includes('.planning/phases/01-base/01-VERIFICATION.md'));
  assert.ok(shown(git).includes('.planning/turbo/adopt/reverify-p2.md'));
  assert.ok(!shown(git).includes(v2));
  assert.equal(fs.readFileSync(path.join(root, v2), 'utf8'), STALE_REPORT.replace('01-base', '02-api'));
  assert.equal(fs.existsSync(reverifyFile(root)), false);
  assert.deepEqual(readRecord(root).reverified, { 1: 'passed', 2: 'gaps_found' });
  assert.deepEqual(readRecord(root).staleClosed, ['1', '2']);
  assert.equal(status(git), '');
  assert.match(r.report.join('\n'), /phase 2: re-checked, gaps_found; .*report: `\.planning\/turbo\/adopt\/reverify-p2\.md`/);
});

test('re-check reports nobody chose are put back when the answer is keep', () => {
  const { root, git, deps } = adoptProject();
  write(root, '.planning/phases/01-base/01-VERIFICATION.md', '---\nstatus: gaps_found\n---\nnew\n');
  reverifyResult(root, '1', { deps });
  const answers = { 'stale-closed': 'keep' };
  const p = adoptPlan(root, { deps, answers });
  assert.ok(p.changes.some((c) => c.kind === 'reverify-drop'));
  applyAdopt(root, { answers, plan: p.plan, deps });
  assert.equal(fs.existsSync(path.join(root, '.planning', 'turbo', 'adopt', 'reverify-p1.md')), false);
  assert.equal(status(git), '');
});

test('adopt touches no slot and no worktree (the CLI test checks the Claude home)', () => {
  const { root, git, deps } = adoptProject();
  const trees = git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '));
  applyAdopt(root, { answers: { 'stale-closed': 'keep' }, plan: confirm(root, deps, { 'stale-closed': 'keep' }), deps });
  assert.deepEqual(git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')), trees);
  assert.equal(fs.existsSync(`${root}.turbo`), false, 'no slot made');
});

test('the closed-phases line: until the owner decided in adopt, and never for a phase turbo finished itself', () => {
  const { root, deps } = adoptProject();
  const phases = scanProject(root, { deps }).phases;
  assert.equal(staleClosedLine(root, phases, 'en'), 'closed phases not re-verified: 1 (checked off, verification stale; turbo skips them) · /turbo-adopt');
  assert.match(staleClosedLine(root, phases, 'ru'), /^закрытые фазы без свежей проверки: 1 \(отмечены сделанными/);
  assert.equal(staleClosedLine(root, phases, 'en', { laneDone: (n) => n === '1' }), null);
  applyAdopt(root, { answers: { 'stale-closed': 'keep' }, plan: confirm(root, deps, { 'stale-closed': 'keep' }), deps });
  assert.equal(staleClosedLine(root, phases, 'en'), null);
});
