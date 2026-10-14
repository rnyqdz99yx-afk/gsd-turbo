import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpGitRepo } from './helpers/tmp.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { parseUat } from '../lib/uat.mjs';
import { readQuestions } from '../lib/questions.mjs';
import { answerQuestion } from '../lib/answers.mjs';
import { UAT } from './fixtures/uat-sample.mjs';

function project(uat = UAT) {
  const root = tmpGitRepo();
  const dir = path.join(root, '.planning', 'phases', '03-demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '03-UAT.md'), uat);
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify({ lang: 'en', autonomy: 'standard', uat: { base_url: 'http://localhost:3000', forbidden_hosts: ['api.example.com'] } }));
  const notes = [];
  const lines = [];
  const run = (...a) => runPhaseCommand('uat', a, { root, out: (l) => lines.push(l), err: (l) => lines.push(l), deps: { notify: async (key, vars) => { notes.push({ key, vars }); } } });
  return { root, dir, run, lines, notes };
}

// A prepared stand and one small evidence file: a pass needs evidence (M7), and evidence needs the stand's
// one-time credentials for the record's secret scan.
async function standEvidence(p) {
  assert.equal(await p.run('stand', '3', 'prepare'), 0);
  const file = path.join(JSON.parse(p.lines.at(-1)).evidenceDir, 't.txt');
  fs.writeFileSync(file, 'the page showed the value');
  return [path.relative(p.root, file).split(path.sep).join('/')];
}

test('uat plan classifies pending items and checks the stand', async () => {
  const p = project();
  assert.equal(await p.run('plan', '3'), 0);
  const plan = JSON.parse(p.lines.at(-1));
  assert.equal(plan.stand.ok, true);
  assert.deepEqual(plan.items.map((i) => [i.test, i.class, i.split ?? '']), [[1, 'A', ''], [2, 'D', ''], [3, 'A', 'hermetic'], [3, 'C', 'live'], [4, 'A', '']]);
});

test('uat stand prepare/cleanup never prints the credentials', async () => {
  const p = project();
  assert.equal(await p.run('stand', '3', 'prepare'), 0);
  const s = JSON.parse(p.lines.at(-1));
  const { password } = JSON.parse(fs.readFileSync(s.credsFile, 'utf8'));
  assert.ok(!p.lines.join('\n').includes(password));
  assert.ok(fs.statSync(s.evidenceDir).isDirectory());
  assert.equal(await p.run('stand', '3', 'cleanup'), 0);
  assert.ok(!fs.existsSync(s.credsFile));
});

test('uat net-check fails on a request outside the allowlist', async () => {
  const p = project();
  const log = path.join(p.root, 'req.log');
  fs.writeFileSync(log, 'http://localhost:3000/\nhttp://127.0.0.1:3000/api\n');
  assert.equal(await p.run('net-check', '3', '--log', log), 0);
  fs.appendFileSync(log, 'https://api.example.com/v1?key=zzz\n');
  assert.equal(await p.run('net-check', '3', '--log', log), 1);
  assert.ok(p.lines.some((l) => /forbidden host: https:\/\/api\.example\.com$/.test(l)));
  assert.ok(!p.lines.join('\n').includes('zzz'), 'a violation never shows the path or query');
  // an empty log is reported as such; whether one was required is the turbo-uat procedure's call
  fs.writeFileSync(log, '\n  \n');
  assert.equal(await p.run('net-check', '3', '--log', log), 0);
  assert.equal(p.lines.at(-1), 'no requests logged');
});

test('uat stand prepare and net-check refuse a stand config that standCheck refuses', async () => {
  const p = project();
  fs.writeFileSync(path.join(p.root, '.planning', 'turbo', 'config.json'), JSON.stringify({ lang: 'en', uat: { base_url: 'http://localhost:3000', forbidden_hosts: 'api.example.com' } }));
  const log = path.join(p.root, 'req.log');
  fs.writeFileSync(log, 'https://api.example.com/v1\n');
  assert.equal(await p.run('stand', '3', 'prepare'), 1);
  assert.ok(!fs.existsSync(path.join(p.root, '.planning', 'turbo', 'run', 'uat-p3')), 'a refused stand is never prepared');
  assert.equal(await p.run('net-check', '3', '--log', log), 1);
  assert.equal(p.lines.filter((l) => /forbidden_hosts must be a list of host names/.test(l)).length, 2);
  assert.equal(await p.run('plan', '3'), 1);
  assert.equal(await p.run('stand', '3', 'cleanup'), 0, 'cleanup always runs');
});

