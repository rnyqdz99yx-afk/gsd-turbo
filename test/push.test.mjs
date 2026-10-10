import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { createGit, scanRange, requestPush, requestFile, recordFile, pushTick, describeRecord } from '../lib/push.mjs';
import { DEFAULTS, pushSettings } from '../lib/config.mjs';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';
import { readInbox, inboxFile } from '../lib/inbox.mjs';

// built at run time: no token-shaped literal in this file
const GH = `ghp_${'a1B2'.repeat(9)}`;
// a URL with credentials, joined at run time like the token
const CRED_URL = `https://bob:${'s3cretpw'}@example.com/r.git/`;
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
  // a signature check never prints into what turbo parses
  assert.ok(c.args.includes('log.showSignature=false'));
  assert.deepEqual([c.opts.cwd, c.opts.shell, c.opts.timeout, c.opts.env.KEEP, c.opts.env.GIT_TERMINAL_PROMPT, c.opts.env.GCM_INTERACTIVE], ['/proj', undefined, 1234, '1', '0', 'never']);
  assert.equal((createGit('/proj', { exec: (cmd, args, opts) => opts.timeout })(['status'])), 60000, 'a default time limit');
  // fetch and push run under lib/tree-timeout.mjs, which ends git's hooks, ssh and remote helpers at the time limit
  const net = [];
  createGit('/proj', { exec: (cmd, args, opts) => { net.push({ cmd, args, opts }); return ''; } })(['-c', 'k=v', 'push', 'origin', 'x'], { timeout: 5000 });
  const p = net.at(-1);
  assert.deepEqual([p.cmd, path.basename(p.args[0]), p.args[1], p.args[2], p.args.at(-3)], [process.execPath, 'tree-timeout.mjs', '5000', 'git', 'push']);
  assert.ok(p.opts.timeout > 5000, 'a later backstop for the wrapper itself');
  const tree = createGit('/proj', { exec: () => { throw Object.assign(new Error('x'), { status: 124, stderr: 'fatal: x\nturbo: timed out, process tree ended\n' }); } });
  assert.throws(() => tree(['fetch'], { timeout: 5000 }), (e) => e.message === 'timed out after 5 s' && e.status === null);
  const denied = createGit('/proj', { exec: () => { throw Object.assign(new Error('Command failed: git push x'), { status: 128, stderr: `remote: denied\nfatal: unable to access '${CRED_URL}': 403\n` }); } });
  assert.throws(() => denied(['push']), (e) => e.status === 128 && e.message === "remote: denied / fatal: unable to access 'https://[secret]@example.com/r.git/': 403");
  const hung = createGit('/proj', { exec: () => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }); } });
  assert.throws(() => hung(['fetch']), (e) => e.message === 'timed out after 60 s' && e.status === null);
});

