export const HEAD = '0123456789abcdef0123456789abcdef01234567';
// The shape execute-phase Step A persists (G9) plus one row the owner already answered.
export const UAT = [
  '---', 'status: testing', 'phase: 03-demo', 'source: [03-VERIFICATION.md]', 'started: 2026-01-01T00:00:00Z', 'updated: 2026-01-01T00:00:00Z', '---', '',
  '## Current Test', '', 'number: 1', 'name: Settings page shows the saved value', 'expected: |', '  the value persists after reload', 'awaiting: user response', '',
  '## Tests', '',
  '### 1. Settings page shows the saved value', 'expected: the value persists after reload', 'result: [pending]', '',
  '### 2. Owner signs the release', 'expected: the release is signed', 'result: [pending]', '',
  '### 3. Page shows the code and an SMS arrives on the phone', 'expected: the code is visible', 'result: [pending]', '',
  '### 4. Export button downloads a CSV', 'expected: |', '  a CSV file downloads', 'result: [pending]', '',
  '### 5. Already answered by the owner', 'expected: x', 'result: pass', '',
  '## Summary', '', 'total: 5', 'passed: 1', 'issues: 0', 'pending: 4', 'skipped: 0', 'blocked: 0', '',
  '## Gaps', '',
].join('\n');
