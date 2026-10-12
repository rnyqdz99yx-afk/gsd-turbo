import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASK, SECRET_RULES, maskSecrets } from '../lib/secrets.mjs';
import { scanSecrets } from '../lib/uat.mjs';

// One sample per rule, built at run time so the source holds no token-shaped literal.
const SAMPLES = {
  'private key': `-----BEGIN RSA ${'PRIVATE'} KEY-----`,
  'aws access key': `AKIA${'ABCDEFGHIJKLMNOP'}`,
  'github token': `ghp_${'a'.repeat(36)}`,
  'slack token': `xoxb-${'1234567890'}-abc`,
  'api key': `sk-${'A'.repeat(24)}`,
  jwt: `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`,
  'bot token': `123456789:${'A'.repeat(35)}`,
  'bearer token': `Bearer ${'x'.repeat(24)}`,
  'credential assignment': `${'pass'}word=${'hunter2'.repeat(2)}`,
};

test('every secret rule has a sample, and maskSecrets replaces each match of each rule', () => {
  assert.deepEqual(SECRET_RULES.map(([rule]) => rule).sort(), Object.keys(SAMPLES).sort());
  for (const [rule, value] of Object.entries(SAMPLES)) {
    const out = maskSecrets(`before ${value} after ${value} end`);
    assert.equal(out.includes(value), false, rule);
    assert.equal(out, `before ${MASK} after ${MASK} end`, rule);
  }
});

test('maskSecrets keeps plain text and reads anything but a string as empty', () => {
  assert.equal(maskSecrets('Edit lib/x.mjs'), 'Edit lib/x.mjs');
  assert.equal(maskSecrets(undefined), '');
  assert.equal(maskSecrets(42), '');
});

test('the UAT scan still uses the shared rules', () => {
  const f = scanSecrets(['ok', SAMPLES['github token']].join('\n'));
  assert.deepEqual(f, [{ rule: 'github token', line: 2 }]);
});

const CRED = SECRET_RULES.find(([rule]) => rule === 'credential assignment')[1];

test('credential assignment: prose with pass: or PASS: is not a finding', () => {
  const prose = [
    'prints `PASS: dry-run complete (a -> b-before)`',
    '(third pass: re-review of the fixes)',
    'the targeted tests pass: `node --test test/a.test.mjs`',
    'PASS: 14/14 checks',
    'pass: all-green-today',
    'PASS:14/14',
    'a first-pass: re-review-later',
  ];
  for (const line of prose) assert.equal(CRED.test(line), false, line);
});

test('credential assignment: real assignments still match, identifier-shaped keys included, and the value is masked', () => {
  const v = 'hunter2'.repeat(2);
  const hits = [
    `password=${v}`, `"pass": "${v}"`, `'pass' = '${v}'`, `pass=${v}`, `DB_PASS: ${v}`, `smtp_pass=${v}`,
    `DB_PASSWORD=${v}`, `GITHUB_TOKEN=${v}`, `client.secret: ${v}`, `my-api-key: ${v}`, `api_key: "${v}"`, `secret: ${v}`,
    // a bare pass in config: indented YAML, an object literal, a spaced =, a dotted key, no space after the colon
    `  pass: ${v}`, `auth: { user: 'u', pass: '${v}' }`, `pass = '${v}'`, `PASS = ${v}`, `smtp.pass: ${v}`, `pass:${v}`,
  ];
  for (const line of hits) {
    assert.equal(CRED.test(line), true, line);
    assert.equal(maskSecrets(line).includes(v), false, line);
  }
});
