import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './fsx.mjs';
import { localRunDir } from './paths.mjs';
import { normalizePhaseId } from './gsd.mjs';
import { comparePhase, isFinished } from './scheduler.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { commitPaths } from './gates.mjs';
import { askOwner, liveAnswer, readAnswers, readQuestions, withPhaseLock, writeQuestions } from './questions.mjs';
import { writeJobStatus } from './run-status.mjs';
import { depsText, parseRoadmapPhases, roadmapDigest, setDependsOn, writeLaneLines } from './roadmap-lanes.mjs';
import { laneGates } from './config.mjs';
import { CONFIDENCE, EVERYTHING, LANES_REL, PAIR_STATES, ROADMAP_REL, readLanesRaw, readRoadmap, roadmapFile, stalePhases, writeLanesFile } from './lanes-file.mjs';
import { ANNOTATE_PHASE, DECISIONS_DIR_REL, DECISIONS_FILE_REL } from './prep.mjs';

// spec §6.2 (D8): the analyst writes one JSON; turbo-run annotate apply checks it and writes the markup.
export const RELAX_KINDS = Object.freeze(['prose', 'imaginary']);
export class AnnotateRefused extends Error {
  constructor(problems) {
    super(problems.join('; '));
    this.problems = problems;
  }
}
export const annotateDir = (root) => path.join(localRunDir(root), 'annotate');
export const briefFile = (root) => path.join(annotateDir(root), 'brief.json');
export const analysisFile = (root) => path.join(annotateDir(root), 'analysis.json');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');
const id = (v) => normalizePhaseId(String(v));

