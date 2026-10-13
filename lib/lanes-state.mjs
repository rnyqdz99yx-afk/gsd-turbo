import path from 'node:path';
import { comparePhase } from './scheduler.mjs';
import { dirKey } from './paths.mjs';

// spec §5 (Stage 4 L1): supervisor.json's lanes as everyone outside the supervisor reads them. Slots mode writes
// lanes (keyed: <N>, prep-<N>, annotate); checkout mode keeps v0.3's single lane (D1), shown here in the same shape.
export const JOBS = Object.freeze(['phase', 'prep', 'annotate']);
// D3: the run-record statuses that end a lane of each job, once its session's turn has ended
export const DONE_STATUSES = Object.freeze({ phase: Object.freeze(['ready', 'done']), prep: Object.freeze(['prepped']), annotate: Object.freeze(['annotated']) });

export function laneKey({ job, phase }) {
  if (job === 'annotate') return 'annotate';
  return job === 'prep' ? `prep-${phase}` : String(phase);
}
// The run record (run/p<key>.json) a lane writes with lane-status: its phase's for a phase and its prep (never at
// once), annotate's own for the annotation.
export const recordKey = (lane) => (lane?.job === 'annotate' ? 'annotate' : String(lane.phase));
export const laneCwd = (root, lane) => (lane?.slotPath ? path.resolve(lane.slotPath) : root);

const JOB_ORDER = { phase: 0, prep: 1, annotate: 2 };
export function compareLanes(a, b) {
  const ja = JOB_ORDER[a.job || 'phase'] ?? 3;
  const jb = JOB_ORDER[b.job || 'phase'] ?? 3;
  return ja - jb || comparePhase(a.phase ?? '', b.phase ?? '');
}

export function laneLabel(lane, lang = 'en') {
  const ru = lang === 'ru';
  if (lane.job === 'prep') return ru ? `подготовка фазы ${lane.phase}` : `prep of phase ${lane.phase}`;
  if (lane.job === 'annotate') return ru ? 'разметка' : 'annotation';
  return ru ? `фаза ${lane.phase}` : `phase ${lane.phase}`;
}

export function supervisorLanes(sup, root = null) {
  if (sup?.lanes && typeof sup.lanes === 'object' && !Array.isArray(sup.lanes)) {
    return Object.entries(sup.lanes)
      .filter(([, l]) => l && typeof l === 'object')
      .map(([key, l]) => ({ ...l, key: l.key ?? key, job: JOBS.includes(l.job) ? l.job : 'phase', phase: l.phase == null ? null : String(l.phase) }))
      .sort(compareLanes);
  }
  if (sup?.lane && typeof sup.lane === 'object' && sup.lane.phase != null) {
    const phase = String(sup.lane.phase);
    return [{ ...sup.lane, phase, key: phase, job: 'phase', slot: 0, slotPath: root ? path.resolve(root) : null, branch: null }];
  }
  return [];
}

export const laneForPhase = (sup, root, phase) => supervisorLanes(sup, root).find((l) => l.job === 'phase' && l.phase === String(phase)) || null;

export function laneAt(sup, root, dir) {
  const here = dirKey(dir);
  return supervisorLanes(sup, root).find((l) => l.slotPath && dirKey(l.slotPath) === here) || null;
}

const W = {
  en: { phase: (n) => `phase ${n}`, list: (l) => (l.length > 1 ? `phases ${l.join(', ')}` : `phase ${l[0]}`), waits: 'waits for', same: 'same files', held: (who) => `held by ${who}`, slot: 'a free slot', annotation: 'the lane annotation', lanes: 'lanes', questions: 'questions', next: 'next' },
  ru: { phase: (n) => `фаза ${n}`, list: (l) => (l.length > 1 ? `фазы ${l.join(', ')}` : `фазу ${l[0]}`), waits: 'ждёт', same: 'общие файлы', held: (who) => `держит ${who}`, slot: 'свободный слот', annotation: 'разметку', lanes: 'полосы', questions: 'вопросы', next: 'следующая' },
};

// spec §8: what the next phase waits for (supervisor.json next), in the owner's language; null when nothing waits.
export function nextLine(next, lang = 'en') {
  if (!next?.phase) return null;
  const w = lang === 'ru' ? W.ru : W.en;
  const who = w.phase(next.phase);
  const on = Array.isArray(next.waitsFor) ? next.waitsFor.map(String) : [];
  switch (next.why) {
    case 'deps': return on.length ? `${who} ${w.waits} ${w.list(on)}` : null;
    case 'areas': return on.length ? `${who} ${w.waits} ${w.list(on)} (${w.same})` : null;
    case 'gates': return `${who} ${w.waits} ${next.gate}${on.length ? ` (${w.held(W[lang === 'ru' ? 'ru' : 'en'].phase(on[0]))})` : ''}`;
    case 'slots': return `${who} ${w.waits} ${w.slot}`;
    case 'annotation': return `${who} ${w.waits} ${w.annotation}`;
    default: return null;
  }
}

// spec §8: the status summary line, e.g. lanes: 3 · questions: 1 · next: phase 36 waits for phase 34.
export function lanesSummary({ lanes, questions, next }, lang = 'en') {
  const w = lang === 'ru' ? W.ru : W.en;
  const n = nextLine(next, lang);
  return [`${w.lanes}: ${lanes}`, `${w.questions}: ${questions}`, ...(n ? [`${w.next}: ${n}`] : [])].join(' · ');
}

// The lines start prints after L0's setupSlots: each slot's action and trust (L0's lanes setup contract), the backup.
export function setupLines(result) {
  const lines = [];
  for (const s of result?.slots || []) {
    lines.push(s.action === 'refused' ? `lane-${s.k}: refused: ${s.why}` : `lane-${s.k}: ${s.action} ${s.path}`);
    const t = s.trust;
    if (!t) continue;
    if (t.status === 'already') lines.push(`lane-${s.k}: trusted (already)`);
    else if (t.status === 'trusted') lines.push(`lane-${s.k}: trusted`);
    else lines.push(`lane-${s.k}: ${t.line}${t.why ? ` (${t.why})` : ''}`);
  }
  if (result?.backup) lines.push(`backup: ${result.backup}`);
  return lines;
}