test('uat record + owner-request: D items make the phase wait, C-only sends one checklist notification', async () => {
  const p = project();
  const results = path.join(p.root, 'results.json');
  const pev = await standEvidence(p);
  fs.writeFileSync(results, JSON.stringify([
    { test: 1, result: 'pass', class: 'A', harness: 'http', evidence: pev },
    { test: 2, result: 'owner', class: 'D' },
    { test: 3, result: 'deferred', class: 'C', reason: 'needs a physical phone' },
    { test: 4, result: 'pass', class: 'A', harness: 'http', evidence: pev },
  ]));
  assert.equal(await p.run('record', '3', '--results', results), 0);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: p.root, encoding: 'utf8' }).trim();
  assert.equal(parseUat(fs.readFileSync(path.join(p.dir, '03-UAT.md'), 'utf8')).tests[0].fields.head, head);
  assert.equal(await p.run('owner-request', '3', '--json'), 0);
  const r = JSON.parse(p.lines.at(-1));
  assert.deepEqual([r.needsOwner, r.counts.signoff, r.counts.checklist], [true, 1, 1]);
  assert.ok(fs.existsSync(path.join(p.root, r.file)));
  assert.equal(p.notes.length, 0, 'D items: the lane reports needs-owner, the supervisor notifies');

  // every open row makes the phase wait, whoever wrote it: test 2 stays GSD's pending row here
  const q = project();
  fs.writeFileSync(path.join(q.root, 'r.json'), JSON.stringify([{ test: 3, result: 'deferred', class: 'C', reason: 'phone' }]));
  assert.equal(await q.run('record', '3', '--results', path.join(q.root, 'r.json')), 0);
  assert.equal(await q.run('owner-request', '3', '--json'), 0);
  assert.equal(JSON.parse(q.lines.at(-1)).needsOwner, true);
  assert.equal(q.notes.length, 0);

  // the owner already answered test 2 through verify-work; only the C item is left
  const c = project();
  const uatFile = path.join(c.dir, '03-UAT.md');
  const before = fs.readFileSync(uatFile, 'utf8');
  const answered = before.replace('### 2. Owner signs the release\nexpected: the release is signed\nresult: [pending]', '### 2. Owner signs the release\nexpected: the release is signed\nresult: pass');
  assert.notEqual(answered, before);
  fs.writeFileSync(uatFile, answered);
  const cev = await standEvidence(c);
  fs.writeFileSync(path.join(c.root, 'r.json'), JSON.stringify([
    { test: 1, result: 'pass', class: 'A', harness: 'http', evidence: cev },
    { test: 3, result: 'deferred', class: 'C', reason: 'phone' },
    { test: 4, result: 'pass', class: 'A', harness: 'http', evidence: cev },
  ]));
  assert.equal(await c.run('record', '3', '--results', path.join(c.root, 'r.json')), 0);
  assert.equal(await c.run('owner-request', '3', '--json'), 0);
  const cr = JSON.parse(c.lines.at(-1));
  assert.deepEqual([cr.needsOwner, cr.counts.signoff, cr.counts.checklist], [false, 0, 1]);
  assert.ok(fs.existsSync(path.join(c.root, cr.file)));
  assert.deepEqual(c.notes.map((n) => n.key), ['ownerChecklist']);
  assert.deepEqual(c.notes[0].vars, { phase: '3', n: 1, file: '.planning/turbo/run/p3-owner.md' });

  // the lane's uat step runs owner-request more than once: the same checklist is never sent twice
  const sidecar = path.join(c.root, '.planning', 'turbo', 'run', 'p3-owner.notified');
  assert.ok(fs.existsSync(sidecar));
  assert.equal(await c.run('owner-request', '3', '--json'), 0);
  assert.equal(c.notes.length, 1);
  // a new C item changes the checklist: the owner hears about it once more
  fs.writeFileSync(path.join(c.root, 'r4.json'), JSON.stringify([{ test: 4, result: 'deferred', class: 'C', reason: 'a real browser download' }]));
  assert.equal(await c.run('record', '3', '--results', path.join(c.root, 'r4.json')), 0);
  assert.equal(await c.run('owner-request', '3', '--json'), 0);
  assert.deepEqual(c.notes.map((n) => n.vars.n), [1, 2]);
  assert.equal(await c.run('owner-request', '3', '--json'), 0);
  assert.equal(c.notes.length, 2);
  // the owner closes both checks through verify-work: the stale request and its sidecar go away
  const open = fs.readFileSync(uatFile, 'utf8');
  const closed = open.replaceAll('result: skipped', 'result: pass');
  assert.notEqual(closed, open);
  fs.writeFileSync(uatFile, closed);
  assert.equal(await c.run('owner-request', '3', '--json'), 0);
  const done = JSON.parse(c.lines.at(-1));
  assert.deepEqual([done.file, done.needsOwner, done.counts.checklist, done.counts.signoff], [null, false, 0, 0]);
  assert.ok(!fs.existsSync(path.join(c.root, '.planning', 'turbo', 'run', 'p3-owner.md')));
  assert.ok(!fs.existsSync(sidecar));
  assert.equal(c.notes.length, 2);
});

