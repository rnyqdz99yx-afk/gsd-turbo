import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.mjs';
import { slicePhase } from './helpers/slices.mjs';
import { REAL_CORE, NO_REAL_GSD } from './helpers/real-gsd.mjs';
import { GSD_FILES, gsdUsable, probeGsd } from '../lib/gsd-contract.mjs';
import { GSD_TESTED_RANGE, versionClass } from '../lib/gsd.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// A config directory with a gsd-core of the given version and every file of GSD_FILES. -> { home, core }
function gsdHome(version) {
  const home = tmpDir('gsd-home');
  const core = path.join(home, 'gsd-core');
  const put = (f) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
  };
  fs.mkdirSync(path.join(core, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(core, 'VERSION'), `${version}\n`);
  for (const f of GSD_FILES.agents) put(path.join(home, 'agents', f));
  for (const f of GSD_FILES.core) put(path.join(core, ...f.split('/')));
  return { home, core };
}

const ROW = { number: '5', name: 'Demo', dep_phases: [], deps_display: '', disk_status: 'planned', phase_complete: false, roadmap_complete: false, implementation_complete: false, verification_status: 'missing', is_active: true };
// gsd-tools as the probes call it: the answers of a GSD that turbo reads; over: { '<first two args>': answer | Error }.
function gsdAnswers(over = {}, calls = []) {
  const base = {
    'init manager': JSON.stringify({ milestone_version: 'v1.0', phases: [{ ...ROW, number: '4', phase_complete: true }, ROW] }),
    'init phase-op': JSON.stringify({ phase_name: 'Demo', padded_phase: '05', phase_dir: '.planning/phases/05-demo' }),
    'roadmap get-phase': '### Phase 5: Demo\n**Goal**: demo\n',
    'phase-plan-index 5': JSON.stringify({ phase: '5', plans: [] }),
    'verification status': JSON.stringify({ status: 'missing' }),
    'config-get workflow.no_such_key_turbo': '__turbo_absent__\n',
    'config-get workflow.security_enforcement': 'false\n',
    'loop render-hooks': JSON.stringify({ point: 'verify:post', activeHooks: [{ kind: 'step', capId: 'security' }], rendered: '' }),
  };
  return (cmd, args) => {
    const rest = args.slice(1, args.indexOf('--cwd') < 0 ? undefined : args.indexOf('--cwd')).filter((a) => a !== '--raw');
    const key = rest.slice(0, 2).join(' ');
    calls.push(rest.join(' '));
    const a = key in over ? over[key] : base[key];
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error(`fake gsd-tools: unexpected call ${rest.join(' ')}`);
    return a;
  };
}

test('versionClass: tested, newer in the same major, anything else', () => {
  assert.equal(GSD_TESTED_RANGE, '>=1.16.0 <1.23.0');
  assert.deepEqual(['1.16.0', '1.22.9'].map((v) => versionClass(v)), ['tested', 'tested']);
  assert.deepEqual(['1.23.0', '1.23.4', '1.40.0'].map((v) => versionClass(v)), ['newer', 'newer', 'newer']);
  assert.deepEqual(['1.15.9', '2.0.0', '0.9.0', 'garbage', ''].map((v) => versionClass(v)), ['other', 'other', 'other', 'other', 'other']);
  assert.deepEqual(['1.30.0', '1.10.0'].map((v) => versionClass(v, '>=1.16.0')), ['tested', 'other'], 'a range without an upper bound has no newer side');
});

test('GSD_FILES names every GSD file the roles, skills and code refer to, and nothing else', () => {
  const found = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(?:mjs|md)$/.test(e.name) && !f.endsWith(path.join('lib', 'gsd-contract.mjs'))) {
        const text = fs.readFileSync(f, 'utf8');
        for (const m of text.matchAll(/(?<![A-Za-z0-9_-])((?:workflows|references|templates)\/[A-Za-z0-9_./-]+\.md)/g)) found.add(m[1]);
        for (const m of text.matchAll(/agents\/(gsd-[a-z-]+\.md)/g)) found.add(`agents/${m[1]}`);
      }
    }
  };
  for (const d of ['lib', 'roles', 'skills', 'agents']) walk(path.join(REPO, d));
  const listed = [...GSD_FILES.agents.map((f) => `agents/${f}`), ...GSD_FILES.core];
  assert.deepEqual([...found].sort(), [...listed].sort());
});

