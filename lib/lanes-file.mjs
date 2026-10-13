import fs from 'node:fs';
import path from 'node:path';
import { GATE_RE } from './config.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { normalizePhaseId } from './gsd.mjs';
import { comparePhase, isFinished } from './scheduler.mjs';
import { parseRoadmapPhases, roadmapDigest } from './roadmap-lanes.mjs';

// spec §6.2: the machine-readable markup next to the ROADMAP lines; L1's scheduler reads it (readLanesFile). The gate
// vocabulary is L1's (lib/config.mjs GATE_NAMES, laneGates; reconcile R6).
export const LANES_REL = '.planning/turbo/lanes.json';
export const ROADMAP_REL = '.planning/ROADMAP.md';
export const CONFIDENCE = Object.freeze(['high', 'low']);
export const PAIR_STATES = Object.freeze(['conflict', 'ok']);
// spec §5, §6.3: a phase without markup touches everything
export const EVERYTHING = '**';

export const lanesFile = (root) => path.join(root, ...LANES_REL.split('/'));
export const roadmapFile = (root) => path.join(root, ...ROADMAP_REL.split('/'));

export function readRoadmap(root) {
  try {
    return fs.readFileSync(roadmapFile(root), 'utf8');
  } catch {
    return null;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : null);

// D7: read conservatively: no valid areas, or any confidence but high, is low (counted as everything).
function entryOf(e) {
  const areas = strings(e?.areas);
  const valid = Boolean(areas && areas.length);
  return {
    areas: valid ? areas : [EVERYTHING],
    gates: [...new Set((strings(e?.gates) ?? []).filter((g) => GATE_RE.test(g)))],
    confidence: valid && e?.confidence === 'high' ? 'high' : 'low',
    section: typeof e?.section === 'string' ? e.section : null,
  };
}

function pairOf(p) {
  if (!Array.isArray(p) || p.length < 3 || !PAIR_STATES.includes(p[2])) return null;
  const [a, b] = [normalizePhaseId(String(p[0])), normalizePhaseId(String(p[1]))];
  if (a === b) return null;
  const [x, y] = [a, b].sort(comparePhase);
  return [x, y, p[2], typeof p[3] === 'string' ? p[3] : ''];
}

const proposalOf = (p) => (isObj(p) && Array.isArray(p.relax) && ['asked', 'applied', 'declined'].includes(p.state) ? p : null);

export function readLanesRaw(root) {
  const raw = readJson(lanesFile(root), null);
  if (!isObj(raw) || !isObj(raw.phases) || typeof raw.roadmap_sha256 !== 'string') return null;
  const phases = {};
  for (const [n, e] of Object.entries(raw.phases)) phases[normalizePhaseId(n)] = entryOf(e);
  return {
    roadmapSha256: raw.roadmap_sha256,
    annotatedAt: typeof raw.annotated_at === 'string' ? raw.annotated_at : null,
    phases,
    pairs: (Array.isArray(raw.pairs) ? raw.pairs : []).map(pairOf).filter(Boolean),
    proposal: proposalOf(raw.proposal),
  };
}

// The pinned interface (L1): fresh = the digest of the ROADMAP on disk equals the stored one (D3). A phase whose
// section changed since its markup (or that left the ROADMAP) is left out, so it counts as everything (spec §6.4).
export function readLanesFile(root) {
  const raw = readLanesRaw(root);
  if (!raw) return null;
  const text = readRoadmap(root);
  const keys = new Map((text === null ? [] : parseRoadmapPhases(text)).map((s) => [s.number, s.key]));
  return {
    fresh: text !== null && roadmapDigest(text) === raw.roadmapSha256,
    roadmapSha256: raw.roadmapSha256,
    phases: Object.fromEntries(Object.entries(raw.phases).filter(([n, e]) => keys.get(n) === e.section).map(([n, e]) => [n, { areas: e.areas, gates: e.gates, confidence: e.confidence }])),
    pairs: raw.pairs,
  };
}

// The roadmap digest and each phase's section key come from the ROADMAP on disk unless given.
export function writeLanesFile(root, data) {
  const text = readRoadmap(root);
  if (text === null) throw new Error(`no ${ROADMAP_REL}: nothing to mark up`);
  const keys = new Map(parseRoadmapPhases(text).map((s) => [s.number, s.key]));
  const phases = {};
  for (const n of Object.keys(data.phases || {}).sort((a, b) => comparePhase(normalizePhaseId(a), normalizePhaseId(b)))) {
    const id = normalizePhaseId(n);
    const e = entryOf(data.phases[n]);
    phases[id] = { areas: e.areas, gates: e.gates, confidence: e.confidence, section: e.section ?? keys.get(id) ?? null };
  }
  const out = {
    v: 1,
    roadmap_sha256: data.roadmapSha256 ?? roadmapDigest(text),
    annotated_at: data.annotatedAt ?? new Date().toISOString(),
    phases,
    pairs: (data.pairs || []).map(pairOf).filter(Boolean),
    proposal: data.proposal ?? null,
  };
  writeJsonAtomic(lanesFile(root), out);
  return out;
}

// spec §6.2: a phase missing from the markup, or with low confidence, counts as everything (L1's scheduler).
export function areasOf(lanes, phase) {
  const e = lanes?.phases?.[normalizePhaseId(String(phase))];
  return e && e.confidence === 'high' ? e.areas : [EVERYTHING];
}
export const gatesOf = (lanes, phase) => lanes?.phases?.[normalizePhaseId(String(phase))]?.gates ?? [];

// spec §6.4: the unfinished phases with a ROADMAP section that have no markup or whose section changed since.
export function stalePhases(root, phases) {
  const text = readRoadmap(root);
  if (text === null) return [];
  const raw = readLanesRaw(root);
  const keys = new Map(parseRoadmapPhases(text).map((s) => [s.number, s.key]));
  return phases
    .filter((p) => !isFinished(p) && keys.has(p.number))
    .filter((p) => raw?.phases[p.number]?.section !== keys.get(p.number))
    .map((p) => p.number)
    .sort(comparePhase);
}
