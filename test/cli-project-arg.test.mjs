import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';
import { readProgress } from '../lib/phase-progress.mjs';
import { VALUE_FLAGS as PHASE_VALUE_FLAGS } from '../lib/cli-phase.mjs';
import { readAnswers } from '../lib/questions.mjs';
import { DECISION_PLAN, writePhase } from './helpers/plans.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const run = (args, cwd) => execFileSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir('home') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Two projects: the one named with --project draws in Russian, the one the command runs in in English.
function projects() {
  const named = tmpDir('named');
  fs.mkdirSync(path.join(named, '.planning', 'turbo', 'run'), { recursive: true });
  fs.writeFileSync(path.join(named, '.planning', 'turbo', 'config.json'), JSON.stringify({ lang: 'ru' }));
  const here = tmpDir('here');
  fs.mkdirSync(path.join(here, '.planning', 'turbo', 'run'), { recursive: true });
  return { named, here };
}

test('a flag value is never read as a flag: an answer text that says --project, --by, --rev or -x leaves the project named by --project', () => {
  const { named, here } = projects();
  for (const text of ['--project', '--by', '--rev', '-x']) {
    assert.equal(JSON.parse(run(['view', '--text', text, '--project', named, '--json'], here)).ui.lang, 'ru', text);
  }
  assert.equal(JSON.parse(run(['view', '--text', '--project', '--json'], here)).ui.lang, 'en', 'a --project that is a value names no project: the one the command runs in');
});

test('every value flag of the phase commands (cli-phase VALUE_FLAGS, read at run time) keeps a --project text as its value', () => {
  const { named, here } = projects();
  for (const f of [...PHASE_VALUE_FLAGS].filter((x) => x !== '--project')) {
    assert.equal(JSON.parse(run(['view', f, '--project', '--project', named, '--json'], here)).ui.lang, 'ru', f);
  }
  run(['phase-step', '3', '--done', 'freshness', '--note', '--project', '--project', named], here);
  const progress = readProgress(named, '3');
  assert.deepEqual([progress.done, progress.notes.freshness], [['freshness'], '--project']);
});

test('a lane-status reason that reads --project is the reason, not the project', () => {
  const { named, here } = projects();
  run(['lane-status', '3', 'needs-owner', '--reason', '--project', '--project', named], here);
  assert.deepEqual([readLaneStatus(named, '3')?.status, readLaneStatus(named, '3')?.reason], ['needs-owner', '--project']);
  assert.equal(readLaneStatus(here, '3'), null);
});

test('--project after the positional arguments still names the project; arguments after -- are never flags', () => {
  const { named, here } = projects();
  run(['lane-status', '3', 'done', '--project', named], here);
  assert.equal(readLaneStatus(named, '3')?.status, 'done');
  assert.equal(JSON.parse(run(['view', '--json', '--', '--project', named], here)).ui.lang, 'en');
});

test('turbo-run questions and answer take their values through cli-phase VALUE_FLAGS: the pane\'s argv with a text that reads --project answers the named project', () => {
  for (const f of ['--class', '--preanswers', '--stop', '--agent', '--kind', '--question', '--delivered', '--path', '--option', '--text', '--by', '--rev']) assert.ok(PHASE_VALUE_FLAGS.has(f), f);
  const { here } = projects();
  // a git repository: with no lane running, turbo-run answer commits the answers file
  const named = tmpGitRepo();
  writePhase(named, '32-auth', { '32-09-PLAN.md': DECISION_PLAN });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: tmpDir('home'), TURBO_LANE: '' };
  const cli = (args) => execFileSync(process.execPath, [CLI, ...args], { cwd: here, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  cli(['questions', '--project', named, '32']);
  // the argv the turbo-view pane builds (mod/hooks/view-model.mjs answerArgv): the text last, after every real flag
  assert.match(cli(['answer', '--project', named, '32', '32-09-t2', '--by', 'pane', '--rev', '1', '--text', '--project']), /^answered 32-09-t2: --project, pane, \S+ · committed\n$/);
  assert.deepEqual(readAnswers(named, '32').map((r) => [r.answer, r.by]), [['--project', 'pane']]);
  assert.deepEqual(readAnswers(here, '32'), []);
});
