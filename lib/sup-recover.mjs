import fs from 'node:fs';
import path from 'node:path';
import { laneSessionName } from './claude.mjs';
import { readJsonState, writeJsonAtomic } from './fsx.mjs';
import { laneKey, laneLabel } from './lanes-state.mjs';
import { dirKey, runDir, slotRecordFile } from './paths.mjs';
import { nextStep, readProgress } from './phase-progress.mjs';
import { isAgentAlive, readLaneStatus } from './run-status.mjs';
import { comparePhase, rangeLabel } from './scheduler.mjs';
import { readSupervisor, setAside, supervisorFile } from './sup-state.mjs';
import { WORDS, clean } from './view.mjs';

// The owner's start (and resume) over a damaged supervisor.json (lib/sup-state.mjs): the file is kept aside, never
// deleted, and what can be rebuilt is rebuilt from what lives outside it, so the supervisor takes the lanes up instead of
// starting over:
// - slots mode: each slot of this project whose job is active (its own record, kept in its .git) is a lane: its key,
//   job, phase, slot and branch; its session is the lane's by name and slot (claude agents), alive first;
// - checkout mode: the lane of this checkout: an alive lane session here, else the newest lane record (run/p<N>.json)
//   of a phase GSD has not completed, else the newest lane session of such a phase, else the newest unfinished
//   /turbo-phase progress (run/phase-p<N>.json);
// - each phase's progress (its next /turbo-phase step) is read for the summary; turbo-phase keeps it outside
//   supervisor.json.
// Lost with the file: the run's range and plan-only mark, restart counts and sent-notification marks (the supervisor
// recomputes what comes next). A slot whose own record is damaged too is named, never guessed into a lane. One summary
// says what was recovered and what was not, in the owner's language (lines) and in English for the log (log).

const W = {
  en: {
    head: (why, aside) => `supervisor.json was damaged (${why}; most likely a machine crash): kept as ${aside}`,
    lane: (label, where, branch, next, session) => `recovered ${label} ${where}${branch ? `, branch ${branch}` : ''}${next ? `, next step: ${next}` : ''}; ${session}`,
    slot: (k, p) => `in slot ${k} (${p})`,
    here: 'in this checkout',
    alive: (id) => `session ${id} runs: the supervisor adopts it`,
    ended: (id, state) => `session ${id} ${state ? `is ${state}` : 'has ended'}: the supervisor resumes the lane in a new session`,
    noSession: 'no lane session found: the supervisor starts a resumed one',
    noList: (why) => `lane sessions could not be listed (${why}): the supervisor looks at its first check`,
    slotDamaged: (k, p, why, branch) => `not recovered: slot ${k} (${p}): its own record is damaged too (${why})${branch ? `; its branch is ${branch}` : ''}: repair or remove that slot by hand (turbo-run lanes)`,
    none: 'no lane to recover (no slot holds a job, and this checkout has no lane session or record): this start begins with the next ready phase',
    lost: (range) => `not recovered: the run's range and plan-only mark (the supervisor now runs ${range}), restart counts and sent-notification marks`,
    whole: 'the whole milestone',
    phases: (r) => `phases ${r}`,
    step: WORDS.en.step,
  },
  ru: {
    head: (why, aside) => `supervisor.json был повреждён (${why}; вероятно, сбой машины): сохранён как ${aside}`,
    // фаза, подготовка, разметка: all feminine
    lane: (label, where, branch, next, session) => `восстановлена ${label} ${where}${branch ? `, ветка ${branch}` : ''}${next ? `, следующий шаг: ${next}` : ''}; ${session}`,
    slot: (k, p) => `в слоте ${k} (${p})`,
    here: 'в этой рабочей копии',
    alive: (id) => `сессия ${id} работает: супервизор подхватит её`,
    ended: (id, state) => `сессия ${id} ${state ? `в состоянии ${state}` : 'завершилась'}: супервизор продолжит полосу в новой сессии`,
    noSession: 'сессия полосы не найдена: супервизор запустит продолжение',
    noList: (why) => `сессии полос не удалось перечислить (${why}): супервизор посмотрит при первой проверке`,
    slotDamaged: (k, p, why, branch) => `не восстановлено: слот ${k} (${p}): его собственная запись тоже повреждена (${why})${branch ? `; его ветка ${branch}` : ''}: почините или уберите этот слот вручную (turbo-run lanes)`,
    none: 'восстанавливать нечего (ни один слот не занят задачей, в этой рабочей копии нет сессии или записи полосы): запуск начнёт со следующей готовой фазы',
    lost: (range) => `не восстановлено: диапазон прогона и пометка «только планирование» (супервизор теперь идёт по ${range}), счётчики перезапусков и пометки отправленных уведомлений`,
    whole: 'всему milestone',
    phases: (r) => `фазам ${r}`,
    step: WORDS.ru.step,
  },
};

