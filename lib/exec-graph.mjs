import { dependIds, frontList, frontScalar } from './plan-drafts.mjs';

// Stage 6 (execution graph, spec docs/specs/2026-10-15-stage-6-design.md §4). The plans of a phase as a graph, and two
// schedules of it: GSD's waves (each wave waits for the one before it, then a serial tail) and a ready queue (each plan
// starts as soon as the plans it needs are merged). Pure functions: no files, no git, no clock. The what-if calculator
// (lib/exec-whatif.mjs) feeds them measured minutes; turbo-run exec will build its graph with planEdges.
//
// GSD 1.16 facts this follows (spec §3): execute-phase groups plans by the longest-path level of the depends_on graph
// (gsd-core/bin/lib/phase.cjs computeDependencyLevels, cmdPhasePlanIndex: wave = level, a declared wave that differs
// only warns); a wave runs in parallel unless two of its plans share a file in files_modified, then the whole wave runs
// one plan at a time (execute-phase.md step execute_waves, point 1); the next wave starts after the wave's merges, test
// gate and tracking commit (points 4-5.7). The planner's own rule (agents/gsd-planner.md assign_waves) makes a plan
// that changes or deletes a file an earlier plan changes or deletes come later; its coupling rule
// (references/planner-coupling.md) orders a plan that consumes what another produces.

export const EDGE_KINDS = Object.freeze(['depends', 'files', 'reads']);

// A plan id compared without leading zeros or case: 32-07, 32-7 and 032-07 are one plan.
export const canonId = (id) => String(id).toLowerCase().split('-').map((s) => s.replace(/^0+(?=\d)/, '')).join('-');
// A plan file's id (32-07-PLAN.md -> 32-07; a long form 32-07-auth -> 32-07) and the phase prefix of an id.
export const planIdOf = (fileId) => /^(\d+[A-Za-z]?(?:\.\d+)*-\d+[A-Za-z]?)(?:-|$)/.exec(String(fileId))?.[1] ?? String(fileId);
export const prefixOf = (id) => String(id).slice(0, String(id).lastIndexOf('-'));

// A path as plans write it, compared: slashes forward, no leading ./, no surrounding space or quotes.
export const normPath = (p) => String(p).trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');

