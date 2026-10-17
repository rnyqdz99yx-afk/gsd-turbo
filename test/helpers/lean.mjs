import { createHash } from 'node:crypto';

// Stage 6 L2: a skill's lean text is its `## Lean mode` section and its one-line **Lean:** bullets. Stripped, the skill
// must be stage-5's text byte for byte (the lean-off golden).
export const LEAN_LINE = /^\s*(?:[-*]\s+|\d+\.\s+)?\*\*Lean\b/;

export function stripLean(text) {
  let s = String(text).replace(/\r\n/g, '\n');
  const at = s.indexOf('\n## Lean mode\n');
  if (at >= 0) {
    const end = s.indexOf('\n## ', at + 1);
    s = s.slice(0, at) + (end < 0 ? '' : s.slice(end));
  }
  return s.split('\n').filter((l) => !LEAN_LINE.test(l)).join('\n');
}

export const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