// A plan's files_modified (GSD frontmatter): an inline [a, b] list or a block list of - items.
export function filesModified(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text));
  if (!fm) return [];
  const lines = fm[1].split(/\r?\n/);
  const at = lines.findIndex((l) => /^files_modified:/.test(l));
  if (at < 0) return [];
  const unq = (s) => s.trim().replace(/^["']|["']$/g, '');
  const inline = /^files_modified:\s*\[(.*)\]\s*$/.exec(lines[at]);
  if (inline) return inline[1].split(',').map(unq).filter(Boolean);
  const out = [];
  for (const l of lines.slice(at + 1)) {
    const m = /^\s+-\s+(.*)$/.exec(l);
    if (!m) break;
    out.push(unq(m[1]));
  }
  return out;
}

// What the markup works on: the ROADMAP's sections, the unfinished phases that have one, the targets (all of them
// without lanes.json, else the stale ones, spec §6.4) and each phase's dependencies as GSD reads them.
function scope(root, phases) {
  const text = readRoadmap(root);
  if (text === null) throw new Error(`no ${ROADMAP_REL}: nothing to mark up`);
  const sections = new Map(parseRoadmapPhases(text).map((s) => [s.number, s]));
  const raw = readLanesRaw(root);
  const unfinished = phases.filter((p) => !isFinished(p) && sections.has(p.number)).map((p) => p.number).sort(comparePhase);
  const targets = raw ? stalePhases(root, phases) : unfinished;
  return { text, sections, raw, unfinished, targets, deps: new Map(phases.map((p) => [p.number, p.deps])) };
}

// D9: the owner's answer to the dependency card that no markup applied yet. Option 1 (recommended, first) removes
// every wait, option 2 none; own words are the session's to read.
export function pendingAnswer(root, raw = readLanesRaw(root)) {
  const p = raw?.proposal;
  if (p?.state !== 'asked' || !p.id) return null;
  const a = liveAnswer(readAnswers(root, ANNOTATE_PHASE), p.id);
  if (!a) return null;
  const own = a.option === null || a.option === undefined;
  return { id: p.id, option: own ? null : a.option, label: a.label ?? null, text: own ? String(a.answer ?? '') : null, relax: a.option === 1 ? 'all' : a.option === 2 ? 'none' : null };
}

function target(root, s, p) {
  const dir = findPhaseDir(root, s.number);
  const a = dir ? phaseArtifacts(dir) : null;
  const at = (f) => (f ? rel(root, path.join(dir, f)) : null);
  return {
    phase: s.number, name: s.name, goal: s.goal, deps: p?.deps ?? [], dependsOn: s.dependsOn,
    dir: dir ? rel(root, dir) : null, context: at(a?.context), research: at(a?.research),
    plans: (a?.plans ?? []).map((pl) => ({ file: at(pl.file), filesModified: filesModified(fs.readFileSync(path.join(dir, pl.file), 'utf8')) })),
  };
}

// The analyst's input (Contracts: Brief), written to briefFile.
export function annotateBrief(root, { phases, config = {} }) {
  const { sections, raw, unfinished, targets } = scope(root, phases);
  const answer = pendingAnswer(root, raw);
  const reason = answer ? 'answer' : targets.length ? 'phases' : 'none';
  const byId = new Map(phases.map((p) => [p.number, p]));
  const brief = {
    v: 1, reason, lang: config.lang || 'en', autonomy: config.autonomy === 'max' ? 'max' : 'standard',
    roadmap: ROADMAP_REL, briefFile: briefFile(root), analysisFile: analysisFile(root), gates: laneGates(config),
    targets: targets.map((n) => target(root, sections.get(n), byId.get(n))),
    others: unfinished.filter((n) => !targets.includes(n)).map((n) => ({
      phase: n, name: sections.get(n).name, deps: byId.get(n)?.deps ?? [],
      areas: raw?.phases[n]?.areas ?? [EVERYTHING], gates: raw?.phases[n]?.gates ?? [], confidence: raw?.phases[n]?.confidence ?? 'low',
    })),
    proposal: raw?.proposal ?? null,
    answer,
  };
  writeJsonAtomic(briefFile(root), brief);
  if (reason === 'phases') fs.rmSync(analysisFile(root), { force: true });
  return brief;
}

// D6: what an area mask may not be.
const MASK_BAD = [
  [/[\x00-\x1f\x7f]/, 'has a control character'],
  [/^\/|^[A-Za-z]:/, 'is absolute'],
  [/\\/, 'has a backslash (use /)'],
  [/[{}]/, 'has braces (write each alternative as its own mask)'],
  [/,/, 'has a comma'],
  [/(^|\/)\.\.(\/|$)/, 'leaves the repository (..)'],
  [/^\.planning(\/|$)/, 'names .planning (each phase has its own directory there)'],
  [/^\s|\s$/, 'has spaces at its ends'],
];

export function validateAnalysis(a, { targets, unfinished, gates, deps }) {
  if (!isObj(a) || !isObj(a.phases)) return ['the analysis is not a JSON object with a phases object'];
  const problems = [];
  for (const [n, e] of Object.entries(a.phases)) {
    if (!targets.includes(id(n))) problems.push(`phase ${n} is not a phase to mark up (${targets.join(', ') || 'none'})`);
    if (!isObj(e)) {
      problems.push(`phase ${n}: not an object`);
      continue;
    }
    if (!Array.isArray(e.areas) || !e.areas.length || e.areas.some((m) => typeof m !== 'string' || !m)) problems.push(`phase ${n}: areas must be a non-empty list of path masks`);
    else for (const m of e.areas) for (const [re, why] of MASK_BAD) if (re.test(m)) problems.push(`phase ${n}: area ${m} ${why}`);
    if (!Array.isArray(e.gates) || e.gates.some((g) => !gates.includes(g))) problems.push(`phase ${n}: gates must be a list of ${gates.join(', ')}`);
    if (!CONFIDENCE.includes(e.confidence)) problems.push(`phase ${n}: confidence must be high or low`);
  }
  if (a.pairs !== undefined && !Array.isArray(a.pairs)) problems.push('pairs must be a list');
  for (const p of Array.isArray(a.pairs) ? a.pairs : []) {
    if (!Array.isArray(p) || p.length !== 4) {
      problems.push(`pair ${JSON.stringify(p)}: must be [phase, phase, conflict or ok, reason]`);
      continue;
    }
    const [x, y, s, r] = p;
    if (![x, y].every((v) => unfinished.includes(id(v))) || id(x) === id(y)) problems.push(`pair ${x}/${y}: two different unfinished phases`);
    else if (![x, y].some((v) => targets.includes(id(v)))) problems.push(`pair ${x}/${y}: names no phase to mark up`);
    if (!PAIR_STATES.includes(s)) problems.push(`pair ${x}/${y}: state must be conflict or ok`);
    if (typeof r !== 'string') problems.push(`pair ${x}/${y}: the reason must be text`);
  }
  if (a.relax !== undefined && !Array.isArray(a.relax)) problems.push('relax must be a list');
  for (const [i, r] of (Array.isArray(a.relax) ? a.relax : []).entries()) {
    const n = id(r?.phase);
    const have = deps.get(n) ?? [];
    if (!unfinished.includes(n)) problems.push(`relax ${i + 1}: phase ${r?.phase} is not an unfinished phase`);
    if (!Array.isArray(r?.drop) || !r.drop.length || r.drop.some((d) => !have.includes(id(d)))) problems.push(`relax ${i + 1}: drop must name dependencies phase ${n} has (${have.join(', ') || 'none'})`);
    if (!RELAX_KINDS.includes(r?.kind)) problems.push(`relax ${i + 1}: kind must be prose or imaginary`);
    if (typeof r?.reason !== 'string' || !r.reason.trim()) problems.push(`relax ${i + 1}: needs a reason`);
  }
  return problems;
}

// The kept pairs of phases that are not marked up again, plus the analysis's, one per pair of phases.
function mergePairs(old, given, sc) {
  const out = new Map();
  const keep = (n) => sc.unfinished.includes(n) && !sc.targets.includes(n);
  for (const [a, b, s, r] of old) if (keep(a) && keep(b)) out.set(`${a}|${b}`, [a, b, s, r]);
  for (const p of given) {
    const [a, b] = [id(p[0]), id(p[1])].sort(comparePhase);
    out.set(`${a}|${b}`, [a, b, p[2], p[3]]);
  }
  return [...out.values()].sort((x, y) => comparePhase(x[0], y[0]) || comparePhase(x[1], y[1]));
}

// a depends on b, directly or through other phases
function reaches(deps, a, b, seen = new Set()) {
  for (const d of deps.get(a) ?? []) {
    if (d === b) return true;
    if (!seen.has(d)) {
      seen.add(d);
      if (reaches(deps, d, b, seen)) return true;
    }
  }
  return false;
}

// D5: the lines of every phase with markup; Parallel with = the ok pairs no dependency chain links.
function markLines(text, entries, pairs, deps) {
  let out = text;
  for (const n of Object.keys(entries).sort(comparePhase)) {
    const parallelWith = pairs
      .filter((p) => p[2] === 'ok' && (p[0] === n || p[1] === n))
      .map((p) => (p[0] === n ? p[1] : p[0]))
      .filter((m) => !reaches(deps, n, m) && !reaches(deps, m, n))
      .sort(comparePhase);
    out = writeLaneLines(out, n, { areas: entries[n].areas, gates: entries[n].gates, parallelWith });
  }
  return out;
}

// D9: the card's text, templated: no file names, so the owner's plain-words check passes.
const CARD = {
  en: {
    question: (n) => `Some phases could start earlier: ${n === 1 ? 'one wait looks' : `${n} waits look`} like wording only. Remove ${n === 1 ? 'it' : 'them'}?`,
    line: (r) => `Phase ${r.phase} waits for ${r.drop.map((d) => `phase ${d}`).join(' and ')}${r.kind === 'prose' ? ' only in its wording' : ', though they share no files, data or behaviour'}.`,
    some: 'To remove only some of them, answer in your own words which.',
    options: [
      { label: 'Remove all', description: 'Turbo removes these waits, writes a decision record, and starts those phases as soon as a lane is free.' },
      { label: 'Leave as is', description: 'Nothing changes: the phases keep waiting as written.' },
    ],
  },
  ru: {
    question: (n) => `Часть фаз может начаться раньше: ${n === 1 ? 'одно ожидание похоже' : `ожидания (${n}) похожи`} на формулировку, а не на настоящую зависимость. Убрать ${n === 1 ? 'его' : 'их'}?`,
    line: (r) => `Фаза ${r.phase} ждёт ${r.drop.map((d) => `фазу ${d}`).join(' и ')}${r.kind === 'prose' ? ' только на словах' : ', хотя у них нет общих файлов, данных и поведения'}.`,
    some: 'Чтобы убрать только часть, ответьте своими словами, какие.',
    options: [
      { label: 'Убрать все', description: 'Turbo уберёт эти ожидания, запишет решение и запустит эти фазы, как только освободится полоса.' },
      { label: 'Оставить как есть', description: 'Ничего не меняется: фазы ждут, как написано.' },
    ],
  },
};

function askCard(root, relax, config, now) {
  const lang = Object.hasOwn(CARD, config.lang) ? config.lang : 'en';
  const t = CARD[lang];
  return askOwner(root, ANNOTATE_PHASE, { question: t.question(relax.length), context: [...relax.map(t.line), t.some].join(' '), options: t.options, recommended: 1 }, { lang, now });
}

// D10: one record per applied set of relaxations.
export function writeDecision(root, relax, { now = new Date(), by }) {
  const day = now.toISOString().slice(0, 10);
  const text = (h) => [
    `${h} Relaxed phase dependencies (${day})`, '',
    `Decided by: ${by}. Proposed by gsd-turbo's lane markup (turbo-lane-analyst).`, '',
    ...relax.flatMap((r) => [
      `${h}# Phase ${r.phase}`, '',
      `- Was: \`**Depends on**: ${r.from}\``,
      `- Now: \`**Depends on**: ${depsText(r.remaining)}\``,
      `- Why (${r.kind}): ${r.reason}`,
      `- Roll back: put the Was line back into phase ${r.phase}'s section of ${ROADMAP_REL}; the next turbo run marks the ROADMAP up again.`,
      '',
    ]),
  ].join('\n');
  const dir = path.join(root, ...DECISIONS_DIR_REL.split('/'));
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    let name = `turbo-${day}-relaxed-dependencies.md`;
    for (let k = 2; fs.existsSync(path.join(dir, name)); k++) name = `turbo-${day}-relaxed-dependencies-${k}.md`;
    fs.writeFileSync(path.join(dir, name), text('#'));
    return `${DECISIONS_DIR_REL}/${name}`;
  }
  const file = path.join(root, ...DECISIONS_FILE_REL.split('/'));
  let prev;
  try {
    prev = fs.readFileSync(file, 'utf8');
  } catch {
    prev = '# gsd-turbo decisions\n';
  }
  fs.writeFileSync(file, `${prev.replace(/\s*$/, '\n')}\n${text('##')}`);
  return DECISIONS_FILE_REL;
}