// Two declared paths name a common file: equal, or one is a directory (ends with /) or a glob whose fixed start is the
// start of the other (GSD's per-plan gate reads globs by their prefix).
export function pathsMeet(a, b) {
  const x = normPath(a);
  const y = normPath(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const stem = (p) => {
    const star = p.search(/[*?[]/);
    if (star >= 0) return p.slice(0, star);
    return p.endsWith('/') ? p : null;
  };
  const sx = stem(x);
  const sy = stem(y);
  return (sx !== null && y.startsWith(sx)) || (sy !== null && x.startsWith(sy));
}
// The first file two path lists share, named by the concrete path of the pair (not the glob or the directory); null.
const concrete = (p) => !/[*?[]|\/$/.test(normPath(p));
const firstMeeting = (as, bs) => {
  for (const a of as) for (const b of bs) if (pathsMeet(a, b)) return normPath(concrete(a) ? a : b);
  return null;
};

// The files a plan's must_haves.key_links name (from: and to: of each link; a bare-string link gives the path-like
// words in it), in order, each once. GSD writes them nested in the frontmatter (templates/phase-prompt.md):
//   must_haves:
//     key_links:
//       - from: "src/components/Chat.tsx"
//         to: "src/app/api/chat/route.ts"
export function keyLinkPaths(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(text ?? ''));
  if (!m) return [];
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*key_links:/.test(l));
  if (at < 0) return [];
  const indent = /^(\s*)/.exec(lines[at])[1].length;
  const out = [];
  const add = (p) => {
    const n = normPath(p);
    if (n && !out.includes(n)) out.push(n);
  };
  const pathWords = (s) => (String(s).match(/[A-Za-z0-9_.@~-]*[/.][A-Za-z0-9_./@~-]*[A-Za-z0-9_]/g) ?? []).filter((w) => w.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(w));
  const rest = lines[at].replace(/^\s*key_links:/, '').replace(/(^|\s)#.*$/, '').trim();
  if (rest.startsWith('[')) {
    for (const w of pathWords(rest)) add(w);
    return out;
  }
  for (const l of lines.slice(at + 1)) {
    if (!l.trim()) continue;
    // YAML lets a block sequence sit at its key's own indent (key_links:\n- from: …): such an item still belongs to it
    const ind = /^(\s*)/.exec(l)[1].length;
    if (ind < indent || (ind === indent && !/^\s*-(\s|$)/.test(l))) break;
    const kv = /^\s*(?:-\s+)?(from|to)\s*:\s*(.*)$/.exec(l);
    if (kv) {
      add(kv[2].replace(/(^|\s)#.*$/, ''));
      continue;
    }
    const bare = /^\s*-\s+(.*)$/.exec(l);
    if (bare && !/^\s*-\s+\w+\s*:/.test(l)) for (const w of pathWords(bare[1])) add(w);
  }
  return out;
}

// One plan as the graph reads it, from its PLAN.md text and its id (32-07).
export function planInfo(text, id) {
  const prefix = prefixOf(id);
  const wave = frontScalar(text, 'wave');
  const files = (frontList(text, 'files_modified') ?? []).map(normPath).filter(Boolean);
  const deleted = (frontList(text, 'files_deleted') ?? []).map(normPath).filter(Boolean);
  const writes = [...new Set([...files, ...deleted])];
  return {
    id,
    declaredWave: /^\d+$/.test(wave ?? '') ? Number(wave) : null,
    dependsOn: dependIds((frontList(text, 'depends_on') ?? []).filter((d) => d && !/^(none|-|—)$/i.test(d)), prefix),
    writes,
    reads: keyLinkPaths(text).filter((p) => !writes.some((w) => pathsMeet(w, p))),
    autonomous: frontScalar(text, 'autonomous') !== 'false',
    gapClosure: frontScalar(text, 'gap_closure') === 'true',
  };
}

// depends_on resolved against the phase's plans: { deps: Map id -> [ids], dropped: [{ plan, token }] }. A token that
// names no plan of the phase (another phase's plan, a typo) is dropped, as GSD drops it (phase.cjs #3427).
export function resolveDeps(plans) {
  const byCanon = new Map(plans.map((p) => [canonId(p.id), p.id]));
  const deps = new Map();
  const dropped = [];
  for (const p of plans) {
    const ids = [];
    for (const t of p.dependsOn) {
      const hit = byCanon.get(canonId(t));
      if (hit && hit !== p.id) {
        if (!ids.includes(hit)) ids.push(hit);
      } else dropped.push({ plan: p.id, token: t });
    }
    deps.set(p.id, ids);
  }
  return { deps, dropped };
}

// GSD's waves: 1 + the longest depends_on path into the plan (Kahn's algorithm, as phase.cjs computeDependencyLevels).
// Map id -> wave. A cycle throws, as GSD refuses one.
export function gsdWaves(plans, deps = resolveDeps(plans).deps) {
  const level = new Map();
  const indeg = new Map(plans.map((p) => [p.id, deps.get(p.id).length]));
  const succ = new Map(plans.map((p) => [p.id, []]));
  for (const p of plans) for (const d of deps.get(p.id)) succ.get(d).push(p.id);
  const queue = plans.filter((p) => indeg.get(p.id) === 0).map((p) => p.id);
  for (const id of queue) level.set(id, 1);
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const s of succ.get(cur)) {
      level.set(s, Math.max(level.get(s) ?? 0, level.get(cur) + 1));
      indeg.set(s, indeg.get(s) - 1);
      if (indeg.get(s) === 0) queue.push(s);
    }
  }
  if (queue.length < plans.length) throw new Error(`depends_on cycle among: ${plans.filter((p) => indeg.get(p.id) > 0).map((p) => p.id).join(', ')}`);
  return level;
}

// The plans in the order implicit edges follow: GSD's wave, then the declared wave (the planner's file bumps), then the
// id. Every depends_on edge goes forward in it, so edges that also only go forward keep the graph acyclic.
export function planOrder(plans, waves = gsdWaves(plans)) {
  const cmpId = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  return [...plans].sort((a, b) => waves.get(a.id) - waves.get(b.id) || (a.declaredWave ?? 0) - (b.declaredWave ?? 0) || cmpId(a.id, b.id));
}

// The edges of the graph, of the kinds asked (EDGE_KINDS): [{ from, to, kind, why }], from before to.
// - depends: the plan's depends_on (why: '');
// - files: a later plan changes or deletes a file an earlier plan changes or deletes (why: the file);
// - reads: a later plan's key_links name a file an earlier plan changes or deletes, and it does not change that file
//   itself (why: the file).
// An implicit edge already given by depends_on is not repeated.
export function planEdges(plans, kinds = EDGE_KINDS) {
  const { deps } = resolveDeps(plans);
  const order = planOrder(plans, gsdWaves(plans, deps));
  const edges = [];
  const has = new Set();
  const add = (from, to, kind, why) => {
    const key = `${from}>${to}`;
    if (has.has(key)) return;
    has.add(key);
    edges.push({ from, to, kind, why });
  };
  if (kinds.includes('depends')) for (const p of order) for (const d of deps.get(p.id)) add(d, p.id, 'depends', '');
  for (let j = 0; j < order.length; j++) {
    for (let i = 0; i < j; i++) {
      const a = order[i];
      const b = order[j];
      if (kinds.includes('files')) {
        const f = firstMeeting(a.writes, b.writes);
        if (f) {
          add(a.id, b.id, 'files', f);
          continue;
        }
      }
      if (kinds.includes('reads')) {
        const r = firstMeeting(a.writes, b.reads);
        if (r) add(a.id, b.id, 'reads', r);
      }
    }
  }
  return edges;
}

const fixed = (x) => Math.round(x * 1000) / 1000;

// GSD's schedule: the waves in order; a wave's plans in parallel (at most maxExecutors at once, dispatched in id
// order) or, when two of them share a written file, one at a time; after each wave its tail (merges, test gate,
// tracking commit). minutes: Map id -> active minutes. waves: Map id -> wave (gsdWaves by default).
// { total, waves: [{ wave, ids, sequential, overlap: { a, b, file } | null, exec, tail }], start, end } (Maps).
export function simulateWaves(plans, { minutes, tail = 0, maxExecutors = Infinity, waves = gsdWaves(plans) }) {
  const numbers = [...new Set(plans.map((p) => waves.get(p.id)))].sort((a, b) => a - b);
  const start = new Map();
  const end = new Map();
  const out = [];
  let t = 0;
  for (const w of numbers) {
    const ps = planOrder(plans.filter((p) => waves.get(p.id) === w), waves);
    let overlap = null;
    for (let j = 0; j < ps.length && !overlap; j++) {
      for (let i = 0; i < j && !overlap; i++) {
        const f = firstMeeting(ps[i].writes, ps[j].writes);
        if (f) overlap = { a: ps[i].id, b: ps[j].id, file: f };
      }
    }
    const k = overlap ? 1 : Math.max(1, maxExecutors);
    const free = Array.from({ length: Math.min(k, ps.length) }, () => t);
    for (const p of ps) {
      free.sort((a, b) => a - b);
      const s = free.shift();
      start.set(p.id, s);
      end.set(p.id, fixed(s + minutes.get(p.id)));
      free.push(end.get(p.id));
    }
    const done = ps.length ? Math.max(...ps.map((p) => end.get(p.id))) : t;
    out.push({ wave: w, ids: ps.map((p) => p.id), sequential: Boolean(overlap) && ps.length > 1, overlap, exec: fixed(done - t), tail });
    t = fixed(done + tail);
  }
  return { total: t, waves: out, start, end };
}

// Longest remaining path from each plan to the end, each plan weighing its minutes plus one merge: the ready queue's
// priority. Map id -> minutes.
function remaining(plans, edges, minutes, merge) {
  const succ = new Map(plans.map((p) => [p.id, []]));
  for (const e of edges) succ.get(e.from).push(e.to);
  const memo = new Map();
  const visit = (id, stack = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (stack.has(id)) throw new Error(`edge cycle through ${id}`);
    stack.add(id);
    const v = minutes.get(id) + merge + Math.max(0, ...succ.get(id).map((s) => visit(s, stack)));
    stack.delete(id);
    memo.set(id, v);
    return v;
  };
  for (const p of plans) visit(p.id);
  return memo;
}

// The ready queue (spec §4.3): a plan starts as soon as every plan it needs (edges) is merged and an executor is free
// (at most maxExecutors at once), the longest remaining path first, then plan order; a finished plan waits for the one
// merge at a time (merge minutes each, merge plus targeted tests), in the order plans finished; its dependents become
// ready when its merge ends. { total, start, end, merged } (Maps); total is the end of the last merge.
export function simulateGraph(plans, edges, { minutes, merge = 0, maxExecutors = Infinity }) {
  const order = planOrder(plans);
  const rank = new Map(order.map((p, i) => [p.id, i]));
  const prio = remaining(plans, edges, minutes, merge);
  const preds = new Map(plans.map((p) => [p.id, 0]));
  const succ = new Map(plans.map((p) => [p.id, []]));
  for (const e of edges) {
    preds.set(e.to, preds.get(e.to) + 1);
    succ.get(e.from).push(e.to);
  }
  const ready = order.filter((p) => preds.get(p.id) === 0).map((p) => p.id);
  const start = new Map();
  const end = new Map();
  const merged = new Map();
  let running = [];
  const queue = [];
  let merging = null;
  let t = 0;
  const k = Math.max(1, maxExecutors);
  while (merged.size < plans.length) {
    ready.sort((a, b) => prio.get(b) - prio.get(a) || rank.get(a) - rank.get(b));
    while (running.length < k && ready.length) {
      const id = ready.shift();
      start.set(id, t);
      end.set(id, fixed(t + minutes.get(id)));
      running.push(id);
    }
    if (!merging && queue.length) {
      const id = queue.shift();
      merging = { id, end: fixed(t + merge) };
    }
    const next = Math.min(...running.map((id) => end.get(id)), merging ? merging.end : Infinity);
    if (!Number.isFinite(next)) throw new Error(`no plan can start: ${plans.filter((p) => !merged.has(p.id)).map((p) => p.id).join(', ')}`);
    t = next;
    const finished = running.filter((id) => end.get(id) <= t).sort((a, b) => end.get(a) - end.get(b) || rank.get(a) - rank.get(b));
    running = running.filter((id) => end.get(id) > t);
    queue.push(...finished);
    if (merging && merging.end <= t) {
      merged.set(merging.id, merging.end);
      for (const s of succ.get(merging.id)) {
        preds.set(s, preds.get(s) - 1);
        if (preds.get(s) === 0) ready.push(s);
      }
      merging = null;
    }
  }
  return { total: t, start, end, merged };
}

// The critical path of the graph: the plans of the longest chain, each weighing its minutes plus one merge.
// { ids, minutes }.
export function criticalPath(plans, edges, { minutes, merge = 0 }) {
  const prio = remaining(plans, edges, minutes, merge);
  const succ = new Map(plans.map((p) => [p.id, []]));
  for (const e of edges) succ.get(e.from).push(e.to);
  const rank = new Map(planOrder(plans).map((p, i) => [p.id, i]));
  const best = (ids) => [...ids].sort((a, b) => prio.get(b) - prio.get(a) || rank.get(a) - rank.get(b))[0];
  const hasPred = new Set(edges.map((e) => e.to));
  let id = best(plans.map((p) => p.id).filter((x) => !hasPred.has(x)));
  const ids = [];
  while (id) {
    ids.push(id);
    id = succ.get(id).length ? best(succ.get(id)) : null;
  }
  return { ids, minutes: ids.length ? fixed(prio.get(ids[0])) : 0 };
}

// What each edge costs: the ready queue's time with the edge minus without it. [{ ...edge, saves }], the costliest first.
export function edgeCosts(plans, edges, opts) {
  const base = simulateGraph(plans, edges, opts).total;
  return edges
    .map((e, i) => ({ ...e, saves: fixed(base - simulateGraph(plans, edges.filter((_, j) => j !== i), opts).total) }))
    .sort((a, b) => b.saves - a.saves || EDGE_KINDS.indexOf(a.kind) - EDGE_KINDS.indexOf(b.kind) || a.from.localeCompare(b.from, 'en', { numeric: true }) || a.to.localeCompare(b.to, 'en', { numeric: true }));
}
