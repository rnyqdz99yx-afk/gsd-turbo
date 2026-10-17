import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { ISOLATED, controlProject, fakeSlot, gitIn } from './helpers/slots.mjs';
import { CONTROL_ENV, controlRoot, dirKey, isSlot, localRemotePath, localRunDir, locksDir, logsDir, runDir, slotRecordFile, stateRoot } from '../lib/paths.mjs';
import { buildBgArgs } from '../lib/claude.mjs';
import { gatesLeftovers } from '../lib/gates.mjs';
import { appendInbox } from '../lib/inbox.mjs';
import { readAnswers, writeAnswers } from '../lib/questions.mjs';
import { readJson } from '../lib/fsx.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const state = (root, ...rest) => path.join(root, '.planning', 'turbo', ...rest);

test('a directory that is not a slot keeps its own state, whatever TURBO_CONTROL_ROOT says (Review Focus 1)', () => {
  const root = tmpDir('plain');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  const other = controlProject();
  assert.equal(isSlot(root), false);
  assert.equal(stateRoot(root, { [CONTROL_ENV]: other }), root);
  assert.equal(controlRoot(path.join(root, '.planning'), { [CONTROL_ENV]: other }), root);
  assert.equal(runDir(root), state(root, 'run'));
  assert.equal(localRunDir(root), state(root, 'run'));
});

test('a slot keeps its state in its control root, found through remote.origin.url or TURBO_CONTROL_ROOT; gates stay in the slot; answers in the control root', () => {
  const { control, slot } = fakeSlot();
  fs.mkdirSync(path.join(slot, 'src'));
  assert.equal(isSlot(slot), true);
  assert.equal(dirKey(controlRoot(path.join(slot, 'src'), {})), dirKey(control));
  assert.equal(dirKey(controlRoot(slot, { [CONTROL_ENV]: control })), dirKey(control));
  for (const [fn, name] of [[runDir, 'run'], [logsDir, 'logs'], [locksDir, 'locks']]) assert.equal(dirKey(fn(slot)), dirKey(state(control, name)), name);
  assert.equal(localRunDir(slot), state(slot, 'run'));
  // GSD's gate switches describe the slot's own GSD config: their run files stay in the slot
  fs.mkdirSync(localRunDir(slot), { recursive: true });
  fs.writeFileSync(path.join(localRunDir(slot), 'docs-p3.json'), '{}');
  assert.deepEqual(gatesLeftovers(slot), { gates: [], docs: ['3'] });
  assert.deepEqual(gatesLeftovers(control), { gates: [], docs: [] });
  // the owner's answers are written and read in the control root
  writeAnswers(slot, '3', [{ id: '03-01-t1', answer: 'yes' }]);
  assert.deepEqual(readJson(state(control, 'answers', 'p3.json')), [{ id: '03-01-t1', answer: 'yes' }]);
  assert.equal(fs.existsSync(state(slot, 'answers')), false);
  assert.deepEqual(readAnswers(slot, '3'), [{ id: '03-01-t1', answer: 'yes' }]);
});

test('a slot whose control root cannot be confirmed fails loudly and never keeps state itself (Review Focus 1)', () => {
  const { control, slot } = fakeSlot();
  const other = controlProject();
  assert.throws(() => stateRoot(slot, { [CONTROL_ENV]: other }), /TURBO_CONTROL_ROOT names .* but the slot belongs to/);
  gitIn(slot, 'remote', 'set-url', 'origin', other);
  assert.throws(() => stateRoot(slot, {}), /remote\.origin\.url names .* but the slot belongs to/);
  gitIn(slot, 'remote', 'set-url', 'origin', 'https://example.com/app.git');
  assert.throws(() => stateRoot(slot, {}), /names no local checkout/);
  assert.equal(dirKey(stateRoot(slot, { [CONTROL_ENV]: control })), dirKey(control), 'the env names it: no remote needed');
  const bare = fakeSlot({ control: tmpDir('bare-control') });
  assert.throws(() => stateRoot(bare.slot, {}), /has no \.planning\/turbo/);
  fs.writeFileSync(slotRecordFile(slot), '{}');
  assert.throws(() => stateRoot(slot, {}), /names no control root/);
});

test('localRemotePath: a local path or a file URL; any other URL is no local checkout', () => {
  const local = tmpDir('remote');
  assert.equal(localRemotePath(local), local);
  assert.equal(localRemotePath(pathToFileURL(local).href), local);
  for (const u of ['https://example.com/app.git', 'ssh://git@example.com/app.git', 'git@example.com:team/app.git', '']) assert.equal(localRemotePath(u), null, u);
});

test('the lane session gets TURBO_CONTROL_ROOT in its --settings env only when the supervisor passes a control root', () => {
  const settings = (more) => {
    const args = buildBgArgs({ name: 'n', prompt: 'P', systemPrompt: 'S', permissionMode: 'auto', model: '', ...more });
    return JSON.parse(args[args.indexOf('--settings') + 1]);
  };
  const control = path.resolve('/projects/app');
  assert.deepEqual(settings({}), { worktree: { bgIsolation: 'none' }, env: { TURBO_LANE: '1' } });
  assert.deepEqual(settings({ controlRoot: control }).env, { TURBO_LANE: '1', TURBO_CONTROL_ROOT: control });
});

test('lane commands run in a slot keep their state in the control root (turbo-run lane-status, inbox); a wrong root writes nothing', () => {
  const { control, slot } = fakeSlot();
  appendInbox(control, '3', { kind: 'note', text: 'hello' });
  const env = { ...ISOLATED, [CONTROL_ENV]: control };
  execFileSync(process.execPath, [CLI, 'lane-status', '3', 'running'], { cwd: slot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  assert.equal(readJson(state(control, 'run', 'p3.json')).status, 'running');
  const inbox = execFileSync(process.execPath, [CLI, 'inbox', '3', '--json'], { cwd: slot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  assert.deepEqual(JSON.parse(inbox).map((m) => m.text), ['hello']);
  const r = spawnSync(process.execPath, [CLI, 'lane-status', '3', 'done'], { cwd: slot, env: { ...env, [CONTROL_ENV]: controlProject() }, encoding: 'utf8', windowsHide: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /but the slot belongs to/);
  assert.equal(fs.existsSync(state(slot, 'run')), false);
  assert.equal(readJson(state(control, 'run', 'p3.json')).status, 'running');
});