export function applyAnalysis(root, analysis, { phases, config = {}, now = new Date(), commit = (paths, message) => commitPaths(root, paths, message) } = {}) {
  const sc = scope(root, phases);
  if (!sc.targets.length) throw new AnnotateRefused(['nothing to mark up: every unfinished phase has fresh markup']);
  const problems = validateAnalysis(analysis, { targets: sc.targets, unfinished: sc.unfinished, gates: laneGates(config), deps: sc.deps });
  if (problems.length) throw new AnnotateRefused(problems);
  const given = new Map(Object.entries(analysis.phases).map(([n, e]) => [id(n), e]));
  const entries = {};
  for (const n of sc.unfinished) {
    const e = sc.targets.includes(n) ? given.get(n) : sc.raw?.phases[n];
    if (e) entries[n] = { areas: e.areas.map((m) => m.trim()), gates: [...new Set(e.gates)], confidence: e.confidence };
    else if (sc.targets.includes(n)) entries[n] = { areas: [EVERYTHING], gates: [], confidence: 'low' };
  }
  const low = sc.targets.filter((n) => !given.has(n));
  const pairs = mergePairs(sc.raw?.pairs ?? [], analysis.pairs ?? [], sc);
  const at = now.toISOString();
  const relax = (analysis.relax ?? []).map((r, i) => {
    const phase = id(r.phase);
    const drop = [...new Set(r.drop.map(id))];
    return { id: `r${i + 1}`, phase, drop, remaining: (sc.deps.get(phase) ?? []).filter((d) => !drop.includes(d)), kind: r.kind, reason: r.reason.trim(), from: sc.sections.get(phase)?.dependsOn ?? '' };
  });
  const max = config.autonomy === 'max';
  const deps = new Map(sc.deps);
  let text = sc.text;
  let proposal = sc.raw?.proposal ?? null;
  let asked = null;
  if (relax.length && max) {
    for (const r of relax) {
      text = setDependsOn(text, r.phase, r.remaining);
      deps.set(r.phase, r.remaining);
    }
    proposal = { id: null, state: 'applied', at, by: 'autonomy max', accepted: relax.map((r) => r.id), relax };
  } else if (relax.length) {
    asked = askCard(root, relax, config, now).question.id;
    // askOwner records needs-owner in pannotate.json, the annotate lane's record (L1): nothing waits for the card (D9)
    writeJobStatus(root, { kind: 'annotate', phase: null }, 'running', { reason: `dependency card ${asked} asked`, at });
    proposal = { id: asked, state: 'asked', at, by: null, accepted: [], relax };
  }
  text = markLines(text, entries, pairs, deps);
  fs.writeFileSync(roadmapFile(root), text);
  const adr = relax.length && max ? writeDecision(root, relax, { now, by: 'gsd-turbo (autonomy max)' }) : null;
  writeLanesFile(root, { phases: entries, pairs, proposal, annotatedAt: at });
  const c = commit([ROADMAP_REL, LANES_REL, ...(adr ? [adr] : [])], `docs(turbo): lane markup for phase ${sc.targets.join(', ')}`);
  return { annotated: sc.targets, low, pairs: pairs.length, relaxed: max ? relax.map((r) => r.id) : [], asked, adr, commit: c };
}

