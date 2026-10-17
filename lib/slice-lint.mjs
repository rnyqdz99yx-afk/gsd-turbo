import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { frontList } from './plan-drafts.mjs';
import { normPath, planInfo, planEdges } from './exec-graph.mjs';
import { gsdCoreDir } from './paths.mjs';

// The deterministic check of a phase's slices (spec §6.3 step 4): no model. Per slice plan: size, GSD's own
// plan-structure verdict, task count, its files; for the phase: GSD's decision-coverage gate, and the edges of the
// graph exec-graph builds. A problem is { plan, kind, detail } (plan: the plan id, or null for the phase); a `gsd`
// problem means a check could not run, never something the slicer can fix.

export const SLICE_MAX_BYTES = 8192;
export const SLICE_MAX_TASKS = 5;
export const LINT_KINDS = Object.freeze(['phase', 'empty', 'size', 'structure', 'tasks', 'files', 'depends', 'coverage', 'decisions', 'cycle', 'gsd']);

// One gsd-tools verdict verb. Without --raw: with it, verify plan-structure prints the word "valid" instead of its JSON.
// Exit 0 and 1 are verdicts with JSON on stdout; any other exit means gsd-tools could not look (69: file not found).
// -> { code, json } (json: the JSON from the first { or [ of stdout, or null).
export function gsdVerdict(core, args, { cwd }) {
  const r = spawnSync(process.execPath, [path.join(core, 'bin', 'gsd-tools.cjs'), ...args, '--cwd', cwd], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = String(r.stdout ?? '');
  const start = out.search(/[{[]/);
  let json = null;
  if (start >= 0) {
    try {
      json = JSON.parse(out.slice(start));
    } catch {
      json = null;
    }
  }
  return { code: r.status ?? -1, json };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Why a listed path is not one a slice may own: a glob or a directory, outside the project, under .planning; or null.
function badPath(p) {
  if (/[*?[]/.test(p) || p.endsWith('/')) return 'a glob or a directory, not an exact path';
  if (/^([A-Za-z]:)?\//.test(p) || p.split('/').includes('..')) return 'outside the project';
  if (p === '.planning' || p.startsWith('.planning/')) return 'under .planning/';
  return null;
}

// root, phase -> { ok, problems: [{ plan, kind, detail }], edges: [{ from, to, kind, why }] }.
// opts: gsd (args -> { code, json }, for tests), core (the GSD core directory; null: none), info (L1's readPhaseInfo).
export function lintSlices(root, phase, opts = {}) {
  const dir = findPhaseDir(root, phase);
  if (!dir) return { ok: false, problems: [{ plan: null, kind: 'phase', detail: `no directory for phase ${phase}` }], edges: [] };
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  const relDir = rel(dir);
  const art = phaseArtifacts(dir);
  if (!art.plans.length) return { ok: false, problems: [{ plan: null, kind: 'empty', detail: `no slice plans in ${relDir}` }], edges: [] };
  const core = 'core' in opts ? opts.core : gsdCoreDir(root);
  const gsd = opts.gsd ?? (core ? (a) => gsdVerdict(core, a, { cwd: root }) : null);
  const problems = [];
  if (!gsd) problems.push({ plan: null, kind: 'gsd', detail: 'GSD core not found' });
  // a verdict, or null after recording why gsd-tools could not give one
  const verdict = (plan, args) => {
    const r = gsd(args);
    if ((r?.code === 0 || r?.code === 1) && isObj(r.json)) return r.json;
    const why = isObj(r?.json) && r.json.error ? `: ${r.json.error}` : '';
    problems.push({ plan, kind: 'gsd', detail: `gsd-tools ${args[0]} ${args[1]}: exit ${r?.code ?? -1}${why}` });
    return null;
  };

  const plans = art.plans.map((p) => ({ id: p.id, text: fs.readFileSync(path.join(dir, p.file), 'utf8'), rel: `${relDir}/${p.file}` }));
  for (const p of plans) {
    const bytes = Buffer.byteLength(p.text);
    if (bytes > SLICE_MAX_BYTES) problems.push({ plan: p.id, kind: 'size', detail: `${bytes} bytes, more than ${SLICE_MAX_BYTES}` });
    const v = gsd ? verdict(p.id, ['verify', 'plan-structure', p.rel]) : null;
    if (v) {
      for (const e of Array.isArray(v.errors) ? v.errors : []) problems.push({ plan: p.id, kind: 'structure', detail: String(e) });
      const n = Number(v.task_count ?? 0);
      if (n > SLICE_MAX_TASKS) problems.push({ plan: p.id, kind: 'tasks', detail: `${n} tasks, more than ${SLICE_MAX_TASKS}` });
      else if (n === 0) problems.push({ plan: p.id, kind: 'tasks', detail: 'no tasks' });
    }
    const files = [...new Set([...(frontList(p.text, 'files_modified') ?? []), ...(frontList(p.text, 'files_deleted') ?? [])].map(normPath).filter(Boolean))];
    if (!files.length) problems.push({ plan: p.id, kind: 'files', detail: 'lists no files' });
    for (const f of files) {
      const why = badPath(f);
      if (why) problems.push({ plan: p.id, kind: 'files', detail: `${f}: ${why}` });
    }
  }

  if (gsd && art.context) verdict(null, ['check', 'decision-coverage-plan', relDir, `${relDir}/${art.context}`]);

  const infos = plans.map((p) => planInfo(p.text, p.id));
  const edges = planEdges(infos);
  return { ok: problems.length === 0, problems, edges };
}