test('uat record refuses evidence without the stand credentials, and a repository without a commit', async () => {
  const p = project();
  const uatFile = path.join(p.dir, '03-UAT.md');
  const ev = path.join(p.root, '.planning', 'turbo', 'run', 'evidence', 'p3');
  fs.mkdirSync(ev, { recursive: true });
  fs.writeFileSync(path.join(ev, 'note.txt'), 'the value persisted\n');
  const results = path.join(p.root, 'results.json');
  fs.writeFileSync(results, JSON.stringify([{ test: 1, result: 'pass', class: 'A', harness: 'http', evidence: ['.planning/turbo/run/evidence/p3/note.txt'] }]));
  const before = fs.readFileSync(uatFile, 'utf8');
  // never prepared (or already cleaned up): the known-credential scan would run blind
  assert.equal(await p.run('record', '3', '--results', results), 1);
  assert.match(p.lines.at(-1), /record before stand cleanup/);
  assert.equal(fs.readFileSync(uatFile, 'utf8'), before);
  assert.equal(await p.run('stand', '3', 'prepare'), 0);
  assert.equal(await p.run('record', '3', '--results', results), 0);
  assert.equal(parseUat(fs.readFileSync(uatFile, 'utf8')).tests[0].result, 'pass');

  const q = project();
  execFileSync('git', ['update-ref', '-d', 'HEAD'], { cwd: q.root });
  fs.writeFileSync(path.join(q.root, 'r.json'), JSON.stringify([{ test: 1, result: 'pass', class: 'A', harness: 'http' }]));
  assert.equal(await q.run('record', '3', '--results', path.join(q.root, 'r.json')), 1);
  assert.equal(q.lines.at(-1), 'turbo-run uat: record needs a commit');
});

test('turbo-run status lists owner requests in every view', () => {
  const p = project();
  const run = path.join(p.root, '.planning', 'turbo', 'run');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'p3-owner.md'), 'x');
  fs.writeFileSync(path.join(run, 'p3-owner.notified'), '{}');
  // outside any Claude Code session: status ends with the owner request, no line back to a chat
  const status = (...a) => execFileSync(process.execPath, [path.resolve('bin/turbo-run.mjs'), 'status', '--project', p.root, ...a], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: '' } });
  const want = ['.planning/turbo/run/p3-owner.md'];
  // never started: a phase run by hand still shows its request
  assert.match(status(), /never started\)\nowner request: \.planning\/turbo\/run\/p3-owner\.md\n$/);
  assert.deepEqual(JSON.parse(status('--json')).ownerRequests, want);
  fs.writeFileSync(path.join(run, 'supervisor.json'), JSON.stringify({ lane: null, finished: false, halted: false, pid: null }));
  const out = status();
  assert.match(out, /owner request: \.planning\/turbo\/run\/p3-owner\.md/);
  assert.equal(out.match(/owner request:/g).length, 1, 'the notification sidecar is not an owner request');
  assert.deepEqual(JSON.parse(status('--json')).ownerRequests, want);
});

