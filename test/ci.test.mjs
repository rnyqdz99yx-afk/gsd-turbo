import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGh, parseRuns, ciVerdict, failedLogTail, githubRepo, RED_CONCLUSIONS } from '../lib/ci.mjs';

const GH = `ghp_${'a1B2'.repeat(9)}`;

test('createGh runs gh by name with an argument array, no shell and no prompt; its errors are one masked line', () => {
  const calls = [];
  const gh = createGh('/proj', { exec: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return '[]'; }, env: { KEEP: '1' } });
  assert.equal(gh(['run', 'list', '--commit', 'abc']), '[]');
  const c = calls[0];
  assert.deepEqual([c.cmd, c.args, c.opts.cwd, c.opts.shell, c.opts.timeout, c.opts.env.KEEP, c.opts.env.GH_PROMPT_DISABLED], ['gh', ['run', 'list', '--commit', 'abc'], '/proj', undefined, 60000, '1', '1']);
  const denied = createGh('/proj', { exec: () => { throw Object.assign(new Error(`Command failed: gh run view 7 ${GH}`), { status: 1, stderr: `HTTP 401: Bad credentials (token ${GH})\n` }); } });
  assert.throws(() => denied(['run', 'view', '7']), (e) => e.message === 'gh run view failed: HTTP 401: Bad credentials (token [secret])');
  const hung = createGh('/proj', { exec: () => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }); } });
  assert.throws(() => hung(['run', 'list']), (e) => e.message === 'gh run list failed: timed out after 60 s');
});

test('parseRuns reads gh run list JSON and refuses any other shape', () => {
  const text = JSON.stringify([{ databaseId: 11, name: 'CI', status: 'completed', conclusion: 'success' }, { databaseId: 12, name: 'Lint', status: 'in_progress', conclusion: '' }]);
  assert.deepEqual(parseRuns(text), [{ id: 11, name: 'CI', status: 'completed', conclusion: 'success' }, { id: 12, name: 'Lint', status: 'in_progress', conclusion: '' }]);
  assert.deepEqual(parseRuns('[]'), []);
  for (const bad of ['', 'nope', '{}', '[1]', '[{"name":"x","status":"completed"}]', '[{"databaseId":"1","status":"completed"}]']) {
    assert.throws(() => parseRuns(bad), Error, bad);
  }
});

test('ciVerdict: pending until every run completed; red only for failure, timed_out or startup_failure', () => {
  const run = (status, conclusion = '') => ({ id: 1, name: 'x', status, conclusion });
  assert.equal(ciVerdict([]), 'pending');
  assert.equal(ciVerdict([run('completed', 'failure'), run('queued')]), 'pending');
  assert.equal(ciVerdict([run('completed', 'success'), run('completed', 'skipped')]), 'green');
  for (const c of ['cancelled', 'neutral', 'action_required', 'stale']) assert.equal(ciVerdict([run('completed', 'success'), run('completed', c)]), 'green', c);
  for (const c of RED_CONCLUSIONS) assert.equal(ciVerdict([run('completed', 'success'), run('completed', c)]), 'red', c);
  // nothing passed: every run cancelled (a skipped one beside it changes nothing) is neither green nor red
  assert.equal(ciVerdict([run('completed', 'cancelled')]), 'cancelled');
  assert.equal(ciVerdict([run('completed', 'cancelled'), run('completed', 'skipped')]), 'cancelled');
  assert.equal(ciVerdict([run('completed', 'cancelled'), run('completed', 'failure')]), 'red');
});

test('failedLogTail masks every line of a private key block in the log, and parseRuns strips control characters from names', () => {
  const begin = `-----BEGIN ${'OPENSSH PRIVATE'} KEY-----`;
  const end = `-----END ${'OPENSSH PRIVATE'} KEY-----`;
  const at = (i, text) => `test\tRun\t2026-10-10T10:00:0${i}.0000000Z ${text}`;
  const r = failedLogTail([at(0, 'start'), at(1, begin), at(2, 'b3BlbnNzaC1rZXktdjEAAAAA'), at(3, 'AAAABG5vbmUAAAAEbm9uZQ'), at(4, end), at(5, 'done')].join('\n'));
  assert.deepEqual(r.tail, ['start', '[secret]', '[secret]', '[secret]', '[secret]', 'done']);
  const [run] = parseRuns(JSON.stringify([{ databaseId: 1, name: 'CI\x1b[31m\r\nfake line\x07', status: 'completed', conclusion: 'success' }]));
  assert.equal(run.name, 'CI[31mfake line');
});

test('failedLogTail keeps the last 200 lines, the failing job and step, and no colour codes or secrets', () => {
  const lines = [];
  for (let i = 1; i <= 250; i++) lines.push(`test\tRun npm test\t2026-10-10T10:00:${String(i % 60).padStart(2, '0')}.1234567Z \x1b[31mline ${i}\x1b[0m`);
  lines.push(`test\tRun npm test\t2026-10-10T10:05:00.0000000Z token=${GH}`);
  lines.push(`test\tRun npm test\t2026-10-10T10:05:01.0000000Z ${'x'.repeat(1000)}`);
  const r = failedLogTail(lines.join('\r\n'));
  assert.equal(r.job, 'test');
  assert.equal(r.step, 'Run npm test');
  assert.equal(r.tail.length, 200);
  assert.equal(r.tail[0], 'line 53');
  assert.ok(r.tail.every((l) => !l.includes('\x1b') && !l.includes(GH)));
  assert.equal(r.tail.at(-2), '[secret]');
  assert.equal(r.tail.at(-1).length, 400);
  assert.deepEqual(failedLogTail(''), { job: '', step: '', tail: [] });
});

test('parseRuns masks every text gh prints for a run (S2: all gh output is masked)', () => {
  const text = JSON.stringify([{ databaseId: 1, name: `deploy ${GH}`, status: 'completed', conclusion: 'failure' }]);
  assert.deepEqual(parseRuns(text), [{ id: 1, name: 'deploy [secret]', status: 'completed', conclusion: 'failure' }]);
});

test('githubRepo reads owner/repo from the GitHub URL forms git prints, and nothing else', () => {
  const cases = {
    'https://github.com/acme/app.git': 'acme/app',
    'https://github.com/acme/app': 'acme/app',
    'https://x-access@github.com/acme/app.git': 'acme/app',
    'HTTPS://GitHub.com/acme/app.git/': 'acme/app',
    'git@github.com:acme/app.git': 'acme/app',
    'ssh://git@github.com/acme/app.git': 'acme/app',
    'ssh://git@github.com:22/acme/my.app': 'acme/my.app',
  };
  for (const [url, repo] of Object.entries(cases)) assert.equal(githubRepo(url), repo, url);
  for (const url of ['https://gitlab.com/acme/app.git', '/srv/git/app.git', 'https://github.com.evil.test/acme/app', 'https://github.com/acme', 'file:///tmp/x', '']) {
    assert.equal(githubRepo(url), null, url);
  }
});

test('createGh marks a missing gh or a missing login as unavailable, other failures not', () => {
  const fail = (err) => {
    try {
      createGh('/p', { exec: () => { throw err; } })(['run', 'list']);
    } catch (e) {
      return e;
    }
    return null;
  };
  const missing = fail(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
  assert.deepEqual([missing.unavailable, missing.message], [true, 'gh run list failed: the GitHub CLI (gh) is not installed or not on PATH']);
  assert.equal(fail(Object.assign(new Error('x'), { status: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' })).unavailable, true);
  assert.equal(fail(Object.assign(new Error('x'), { status: 1, stderr: 'HTTP 502: Bad Gateway\n' })).unavailable, undefined);
});