const MIN_START_MS = Date.parse('2000-01-01T00:00:00Z');
// A listed session's start time as ISO (ms number, digit string or ISO string, between 2000 and now), else null: the
// lane records it wrote after its start then count as its own (lib/supervisor.mjs startedAtIso).
function startedAt(agent, now) {
  const v = agent?.startedAt;
  const text = typeof v === 'string' ? v.trim() : '';
  const ms = typeof v === 'number' ? v : /^\d+$/.test(text) ? Number(text) : text ? Date.parse(text) : NaN;
  return Number.isFinite(ms) && ms >= MIN_START_MS && ms <= now.getTime() ? new Date(ms).toISOString() : null;
}

// The session of a lane: its name, started in its directory; an alive one first, else the newest.
function laneSession(agents, name, cwd, now) {
  if (!Array.isArray(agents)) return null;
  const home = dirKey(cwd);
  const mine = agents.filter((a) => a?.name === name && Boolean(a.cwd) && dirKey(a.cwd) === home);
  const newest = (list) => [...list].sort((a, b) => String(startedAt(b, now) ?? '').localeCompare(String(startedAt(a, now) ?? '')))[0] ?? null;
  return newest(mine.filter(isAgentAlive)) ?? newest(mine);
}

// A slot's branch from its .git/HEAD (no git call): turbo/p38, or null.
function headBranch(slot) {
  try {
    return /^ref: refs\/heads\/(\S+)/.exec(fs.readFileSync(path.join(slot, '.git', 'HEAD'), 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

function slotLanes(root, { slots, agents, now }) {
  const lanes = {};
  const found = [];
  const damaged = [];
  const home = dirKey(root);
  for (const slot of slots) {
    const rec = slot.record;
    const job = rec?.job;
    if (!rec) {
      // a slot directory whose own record a crash damaged as well: named, never guessed into a lane
      const r = fs.existsSync(slot.path) ? readJsonState(slotRecordFile(slot.path)) : { state: 'missing' };
      if (r.state === 'damaged') damaged.push({ k: slot.k, path: slot.path, why: r.why, branch: headBranch(slot.path) });
      continue;
    }
    if (job?.state !== 'active' || typeof rec.control !== 'string' || dirKey(rec.control) !== home) continue;
    const phase = job.phase == null ? null : String(job.phase);
    const key = laneKey({ job: job.kind, phase });
    if (lanes[key]) continue;
    const agent = laneSession(agents, laneSessionName(root, key), slot.path, now);
    lanes[key] = { key, job: job.kind, phase, slot: slot.k, slotPath: slot.path, branch: job.branch, sessionId: agent?.id ?? null, ...(agent ? {} : { launch: 'resume' }), launchedAt: agent ? startedAt(agent, now) : null, restarts: 0, notified: {}, mode: 'full', blockedSince: null };
    found.push({ lane: lanes[key], agent });
  }
  return { lanes, found, damaged };
}

// The phase ids this checkout's lane records name (run/p<N>.json; numeric ids, as GSD numbers its phases).
function recordPhases(root) {
  try {
    return fs.readdirSync(runDir(root)).map((n) => /^p(\d+(?:\.\d+)*)\.json$/.exec(n)?.[1]).filter(Boolean);
  } catch {
    return [];
  }
}

function checkoutLane(root, { agents, phases, mode, now }) {
  const complete = (p) => Array.isArray(phases) && phases.some((x) => String(x.number) === String(p) && (x.complete || x.closed));
  const ids = [...new Set([...(Array.isArray(phases) ? phases.map((x) => String(x.number)) : []), ...recordPhases(root)])].filter((p) => !complete(p));
  const sessionOf = (p) => laneSession(agents, laneSessionName(root, p), root, now);
  const byTime = (get) => (a, b) => String(get(b) ?? '').localeCompare(String(get(a) ?? ''));
  const sessions = ids.map((p) => ({ p, agent: sessionOf(p) })).filter((x) => x.agent);
  let pick = sessions.filter((x) => isAgentAlive(x.agent)).sort(byTime((x) => startedAt(x.agent, now)))[0] ?? null;
  if (!pick) {
    const records = ids.map((p) => ({ p, rec: readLaneStatus(root, p) })).filter((x) => x.rec && typeof x.rec === 'object' && x.rec.status !== 'done' && typeof x.rec.at === 'string');
    const rec = records.sort(byTime((x) => x.rec.at))[0];
    if (rec) pick = { p: rec.p, agent: sessionOf(rec.p), recordId: typeof rec.rec.sessionId === 'string' && rec.rec.sessionId ? rec.rec.sessionId : null };
  }
  pick ??= sessions.sort(byTime((x) => startedAt(x.agent, now)))[0] ?? null;
  if (!pick) {
    const progress = ids.map((p) => readProgress(root, p)).filter((x) => x.updatedAt && nextStep(x) !== null).sort(byTime((x) => x.updatedAt))[0];
    if (progress) pick = { p: progress.phase, agent: null };
  }
  if (!pick) return null;
  const sessionId = pick.agent?.id ?? pick.recordId ?? null;
  // /turbo-phase keeps its progress per phase: such a lane ran full mode, whatever this start's doctor says
  const ranFull = readProgress(root, pick.p).updatedAt !== null;
  const lane = { phase: pick.p, sessionId, name: laneSessionName(root, pick.p), launchedAt: pick.agent ? startedAt(pick.agent, now) : null, mode: ranFull ? 'full' : mode === 'full' ? 'full' : 'safe', restarts: 0, notified: {}, blockedSince: null };
  return { lane, agent: pick.agent, sessionId };
}

// A summary of one lane: where it is, its next step, its session.
function laneLine(w, root, { lane, agent, sessionId = lane.sessionId }, agents) {
  const where = lane.slotPath ? w.slot(lane.slot, lane.slotPath) : w.here;
  const label = laneLabel(lane, w === W.ru ? 'ru' : 'en');
  const step = lane.job === 'phase' || !lane.job ? nextStep(readProgress(root, lane.phase)) : null;
  const next = step && readProgress(root, lane.phase).updatedAt ? w.step[step] ?? step : null;
  const session = agents instanceof Error ? w.noList(String(agents.message).split(/\r?\n/)[0])
    : agent ? (isAgentAlive(agent) ? w.alive(agent.id) : w.ended(agent.id, agent.state || ''))
      : sessionId ? w.ended(sessionId, '') : w.noSession;
  return w.lane(label, where, lane.branch || null, next, session);
}

// Recovers a damaged supervisor.json at root (the control root). null when it is not damaged (missing or valid: nothing
// to do). An unreadable file (an error code, not damaged content) is not touched: throws, the caller refuses. Otherwise
// the file goes aside, the rebuilt state is written ({ pid: null, finished: false, halted: false, lanes or lane }) and
// { aside, sup, lines, log } is returned: the summary in the owner's language and in English.
// slots: lanes.mode slots; listSlots() the project's slots (lib/slots.mjs listSlots); agents() the lane sessions
// (claude agents; a throw is reported, nothing waits on it); phases() GSD's phases (a throw: unknown); mode: the
// start's mode, for a checkout lane that left no /turbo-phase progress; range: the range this start runs, or null.
export function recoverSupervisor(root, { lang = 'en', slots = false, listSlots = () => [], agents = () => [], phases = () => null, mode = 'safe', range = null, now = new Date() } = {}) {
  const read = readSupervisor(root);
  if (read.state !== 'damaged') return null;
  if (read.damaged.unreadable) throw new Error(`supervisor.json cannot be read: ${read.damaged.why}`);
  const aside = setAside(root, { now });
  let listed;
  try {
    listed = agents();
  } catch (err) {
    listed = err instanceof Error ? err : new Error(String(err));
  }
  let known = null;
  try {
    known = phases();
  } catch { /* unknown: every recorded phase counts as unfinished */ }
  const list = Array.isArray(listed) ? listed : [];
  const found = [];
  let damagedSlots = [];
  let sup;
  if (slots) {
    let all = [];
    try {
      all = listSlots();
    } catch { /* none listed: the supervisor looks for slots with a job at its start */ }
    const r = slotLanes(root, { slots: all, agents: list, now });
    found.push(...r.found);
    damagedSlots = r.damaged;
    sup = { lanesMode: 'slots', lanes: r.lanes };
  } else {
    const r = checkoutLane(root, { agents: list, phases: known, mode, now });
    if (r) found.push(r);
    sup = { lane: r?.lane ?? null };
  }
  sup = { ...sup, finished: false, halted: false, pid: null, updatedAt: now.toISOString(), recovered: { at: now.toISOString(), from: path.basename(aside), why: read.damaged.why } };
  writeJsonAtomic(supervisorFile(root), sup);
  const say = (w) => [
    w.head(read.damaged.why, path.relative(root, aside).replace(/\\/g, '/')),
    ...found.sort((a, b) => comparePhase(String(a.lane.phase ?? ''), String(b.lane.phase ?? ''))).map((f) => laneLine(w, root, f, listed)),
    ...damagedSlots.map((d) => w.slotDamaged(d.k, d.path, d.why, d.branch)),
    ...(found.length ? [] : [w.none]),
    w.lost(range ? w.phases(rangeLabel(range)) : w.whole),
  ].map((l) => clean(l));
  return { aside, sup, lines: say(lang === 'ru' ? W.ru : W.en), log: say(W.en) };
}
