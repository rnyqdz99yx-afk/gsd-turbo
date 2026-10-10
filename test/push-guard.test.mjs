import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskOutput, forbiddenName } from '../lib/push-guard.mjs';

// built at run time: no token-shaped literal in this file
const GH = `ghp_${'a1B2'.repeat(9)}`;
const AWS = `AKIA${'Q'.repeat(16)}`;

test('maskOutput masks the shared rules and URL credentials, never keeps the value, and changes nothing twice', () => {
  const text = [`token ${GH} here`, `aws ${AWS}`, 'password=hunter2hunter2', "fatal: unable to access 'https://bob:s3cretpw@example.com/x.git/'", 'plain line'].join('\n');
  const m = maskOutput(text);
  for (const v of [GH, AWS, 'hunter2hunter2', 's3cretpw', 'bob:']) assert.ok(!m.includes(v), v);
  assert.equal(m, ['token [secret] here', 'aws [secret]', '[secret]', "fatal: unable to access 'https://[secret]@example.com/x.git/'", 'plain line'].join('\n'));
  assert.equal(maskOutput(m), m);
  assert.equal(maskOutput(undefined), '');
  assert.equal(maskOutput(401), '401');
});

test('forbiddenName matches the spec list by base name, any case; ordinary files pass', () => {
  const cases = {
    '.env': '.env*', 'app/.env.local': '.env*', 'x/bot.session': '*.session', 'data/app.DB': '*.db', 'a.sqlite': '*.sqlite',
    'logs/run.log': '*.log', 'cfg/Accounts.json': 'accounts.json', 'certs/site.pem': '*.pem', 'id.key': '*.key',
  };
  for (const [file, glob] of Object.entries(cases)) assert.equal(forbiddenName(file), `forbidden name ${glob}`, file);
  for (const file of ['README.md', 'lib/env.mjs', 'docs/catalog.md', 'src/keyboard.js', 'my-accounts.json.md', 'login.mjs', 'dbutil.js', '']) {
    assert.equal(forbiddenName(file), null, file);
  }
});

test('maskOutput masks a whole private key block, not only its first line, and a block cut off at the end', () => {
  // built at run time: no key header literal in this file
  const begin = `-----BEGIN ${'RSA PRIVATE'} KEY-----`;
  const end = `-----END ${'RSA PRIVATE'} KEY-----`;
  const body = ['MIIEowIBAAKCAQEA1b2c3d4e5f6', 'g7h8i9j0k1l2m3n4o5p6q7r8s9t0'];
  assert.equal(maskOutput(['before', begin, ...body, end, 'after'].join('\n')), ['before', '[secret]', 'after'].join('\n'));
  assert.equal(maskOutput(['before', begin, ...body].join('\n')), ['before', '[secret]'].join('\n'));
  for (const line of body) assert.ok(!maskOutput([begin, ...body].join('\n')).includes(line));
});
