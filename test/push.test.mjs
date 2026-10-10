import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { createGit, scanRange, requestPush, requestFile, recordFile } from '../lib/push.mjs';
import { pushSettings } from '../lib/config.mjs';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';

// built at run time: no token-shaped literal in this file
const GH = `ghp_${'a1B2'.repeat(9)}`;
const SETTINGS = pushSettings({ mode: 'after-wave', ci: 'none' });

// A repository with a temporary local bare remote: no network, nothing outside the temp directory.
function pushRepo() {
  const root = tmpGitRepo();
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, '.git', 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1' };
  const sh = (...a) => execFileSync('git', a, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const bare = path.join(tmpDir('bare'), 'remote.git');
  sh('init', '-q', '--bare', '-b', 'main', bare);
  fs.mkdirSync(path.join(root, '.planning', 'turbo', 'run'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', '.gitignore'), 'run/\nlogs/\nlocks/\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'turbo files');
  sh('remote', 'add', 'origin', bare);
  sh('push', '-q', 'origin', 'main');
  const commit = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
    sh('add', '-A');
    sh('commit', '-q', '-m', `change ${file}`);
    return sh('rev-parse', 'HEAD');
  };
  const remoteHead = () => sh('ls-remote', bare, 'refs/heads/main').split(/\s/)[0];
  return { root, bare, env, sh, commit, remoteHead, git: createGit(root, { env }) };
}

test('createGit: argument array, no shell, never a credential prompt, a time limit, masked one-line errors', () => {
  const calls = [];
  const git = createGit('/proj', { exec: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return 'ok\n'; }, env: { KEEP: '1' } });
  assert.equal(git(['status'], { timeout: 1234 }), 'ok\n');
  const c = calls[0];
  assert.equal(c.cmd, 'git');
  assert.equal(c.args.at(-1), 'status');
  assert.ok(c.args.includes('core.quotepath=false'));
  assert.deepEqual([c.opts.cwd, c.opts.shell, c.opts.timeout, c.opts.env.KEEP, c.opts.env.GIT_TERMINAL_PROMPT, c.opts.env.GCM_INTERACTIVE], ['/proj', undefined, 1234, '1', '0', 'never']);
  assert.equal((createGit('/proj', { exec: (cmd, args, opts) => opts.timeout })(['fetch'])), 60000, 'a default time limit');
  const denied = createGit('/proj', { exec: () => { throw Object.assign(new Error('Command failed: git push x'), { status: 128, stderr: "remote: denied\nfatal: unable to access 'https://bob:s3cretpw@example.com/r.git/': 403\n" }); } });
  assert.throws(() => denied(['push']), (e) => e.status === 128 && e.message === "remote: denied / fatal: unable to access 'https://[secret]@example.com/r.git/': 403");
  const hung = createGit('/proj', { exec: () => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }); } });
  assert.throws(() => hung(['fetch']), (e) => e.message === 'timed out after 60 s' && e.status === null);
});

test('scanRange names forbidden files and secret kinds from every commit of the range, never the value', () => {
  const r = pushRepo();
  r.commit('old/app.db', 'x');
  const base = r.sh('rev-parse', 'HEAD');
  r.sh('rm', '-q', 'old/app.db');
  r.sh('commit', '-q', '-m', 'drop the old database'); // a deletion is pushed, not refused
  r.commit('src/ok.mjs', 'export const x = 1;\n');
  r.commit('logs/run.log', 'started\n');
  r.sh('rm', '-q', 'logs/run.log');
  r.sh('commit', '-q', '-m', 'drop the log'); // gone at HEAD, still in the pushed history
  r.commit('src/conf.mjs', `export const t = '${GH}';\n`);
  const sha = r.commit('src/conf.mjs', 'export const t = process.env.T;\n'); // removed again, still in history
  const findings = scanRange(r.git, base, sha);
  assert.deepEqual(findings, [{ file: 'logs/run.log', kind: 'forbidden name *.log' }, { file: 'src/conf.mjs', kind: 'github token' }]);
  assert.ok(!JSON.stringify(findings).includes(GH));
  assert.deepEqual(scanRange(r.git, sha, sha), []);
});

test('scanRange refuses a file name it cannot read as UTF-8 instead of skipping it', () => {
  const git = (args) => (args.includes('--name-only') ? Buffer.from([0x61, 0xff, 0x2e, 0x6c, 0x6f, 0x67, 0x00]) : '');
  assert.deepEqual(scanRange(git, 'b', 'h'), [{ file: '(a file name that is not UTF-8)', kind: 'unreadable file name' }]);
});

test('requestPush asks nothing with push off, at a wave in after-phase mode, or before the first commit', () => {
  const r = pushRepo();
  const ask = (settings, point = null) => requestPush({ root: r.root, phase: '3', point, settings, git: r.git });
  assert.deepEqual(ask(pushSettings()), { code: 0, line: 'push off: nothing requested (push.mode in .planning/turbo/config.json)' });
  assert.deepEqual(ask(pushSettings({ mode: 'after-phase' }), 'wave'), { code: 0, line: 'push after-phase: nothing requested at a wave' });
  assert.ok(!fs.existsSync(requestFile(r.root, '3')));
  const unborn = tmpDir('unborn');
  execFileSync('git', ['init', '-q', unborn], { env: r.env });
  assert.equal(requestPush({ root: unborn, phase: '3', settings: SETTINGS, git: createGit(unborn, { env: r.env }) }).line, 'nothing to push: no commit yet');
});

test('requestPush writes one request per head and reuses it for the same head until it ends without a push', () => {
  const r = pushRepo();
  let n = 0;
  const ask = (point = null) => requestPush({ root: r.root, phase: '3', point, settings: SETTINGS, git: r.git, newId: () => `id-${++n}`, now: new Date('2026-01-01T00:00:00Z') });
  const head = r.sh('rev-parse', 'HEAD');
  const first = ask('wave');
  assert.deepEqual(first.request, { id: 'id-1', phase: '3', head, at: '2026-01-01T00:00:00.000Z' });
  assert.equal(first.line, `push requested: ${head.slice(0, 7)} (the supervisor pushes it at its next check)`);
  assert.deepEqual(readJson(requestFile(r.root, '3')), first.request);
  // a --wait run again after "waiting:" keeps the request
  assert.equal(ask('phase').request.id, 'id-1');
  assert.equal(ask().line, `push already requested: ${head.slice(0, 7)}`);
  // pushed: the same head still has the same request (its CI result answers the next --wait at once)
  writeJsonAtomic(recordFile(r.root, '3'), { requestId: 'id-1', outcome: 'pushed', sha: head, ci: { state: 'green' } });
  assert.equal(ask().request.id, 'id-1');
  // refused, diverged or failed: asking again is a new request that the supervisor handles afresh
  writeJsonAtomic(recordFile(r.root, '3'), { requestId: 'id-1', outcome: 'failed', reason: 'x' });
  assert.equal(ask().request.id, 'id-2');
  // a new commit: a new request
  r.commit('src/a.mjs', 'export const a = 1;\n');
  assert.equal(ask().request.id, 'id-3');
});
