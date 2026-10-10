import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { PROBE, fakeTurboRun, instructions, setupDemo } from '../scripts/turbo-view-demo.mjs';
import { answerArgv, bandLine, parseView, render, toastsFor } from '../mod/hooks/view-model.mjs';

const DEMO = path.resolve('scripts/turbo-view-demo.mjs');

test('the demo builds a project with .planning/turbo/ and a test-free copy of the mod, and prints the command that opens them', () => {
  const dir = tmpDir('demo');
  const { project, mod } = setupDemo({ dir, lang: 'ru' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, '.planning', 'turbo', 'config.json'), 'utf8')), { lang: 'ru', view: { refresh_seconds: 3 } });
  assert.ok(fs.existsSync(path.join(mod, 'hooks', 'register.mjs')));
  assert.ok(fs.existsSync(path.join(mod, '.claude-plugin', 'plugin.json')));
  assert.equal(fs.existsSync(path.join(mod, 'hooks', 'register.test.tsx')), false);
  const text = instructions({ dir, project, mod, lang: 'ru' });
  // TURBO_VIEW_BIN lives only as long as that one claude: a later claude in the same window runs the real turbo-run
  assert.ok(text.includes(`(cd "${project}" && TURBO_VIEW_BIN="${DEMO}" claude --plugin-dir "${mod}")`), text);
  const win = (p) => p.replace(/\//g, '\\');
  assert.ok(text.includes(`Push-Location "${win(project)}"; try { $env:TURBO_VIEW_BIN = "${win(DEMO)}"; claude --plugin-dir "${win(mod)}" } finally { Remove-Item Env:TURBO_VIEW_BIN; Pop-Location }`), text);
  assert.ok(text.includes(`node "${DEMO}" check "${project}"`), text);
  assert.ok(text.includes(PROBE), text);
  assert.ok(text.includes('"turbo · фазы 32–34 · супервизор работает"'), text);
  assert.ok(text.includes('1. Да, по гейту  2. Стоп') && text.includes('[1] [2] [Другое…]'), text);
  assert.ok(text.includes('"turbo p32 execute · 3 агента · ? 1 вопрос · CI ✓"'), text);
});

test('the scripted run, read the way the mod reads it, raises the four toasts in order and keeps the band current', () => {
  const { project } = setupDemo({ dir: tmpDir('demo'), now: 0 });
  let prev = null;
  const toasts = [];
  const bands = [];
  for (let read = 1; read <= 13; read++) {
    const r = fakeTurboRun(['view', '--json'], project, read * 3000);
    assert.equal(r.code, 0);
    const v = parseView(r.stdout);
    assert.ok(render(v).rows.length > 3);
    for (const t of toastsFor(prev, v)) toasts.push(`${read}: ${t}`);
    bands.push(bandLine(v));
    prev = v;
  }
  assert.deepEqual(toasts, ['4: new question: 32-10 Task 1 — Does the export page look right?', '7: CI red: phase 32, b2c3d4e', '10: phase 32 stopped: needs-owner — checkpoint 32-09 Task 3: deploy needs your answer', '13: phase 32 done']);
  assert.equal(bands[0], 'turbo p32 execute · 3 agents · ? 1 question · CI ✓');
  assert.equal(bands[12], 'turbo p32 all steps done (done) · ? 2 questions · CI ✗');
});

test('answers from the pane are recorded once; the answered question leaves the next view; the real script speaks the same (Review Focus 3)', () => {
  const { project } = setupDemo({ dir: tmpDir('demo'), now: 0 });
  // as the mod runs it: in turbo's directory (here the clone), the project named with --project
  const run = (cmd, ...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [DEMO, cmd, '--project', project, ...args], { cwd: path.dirname(path.dirname(DEMO)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      return { code: e.status, out: e.stdout || e.stderr };
    }
  };
  assert.deepEqual(parseView(run('view', '--json').out).questions.map((q) => [q.id, q.rev]), [['q1', 1]]);
  assert.deepEqual(run('answer', '32', 'q1', '--option', '2', '--by', 'pane', '--rev', '2'), { code: 4, out: 'changed: question q1 changed since it was shown (now rev 1, shown rev 2); read it again and answer the new version\n' });
  assert.deepEqual(run('answer', '32', 'q9', '--option', '1', '--by', 'pane', '--rev', '1'), { code: 1, out: 'refused: no question q9\n' });
  const first = run('answer', '32', 'q1', '--option', '2', '--by', 'pane', '--rev', '1');
  assert.equal(first.code, 0);
  assert.match(first.out, /^answered q1: Stop, pane, \d{4}-\d\d-\d\dT[\d:.]+Z\n$/);
  const again = run('answer', '32', 'q1', '--text', 'x', '--by', 'pane', '--rev', '2');
  assert.equal(again.code, 3, 'already answered is checked before the rev');
  assert.match(again.out, /^already answered: Stop, pane, \d{4}-/);
  assert.deepEqual(parseView(run('view', '--json').out).questions, []);
  const lines = fs.readFileSync(path.join(project, '.planning', 'turbo', 'demo-answers.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.id, l.option, l.text, l.by]), [['q1', '2', null, 'pane']]);
});

test('answered questions come back when the scripted run repeats, so the owner can answer again', () => {
  const { project } = setupDemo({ dir: tmpDir('demo'), now: 0 });
  fakeTurboRun(['view', '--json'], project, 3000);
  assert.equal(fakeTurboRun(['answer', '32', 'q1', '--option', '1', '--by', 'pane', '--rev', '1'], project, 3000).code, 0);
  const ids = (read) => JSON.parse(fakeTurboRun(['view', '--json'], project, read * 3000).stdout).questions.map((q) => q.id);
  assert.deepEqual(ids(2), []);
  for (let read = 3; read <= 16; read++) ids(read);
  assert.deepEqual(ids(17), ['q1'], 'read 17 starts the script again');
});

test('the argument check: an Other… text of quotes, flags and a backslash reaches turbo-run as one argument, by pane, and check says so (Review Focus 2)', () => {
  const { project } = setupDemo({ dir: tmpDir('demo'), now: 0 });
  const check = () => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [DEMO, 'check', project], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      return { code: e.status, out: e.stdout };
    }
  };
  assert.equal(check().code, 1, 'nothing recorded yet');
  assert.equal(PROBE, 'a" --by telegram "b \\');
  // the argv the pane builds, through a real process boundary as $.process.run starts it
  const argv = answerArgv({ node: process.execPath, turboRun: DEMO, root: project, question: { phase: '32', id: 'q1', rev: 1 }, text: PROBE });
  fakeTurboRun(['view', '--json'], project);
  assert.match(execFileSync(argv[0], argv.slice(1), { cwd: path.dirname(path.dirname(DEMO)), encoding: 'utf8' }), /^answered q1: /);
  const r = check();
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, `ok: the answer arrived as one argument, by pane: ${JSON.stringify(PROBE)}\n`);
});
