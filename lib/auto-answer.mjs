import { openQuestions } from './view.mjs';
import { attendedPhases } from './attend.mjs';
import { laneCwd, supervisorLanes } from './lanes-state.mjs';
import { pendingCard, planCheckpoints, questionId, readAnswers, readQuestions, verifyCondition, withPhaseLock, writeQuestions } from './questions.mjs';
import { answerQuestion } from './answers.mjs';

// v0.4.0 (owner ruling 2026-10-14): an owner question left unanswered for owner.auto_answer_minutes is answered by
// turbo itself through its recommended option (by auto), for the safe questions only. The supervisor's owner tick runs
// autoTick; the owner takes an auto answer back with turbo-run answer N <id> --undo (answers.mjs undoAutoAnswer).

const errLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0];

// The safety net over a question's words: the plan's own checkpoint text for a plan question (the owner card is cut
// and, in Russian, drops English sentences), the card for a lane question. What turbo never decides for the owner even
// when the plan recommends it. A word is matched whole (\p{L} around it), with the forms and prefixes listed, so
// "product" is no "prod", «продолжить» no «прод», "signal" no "sign" and «платформа» no «платить»; a false alarm only
// leaves the question to the owner.
const W = (body) => new RegExp(`(?<!\\p{L})(?:${body})(?!\\p{L})`, 'iu');
export const DENY = Object.freeze([
  ['money', W([
    'money', 'pay\\p{L}*', 'paid', 'billing', 'bill', 'invoice\\p{L}*', 'purchas\\p{L}*', 'buy\\p{L}*', 'bought', 'charg\\p{L}*', 'refund\\p{L}*', 'subscri\\p{L}*',
    '(?:за|о|у|вы|до|пере|не)?плат(?:а|у|ы|е|ой|ить|ите|им|ит|ят|ишь|ил|ила|ило|или|ёж\\p{L}*|еж\\p{L}*|н\\p{L}*)', 'оплат\\p{L}*',
    '(?:по|за|вы)?куп(?:ить|ите|им|ит|ка|ки|ку|кой|ок|ает|аем|ают|ать|ал|ала|ли)\\p{L}*', 'деньг\\p{L}*', 'денег', 'денежн\\p{L}*', 'подписк\\p{L}*',
  ].join('|'))],
  ['account', W([
    'account\\p{L}*', 'log[- ]?in\\p{L}*', 'log[- ]?on', 'sign[- ]?(?:in|up|on)', 'credential\\p{L}*', 'token\\p{L}*', '2fa', 'otp',
    'аккаунт\\p{L}*', 'учётн\\p{L}*\\s+запис\\p{L}*', 'учетн\\p{L}*\\s+запис\\p{L}*', '(?:за|раз|пере)?логин\\p{L}*', 'токен\\p{L}*',
    'войти', 'войдите', 'войдём', 'войдем', 'войдя', 'вход', 'входа', 'входе', 'входом', 'входить', 'входите', 'входи',
  ].join('|'))],
  ['deploy', W([
    '\\p{L}*deploy\\p{L}*', 'prod', 'production', 'releas\\p{L}*', 'publish\\p{L}*',
    'прод', 'прода', 'проде', 'проду', 'продом', 'продакшн\\p{L}*', 'продакшен\\p{L}*', '\\p{L}*депло\\p{L}*', 'выкат\\p{L}*', 'выкладк\\p{L}*', 'выложить',
    'релиз\\p{L}*', 'опубликова\\p{L}*', 'публикац\\p{L}*', 'публикова\\p{L}*',
  ].join('|'))],
  ['delete', W([
    '\\p{L}*delet\\p{L}*', 'wip(?:e|es|ed|ing)', 'purg\\p{L}*', 'drop\\p{L}*', 'truncat\\p{L}*', 'eras\\p{L}*', 'destroy\\p{L}*',
    'удал\\p{L}*', 'стереть', 'сотр\\p{L}*', 'стёр\\p{L}*', 'стер', 'уничтож\\p{L}*', 'снест\\p{L}*', 'снесите',
  ].join('|'))],
  ['sign', W(['sign', 'signs', 'signed', 'signing', 'signatur\\p{L}*', 'sign-off', 'подпи[сш]\\p{L}*'].join('|'))],
  ['password', W(['password\\p{L}*', 'passwd', 'passphrase\\p{L}*', 'secret\\p{L}*', 'парол\\p{L}*', 'секрет\\p{L}*'].join('|'))],
  ['live', W(['live', 'вживую', 'жив\\p{L}*\\s+(?:провер|систем|сесси|аккаунт|данн)\\p{L}*'].join('|'))],
]);

function deniedText(texts) {
  for (const t of texts) {
    for (const [name, re] of DENY) {
      const m = re.exec(String(t ?? ''));
      if (m) return `${name} (${m[0]})`;
    }
  }
  return null;
}