test('uat defer: --rulings defers the owner-ruled rows, numbers confirm the others, a refused number changes nothing', async () => {
  const rows = [
    '### 6. Payment with a real card', 'result: skipped', 'reason: owner ruling 2026-01-02: defer to Phase 9', '',
    '### 7. Store listing', 'result: blocked', 'reason: the store review is pending', '',
  ].join('\n');
  const p = project(UAT.replace('## Summary', `${rows}\n## Summary`));
  const uatFile = path.join(p.dir, '03-UAT.md');
  assert.equal(await p.run('defer', '3', '--rulings'), 0);
  assert.equal(p.lines.at(-1), 'deferred as follow-ups: 6 (.planning/phases/03-demo/03-UAT.md)');
  assert.equal(parseUat(fs.readFileSync(uatFile, 'utf8')).tests.find((t) => t.number === 6).fields.reason, '"Deferred follow-up: owner ruling 2026-01-02: defer to Phase 9"');
  assert.equal(await p.run('defer', '3', '--rulings', '--json'), 0);
  assert.deepEqual(JSON.parse(p.lines.at(-1)), { file: '.planning/phases/03-demo/03-UAT.md', deferred: [], already: [] });
  const before = fs.readFileSync(uatFile, 'utf8');
  assert.equal(await p.run('defer', '3', '7,1'), 1);
  assert.match(p.lines.at(-1), /test 1: only a skipped or blocked row/);
  assert.equal(fs.readFileSync(uatFile, 'utf8'), before);
  assert.equal(await p.run('defer', '3', '7'), 0);
  assert.equal(p.lines.at(-1), 'deferred as follow-ups: 7 (.planning/phases/03-demo/03-UAT.md)');
  assert.equal(await p.run('defer', '3'), 2, 'neither --rulings nor numbers');
  assert.equal(await p.run('defer', '3', '7', '11'), 2, 'a second number list is never ignored');
});

