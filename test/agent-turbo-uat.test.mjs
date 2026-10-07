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

test('turbo-uat agent: owner-only list, refusal handling, isolation and record order', () => {
  const s = fs.readFileSync('agents/turbo-uat.md', 'utf8');
  const needles = [
    'D for real money, a signature or legal review, private/offline keys, 2FA, an owner\'s decision, and under `standard` autonomy any deploy or production write',
    'C for production reads, third-party platforms, the owner\'s accounts, devices or phones, desktop apps, and email/SMS delivery',
    '`uat.base_url` is one of `uat.forbidden_hosts`', '`stand.reason` exactly as printed', 'stop and reply with its error',
    'fresh, empty profile', 'no isolated browser', 'no isolated data dir', 'every A and B item needs a non-empty request log', 'no requests logged',
    'Never edit the UAT file', 'new record line', 'At most 3 record attempts', 'live part, split from test',
    'Record before cleanup', 'only after step 4', '.planning/turbo/run/uat-pN/',
    'the value never reaches command output, evidence or your reply', 'when unsure between C and D, D',
    'A proposal may raise A, B, `null` or C to D', 'only a Node Playwright script', '`chromium.launch()` and `browser.newContext()`',
    'Never use a browser MCP tool for stand checks', 'B items checked over HTTP or sockets still run',
    'capture clean evidence again or record that item `deferred` C', 'A refusal is atomic', 'the whole results array',
    'an `owner` D entry stays `owner` D, never `deferred` C',
  ];
  for (const n of needles) assert.ok(s.includes(n), n);
  assert.ok(!s.includes('playwright-mcp'), 'the agent never names the MCP harness');
});