test('probeGsd: every read check passes on the answers turbo reads; each broken answer is named', () => {
  const { core } = gsdHome('1.23.0');
  const root = tmpDir('proj');
  const calls = [];
  const ok = probeGsd({ core, root, exec: gsdAnswers({}, calls) });
  assert.deepEqual(ok.map((c) => [c.name, c.ok]), [
    ['init manager', true], ['init phase-op', true], ['roadmap get-phase --pick section', true], ['phase-plan-index', true], ['verification status', true],
    ['config-get --default --raw', true], ['config-get workflow.security_enforcement', true], ['loop render-hooks verify:post', true], ['gsd files', true],
  ]);
  // the phase asked about is the first one not complete
  assert.ok(calls.includes('init phase-op 5') && calls.includes('verification status .planning/phases/05-demo'), calls.join('\n'));
  const why = (over) => Object.fromEntries(probeGsd({ core, root, exec: gsdAnswers(over) }).filter((c) => !c.ok).map((c) => [c.name, c.why]));
  const { implementation_complete: _gone, ...old } = ROW;
  assert.deepEqual(why({ 'init manager': JSON.stringify({ phases: [old] }) }), { 'init manager': 'phase 5: implementation_complete is not true or false' });
  assert.deepEqual(why({ 'init manager': '{"rows":[]}' }), { 'init manager': 'no phases list' });
  assert.deepEqual(why({ 'config-get workflow.no_such_key_turbo': 'null\n' }), { 'config-get --default --raw': 'a key that is not set printed "null", not the default' });
  assert.deepEqual(why({ 'loop render-hooks': JSON.stringify({ activeHooks: [{ id: 'x' }] }) }), { 'loop render-hooks verify:post': 'a hook without kind or capId' });
  assert.deepEqual(why({ 'verification status': new Error('Unknown command: verification\nusage') }), { 'verification status': 'Unknown command: verification' });
  // a project without phases: the checks that need one are left out, not failed
  const empty = probeGsd({ core, root, exec: gsdAnswers({ 'init manager': '{"phases":[]}' }) });
  assert.deepEqual(empty.map((c) => c.name), ['init manager', 'config-get --default --raw', 'config-get workflow.security_enforcement', 'loop render-hooks verify:post', 'gsd files']);
  assert.ok(empty.every((c) => c.ok));
  // a GSD file turbo's prompts name is gone
  const cut = gsdHome('1.23.0');
  fs.rmSync(path.join(cut.core, 'workflows', 'secure-phase.md'));
  fs.rmSync(path.join(cut.home, 'agents', 'gsd-verifier.md'));
  assert.deepEqual(probeGsd({ core: cut.core, root, exec: gsdAnswers() }).at(-1), { name: 'gsd files', ok: false, why: 'missing: agents/gsd-verifier.md, workflows/secure-phase.md' });
});

test('gsdUsable: a tested GSD without a call; a newer one by the read checks; an older one or another major never', () => {
  const root = tmpDir('proj');
  const none = () => { throw new Error('no call expected'); };
  const tested = gsdUsable(gsdHome('1.22.0').core, root, { exec: none });
  assert.deepEqual([tested.ok, tested.cls, tested.detail], [true, 'tested', '1.22.0 (tested >=1.16.0 <1.23.0)']);
  for (const v of ['1.15.9', '2.0.0']) {
    const r = gsdUsable(gsdHome(v).core, root, { exec: none });
    assert.deepEqual([r.ok, r.cls, r.detail], [false, 'other', `${v} (tested >=1.16.0 <1.23.0)`]);
  }
  assert.deepEqual([gsdUsable(null, root, { exec: none }).ok, gsdUsable(null, root, { exec: none }).detail], [false, '? (tested >=1.16.0 <1.23.0)']);
  const newer = gsdUsable(gsdHome('1.23.0').core, root, { exec: gsdAnswers() });
  assert.deepEqual([newer.ok, newer.cls], [true, 'newer']);
  assert.equal(newer.detail, '1.23.0 is newer than the tested range (>=1.16.0 <1.23.0): 9 read checks of what turbo uses passed; what turbo writes through GSD is not checked on this version');
  const broken = gsdUsable(gsdHome('1.23.0').core, root, { exec: gsdAnswers({ 'phase-plan-index 5': '{"error":"moved"}' }) });
  assert.deepEqual([broken.ok, broken.cls], [false, 'newer']);
  assert.equal(broken.detail, '1.23.0 (tested >=1.16.0 <1.23.0); on this version: phase-plan-index: no plans list');
  // outside a project nothing can be asked: not usable, no call
  assert.equal(gsdUsable(gsdHome('1.23.0').core, null, { exec: none }).ok, false);
});

test('the read checks pass on the installed GSD', { skip: NO_REAL_GSD, timeout: 120000 }, () => {
  const root = slicePhase();
  const checks = probeGsd({ core: REAL_CORE, root });
  assert.deepEqual(checks.filter((c) => !c.ok), []);
  assert.equal(checks.length, 9, JSON.stringify(checks.map((c) => c.name)));
});