// The deny entry a question card's words match ('<name> (<word>)'), or null.
export const denied = (q) => deniedText([q?.question, q?.context, ...(Array.isArray(q?.options) ? q.options.flatMap((o) => [o?.label, o?.description]) : [])]);

// The same over a plan's checkpoint (lib/checkpoints.mjs), every field the plan wrote, its options with them.
export const deniedPlan = (cp) => deniedText([
  cp?.name, cp?.decision, cp?.context, cp?.whatBuilt, cp?.howToVerify, cp?.action, cp?.instructions, cp?.verification, cp?.resumeSignal,
  ...(Array.isArray(cp?.options) ? cp.options.flatMap((o) => [o?.id, o?.name, o?.pros, o?.cons]) : []),
]);

// owner.auto_answer_minutes: a whole number of minutes, 0 off. Anything else stops the auto answers (the owner tick
// logs it): a typo never answers for the owner.
export function autoAnswerMinutes(config) {
  const v = config?.owner?.auto_answer_minutes === undefined ? 60 : config.owner.auto_answer_minutes;
  if (!Number.isInteger(v) || v < 0) throw new Error('invalid turbo config owner.auto_answer_minutes: must be a whole number of minutes, 0 to turn it off');
  return v;
}

// The lane's classes turbo may answer for (spec §5.1): a plain decision or a verification. owner-only, consent and
// consent:deploy (the standing deploy rule's, with its gate) stay the owner's, and so does a question no lane has
// classified yet.
const AUTO_CLASSES = new Set(['decision', 'verify']);

// Which option turbo may take for an open question: { option (1-based), condition } or { skip: why }. Never a physical
// action, a blocking-human checkpoint, a question not classified decision or verify, a lane question not marked autoOk,
// a question with any earlier record (an owner answer reopened at a stop, an undone auto answer), a card that fell
// back to "see the plan" (the owner could not tell what was taken), or one the deny list matches on the card (the plan's
// own text is screened by autoTick). A decision needs exactly one recommended option; a verification takes its accept
// option, under the plan's evidence condition at a stop (ahead the question carries it already).
export function autoChoice(q, records = [], lang = 'en') {
  const skip = (why) => ({ skip: why });
  if (q?.state !== 'open') return skip('not open');
  if (records.some((r) => r?.id === q.id)) return skip('answered before');
  if (q.kind === 'human-action') return skip('physical: only the owner can do it');
  if (q.gate === 'blocking-human') return skip('blocking-human checkpoint');
  if (q.classified !== true || !AUTO_CLASSES.has(q.class)) return skip(`class ${q.classified === true ? q.class : 'not classified yet'}`);
  if (q.source === 'lane' && q.autoOk !== true) return skip('lane question without autoOk');
  if (pendingCard(q)) return skip('the card only says to see the plan');
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

// A plan question's checkpoint as the plan states it, read where the phase's plans are (its lane's slot, else the
// project): { cp } or { skip }. A checkpoint that cannot be found is left to the owner.
function planScreen(root, state, phase, q, cache) {
  if (q.source === 'lane') return {};
  if (!cache.has(phase)) {
    const lane = supervisorLanes(state, root).find((l) => l.job === 'phase' && l.phase === String(phase));
    cache.set(phase, planCheckpoints(lane ? laneCwd(root, lane) : root, phase).items);
  }
  const found = cache.get(phase).find((x) => questionId(x.plan, x.cp.task) === q.id);
  if (!found) return { skip: 'its checkpoint is not in the plans' };
  const deny = deniedPlan(found.cp);
  return deny ? { skip: `deny list in the plan: ${deny}` } : {};
}

// The owner tick's part (spec §5.2, v0.4.0): stamps askedAt on an open question that has none (the clock starts when
// turbo first sees it), then answers every eligible question that waited the limit, through answerQuestion (the
// single arbiter: an answer that came meanwhile wins), and notifies each. Attended phases are the owner's. A failure in
// one phase (its lock held, say) is logged and leaves the others. state: the supervisor's (where each lane works).
// Returns the answers recorded: [{ phase, id, question, option, undo }].
export async function autoTick(ctx, now, { laneRunning = false, state = null } = {}) {
  const { root, config, deps } = ctx;
  const minutes = autoAnswerMinutes(config);
  if (!minutes) return [];
  const held = new Set(attendedPhases(root).map((a) => String(a.phase)));
  const phases = [...new Set(openQuestions(root).map((q) => String(q.phase)))].filter((p) => !held.has(p));
  const plans = new Map();
  const done = [];
  for (const phase of phases) {
    let due;
    try {
      due = withPhaseLock(root, phase, () => {
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
          if (!c.option || planScreen(root, state, phase, q, plans).skip) continue;
          out.push({ id: q.id, rev: q.rev || 1, option: c.option, condition: c.condition, question: q.question, label: q.options[c.option - 1].label });
        }
        if (stamped) writeQuestions(root, phase, list);
        return out;
      });
    } catch (err) {
      deps.log(`auto-answer ${phase}: ${errLine(err)}`);
      continue;
    }
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