// GSD's uat.complete-session compares the working UAT file with its blob at HEAD byte for byte (only updated: aside):
// a checkout with core.autocrlf=true has CRLF in the working copy and LF in the blob, so every call wrote and committed
// a new updated: line and made VERIFICATION.md stale again. uat settle gives the working copy the blob's LF.
test('uat settle: a CRLF working copy of an LF blob gets the committed bytes; nothing is staged and nothing else is touched', async () => {
  const p = project();
  const g = (...a) => execFileSync('git', a, { cwd: p.root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(p.root, '.git', 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1' } });
  const uatFile = path.join(p.dir, '03-UAT.md');
  const rel = '.planning/phases/03-demo/03-UAT.md';
  // not committed yet: nothing to compare with
  assert.equal(await p.run('settle', '3'), 0);
  assert.equal(p.lines.at(-1), `nothing to settle (${rel})`);
  g('add', '-A');
  g('commit', '-q', '-m', 'uat');
  g('config', 'core.autocrlf', 'true');
  // a checkout with core.autocrlf=true: the same content with CRLF
  fs.writeFileSync(uatFile, UAT.replace(/\n/g, '\r\n'));
  assert.equal(await p.run('settle', '3', '--json'), 0);
  assert.deepEqual(JSON.parse(p.lines.at(-1)), { file: rel, settled: true, clean: true });
  assert.equal(fs.readFileSync(uatFile, 'utf8'), UAT);
  assert.equal(g('diff', '--name-only', '--', rel), '', 'no content change');
  assert.equal(g('diff', '--cached', '--name-only'), '', 'nothing staged');
  // an LF working copy is left alone
  assert.equal(await p.run('settle', '3'), 0);
  assert.equal(p.lines.at(-1), `nothing to settle (${rel})`);
  // a real change waiting for its commit keeps its content, gets LF and is not staged
  const changed = UAT.replace('result: pass', 'result: issue');
  fs.writeFileSync(uatFile, changed.replace(/\n/g, '\r\n'));
  assert.equal(await p.run('settle', '3'), 0);
  assert.equal(p.lines.at(-1), `settled: ${rel} has the committed line endings (LF); its own changes wait for their commit`);
  assert.equal(fs.readFileSync(uatFile, 'utf8'), changed);
  assert.equal(g('diff', '--cached', '--name-only'), '');
  assert.match(g('status', '--porcelain', '--', rel), /^ M /);
  // a version staged by hand stays staged as it was: settle never touches the index
  g('add', '--', rel);
  const staged = g('diff', '--cached');
  fs.writeFileSync(uatFile, UAT.replace(/\n/g, '\r\n'));
  assert.equal(await p.run('settle', '3'), 0);
  assert.equal(g('diff', '--cached'), staged);
  assert.equal(fs.readFileSync(uatFile, 'utf8'), UAT);
});

test('uat settle: a blob committed with CRLF is left as it is', async () => {
  const p = project(UAT.replace(/\n/g, '\r\n'));
  const g = (...a) => execFileSync('git', a, { cwd: p.root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(p.root, '.git', 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1' } });
  g('add', '-A');
  g('commit', '-q', '-m', 'uat');
  const uatFile = path.join(p.dir, '03-UAT.md');
  assert.equal(await p.run('settle', '3'), 0);
  assert.equal(p.lines.at(-1), 'nothing to settle (.planning/phases/03-demo/03-UAT.md)');
  assert.equal(fs.readFileSync(uatFile, 'utf8'), UAT.replace(/\n/g, '\r\n'));
});

// F1: a UAT stop for the owner's signature is a sign-off card: its Accept signs exactly the rows it was asked for, and
// only the owner's own Accept does (never turbo's automatic answer, never another option or another question).
test('F1: ask --sign asks for the rows that wait for a signature; uat sign signs them on the owner\'s Accept only', async () => {
  const p = project();
  const ev = await standEvidence(p);
  fs.writeFileSync(path.join(p.root, 'r.json'), JSON.stringify([
    { test: 1, result: 'pass', class: 'A', harness: 'static', evidence: ev },
    { test: 2, result: 'owner', class: 'D' },
    { test: 3, result: 'deferred', class: 'C', reason: 'needs a physical phone' },
    { test: 4, result: 'pass', class: 'A', harness: 'http', evidence: ev },
  ]));
  assert.equal(await p.run('record', '3', '--results', path.join(p.root, 'r.json')), 0);
  assert.equal(await p.run('owner-request', '3', '--json'), 0);
  assert.deepEqual(JSON.parse(p.lines.at(-1)).sign, [2]);
  const cmd = async (name, ...a) => {
    const lines = [];
    const code = await runPhaseCommand(name, a, { root: p.root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`), deps: { env: {}, supervisorAlive: () => false, commit: () => ({ committed: true }) } });
    return { code, text: lines.join('\n') };
  };
  const Q = ['--question', 'The release needs your signature: do you accept it as it is?', '--context', 'The automatic checks passed; only your signature is left.'];
  // refusals ask nothing
  let r = await cmd('ask', '3', '--sign', '2,5', ...Q);
  assert.equal(r.code, 1);
  assert.match(r.text, /test 5 does not wait for a signature/);
  for (const extra of [['--option', 'a|b', '--option', 'c|d', '--recommended', '1'], ['--auto-ok'], ['--about-review']]) assert.equal((await cmd('ask', '3', '--sign', '2', ...Q, ...extra)).code, 2, extra.join(' '));
  assert.equal((await cmd('ask', '3', '--sign', '2', '--action', 'Sign it.')).code, 2);
  assert.equal((await cmd('ask', '3', '--sign', 'x', ...Q)).code, 2);
  assert.equal((await cmd('ask', '3', '--sign', '2')).code, 2);
  assert.deepEqual(readQuestions(p.root, '3'), []);
  r = await cmd('ask', '3', '--sign', '2', ...Q, '--json');
  assert.equal(r.code, 0, r.text);
  const q = JSON.parse(r.text).question;
  assert.deepEqual([q.id, q.kind, q.sign, q.autoOk, q.options.map((o) => [o.label, o.recommended])], ['ask-1', 'decision', [2], false, [['Accept', false], ['Not now', false]]]);
  // review 1: the card names the rows its Accept signs, in turbo's words, and the signature is bound to them
  assert.equal(q.context, 'The automatic checks passed; only your signature is left. To sign: 2. Owner signs the release. the release is signed');
  assert.deepEqual(q.signText, ['Owner signs the release. the release is signed']);
  const sign = async (id) => [await p.run('sign', '3', '--answer', id), p.lines.at(-1)];
  let [code, line] = await sign('ask-1');
  assert.equal(code, 1);
  assert.match(line, /ask-1 has no answer yet/);
  // Not now signs nothing
  assert.equal((await cmd('answer', '3', 'ask-1', '--option', '2', '--by', 'pane')).code, 0);
  [code, line] = await sign('ask-1');
  assert.equal(code, 1);
  assert.match(line, /the owner chose «Not now», not «Accept»: nothing signed/);
  // turbo's automatic answer never signs
  assert.equal((await cmd('ask', '3', '--sign', '2', ...Q)).code, 0);
  answerQuestion({ root: p.root, phase: '3', id: 'ask-2', option: 1, by: 'auto', commit: () => ({ committed: true }) });
  [code, line] = await sign('ask-2');
  assert.equal(code, 1);
  assert.match(line, /ask-2 was answered by auto, not by the owner/);
  // nor does a standing rule
  assert.equal((await cmd('ask', '3', '--sign', '2', ...Q)).code, 0);
  answerQuestion({ root: p.root, phase: '3', id: 'ask-3', option: 1, by: 'standing-rule', commit: () => ({ committed: true }) });
  [code, line] = await sign('ask-3');
  assert.equal(code, 1);
  assert.match(line, /ask-3 was answered by standing-rule, not by the owner/);
  // an Accept on another kind of question signs nothing
  assert.equal((await cmd('ask', '3', '--question', 'Go on with the next step?', '--option', 'Accept|Go on', '--option', 'Stop|Stop here', '--recommended', '1')).code, 0);
  assert.equal((await cmd('answer', '3', 'ask-4', '--option', '1', '--by', 'session')).code, 0);
  [code, line] = await sign('ask-4');
  assert.equal(code, 1);
  assert.match(line, /ask-4 is no sign-off card/);
  const uatFile = path.join(p.dir, '03-UAT.md');
  const before = fs.readFileSync(uatFile, 'utf8');
  assert.equal(parseUat(before).tests[1].result, 'pending', 'nothing signed so far');
  // the owner's Accept signs test 2, and only test 2
  assert.equal((await cmd('ask', '3', '--sign', '2', ...Q)).code, 0);
  assert.equal((await cmd('answer', '3', 'ask-5', '--option', '1', '--by', 'telegram')).code, 0);
  // the row changed after the owner was asked: nothing is signed until it is as they saw it
  fs.writeFileSync(uatFile, before.replace('expected: the release is signed', 'expected: the contract is signed'));
  [code, line] = await sign('ask-5');
  assert.equal(code, 1);
  assert.match(line, /test 2 changed since the owner was asked/);
  fs.writeFileSync(uatFile, before);
  // the lane takes the answer (deliver), signs, then marks it delivered
  assert.match((await cmd('questions', '3', '--deliver')).text, /^ask-5 · your own question/m);
  [code, line] = await sign('ask-5');
  assert.equal(code, 0, line);
  assert.equal(line, 'signed 1 row(s) in .planning/phases/03-demo/03-UAT.md: 2 (owner answer ask-5)');
  const tests = parseUat(fs.readFileSync(uatFile, 'utf8')).tests;
  assert.deepEqual([tests[1].result, tests[1].fields.source, tests[1].fields.class], ['pass', 'owner', 'D']);
  assert.match(tests[1].fields.signed, /^owner answer ask-5 \(telegram, \d{4}-\d\d-\d\dT[\d:.]+Z\)$/);
  assert.deepEqual([tests[0].fields.source, tests[0].fields.harness], ['turbo-uat', 'static']);
  assert.equal(await p.run('owner-request', '3', '--json'), 0);
  assert.equal(JSON.parse(p.lines.at(-1)).needsOwner, false);
  [code, line] = await sign('ask-5');
  assert.deepEqual([code, line], [0, 'nothing to sign in .planning/phases/03-demo/03-UAT.md: 2 already closed']);
  assert.equal((await cmd('questions', '3', '--delivered', 'ask-5', '--path', 'lane')).code, 0);
  // a delivered lane question is gone at the next refresh: it signs nothing any more
  assert.equal((await cmd('questions', '3')).code, 0);
  [code, line] = await sign('ask-5');
  assert.equal(code, 1);
  assert.match(line, /no question ask-5 in phase 3/);
  assert.equal(await p.run('sign', '3'), 2);
  assert.equal(await p.run('sign', '3', '--answer', 'x'), 2);
});

// review 1 (F1): a uat step that runs again after the owner signed has nothing left to record: an empty record
// writes nothing, so it never stales the report with a new updated: line
test('uat record of an empty results array leaves the UAT file as it is', async () => {
  const p = project();
  const uatFile = path.join(p.dir, '03-UAT.md');
  const before = fs.readFileSync(uatFile, 'utf8');
  fs.writeFileSync(path.join(p.root, 'r.json'), '[]');
  assert.equal(await p.run('record', '3', '--results', path.join(p.root, 'r.json')), 0);
  assert.match(p.lines.at(-1), /^recorded 0 result\(s\) in \.planning\/phases\/03-demo\/03-UAT\.md: /);
  assert.equal(fs.readFileSync(uatFile, 'utf8'), before);
});

// F1 (controller): a lane can clear TURBO_LANE, so the owner's sign-off also checks the calling session against the
// lane sessions turbo recorded (supervisor.json): the lane's job id, a transcript named after it, and the session ids its
// job state names. Empty TURBO_LANE still means "not a lane" for everything else.
test('F1: a sign-off card refuses an answer from a recorded lane session even with TURBO_LANE empty; the owner\'s own session answers it', async () => {
  const p = project();
  fs.writeFileSync(path.join(p.root, 'r.json'), JSON.stringify([{ test: 2, result: 'owner', class: 'D' }]));
  assert.equal(await p.run('record', '3', '--results', path.join(p.root, 'r.json')), 0);
  // the claude home the lane's background job writes its state to
  const home = path.join(p.root, 'claude-home');
  const JOB = 'c0ffee12';
  const RESUMED = '9b1d2e3f-0000-4000-8000-000000000001';
  fs.mkdirSync(path.join(home, 'jobs', JOB), { recursive: true });
  fs.writeFileSync(path.join(home, 'jobs', JOB, 'state.json'), JSON.stringify({ sessionId: RESUMED }));
  fs.mkdirSync(path.join(p.root, '.planning', 'turbo', 'run'), { recursive: true });
  fs.writeFileSync(path.join(p.root, '.planning', 'turbo', 'run', 'supervisor.json'), JSON.stringify({ lane: { phase: '3', sessionId: JOB } }));
  const cmd = async (env, name, ...a) => {
    const lines = [];
    const code = await runPhaseCommand(name, a, { root: p.root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`), deps: { env: { CLAUDE_CONFIG_DIR: home, TURBO_LANE: '', ...env }, supervisorAlive: () => false, commit: () => ({ committed: true }) } });
    return { code, text: lines.join('\n') };
  };
  const Q = ['--question', 'The release needs your signature: do you accept it as it is?'];
  assert.equal((await cmd({}, 'ask', '3', '--sign', '2', ...Q)).code, 0);
  // the lane's own session, by the transcript named after its job, by the session its job state names, by its job dir
  for (const env of [
    { CLAUDE_CODE_SESSION_ID: `${JOB}-1111-4111-8111-111111111111` },
    { CLAUDE_CODE_SESSION_ID: RESUMED },
    { CLAUDE_JOB_DIR: path.join(home, 'jobs', JOB) },
  ]) {
    const r = await cmd(env, 'answer', '3', 'ask-1', '--option', '1', '--by', 'session');
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.match(r.text, /^refused: this is the session of the lane of phase 3: a sign-off card is the owner's to answer/);
  }
  assert.equal(readQuestions(p.root, '3').find((q) => q.id === 'ask-1').state, 'open', 'nothing recorded');
  // the owner's own session answers it, and the answer keeps that session
  const OWNER = '5e55a0e0-2222-4222-8222-222222222222';
  const r = await cmd({ CLAUDE_CODE_SESSION_ID: OWNER }, 'answer', '3', 'ask-1', '--option', '1', '--by', 'session');
  assert.equal(r.code, 0, r.text);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, '.planning', 'turbo', 'answers', 'p3.json'), 'utf8')).at(-1).session, OWNER);
  // uat sign checks the recorded answer again: an Accept recorded from a lane session signs nothing
  assert.equal((await cmd({}, 'ask', '3', '--sign', '2', ...Q)).code, 0);
  answerQuestion({ root: p.root, phase: '3', id: 'ask-2', option: 1, by: 'session', session: RESUMED, commit: () => ({ committed: true }) });
  let s = await cmd({}, 'uat', 'sign', '3', '--answer', 'ask-2');
  assert.equal(s.code, 1);
  assert.match(s.text, /ask-2 was answered from the session of the lane of phase 3, not by the owner: nothing signed/);
  s = await cmd({}, 'uat', 'sign', '3', '--answer', 'ask-1');
  assert.equal(s.code, 0, s.text);
  assert.match(s.text, /^signed 1 row\(s\) in .*: 2 \(owner answer ask-1\)$/);
});
