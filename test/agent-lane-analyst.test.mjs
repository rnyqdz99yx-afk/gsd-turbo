import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GATE_NAMES as GATES } from '../lib/config.mjs';
import { validateAnalysis } from '../lib/annotate.mjs';

const FILE = 'agents/turbo-lane-analyst.md';

test('turbo-lane-analyst: frontmatter, its limits, the rules of each field', () => {
  const s = fs.readFileSync(FILE, 'utf8');
  assert.match(s, /^---\nname: turbo-lane-analyst\ndescription: .+\ntools: Read, Grep, Glob, Bash, Write\n---\n/);
  const needles = [
    'Never write any file but the analysis file', 'Never commit', 'Never spawn other agents', 'Never add a dependency',
    '`analysisFile`', '`targets`', '`others`', '`filesModified`', '`lang`',
    '`*` matches within one path segment', '`**` any number of segments', 'no `{a,b}` braces', 'never `.planning/**`', 'Err broad',
    '`high`', '`low`', 'counts the phase as everything', ...GATES.map((g) => `\`${g}\``),
    '`conflict`', '`ok`', 'declared dependencies are checked by the scheduler itself',
    '`prose`', '`imaginary`', 'Must land before Phase 28', 'Nothing (independent of Phase 1)', 'turbo-run annotate apply checks all of it',
  ];
  for (const n of needles) assert.ok(s.includes(n), n);
  assert.ok(!/gsd-turbo-/.test(s));
});

test('the analysis example in the agent file passes the validation it describes', () => {
  const s = fs.readFileSync(FILE, 'utf8');
  const json = /```json\n([\s\S]*?)\n```/.exec(s)[1];
  const problems = validateAnalysis(JSON.parse(json), { targets: ['2', '3'], unfinished: ['2', '3'], gates: [...GATES], deps: new Map([['2', []], ['3', ['2']]]) });
  assert.deepEqual(problems, []);
});
