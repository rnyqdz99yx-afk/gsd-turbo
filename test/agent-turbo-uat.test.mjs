import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('turbo-uat agent: frontmatter, safety rules and the CLI it drives', () => {
  const s = fs.readFileSync('agents/turbo-uat.md', 'utf8');
  assert.match(s, /^---\nname: turbo-uat\ndescription: .+\n---\n/);
  const needles = [
    'node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs"',
    'turbo-run uat plan N', 'turbo-run uat stand N prepare', 'turbo-run uat stand N cleanup', 'turbo-run uat net-check N', 'turbo-run uat record N',
    'loopback', 'forbidden_hosts', 'DATA_DIR', 'TURBO_UAT_CREDS', 'Never print', 'secret-scan', 'finalClass', 'never lower', 'Never commit', 'Never spawn',
  ];
  for (const n of needles) assert.ok(s.includes(n), n);
  assert.ok(!/gsd-turbo-/.test(s));
});
