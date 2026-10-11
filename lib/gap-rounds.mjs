import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { DEFAULTS } from './config.mjs';
import { countAttempt } from './phase-progress.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { parseUat } from './uat.mjs';

// spec §8 (S4): the gap-closure rounds of /turbo-phase's execute step (after verification) and uat step (after UAT).
// At most gap_rounds of each per phase, counted across sessions with phase-step --attempt; a round after the first
// runs only when the previous one brought new evidence, else the phase stops for the owner.
export const GAP_STEPS = Object.freeze(['execute', 'uat']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const indentOf = (line) => line.length - line.trimStart().length;
const roundsFile = (root, phase) => path.join(runDir(root), `p${phase}-gap-rounds.json`);
const digest = (items) => createHash('sha256').update(JSON.stringify(items)).digest('hex');

function unquote(v) {
  const s = String(v).trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

// gap_rounds from the turbo config: a whole number of 0 or more (a digit string counts: the file is edited by hand);
// anything else is the default. 0 means no gap-closure round: the first gaps stop for the owner.
export function gapRounds(config) {
  const v = config?.gap_rounds;
  if (Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v);
  return DEFAULTS.gap_rounds;
}

// The failing items of a GSD verification report (its frontmatter, agents/gsd-verifier.md Step 10): the score, and
// each entry of gaps as its status and truth. The free text around them (reason, missing, artifacts) is written anew
// by every verifier run, so it never counts. null without a closed frontmatter.
export function verificationGaps(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  let score = '';
  const gaps = [];
  let inGaps = false;
  let dash = -1;
  let cur = null;
  const take = (s) => {
    const m = /^(truth|status):\s*(.*)$/.exec(s);
    if (m && cur) cur[m[1]] = flat(unquote(m[2]));
  };
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (top) {
      inGaps = top[1] === 'gaps';
      if (top[1] === 'score') score = flat(unquote(top[2]));
      continue;
    }
    if (!inGaps) continue;
    // an entry of gaps starts at the first dash's column; deeper dashes are its nested lists
    const item = /^(\s*)-\s+(.*)$/.exec(line);
    if (item && (dash < 0 || item[1].length === dash)) {
      dash = item[1].length;
      cur = { status: '', truth: '' };
      gaps.push(cur);
      take(item[2]);
    } else if (cur && indentOf(line) === dash + 2) {
      take(line.trim());
    }
  }
  return { score, gaps: gaps.map((g) => ({ status: g.status || 'failed', truth: g.truth })) };
}

// The UAT rows that do not pass, with their result (turbo-uat rewrites the free text on every run).
export const uatProblems = (text) => parseUat(text).tests.filter((t) => t.result !== 'pass').map((t) => `${t.number}. ${flat(t.name)}: ${t.result}`).sort();

// What a round of the step is judged by: the phase's verification report (execute) or UAT file (uat).
export function gapEvidence(root, phase, step) {
  const dir = findPhaseDir(root, phase);
  const kind = step === 'execute' ? 'VERIFICATION.md' : 'UAT file';
  const name = dir ? phaseArtifacts(dir)[step === 'execute' ? 'verification' : 'uat'] : null;
  if (!name) return { file: null, items: null, why: `no ${kind} for phase ${phase}` };
  let text;
  try {
    text = fs.readFileSync(path.join(dir, name), 'utf8');
  } catch (err) {
    return { file: name, items: null, why: `${name} cannot be read (${err.code || err.message})` };
  }
  if (step === 'uat') {
    const items = uatProblems(text);
    return { file: name, failing: items.length, items };
  }
  const v = verificationGaps(text);
  if (!v) return { file: name, items: null, why: `${name} has no frontmatter` };
  return { file: name, failing: v.gaps.length, items: [`score: ${v.score}`, ...v.gaps.map((g) => `${g.status}: ${g.truth}`)].sort() };
}

// turbo-run phase-step N --attempt execute|uat: counts the round across sessions, then decides it. Round 1 runs within
// the budget; a later round runs only when the evidence differs from what the round before it recorded. Evidence
// that cannot be read at a later round stops; a missing earlier record proves nothing and the round runs.
export function gapRound(root, phase, step, { config = {}, now = new Date() } = {}) {
  if (!GAP_STEPS.includes(step)) throw new Error(`not a gap step: ${step}`);
  const n = countAttempt(root, phase, step, { now });
  const max = gapRounds(config);
  const ev = gapEvidence(root, phase, step);
  const hash = ev.items ? digest(ev.items) : null;
  const saved = readJson(roundsFile(root, phase), {});
  const all = isObj(saved) ? saved : {};
  const prev = isObj(all[step]) ? all[step] : null;
  let reason = '';
  if (n > max) reason = `the gap_rounds budget of ${max} is used up across sessions`;
  else if (n > 1 && !hash) reason = `no result to compare: ${ev.why}`;
  else if (n > 1 && prev?.n === n - 1 && prev.hash === hash) reason = `no new evidence: round ${n - 1} left the same ${ev.failing} failing item(s) in ${ev.file}`;
  writeJsonAtomic(roundsFile(root, phase), { ...all, [step]: { n, hash, failing: ev.failing ?? null, file: ev.file, at: now.toISOString() } });
  return { step, n, max, go: !reason, reason, file: ev.file, failing: ev.failing ?? null };
}
