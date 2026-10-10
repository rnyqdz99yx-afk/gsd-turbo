import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGh, parseRuns, ciVerdict, failedLogTail, RED_CONCLUSIONS } from '../lib/ci.mjs';

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
