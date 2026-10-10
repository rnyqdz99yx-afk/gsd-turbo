import path from 'node:path';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { openQuestions } from './view.mjs';

// The owner's side of a supervisor tick (spec §5.2, §5.3, §10): questionsReady once per phase for the open questions
// not notified before. A question reopened at a stop has a new rev and is notified again. S1b adds Telegram here.
// The caller logs a failure; it never fails the lane's tick.
const NOTIFIED = 'questions-notified.json';
const LIST_MAX = 3;
const cut = (s, n) => [...String(s ?? '')].slice(0, n).join('');
const keyOf = (q) => `${q.phase}:${q.id}:${q.rev || 1}`;

export async function ownerTick(ctx, now, state = {}) {
  const { root, deps } = ctx;
  const open = openQuestions(root);
  const file = path.join(runDir(root), NOTIFIED);
  const before = readJson(file, null);
  if (!open.length && !before) return;
  const seen = new Set(Array.isArray(before?.keys) ? before.keys : []);
  const keys = new Set(open.map(keyOf).filter((k) => seen.has(k)));
  const fresh = new Map();
  for (const q of open) if (!seen.has(keyOf(q))) fresh.set(q.phase, [...(fresh.get(q.phase) || []), q]);
  for (const [phase, list] of fresh) {
    await deps.notify('questionsReady', { phase, n: list.length, list: list.slice(0, LIST_MAX).map((q) => `${q.header}: ${cut(q.question, 80)}`).join('; ') });
    for (const q of list) keys.add(keyOf(q));
  }
  const next = [...keys].sort();
  if (JSON.stringify(next) !== JSON.stringify(before?.keys ?? [])) writeJsonAtomic(file, { keys: next });
}