function closeQuestion(root, qid, now) {
  withPhaseLock(root, ANNOTATE_PHASE, () => {
    const list = readQuestions(root, ANNOTATE_PHASE);
    const q = list.find((x) => x.id === qid);
    if (!q || q.state !== 'answered') return;
    Object.assign(q, { state: 'delivered', delivery: { path: 'lane', at: now.toISOString() } });
    writeQuestions(root, ANNOTATE_PHASE, list);
  });
}

// D9: the owner's answer. A relaxation whose Depends on line changed since the card, or whose phase finished, is
// skipped, never overwritten. Section keys move only for phases that were fresh before, so staleness survives; with no
// stale unfinished phase (review I2: only a finished phase changed) the digest is taken from the new ROADMAP.
export function applyAnswer(root, choice, { phases, config = {}, now = new Date(), commit = (paths, message) => commitPaths(root, paths, message) } = {}) {
  const raw = readLanesRaw(root);
  const p = raw?.proposal;
  if (p?.state !== 'asked') throw new AnnotateRefused(['no dependency card waits for an answer']);
  if (!pendingAnswer(root, raw)) throw new AnnotateRefused([`the owner has not answered ${p.id} yet`]);
  const ids = choice === 'all' ? p.relax.map((r) => r.id) : choice === 'none' ? [] : choice;
  const unknown = ids.filter((x) => !p.relax.some((r) => r.id === x));
  if (unknown.length) throw new AnnotateRefused([`no proposal ${unknown.join(', ')}: the card holds ${p.relax.map((r) => r.id).join(', ')}`]);
  const sc = scope(root, phases);
  const deps = new Map(sc.deps);
  let text = sc.text;
  const applied = [];
  const skipped = [];
  for (const r of p.relax.filter((x) => ids.includes(x.id))) {
    const s = sc.sections.get(r.phase);
    if (!s || !sc.unfinished.includes(r.phase) || (s.dependsOn ?? '') !== r.from) {
      skipped.push(r.id);
      continue;
    }
    const remaining = (deps.get(r.phase) ?? []).filter((d) => !r.drop.includes(d));
    text = setDependsOn(text, r.phase, remaining);
    deps.set(r.phase, remaining);
    applied.push({ ...r, remaining });
  }
  const entries = {};
  for (const [n, e] of Object.entries(raw.phases)) if (sc.unfinished.includes(n)) entries[n] = { areas: e.areas, gates: e.gates, confidence: e.confidence, section: e.section };
  text = markLines(text, entries, raw.pairs, deps);
  const newKeys = new Map(parseRoadmapPhases(text).map((s) => [s.number, s.key]));
  for (const r of applied) if (entries[r.phase] && entries[r.phase].section === sc.sections.get(r.phase).key) entries[r.phase].section = newKeys.get(r.phase);
  const wasFresh = raw.roadmapSha256 === roadmapDigest(sc.text);
  fs.writeFileSync(roadmapFile(root), text);
  const adr = applied.length ? writeDecision(root, applied, { now, by: `the owner (answer ${p.id})` }) : null;
  const proposal = { ...p, state: applied.length ? 'applied' : 'declined', by: 'the owner', accepted: applied.map((r) => r.id), answeredAt: now.toISOString() };
  writeLanesFile(root, { phases: entries, pairs: raw.pairs, proposal, annotatedAt: raw.annotatedAt ?? now.toISOString(), roadmapSha256: wasFresh || !sc.targets.length ? undefined : raw.roadmapSha256 });
  closeQuestion(root, p.id, now);
  const message = applied.length ? `docs(turbo): relaxed dependencies of phase ${applied.map((r) => r.phase).join(', ')} (owner)` : 'docs(turbo): dependency card left as is (owner)';
  const c = commit([ROADMAP_REL, LANES_REL, ...(adr ? [adr] : [])], message);
  return { applied: applied.map((r) => r.id), skipped, adr, commit: c };
}
