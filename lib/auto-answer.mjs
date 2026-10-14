import { openQuestions } from './view.mjs';
import { attendedPhases } from './attend.mjs';
import { readAnswers, readQuestions, verifyCondition, withPhaseLock, writeQuestions } from './questions.mjs';
import { answerQuestion } from './answers.mjs';

// v0.4.0 (owner ruling 2026-10-14): an owner question left unanswered for owner.auto_answer_minutes is answered by
// turbo itself through its recommended option (by auto), for the safe questions only. The supervisor's owner tick runs
// autoTick; the owner takes an auto answer back with turbo-run answer N <id> --undo (answers.mjs undoAutoAnswer).

const errLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0];

// The safety net over a question's own words (its text, context, every option): what turbo never decides for the owner
// even when the plan recommends it. Letters around a word are no part of it (\p{L}), so "product" is no "prod",
// «продолжить» no «прод», "signal" no "sign" and «удалённый» no «удалить».
const W = (body) => new RegExp(`(?<!\\p{L})(?:${body})(?!\\p{L})`, 'iu');
export const DENY = Object.freeze([
  ['money', W('money|pay|pays|paid|payment|payments|billing|invoice|invoices|purchase|оплат\\p{L}*|плат[её]ж\\p{L}*|деньг\\p{L}*|денег')],
  ['account', W('account|accounts|log ?in|logins?|sign ?in|аккаунт\\p{L}*|логин\\p{L}*|войти|вход|входа|входе|входом')],
  ['deploy', W('deploy\\p{L}*|prod|production|прод|прода|проде|проду|продом|продакшн\\p{L}*|продакшен\\p{L}*|деплой\\p{L}*|деплое\\p{L}*|выкат\\p{L}*')],
  ['delete', W('delet\\p{L}*|wipe\\p{L}*|purge\\p{L}*|удал(?!ён|енн)\\p{L}*|стереть|сотри\\p{L}*')],
  ['sign', W('sign|signs|signed|signing|signature\\p{L}*|sign-off|подпис\\p{L}*')],
  ['password', W('password\\p{L}*|passwd|парол\\p{L}*')],
  ['live', W('live|жив\\p{L}*\\s+(?:провер|систем|сесси)\\p{L}*')],
]);

// The deny entry a question's words match ('<name> (<word>)'), or null.
export function denied(q) {
  const texts = [q?.question, q?.context, ...(Array.isArray(q?.options) ? q.options.flatMap((o) => [o?.label, o?.description]) : [])];
  for (const t of texts) {
    for (const [name, re] of DENY) {
      const m = re.exec(String(t ?? ''));
      if (m) return `${name} (${m[0]})`;
    }
  }
  return null;
}

// owner.auto_answer_minutes: a whole number of minutes, 0 off. Anything else stops the auto answers (the owner tick
// logs it): a typo never answers for the owner.
export function autoAnswerMinutes(config) {
  const v = config?.owner?.auto_answer_minutes === undefined ? 60 : config.owner.auto_answer_minutes;
  if (!Number.isInteger(v) || v < 0) throw new Error('invalid turbo config owner.auto_answer_minutes: must be a whole number of minutes, 0 to turn it off');
  return v;
}

// Which option turbo may take for an open question: { option (1-based), condition } or { skip: why }. Never a physical
// action, a blocking-human checkpoint, a lane question not marked autoOk, a question with any earlier record (an owner
// answer reopened at a stop, an undone auto answer), or one the deny list matches. A decision needs exactly one
// recommended option; a verification takes its accept option, under the plan's evidence condition at a stop (ahead the
// question carries it already).
export function autoChoice(q, records = [], lang = 'en') {
  const skip = (why) => ({ skip: why });
  if (q?.state !== 'open') return skip('not open');
  if (records.some((r) => r?.id === q.id)) return skip('answered before');
  if (q.kind === 'human-action') return skip('physical: only the owner can do it');
  if (q.gate === 'blocking-human') return skip('blocking-human checkpoint');
  if (q.source === 'lane' && q.autoOk !== true) return skip('lane question without autoOk');
  const options = Array.isArray(q.options) ? q.options : [];
  let k = 0;
  let condition = null;
  if (q.kind === 'decision') {
    const rec = options.map((o, i) => [o, i]).filter(([o]) => o?.recommended === true && !o.defer);
    if (rec.length !== 1 || options.filter((o) => o?.recommended === true).length !== 1) return skip('no single recommended option');
    k = rec[0][1] + 1;
  } else if (q.kind === 'human-verify') {
    k = options.findIndex((o) => o && !o.defer) + 1;
    if (!k) return skip('no accept option');
    if (!q.condition) condition = verifyCondition(lang);
  } else {
    return skip(`kind ${q.kind}`);
  }
  const deny = denied(q);
  if (deny) return skip(`deny list: ${deny}`);
  return { option: k, condition };
}

// The owner tick's part (spec §5.2, v0.4.0): stamps askedAt on an open question that has none (the clock starts when
// turbo first sees it), then answers every eligible question that waited the limit, through answerQuestion (the
// single arbiter: an answer that came meanwhile wins), and notifies each. Attended phases are the owner's. Returns the
// answers recorded: [{ phase, id, question, option, undo }].
export async function autoTick(ctx, now, { laneRunning = false } = {}) {
  const { root, config, deps } = ctx;
  const minutes = autoAnswerMinutes(config);
  if (!minutes) return [];
  const held = new Set(attendedPhases(root).map((a) => String(a.phase)));
  const phases = [...new Set(openQuestions(root).map((q) => String(q.phase)))].filter((p) => !held.has(p));
  const done = [];
  for (const phase of phases) {
    const due = withPhaseLock(root, phase, () => {
      const list = readQuestions(root, phase);
      const records = readAnswers(root, phase);
      const out = [];
      let stamped = false;
      for (const q of list) {
        if (q.state !== 'open') continue;
        const asked = Date.parse(q.askedAt);
        if (!Number.isFinite(asked)) {
          q.askedAt = now.toISOString();
          stamped = true;
          continue;
        }
        if (now.getTime() - asked < minutes * 60000) continue;
        const c = autoChoice(q, records, config?.lang);
        if (c.option) out.push({ id: q.id, rev: q.rev || 1, option: c.option, condition: c.condition, question: q.question, label: q.options[c.option - 1].label });
      }
      if (stamped) writeQuestions(root, phase, list);
      return out;
    });
    for (const d of due) {
      let r;
      try {
        r = answerQuestion({
          root, phase, id: d.id, option: d.option, by: 'auto', now, laneRunning, condition: d.condition, rev: d.rev,
          reason: `no answer for ${minutes} min: turbo took the recommended option of a safe question`,
          ...(deps.commitAnswers ? { commit: deps.commitAnswers } : {}),
        });
      } catch (err) {
        deps.log(`auto-answer ${phase} ${d.id}: ${errLine(err)}`);
        continue;
      }
      if (r.status !== 'recorded') continue;
      const item = { phase, id: d.id, question: d.question, option: d.label, undo: `turbo-run answer ${phase} ${d.id} --undo` };
      done.push(item);
      deps.log(`auto-answered ${phase} ${d.id}: option ${d.option}${r.commit ? ` · ${r.commit}` : ''}`);
      try {
        await deps.notify('autoAnswered', item);
      } catch (err) {
        deps.log(`auto-answer notification: ${errLine(err)}`);
      }
    }
  }
  return done;
}