test('createGit makes OpenSSH fail at once instead of asking for a passphrase; other ssh programs stay as configured', () => {
  // the GIT_SSH_COMMAND of a status, a fetch and a push call; configured is the project's core.sshCommand
  const run = (env, configured = '') => {
    let lookups = 0;
    const seen = [];
    const git = createGit('/proj', {
      env,
      exec: (cmd, args, opts) => {
        if (args.includes('core.sshCommand')) {
          lookups += 1;
          if (configured) return `${configured}\n`;
          throw Object.assign(new Error('x'), { status: 1 });
        }
        seen.push(opts.env.GIT_SSH_COMMAND);
        return '';
      },
    });
    for (const a of [['status'], ['fetch', 'origin'], ['push', 'origin', 'x']]) git(a);
    return { seen, lookups };
  };
  const batch = (c) => [c, `${c} -o BatchMode=yes`, `${c} -o BatchMode=yes`];
  assert.deepEqual(run({}).seen, [undefined, 'ssh -o BatchMode=yes', 'ssh -o BatchMode=yes']);
  assert.equal(run({}).lookups, 1, 'core.sshCommand is read once');
  assert.deepEqual(run({ GIT_SSH_COMMAND: 'ssh -i /k/id' }), { seen: batch('ssh -i /k/id'), lookups: 0 });
  assert.deepEqual(run({}, '"/opt/open ssh/ssh.exe" -i /k/id').seen.slice(1), batch('"/opt/open ssh/ssh.exe" -i /k/id').slice(1));
  // GIT_SSH (a program without arguments), another program or another ssh variant: left as configured
  assert.deepEqual(run({ GIT_SSH: 'plink' }).seen, [undefined, undefined, undefined]);
  assert.deepEqual(run({ GIT_SSH_COMMAND: 'plink -i k' }).seen, ['plink -i k', 'plink -i k', 'plink -i k']);
  assert.deepEqual(run({ GIT_SSH_COMMAND: 'ssh', GIT_SSH_VARIANT: 'plink' }).seen, ['ssh', 'ssh', 'ssh']);
  // a push with -c options in front is still a push
  const seen = [];
  createGit('/proj', { env: {}, exec: (cmd, args, opts) => { if (!args.includes('core.sshCommand')) seen.push(opts.env.GIT_SSH_COMMAND); return ''; } })(['-c', 'remote.origin.mirror=false', 'push', 'origin', 'x']);
  assert.deepEqual(seen, ['ssh -o BatchMode=yes']);
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

test('scanRange names the real path behind a C-quoted diff header and behind a name with a space', () => {
  // git quotes a path with ", \ or control characters ("b/…" with octal byte escapes) and ends an unquoted
  // path that holds a space with a tab
  const patch = [
    'diff --git "a/d\\303\\251j\\303\\240 \\"q\\".mjs" "b/d\\303\\251j\\303\\240 \\"q\\".mjs"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/d\\303\\251j\\303\\240 \\"q\\".mjs"',
    '@@ -0,0 +1 @@',
    `+export const t = '${GH}';`,
    'diff --git a/sp ace.mjs b/sp ace.mjs',
    '--- /dev/null',
    '+++ b/sp ace.mjs\t',
    '@@ -0,0 +1 @@',
    `+export const t = '${GH}';`,
  ].join('\n');
  const git = (args) => (args.includes('--name-only') ? Buffer.alloc(0) : args.includes('-p') ? patch : '');
  assert.deepEqual(scanRange(git, 'b', 'h'), [{ file: 'déjà "q".mjs', kind: 'github token' }, { file: 'sp ace.mjs', kind: 'github token' }]);
});

test('scanRange reads files git calls binary as text, and refuses Git LFS pointers whose content it cannot see', () => {
  const r = pushRepo();
  const base = r.sh('rev-parse', 'HEAD');
  r.commit('.gitattributes', '*.txt -diff\n');
  r.commit('notes.txt', `token ${GH}\n`);
  r.commit('blob.bin', `\0${GH}\n`);
  const sha = r.commit('art/big.psd', `version https://git-lfs.github.com/spec/v1\noid sha256:${'0'.repeat(64)}\nsize 12\n`);
  assert.deepEqual(scanRange(r.git, base, sha), [
    { file: 'art/big.psd', kind: 'lfs-content-not-scanned' },
    { file: 'blob.bin', kind: 'github token' },
    { file: 'notes.txt', kind: 'github token' },
  ]);
});

test('scanRange scans every commit message of the range and names the commit, never the value', () => {
  const r = pushRepo();
  const base = r.sh('rev-parse', 'HEAD');
  r.sh('commit', '-q', '--allow-empty', '-m', 'wip', '-m', `deploy with ${GH}`);
  const bad = r.sh('rev-parse', 'HEAD');
  const sha = r.commit('src/ok.mjs', 'export const ok = 1;\n');
  const findings = scanRange(r.git, base, sha);
  assert.deepEqual(findings, [{ file: `(commit message ${bad.slice(0, 7)})`, kind: 'github token' }]);
  assert.ok(!JSON.stringify(findings).includes(GH));
});

test('a signed commit is scanned like any other when log.showSignature is on: its files and its message', (t) => {
  const r = pushRepo();
  const key = path.join(tmpDir('sig'), 'key');
  try {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'turbo-test', '-f', key], { stdio: 'ignore', windowsHide: true });
  } catch {
    t.skip('ssh-keygen is not available');
    return;
  }
  for (const [k, v] of [['gpg.format', 'ssh'], ['user.signingkey', key], ['commit.gpgsign', 'true'], ['log.showSignature', 'true']]) r.sh('config', k, v);
  const base = r.sh('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(r.root, '.env'), 'X=1\n');
  r.sh('add', '-A');
  r.sh('commit', '-q', '-m', 'config', '-m', `deploy with ${GH}`);
  const sha = r.sh('rev-parse', 'HEAD');
  assert.deepEqual(scanRange(r.git, base, sha), [
    { file: `(commit message ${sha.slice(0, 7)})`, kind: 'github token' },
    { file: '.env', kind: 'forbidden name .env*' },
  ]);
});

test('scanRange shows merges separately whatever log.diffMerges says, and a header of any diff form starts a new file', () => {
  // a combined-diff header (log.diffMerges=combined) after another file's hunk
  const patch = [
    'diff --git a/x.mjs b/x.mjs',
    '+++ b/x.mjs',
    '@@ -0,0 +1 @@',
    '+const a = 1;',
    'diff --cc y.mjs',
    '--- a/y.mjs',
    '+++ b/y.mjs',
    '@@@ -1,1 -1,1 +1,2 @@@',
    `++const t = '${GH}';`,
  ].join('\n');
  const calls = [];
  const git = (args) => {
    calls.push(args);
    return args.includes('--name-only') ? Buffer.alloc(0) : args.includes('-p') ? patch : '';
  };
  assert.deepEqual(scanRange(git, 'b', 'h'), [{ file: 'y.mjs', kind: 'github token' }]);
  for (const a of calls.filter((c) => c.includes('-p') || c.includes('--name-only'))) {
    assert.ok(a.includes('--diff-merges=separate') && !a.includes('-m'), a.join(' '));
  }
  assert.ok(calls.find((c) => c.includes('-p')).includes('--text'));
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
  assert.deepEqual(first.request, { id: 'id-1', phase: '3', branch: 'main', head, at: '2026-01-01T00:00:00.000Z' });
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

const NOW = new Date('2026-01-01T00:00:00Z');

// The supervisor's ctx around a pushRepo: every git call recorded, notifications and log lines collected.
function supervisorCtx(r, push = {}) {
  const calls = [];
  const notes = [];
  const logs = [];
  const ctx = {
    root: r.root,
    config: { ...structuredClone(DEFAULTS), push: pushSettings({ mode: 'after-wave', ci: 'none', ...push }) },
    deps: {
      git: (args, opts) => { calls.push(args); return r.git(args, opts); },
      gh: () => { throw new Error('gh is not expected here'); },
      notify: async (key, vars) => { notes.push({ key, vars }); },
      log: (l) => logs.push(l),
    },
  };
  return { ctx, calls, notes, logs };
}
const ask = (r, settings) => requestPush({ root: r.root, phase: '3', settings, git: r.git });
// the git subcommand of a recorded call, after any -c <key=value> pairs
const sub = (a) => a[a.findIndex((x, i) => !x.startsWith('-') && a[i - 1] !== '-c')];

test('the supervisor pushes the requested head once: fetch, ancestor check, scan, then a plain push of that sha', async () => {
  const r = pushRepo();
  const { ctx, calls, notes } = supervisorCtx(r);
  const sha = r.commit('src/a.mjs', 'export const a = 1;\n');
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  assert.equal(r.remoteHead(), sha);
  const rec = readJson(recordFile(r.root, '3'));
  assert.deepEqual([rec.outcome, rec.sha, rec.branch, rec.remote, rec.at, rec.lastPush.ci], ['pushed', sha, 'main', 'origin', NOW.toISOString(), { state: 'none', reason: 'push.ci is none' }]);
  assert.deepEqual(calls.map(sub), ['symbolic-ref', 'merge-base', 'config', 'fetch', 'merge-base', 'log', 'log', 'log', 'push']);
  const push = calls.at(-1);
  // config cannot widen the push: no mirror, no tags that follow, no submodule pushes
  assert.deepEqual(push, ['-c', 'remote.origin.mirror=false', 'push', '--quiet', '--no-follow-tags', '--no-recurse-submodules', 'origin', `${sha}:refs/heads/main`]);
  assert.ok(!push.some((a) => /^(-f|--force.*|--no-verify|--mirror|--delete|-d|--all|--tags)$/.test(a) || a.startsWith('+')));
  await pushTick(ctx, NOW);
  assert.equal(calls.filter((a) => sub(a) === 'push').length, 1, 'a handled request is never pushed again');
  assert.deepEqual(notes, []);
});

test('a commit the lane makes during the tick is never pushed unscanned: the supervisor pushes the sha it scanned', async () => {
  const r = pushRepo();
  const { ctx } = supervisorCtx(r);
  const scanned = r.commit('src/a.mjs', 'export const a = 1;\n');
  ask(r, ctx.config.push);
  const inner = ctx.deps.git;
  ctx.deps.git = (args, opts) => {
    const out = inner(args, opts);
    // the lane commits a secret right after the scan read the patches
    if (args[0] === 'log' && args.includes('-p')) r.commit('src/late.mjs', `export const t = '${GH}';\n`);
    return out;
  };
  await pushTick(ctx, NOW);
  assert.equal(r.remoteHead(), scanned);
  assert.notEqual(r.sh('rev-parse', 'HEAD'), scanned);
});

test('a remote branch that is not an ancestor of HEAD: nothing pushed, pushDiverged', async () => {
  const r = pushRepo();
  const { ctx, calls, notes } = supervisorCtx(r);
  const remoteOnly = r.sh('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'remote only');
  r.sh('push', '-q', 'origin', `${remoteOnly}:refs/heads/main`);
  r.commit('src/b.mjs', 'export const b = 2;\n');
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  assert.equal(r.remoteHead(), remoteOnly);
  assert.equal(readJson(recordFile(r.root, '3')).outcome, 'diverged');
  assert.deepEqual(notes, [{ key: 'pushDiverged', vars: { phase: '3', remote: 'origin', branch: 'main' } }]);
  assert.ok(!calls.some((a) => sub(a) === 'push'));
});

test('a file name or a branch name that carries a secret is masked in the record, the log and the notification', async () => {
  const r = pushRepo();
  const { ctx, notes } = supervisorCtx(r);
  const logs = [];
  ctx.deps.log = (l) => logs.push(l);
  r.sh('checkout', '-q', '-b', `feat/${GH}`);
  const c = r.commit(`logs/${GH}.log`, 'started\n'); // its message names the file too
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  const rec = readJson(recordFile(r.root, '3'));
  assert.equal(rec.outcome, 'failed', 'the remote has no such branch yet');
  // a forbidden file found on a branch the remote has: refused, both names masked
  r.sh('push', '-q', 'origin', `HEAD~1:refs/heads/feat/${GH}`);
  ask(r, ctx.config.push);
  await pushTick(ctx, later(1));
  const refused = readJson(recordFile(r.root, '3'));
  assert.equal(refused.outcome, 'refused');
  assert.deepEqual(refused.findings, [{ file: `(commit message ${c.slice(0, 7)})`, kind: 'github token' }, { file: 'logs/[secret].log', kind: 'forbidden name *.log' }]);
  const all = [JSON.stringify(rec), JSON.stringify(refused), JSON.stringify(notes), logs.join('\n')].join('\n');
  assert.ok(!all.includes(GH), all);
  assert.equal(refused.branch, 'feat/[secret]');
});

test('a secret or forbidden file in the range: nothing pushed, file and kind named, never the value; the same findings notify once', async () => {
  const r = pushRepo();
  const { ctx, calls, notes } = supervisorCtx(r);
  const before = r.remoteHead();
  r.commit('src/conf.mjs', `export const t = '${GH}';\n`);
  r.commit('data/app.sqlite', 'x');
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  assert.equal(r.remoteHead(), before);
  const rec = readJson(recordFile(r.root, '3'));
  assert.equal(rec.outcome, 'refused');
  assert.deepEqual(rec.findings, [{ file: 'data/app.sqlite', kind: 'forbidden name *.sqlite' }, { file: 'src/conf.mjs', kind: 'github token' }]);
  assert.deepEqual(notes, [{ key: 'pushRefused', vars: { phase: '3', remote: 'origin', branch: 'main', findings: 'data/app.sqlite (forbidden name *.sqlite), src/conf.mjs (github token)' } }]);
  // the next wave adds a clean commit: the same findings, refused again, not notified again
  r.commit('src/ok.mjs', 'export const ok = 1;\n');
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  assert.equal(readJson(recordFile(r.root, '3')).outcome, 'refused');
  assert.equal(notes.length, 1);
  assert.ok(!calls.some((a) => sub(a) === 'push'));
  assert.ok(!(fs.readFileSync(recordFile(r.root, '3'), 'utf8') + JSON.stringify(notes)).includes(GH));
  // the owner checked the files and pushed the range by hand: turbo pushes again from there
  r.sh('push', '-q', 'origin', 'main');
  const sha = r.commit('src/next.mjs', 'export const next = 1;\n');
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  assert.equal(r.remoteHead(), sha);
});

test('a failing pre-push hook runs (no --no-verify) and fails the push: recorded, masked, notified; the next request tries again', async () => {
  const r = pushRepo();
  const { ctx, notes } = supervisorCtx(r);
  const hook = path.join(r.root, '.git', 'hooks', 'pre-push');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\necho "fatal: unable to access '${CRED_URL}'" >&2\nexit 1\n`);
  fs.chmodSync(hook, 0o755);
  const before = r.remoteHead();
  r.commit('src/a.mjs', 'export const a = 1;\n');
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  assert.equal(r.remoteHead(), before);
  const rec = readJson(recordFile(r.root, '3'));
  assert.equal(rec.outcome, 'failed');
  assert.match(rec.reason, /^git push to origin\/main failed: .*unable to access 'https:\/\/\[secret\]@example\.com/);
  assert.deepEqual(notes.map((n) => n.key), ['pushFailed']);
  assert.ok(!JSON.stringify([rec, notes]).includes('s3cretpw'));
  fs.rmSync(hook);
  const sha = r.commit('src/b.mjs', 'export const b = 2;\n');
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  assert.equal(r.remoteHead(), sha);
});

test('a detached HEAD, or a branch the remote does not have yet: failed with the reason, nothing pushed', async () => {
  const r = pushRepo();
  const { ctx, notes } = supervisorCtx(r);
  r.sh('checkout', '-q', '--detach');
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  assert.equal(readJson(recordFile(r.root, '3')).reason, 'HEAD is detached; turbo pushes a branch only');
  r.sh('checkout', '-q', '-b', 'feature');
  r.commit('src/f.mjs', 'export const f = 1;\n');
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  assert.match(readJson(recordFile(r.root, '3')).reason, /^git fetch origin feature failed: /);
  assert.deepEqual(notes.map((n) => n.key), ['pushFailed', 'pushFailed']);
});

test('the supervisor pushes exactly the requested commit, not a later HEAD', async () => {
  const r = pushRepo();
  const { ctx } = supervisorCtx(r);
  const asked = r.commit('src/a.mjs', 'export const a = 1;\n');
  ask(r, ctx.config.push);
  r.commit('src/b.mjs', 'export const b = 2;\n'); // the next wave goes on before the supervisor's tick
  await pushTick(ctx, NOW);
  assert.equal(r.remoteHead(), asked);
  assert.equal(readJson(recordFile(r.root, '3')).sha, asked);
});

test('a request for another branch than the checkout\'s, or whose commit left its branch, is refused once and nothing is pushed', async () => {
  const r = pushRepo();
  const { ctx, calls, notes } = supervisorCtx(r);
  const before = r.remoteHead();
  r.commit('src/a.mjs', 'export const a = 1;\n');
  ask(r, ctx.config.push);
  r.sh('checkout', '-q', '-b', 'experiment');
  r.commit('src/x.mjs', 'export const x = 1;\n');
  await pushTick(ctx, NOW);
  assert.equal(readJson(recordFile(r.root, '3')).reason, 'the request is for branch main, but the checkout is on experiment now; nothing was pushed');
  r.sh('checkout', '-q', 'main');
  const gone = r.commit('src/c.mjs', 'export const c = 1;\n');
  ask(r, ctx.config.push);
  r.sh('reset', '-q', '--hard', 'HEAD~1');
  r.commit('src/d.mjs', 'export const d = 1;\n');
  await pushTick(ctx, NOW);
  assert.equal(readJson(recordFile(r.root, '3')).reason, `${gone.slice(0, 7)} is no longer on branch main; nothing was pushed`);
  await pushTick(ctx, NOW);
  assert.deepEqual(notes.map((n) => n.key), ['pushFailed', 'pushFailed']);
  assert.ok(!calls.some((a) => a.includes('push')));
  assert.equal(r.remoteHead(), before);
});

test('a remote configured as a mirror is refused with its reason and never pushed to', async () => {
  const r = pushRepo();
  const { ctx, calls, notes } = supervisorCtx(r);
  const before = r.remoteHead();
  r.sh('config', 'remote.origin.mirror', 'true');
  r.commit('src/a.mjs', 'export const a = 1;\n');
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  assert.equal(readJson(recordFile(r.root, '3')).reason, 'remote.origin.mirror is true: turbo never pushes to a mirror remote; nothing was pushed');
  assert.deepEqual(notes.map((n) => n.key), ['pushFailed']);
  assert.ok(!calls.some((a) => sub(a) === 'push'));
  assert.equal(r.remoteHead(), before);
});

test('a tag that shares the branch name does not hide the branch', async () => {
  const r = pushRepo();
  const { ctx } = supervisorCtx(r);
  r.sh('tag', 'main');
  const sha = r.commit('src/a.mjs', 'export const a = 1;\n');
  assert.equal(ask(r, ctx.config.push).request.branch, 'main');
  await pushTick(ctx, NOW);
  assert.equal(r.remoteHead(), sha);
});

test('push off, or a daemon that lost its lease: no git call, no record', async () => {
  const r = pushRepo();
  const { ctx, calls } = supervisorCtx(r);
  ask(r, ctx.config.push);
  ctx.deps.leaseHeld = () => false;
  await pushTick(ctx, NOW);
  ctx.deps.leaseHeld = () => true;
  ctx.config.push = pushSettings();
  await pushTick(ctx, NOW);
  assert.deepEqual(calls, []);
  assert.ok(!fs.existsSync(recordFile(r.root, '3')));
});

const SHA = 'c'.repeat(40);
const later = (min) => new Date(NOW.getTime() + min * 60000);
const runRow = (id, name, status, conclusion = '') => ({ databaseId: id, name, status, conclusion });
const project = () => { const root = tmpDir('ci'); fs.mkdirSync(path.join(root, '.planning', 'turbo', 'run'), { recursive: true }); return root; };
// a record as the supervisor writes it after a push, CI still to watch
const pendingRecord = (root, phase = '3', sha = SHA) => writeJsonAtomic(recordFile(root, phase), {
  requestId: 'r1', phase, remote: 'origin', branch: 'main', at: NOW.toISOString(), outcome: 'pushed', sha,
  lastPush: { requestId: 'r1', sha, branch: 'main', remote: 'origin', repo: 'acme/app', at: NOW.toISOString(), ci: { state: 'pending', since: NOW.toISOString(), runs: [] } },
});
function ghScript(answer) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const a = answer(args);
    if (a instanceof Error) throw a;
    return typeof a === 'string' ? a : JSON.stringify(a);
  };
  return { gh, calls };
}
// the remote reads as a GitHub repository (acme/app); fetch and push still go to the local bare one
function onGithub(ctx) {
  const inner = ctx.deps.git;
  ctx.deps.git = (args, opts) => (args[0] === 'remote' && args[1] === 'get-url' ? 'https://github.com/acme/app.git\n' : inner(args, opts));
}
function ciCtx(root, gh, push = {}) {
  const notes = [];
  const ctx = {
    root,
    config: { ...structuredClone(DEFAULTS), push: pushSettings({ mode: 'after-wave', ...push }) },
    deps: { git: () => { throw new Error('git is not expected here'); }, gh, notify: async (key, vars) => { notes.push({ key, vars }); }, log: () => {} },
  };
  return { ctx, notes };
}

test('CI green: every run of the pushed commit completed without a red conclusion; nothing notified, gh asked no more', async () => {
  const root = project();
  pendingRecord(root);
  const { gh, calls } = ghScript(() => [runRow(1, 'CI', 'completed', 'success'), runRow(2, 'Docs', 'completed', 'skipped')]);
  const { ctx, notes } = ciCtx(root, gh);
  await pushTick(ctx, later(1));
  assert.deepEqual(calls, [['run', 'list', '--commit', SHA, '--json', 'databaseId,name,status,conclusion', '-R', 'acme/app']]);
  assert.equal(readJson(recordFile(root, '3')).lastPush.ci.state, 'green');
  assert.deepEqual(notes, []);
  assert.deepEqual(readInbox(root, '3'), []);
  await pushTick(ctx, later(2));
  assert.equal(calls.length, 1);
});

test('CI red: waits for every run, then puts each red run\'s failed log tail, masked, into the lane inbox and notifies ciRed once', async () => {
  const root = project();
  pendingRecord(root);
  let done = false;
  const log = [`test\tRun npm test\t2026-10-10T10:00:00.0000000Z ${['token', GH].join('=')}`,'test\tRun npm test\t2026-10-10T10:00:01.0000000Z Error: expected 1 to equal 2'].join('\n');
  const { gh, calls } = ghScript((args) => {
    if (args[1] === 'view') return log;
    return [runRow(7, 'CI', 'completed', 'failure'), runRow(8, 'Lint', done ? 'completed' : 'in_progress', done ? 'success' : '')];
  });
  const { ctx, notes } = ciCtx(root, gh);
  await pushTick(ctx, later(1));
  assert.equal(readJson(recordFile(root, '3')).lastPush.ci.state, 'pending', 'one run still going');
  done = true;
  await pushTick(ctx, later(2));
  assert.deepEqual(calls.at(-1), ['run', 'view', '7', '--log-failed', '-R', 'acme/app']);
  const [m] = readInbox(root, '3');
  assert.deepEqual([m.kind, m.sha, m.run, m.workflow, m.conclusion, m.job, m.step, m.tail.at(-1)], ['ci-red', SHA, 7, 'CI', 'failure', 'test', 'Run npm test', 'Error: expected 1 to equal 2']);
  assert.ok(!fs.readFileSync(inboxFile(root, '3'), 'utf8').includes(GH));
  assert.deepEqual(notes, [{ key: 'ciRed', vars: { phase: '3', sha: SHA.slice(0, 7), runs: 'CI (failure)', rounds: 2 } }]);
  assert.equal(readJson(recordFile(root, '3')).lastPush.ci.state, 'red');
  await pushTick(ctx, later(3));
  assert.equal(readInbox(root, '3').length, 1);
  assert.equal(notes.length, 1);
});

test('CI timeout: runs still going after push.ci_timeout_minutes notify ciTimeout; a red run by then counts as red', async () => {
  const root = project();
  pendingRecord(root, '3');
  pendingRecord(root, '4', 'd'.repeat(40));
  const { gh } = ghScript((args) => {
    if (args[1] === 'view') return '';
    return args[3] === SHA ? [runRow(1, 'CI', 'in_progress')] : [runRow(2, 'CI', 'completed', 'failure'), runRow(3, 'E2E', 'queued')];
  });
  const { ctx, notes } = ciCtx(root, gh, { ci_timeout_minutes: 10 });
  await pushTick(ctx, later(9));
  assert.deepEqual(notes, []);
  await pushTick(ctx, later(10));
  assert.equal(readJson(recordFile(root, '3')).lastPush.ci.state, 'timeout');
  assert.equal(readJson(recordFile(root, '4')).lastPush.ci.state, 'red');
  assert.deepEqual(notes.map((n) => n.key), ['ciTimeout', 'ciRed']);
  assert.deepEqual(notes[0].vars, { phase: '3', sha: SHA.slice(0, 7), commit: SHA, repo: ' -R acme/app', minutes: 10, error: '' });
  assert.equal(readInbox(root, '4').length, 1);
});

test('no CI run within 5 minutes counts as no CI; a failing gh keeps waiting and names its error at the timeout', async () => {
  const root = project();
  pendingRecord(root);
  const { ctx, notes } = ciCtx(root, ghScript(() => []).gh);
  await pushTick(ctx, later(4));
  assert.equal(readJson(recordFile(root, '3')).lastPush.ci.state, 'pending');
  await pushTick(ctx, later(5));
  const rec = readJson(recordFile(root, '3'));
  assert.deepEqual([rec.lastPush.ci.state, rec.lastPush.ci.reason], ['none', 'no CI run appeared within 5 min']);
  assert.deepEqual(notes, []);

  const root2 = project();
  pendingRecord(root2);
  const failing = ciCtx(root2, ghScript(() => new Error('gh run list failed: HTTP 502: Bad Gateway')).gh);
  await pushTick(failing.ctx, later(29));
  assert.equal(readJson(recordFile(root2, '3')).lastPush.ci.state, 'pending');
  await pushTick(failing.ctx, later(30));
  assert.equal(readJson(recordFile(root2, '3')).lastPush.ci.state, 'timeout');
  assert.equal(failing.notes[0].vars.error, '; last gh error: gh run list failed: HTTP 502: Bad Gateway');
});

test('CI is checked before new requests: an older push\'s red result still reaches the inbox, then the new push supersedes other watches', async () => {
  const r = pushRepo();
  const old = r.commit('src/a.mjs', 'export const a = 1;\n');
  r.sh('push', '-q', 'origin', 'main');
  pendingRecord(r.root, '3', old);
  pendingRecord(r.root, '2', 'e'.repeat(40)); // another phase's earlier push, no run listed yet
  const sha = r.commit('src/b.mjs', 'export const b = 2;\n');
  const { gh } = ghScript((args) => {
    if (args[1] === 'view') return 'test\tRun\t2026-10-10T10:00:00Z boom';
    return args[3] === old ? [runRow(5, 'CI', 'completed', 'failure')] : [];
  });
  const { ctx } = ciCtx(r.root, gh, { ci: 'github' });
  ctx.deps.git = r.git;
  onGithub(ctx);
  requestPush({ root: r.root, phase: '3', settings: ctx.config.push, git: r.git });
  await pushTick(ctx, later(1));
  assert.equal(readInbox(r.root, '3')[0].sha, old, 'the older push\'s red result reached the inbox');
  assert.equal(r.remoteHead(), sha);
  const rec = readJson(recordFile(r.root, '3'));
  assert.deepEqual([rec.sha, rec.lastPush.ci.state], [sha, 'pending']);
  assert.equal(readJson(recordFile(r.root, '2')).lastPush.ci.state, 'superseded');
});

test('a run name with a secret is masked in the push record, the supervisor log, the notification and the inbox', async () => {
  const root = project();
  pendingRecord(root);
  const { gh } = ghScript((args) => (args[1] === 'view' ? '' : [runRow(9, `deploy ${GH}`, 'completed', 'failure')]));
  const { ctx, notes } = ciCtx(root, gh);
  const logs = [];
  ctx.deps.log = (l) => logs.push(l);
  await pushTick(ctx, later(1));
  const all = [fs.readFileSync(recordFile(root, '3'), 'utf8'), fs.readFileSync(inboxFile(root, '3'), 'utf8'), JSON.stringify(notes), logs.join('\n')].join('\n');
  assert.ok(!all.includes(GH), all);
  assert.equal(notes[0].vars.runs, 'deploy [secret] (failure)');
});

test('a git call that times out while the supervisor handles a request fails that request once: recorded, notified, not retried', async () => {
  const r = pushRepo();
  const { ctx, calls, notes } = supervisorCtx(r);
  const inner = ctx.deps.git;
  ctx.deps.git = (args, opts) => {
    if (args[0] === 'log' && args.includes('-p')) {
      calls.push(args);
      throw Object.assign(new Error('timed out after 60 s'), { status: null });
    }
    return inner(args, opts);
  };
  const sha = r.commit('src/a.mjs', 'export const a = 1;\n');
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  const rec = readJson(recordFile(r.root, '3'));
  assert.deepEqual([rec.outcome, rec.reason, rec.branch, rec.sha], ['failed', 'the secret scan failed: timed out after 60 s', 'main', sha]);
  assert.deepEqual(notes, [{ key: 'pushFailed', vars: { phase: '3', error: 'the secret scan failed: timed out after 60 s' } }]);
  // what a waiting push-request --wait prints: the real cause, not "the supervisor has not taken this request"
  assert.equal(describeRecord(rec).line, 'failed: the secret scan failed: timed out after 60 s');
  const n = calls.length;
  await pushTick(ctx, NOW);
  assert.equal(calls.length, n, 'the failed request is not tried again');
  assert.equal(notes.length, 1);
});

test('a tick starts no new push or CI work once its time budget is used; a watch it skipped goes first in the next tick', async () => {
  const root = project();
  for (const p of ['2', '3', '4']) pendingRecord(root, p, p.repeat(40));
  writeJsonAtomic(requestFile(root, '9'), { id: 'r9', phase: '9', head: 'f'.repeat(40), at: NOW.toISOString() });
  // a fake clock: every gh call takes 90 s
  let t = NOW.getTime();
  const { gh, calls } = ghScript(() => {
    t += 90 * 1000;
    return [runRow(1, 'CI', 'in_progress')];
  });
  const { ctx } = ciCtx(root, gh);
  const logs = [];
  ctx.deps.log = (l) => logs.push(l);
  ctx.deps.now = () => new Date(t);
  await pushTick(ctx, later(1));
  assert.deepEqual(calls.map((a) => a[3][0]), ['2', '3'], 'the third watch is not started after 180 s');
  assert.ok(!fs.existsSync(recordFile(root, '9')), 'no request is started after the budget');
  assert.ok(logs.some((l) => /budget/.test(l)), logs.join('\n'));
  await pushTick(ctx, later(2));
  assert.deepEqual(calls.map((a) => a[3][0]), ['2', '3', '4', '2'], 'the skipped watch goes first');
});

test('a refused request keeps the CI watch of the last push, whose red result still reaches the inbox', async () => {
  const r = pushRepo();
  const { ctx, notes } = supervisorCtx(r, { ci: 'github' });
  onGithub(ctx);
  let red = false;
  ctx.deps.gh = (args) => (args[1] === 'view' ? 'test\tRun\t2026-10-10T10:00:00Z boom' : JSON.stringify([runRow(5, 'CI', red ? 'completed' : 'in_progress', red ? 'failure' : '')]));
  const pushed = r.commit('src/a.mjs', 'export const a = 1;\n');
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  r.commit('src/conf.mjs', `export const t = '${GH}';\n`);
  ask(r, ctx.config.push);
  await pushTick(ctx, later(1));
  let rec = readJson(recordFile(r.root, '3'));
  assert.deepEqual([rec.outcome, rec.lastPush?.sha, rec.lastPush?.ci?.state], ['refused', pushed, 'pending']);
  red = true;
  await pushTick(ctx, later(2));
  rec = readJson(recordFile(r.root, '3'));
  assert.deepEqual([rec.outcome, rec.lastPush.ci.state], ['refused', 'red']);
  assert.equal(readInbox(r.root, '3')[0].sha, pushed);
  assert.deepEqual(notes.map((n) => n.key), ['pushRefused', 'ciRed']);
});

test('CI runs are read from the repository of push.remote; a remote not on GitHub counts as no CI and is told once', async () => {
  const reason = 'remote origin is not a GitHub repository, so CI is not watched';
  const r = pushRepo();
  const { ctx, notes } = supervisorCtx(r, { ci: 'github' });
  r.commit('src/a.mjs', 'export const a = 1;\n');
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  const rec = readJson(recordFile(r.root, '3'));
  assert.deepEqual(rec.lastPush.ci, { state: 'none', reason });
  assert.deepEqual(describeRecord(rec), { code: 0, line: `pushed ${rec.sha.slice(0, 7)} to origin/main · CI none (${reason})` });
  r.commit('src/b.mjs', 'export const b = 1;\n');
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  assert.deepEqual(notes, [{ key: 'ciUnavailable', vars: { phase: '3', reason } }]);
  // on GitHub: the watch names the repository for gh -R
  onGithub(ctx);
  r.commit('src/c.mjs', 'export const c = 1;\n');
  ask(r, { ...ctx.config.push });
  await pushTick(ctx, NOW);
  assert.equal(readJson(recordFile(r.root, '3')).lastPush.repo, 'acme/app');
});

test('gh missing or not logged in: that push counts as having no CI at once, and the owner is told once', async () => {
  const why = 'gh run list failed: the GitHub CLI (gh) is not installed or not on PATH';
  const root = project();
  pendingRecord(root, '3');
  pendingRecord(root, '4', 'd'.repeat(40));
  const { gh } = ghScript(() => Object.assign(new Error(why), { unavailable: true }));
  const { ctx, notes } = ciCtx(root, gh);
  await pushTick(ctx, later(1));
  for (const p of ['3', '4']) {
    const rec = readJson(recordFile(root, p));
    assert.deepEqual([rec.lastPush.ci.state, rec.lastPush.ci.reason], ['none', `CI not watched: ${why}`]);
    assert.equal(describeRecord(rec).code, 0, 'a waiting push-request returns at once');
  }
  assert.deepEqual(notes, [{ key: 'ciUnavailable', vars: { phase: '3', reason: `CI not watched: ${why}` } }]);
});

test('every run cancelled is CI cancelled, not green: nothing notified, a waiting push-request ends with exit 1', async () => {
  const root = project();
  pendingRecord(root);
  const { ctx, notes } = ciCtx(root, ghScript(() => [runRow(1, 'CI', 'completed', 'cancelled')]).gh);
  await pushTick(ctx, later(1));
  const rec = readJson(recordFile(root, '3'));
  assert.equal(rec.lastPush.ci.state, 'cancelled');
  assert.equal(describeRecord(rec).code, 1);
  assert.deepEqual(notes, []);
});

test('a request whose tick ran out of time waits before its scan, goes on first in the next tick, and the heartbeat is kept between steps', async () => {
  const r = pushRepo();
  const { ctx, notes } = supervisorCtx(r);
  let t = NOW.getTime();
  ctx.deps.now = () => new Date(t);
  const beats = [];
  ctx.deps.heartbeat = () => beats.push(t);
  const inner = ctx.deps.git;
  // every fetch takes 150 s: more than the tick's budget
  ctx.deps.git = (args, opts) => {
    if (sub(args) === 'fetch') t += 150 * 1000;
    return inner(args, opts);
  };
  const sha = r.commit('src/a.mjs', 'export const a = 1;\n');
  ask(r, ctx.config.push);
  await pushTick(ctx, NOW);
  assert.notEqual(r.remoteHead(), sha, 'nothing started after the budget');
  assert.equal(readJson(recordFile(r.root, '3')).deferred.requestId, readJson(requestFile(r.root, '3')).id);
  const before = beats.length;
  await pushTick(ctx, later(5));
  assert.equal(r.remoteHead(), sha, 'the deferred request finishes in the next tick, budget or not');
  assert.ok(beats.length - before >= 3, `a heartbeat before the fetch, the scan and the push: ${beats.length - before}`);
  assert.deepEqual(notes, []);
});

test('without a fresh heartbeat each git call\'s time limit ends inside the heartbeat window', async () => {
  const r = pushRepo();
  const { ctx } = supervisorCtx(r);
  let t = NOW.getTime();
  ctx.deps.now = () => new Date(t);
  const limits = {};
  const inner = ctx.deps.git;
  ctx.deps.git = (args, opts = {}) => {
    limits[sub(args)] = opts.timeout;
    if (sub(args) === 'fetch') t += 6 * 60 * 1000; // a fetch that took 6 minutes
    return inner(args, opts);
  };
  r.commit('src/a.mjs', 'export const a = 1;\n');
  const { request } = ask(r, ctx.config.push);
  // already deferred once: no budget check stops it
  writeJsonAtomic(recordFile(r.root, '3'), { deferred: { requestId: request.id, at: NOW.toISOString() } });
  await pushTick(ctx, NOW);
  // 10 min window - 6 min spent - 30 s margin
  assert.equal(limits.push, 210000);
  assert.equal(limits.fetch, 120000);
});
