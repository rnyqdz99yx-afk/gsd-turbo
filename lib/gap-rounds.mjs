import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { DEFAULTS } from './config.mjs';
import { countAttempt, readProgress } from './phase-progress.mjs';
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

// A YAML block scalar header: | (literal) or > (folded), with an optional indentation and chomping indicator.
const BLOCK_RE = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?$/;
const GAP_FIELDS = new Set(['truth', 'status']);

// The failing items of a GSD verification report (its frontmatter, agents/gsd-verifier.md Step 10): the score, and
// each entry of gaps as its status and truth. The free text around them (reason, missing, artifacts) is written anew
// by every verifier run, so it never counts. A truth may be plain, quoted, or a block scalar (folded or literal, the
// text on the lines below); line breaks and runs of spaces never count. null without a closed frontmatter. A gap this
// reader cannot take apart (a quoted value over several lines, a flow mapping, an alias, no truth) sets unreadable:
// such a report is never the same evidence as another.
export function verificationGaps(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  let score = '';
  const gaps = [];
  let bad = '';
  let inGaps = false;
  let dash = -1; // the column of the entries' dashes
  let keyCol = -1; // the column of the current entry's keys
  let cur = null;
  let field = null; // a truth or status whose text may go on below: { name, parts, block }
  const fail = (why) => { bad ||= why; };
  const close = () => {
    if (field && cur) cur[field.name] = flat(field.parts.join(' '));
    field = null;
  };
  const key = (s) => {
    close();
    const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(s);
    if (!m) return fail(`not a key: ${flat(s).slice(0, 40)}`);
    if (!GAP_FIELDS.has(m[1])) return undefined;
    const v = (m[2] ?? '').trim();
    if (BLOCK_RE.test(v)) field = { name: m[1], parts: [], block: true };
    else if (v.startsWith('"') || v.startsWith("'")) {
      if (v.length < 2 || !v.endsWith(v[0])) return fail(`a quoted ${m[1]} that goes on past its line`);
      cur[m[1]] = flat(unquote(v));
    } else if (/^[[{&*!|>%@`]/.test(v)) return fail(`a ${m[1]} that is no plain text: ${v.slice(0, 20)}`);
    else field = { name: m[1], parts: v ? [v] : [], block: false };
    return undefined;
  };
  for (const line of lines.slice(1, end)) {
    const ind = indentOf(line);
    const blank = !line.trim();
    // a block scalar's text: every line deeper than its key, blank lines and lines that start with # included
    if (field?.block && (blank || ind > keyCol)) {
      field.parts.push(line.trim());
      continue;
    }
    if (blank || line.trimStart().startsWith('#')) continue;
    const top = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (top) {
      close();
      inGaps = top[1] === 'gaps';
      if (top[1] === 'score') score = flat(unquote(top[2]));
      continue;
    }
    if (!inGaps) continue;
    // an entry of gaps starts at the first dash's column; deeper dashes are its nested lists
    const item = /^(\s*)-(?:\s+(.*))?$/.exec(line);
    if (item && (dash < 0 || item[1].length === dash)) {
      close();
      dash = item[1].length;
      cur = { status: '', truth: '' };
      gaps.push(cur);
      keyCol = item[2] ? line.length - item[2].length : -1;
      if (item[2]) key(item[2]);
      continue;
    }
    if (!cur) {
      fail(`a line before the first gap: ${flat(line).slice(0, 40)}`);
      continue;
    }
    if (keyCol < 0 && ind > dash) keyCol = ind;
    if (ind === keyCol) key(line.trim());
    else if (ind > keyCol) field?.parts.push(line.trim()); // a plain truth that goes on, or a nested list (ignored)
    else fail(`a line out of place: ${flat(line).slice(0, 40)}`);
  }
  close();
  if (gaps.some((g) => !g.truth)) fail('a gap without a truth');
  const out = { score, gaps: gaps.map((g) => ({ status: g.status || 'failed', truth: g.truth })) };
  if (bad) out.unreadable = bad;
  return out;
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
  if (v.unreadable) return { file: name, items: null, why: `${name}: a gap cannot be read (${v.unreadable})` };
  return { file: name, failing: v.gaps.length, items: [`score: ${v.score}`, ...v.gaps.map((g) => `${g.status}: ${g.truth}`)].sort() };
}

// turbo-run phase-step N --attempt execute|uat: counts the round across sessions, then decides it. Round 1 runs within
// the budget; a later round runs only when the evidence differs from what the round before it recorded. Evidence
// that cannot be read at a later round stops; a missing earlier record proves nothing and the round runs. A round that
// went on records the plans then without a SUMMARY (uat: the gap plans verify-work wrote for it); while one of them
// still has none, the round was interrupted before its plans ran (a context pause, a stop) and is resumed: go, the
// same n, nothing counted or compared (resumed names those plans). Its first resume always; a later one only when
// another of its plans got a SUMMARY since the last resume, so resumes never outnumber its plans. A round still
// waiting for its plans without that progress (an executor that keeps failing) is counted and stops: the budget
// stays the hard bound.
export function gapRound(root, phase, step, { config = {}, now = new Date() } = {}) {
  if (!GAP_STEPS.includes(step)) throw new Error(`not a gap step: ${step}`);
  const max = gapRounds(config);
  const saved = readJson(roundsFile(root, phase), {});
  const all = isObj(saved) ? saved : {};
  const prev = isObj(all[step]) ? all[step] : null;
  const dir = findPhaseDir(root, phase);
  const open = dir ? phaseArtifacts(dir).plans.filter((p) => !p.hasSummary).map((p) => p.id) : [];
  const left = prev?.go === true && Array.isArray(prev.plans) ? prev.plans.filter((id) => open.includes(id)) : [];
  // the count must still be that round's: the owner's resume clears it, and then a fresh round 1 is counted
  const waiting = left.length > 0 && Number.isInteger(prev.n) && readProgress(root, phase).attempts[step] === prev.n;
  const resumes = Number.isInteger(prev?.resumes) ? prev.resumes : 0;
  if (waiting && prev.n <= max && (resumes === 0 || left.length < prev.left)) {
    writeJsonAtomic(roundsFile(root, phase), { ...all, [step]: { ...prev, resumes: resumes + 1, left: left.length, at: now.toISOString() } });
    return { step, n: prev.n, max, go: true, reason: '', file: prev.file ?? null, failing: prev.failing ?? null, resumed: left };
  }
  const n = countAttempt(root, phase, step, { now });
  const ev = gapEvidence(root, phase, step);
  const hash = ev.items ? digest(ev.items) : null;
  let reason = '';
  if (waiting) reason = `round ${prev.n} was resumed and its gap plans ${left.join(', ')} still have no SUMMARY: their execution does not finish`;
  else if (n > max) reason = `the gap_rounds budget of ${max} is used up across sessions`;
  else if (n > 1 && !hash) reason = `no result to compare: ${ev.why}`;
  else if (n > 1 && prev?.n === n - 1 && prev.hash === hash) reason = `no new evidence: round ${n - 1} left the same ${ev.failing} failing item(s) in ${ev.file}`;
  const go = !reason;
  writeJsonAtomic(roundsFile(root, phase), { ...all, [step]: { n, hash, failing: ev.failing ?? null, file: ev.file, go, plans: go ? open : [], at: now.toISOString() } });
  return { step, n, max, go, reason, file: ev.file, failing: ev.failing ?? null, resumed: [] };
}
