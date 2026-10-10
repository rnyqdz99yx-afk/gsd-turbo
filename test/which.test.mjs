import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whichAbsolute } from '../lib/which.mjs';

test('a program is found only in absolute PATH directories outside the project: never the project, a relative or an empty entry (POSIX)', () => {
  const files = new Set(['/proj/git', '/proj/bin/git', 'bin/git', '/usr/local/bin/git', '/usr/bin/git']);
  const exists = (f) => files.has(f);
  assert.equal(whichAbsolute('git', { env: { PATH: ':.:bin:/proj:/proj/bin:/usr/local/bin:/usr/bin' }, platform: 'linux', exclude: ['/proj'], exists }), '/usr/local/bin/git');
  assert.equal(whichAbsolute('git', { env: { PATH: '/opt:/srv' }, platform: 'linux', exists }), null);
  assert.equal(whichAbsolute('git', { env: {}, platform: 'linux', exists }), null);
});

test('on Windows the program is <name>.exe in an absolute PATH directory outside the project, compared without case; Path is read as PATH', () => {
  const files = new Set(['C:\\work\\git.exe', 'C:\\work\\tools\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', '\\\\srv\\share\\git.exe']);
  const exists = (f) => files.has(f);
  const env = { Path: '.;;tools;C:\\work;C:\\work\\tools;"C:\\Program Files\\Git\\cmd";\\\\srv\\share' };
  assert.equal(whichAbsolute('git', { env, platform: 'win32', exclude: ['c:\\WORK'], exists }), 'C:\\Program Files\\Git\\cmd\\git.exe');
  assert.equal(whichAbsolute('git', { env: { PATH: '\\\\srv\\share' }, platform: 'win32', exists }), '\\\\srv\\share\\git.exe');
  assert.equal(whichAbsolute('git', { env: { PATH: '\\rooted;relative' }, platform: 'win32', exists: () => true }), null, 'a drive-relative or relative entry is never used');
});
