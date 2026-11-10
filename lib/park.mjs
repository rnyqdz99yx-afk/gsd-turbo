import path from 'node:path';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';

// A parked phase (live run 2026-11-11): the owner lets the phases that wait for it go on while it waits for them (an
// offline sitting, a decision for another day). Its own lane keeps waiting for its question; the scheduler stops
// counting it as a dependency of the phases after it, and its lane's areas and gates hold no other lane back. The
// owner accepts that the phases after it run without its work (they get a note in their inbox: plan what needs it
// last). run/parked.json in the control root, { "<phase>": { at, by, question? } }; never in git.
export const parkedFile = (root) => path.join(runDir(root), 'parked.json');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function readParked(root) {
  const v = readJson(parkedFile(root), {});
  return isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, e]) => isObj(e))) : {};
}

// Returns { parked: true } when the mark is new, { parked: false } when the phase was parked already.
export function parkPhase(root, phase, { by = 'cli', now = new Date(), question = null } = {}) {
  const all = readParked(root);
  const key = String(phase);
  if (Object.hasOwn(all, key)) return { parked: false, mark: all[key] };
  all[key] = { at: now.toISOString(), by: String(by), ...(question ? { question: String(question) } : {}) };
  writeJsonAtomic(parkedFile(root), all);
  return { parked: true, mark: all[key] };
}

// Returns { unparked: true } when a mark went, false when the phase was not parked.
export function unparkPhase(root, phase) {
  const all = readParked(root);
  const key = String(phase);
  if (!Object.hasOwn(all, key)) return { unparked: false };
  delete all[key];
  writeJsonAtomic(parkedFile(root), all);
  return { unparked: true };
}

// The note a phase gets when it starts while a phase it depends on is parked: information for its planning, in the
// project's language.
export function parkedNote(parked, lang = 'en') {
  const list = parked.map(String).join(', ');
  return lang === 'ru'
    ? `Фаза ${list} отложена владельцем: она ждёт его и ещё не влита в основную ветку. Эта фаза начата без неё. Не рассчитывайте, что её работа уже есть в коде; то, что без неё не сделать, планируйте последним, за вопросом владельцу.`
    : `Phase ${list} is parked by the owner: it waits for the owner and is not merged yet. This phase started without it. Do not count on its work being in the code; plan what cannot be done without it last, behind a question to the owner.`;
}
