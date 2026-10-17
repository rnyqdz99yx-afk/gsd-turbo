import fs from 'node:fs';
import path from 'node:path';
import { runDir, stateRoot } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { answersRel, readAnswers, readQuestions } from './questions.mjs';

// v0.4.0 sleep mode: run/away.json { since, ackAt, snapshot } (its own file: the owner's commands write it, never the
// daemon). since: when the owner left (turbo-run away --set), null while they are here; ackAt: when they last came
// back (turbo-run back): the auto answers after it are still news; snapshot: the phases' progress when they left.
export const awayFile = (root) => path.join(runDir(root), 'away.json');
const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

export function readAway(root) {
  const raw = readJson(awayFile(root), null);
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { since: iso(o.since), ackAt: iso(o.ackAt), snapshot: o.snapshot && typeof o.snapshot === 'object' ? o.snapshot : null };
}

export const writeAway = (root, rec) => writeJsonAtomic(awayFile(root), rec);

// The answers turbo took itself (by auto) that still stand (not undone, not reopened at a stop), newer than after
// (an ISO time; none: all), newest first: [{ phase, id, question, option, at, undo }].
export function autoAnswers(root, { after = null } = {}) {
  const dir = path.join(stateRoot(root), ...answersRel('x').split('/').slice(0, -1));
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^p.+\.json$/.test(n));
  } catch {
    return [];
  }
  const from = after ? Date.parse(after) : -Infinity;
  const out = [];
  for (const name of names) {
    const phase = name.slice(1, -5);
    const records = readAnswers(root, phase).filter((r) => r.by === 'auto' && !r.superseded && !r.undone && Date.parse(r.at) > from);
    if (!records.length) continue;
    const questions = new Map(readQuestions(root, phase).map((q) => [q.id, q]));
    for (const r of records) {
      out.push({ phase, id: r.id, question: questions.get(r.id)?.question ?? r.question ?? '', option: r.label ?? String(r.answer ?? ''), at: r.at, undo: `turbo-run answer ${phase} ${r.id} --undo` });
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
