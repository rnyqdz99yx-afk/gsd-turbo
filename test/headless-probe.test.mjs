import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { probeArgs, PROBE_ITEMS } from '../scripts/headless-probe.mjs';
import { buildHeadlessArgs } from '../lib/headless.mjs';

test('the probe dry run lists P1–P9 with the module argv and runs no claude', () => {
  const out = execFileSync(process.execPath, ['scripts/headless-probe.mjs', '--dry-run'], { encoding: 'utf8', windowsHide: true });
  const lines = out.trim().split(/\r?\n/);
  assert.deepEqual(lines.map((l) => l.split(' ')[0]), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9']);
  for (const l of lines.filter((l) => !/^P[26] /.test(l))) assert.match(l, /-p --output-format stream-json --verbose --model opus/);
  assert.match(lines[2], /--agent gsd-code-reviewer/);
  assert.match(lines[4], /--resume <session>/);
  assert.match(lines[8], /--append-system-prompt-file/);
});

test('the probe launches the module\'s own argv', () => {
  assert.equal(PROBE_ITEMS.length, 9);
  assert.deepEqual(probeArgs('P1', { settingsFile: 'S' }), buildHeadlessArgs({ effort: 'low', settingsFile: 'S' }));
  assert.deepEqual(probeArgs('P5', { settingsFile: 'S', session: 'abc' }), buildHeadlessArgs({ effort: 'low', settingsFile: 'S', resume: 'abc' }));
  assert.equal(probeArgs('P2', { settingsFile: 'S' })[probeArgs('P2', { settingsFile: 'S' }).indexOf('--effort') + 1], 'bogus');
  assert.deepEqual(probeArgs('P7', { settingsFile: 'S' }).slice(-1), ['--include-hook-events']);
});
