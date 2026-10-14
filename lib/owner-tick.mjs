import path from 'node:path';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { openQuestions } from './view.mjs';
import { telegramTick } from './telegram.mjs';
import { attendedPhases } from './attend.mjs';
import { autoTick } from './auto-answer.mjs';

// The owner's side of a supervisor tick (spec §5.2, §5.3, §10): questionsReady once per phase for the open questions
// not notified before, then the Telegram answers (S1b). A question reopened at a stop has a new rev and is notified
// again. The caller logs a failure; it never fails the lane's tick.
const NOTIFIED = 'questions-notified.json';
const LIST_MAX = 3;
const ITEM_MAX = 80;
const QUESTION_MAX = 300;
const cut = (s, n) => [...String(s ?? '')].slice(0, n).join('');
const keyOf = (q) => `${q.phase}:${q.id}:${q.rev || 1}`;

export async function ownerTick(ctx, now, state = {}) {
  let open = openQuestions(ctx.root);
  // a failed notification (its record not written, say) never skips Telegram; it is reported after it
  let failed = null;
  try {
    await notifyNew(ctx, open);
  } catch (err) {
    failed = err;
  }
  // v0.4.0: a safe question left unanswered for owner.auto_answer_minutes takes its recommended option (by auto); a
  // failure there (a bad config value) is logged, and nothing is answered
  try {
    const held = attendedPhases(ctx.root).length > 0;
    if ((await autoTick(ctx, now, { laneRunning: Boolean(state?.lane) && !held })).length) open = openQuestions(ctx.root);
  } catch (err) {
    ctx.deps.log(`auto-answer: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
  }
  // spec §5.3 (S1b): answers by Telegram; a failure there is logged and leaves everything above done
  try {
    // spec §8 (S4): while a phase is attended the owner answers in their own session; presses and replies wait in
    // Telegram until the hand-back, as when attend stopped the daemon (the questions are rebuilt by then)
    const held = attendedPhases(ctx.root).length > 0;
    await telegramTick(ctx, now, { laneRunning: Boolean(state?.lane) && !held, open, answers: !held });
  } catch (err) {
    ctx.deps.log(`telegram: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
  }
  if (failed) throw failed;
}

async function notifyNew({ root, deps }, open) {
  const file = path.join(runDir(root), NOTIFIED);
  const before = readJson(file, null);
  if (!open.length && !before) return;
  const seen = new Set(Array.isArray(before?.keys) ? before.keys : []);
  const keys = new Set(open.map(keyOf).filter((k) => seen.has(k)));
  const fresh = new Map();
  for (const q of open) if (!seen.has(keyOf(q))) fresh.set(q.phase, [...(fresh.get(q.phase) || []), q]);
  for (const [phase, list] of fresh) {
    // a lane's own question (v0.3.3) has no plan and no header: its plain question alone, whole when it is the only one
    const max = list.length === 1 ? QUESTION_MAX : ITEM_MAX;
    const where = (q) => (q.plan && q.task ? `${q.plan} T${q.task}: ` : q.header ? `${q.header}: ` : '');
    await deps.notify('questionsReady', { phase, n: list.length, list: list.slice(0, LIST_MAX).map((q) => `${where(q)}${cut(q.question, max)}`).join('; ') });
    for (const q of list) keys.add(keyOf(q));
  }
  const next = [...keys].sort();
  if (JSON.stringify(next) !== JSON.stringify(before?.keys ?? [])) writeJsonAtomic(file, { keys: next });
}
