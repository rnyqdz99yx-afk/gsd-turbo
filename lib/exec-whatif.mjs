import fs from 'node:fs';
import path from 'node:path';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { agentIndex, allProjectDirs, cwdInside, headEntry, planOf, projectDirs, projectKey, readMeta, tailEntries } from './transcripts.mjs';
import { canonId, criticalPath, edgeCosts, EDGE_KINDS, gsdWaves, planEdges, planIdOf, planInfo, resolveDeps, simulateGraph, simulateWaves } from './exec-graph.mjs';

// Stage 6, measure first (spec docs/specs/2026-10-15-stage-6-design.md §2, §5): turbo-run exec-whatif <N> reads a
// finished phase — its plans and how long each one's executor ran — and compares GSD's waves with a ready queue over the
// chosen edges, for 1..max_executors executors. It reads files, git and Claude Code transcripts only: it never writes
// into the project, the run directory or anything else.
//
// Minutes per plan, the best source first:
// - transcripts: every executor subagent of the plan (<claude home>/projects/<key>/<session>/subagents/agent-<id>.jsonl
//   with its .meta.json: an executor type and GSD's description "Execute plan 07 of phase 32" / "Continue plan 32-07
//   …"), from its first to its last entry; a plan's minutes are the union of its agents' spans, so the time a plan
//   stood at a checkpoint waiting for the owner (its agent returned, a continuation agent came later) does not count;
// - git: from the plan's dispatch (the newest commit of the phase's orchestration before the plan's first commit: a
//   tracking commit, a worktree merge or a summary of an earlier wave) to its summary; a dispatch that cannot be found
//   or lies more than max-lead minutes before the first commit becomes the median lead of the other plans (marked ~);
//   in a plan with checkpoints a gap of more than max-gap minutes between two of its commits counts as a wait;
// - --minutes <id>=<m>,…: the owner's own numbers win over both.
// The wave tail (what GSD does between two waves: merges, test gate, tracking commit, the next dispatch) is measured at
// each wave boundary (the next wave's first dispatch minus the wave's last return), median; else 5 minutes.

export const DEFAULT_TAIL_MINUTES = 5;
export const DEFAULT_LEAD_MINUTES = 5;
export const MAX_LEAD_MINUTES = 20;
export const MAX_GAP_MINUTES = 30;
// A wave boundary longer than this held an owner stop or a pause, not a tail: not measured.
export const MAX_TAIL_MINUTES = 60;
// Every row of the executors table up to this many, then only while the time still changes.
const TABLE_ROWS = 4;

export class WhatifRefused extends Error {}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (x) => Math.round(x * 10) / 10;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
// 95 -> 1h35m, 7.4 -> 7m
export const fmtMin = (m) => {
  const n = Math.round(m);
  return n >= 60 ? `${Math.floor(n / 60)}h${String(n % 60).padStart(2, '0')}m` : `${n}m`;
};
const pct = (gain, base) => (base > 0 ? Math.round((gain / base) * 100) : 0);

// The phase's plans, read as the graph reads them: { dir, rel, plans, left, unsummarized }. Gap-closure plans
// (gap_closure: true) ran in a later round, after verification: left out of both schedules.
export function phasePlans(root, phase) {
  const dir = findPhaseDir(root, phase);
  if (!dir) throw new WhatifRefused(`no single phase directory for phase ${phase} under .planning/phases`);
  const all = phaseArtifacts(dir).plans.map((p) => {
    const text = fs.readFileSync(path.join(dir, p.file), 'utf8');
    return { ...planInfo(text, planIdOf(p.id)), file: p.file, hasSummary: p.hasSummary };
  });
  if (!all.length) throw new WhatifRefused(`phase ${phase} has no plans in ${path.basename(dir)}`);
  const plans = all.filter((p) => !p.gapClosure);
  if (!plans.length) throw new WhatifRefused(`phase ${phase} has only gap-closure plans`);
  return {
    dir,
    rel: path.relative(root, dir).split(path.sep).join('/'),
    plans,
    left: all.filter((p) => p.gapClosure).map((p) => p.id),
    unsummarized: plans.filter((p) => !p.hasSummary).map((p) => p.id),
  };
}

// --- git ---

const SEP = '\x1f';
const REC = '\x1e';
// The scope tokens of a conventional subject: "feat(32-07): x" -> ['32-07']; "docs(phase-32): y" -> ['phase-32'].
const scopeOf = (subject) => (/^[A-Za-z]+!?\(([^)]*)\)!?:/.exec(subject)?.[1] ?? '').split(/[,\s]+/).filter(Boolean);

// The commits of the phase's span, oldest first: [{ sha, parents, at (author ms), ct (committer ms), subject }].
function phaseCommits(git, rel) {
  const touched = String(git(['log', '--format=%ct', '--', rel])).split(/\r?\n/).filter(Boolean).map(Number);
  if (!touched.length) return [];
  const since = Math.min(...touched) - 3600;
  const raw = String(git(['log', 'HEAD', `--since=@${since}`, `--format=%H${SEP}%P${SEP}%at${SEP}%ct${SEP}%s${REC}`]));
  return raw.split(REC).map((r) => r.replace(/^\r?\n/, '')).filter(Boolean).map((r) => {
    const [sha, parents, at, ct, subject] = r.split(SEP);
    return { sha, parents: parents ? parents.split(' ') : [], at: Number(at) * 1000, ct: Number(ct) * 1000, subject: subject ?? '' };
  }).reverse();
}

// Per plan from git: Map id -> { start, end, minutes, est, waited }, and the measured wave tails [{ after, minutes }].
export function gitTimes(git, { rel, plans, waves, maxLead = MAX_LEAD_MINUTES, maxGap = MAX_GAP_MINUTES }) {
  const commits = phaseCommits(git, rel);
  const byCanon = new Map(plans.map((p) => [canonId(p.id), p.id]));
  const phaseCanon = canonId(plans[0].id.slice(0, plans[0].id.lastIndexOf('-')));
  const planOfCommit = (c) => scopeOf(c.subject).map((s) => byCanon.get(canonId(s))).find(Boolean) ?? null;
  const own = new Map(plans.map((p) => [p.id, []]));
  for (const c of commits) {
    const id = planOfCommit(c);
    if (id) own.get(id).push(c);
  }
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  // the phase's orchestration: its own scope (docs(phase-32), docs(32)) and merges of a branch whose tip is a plan's
  const phaseScoped = (c) => scopeOf(c.subject).some((s) => canonId(s.replace(/^phase-/i, '')) === phaseCanon);
  const mergesPlan = (c) => c.parents.length > 1 && c.parents.slice(1).some((p) => bySha.has(p) && planOfCommit(bySha.get(p)));
  const markers = commits.filter((c) => !planOfCommit(c) && (phaseScoped(c) || mergesPlan(c)));
  const summaryRe = /^docs\([^)]*\):\s*complete\b/i;
  const raw = new Map();
  for (const p of plans) {
    const cs = own.get(p.id);
    if (!cs.length) continue;
    const first = Math.min(...cs.map((c) => c.at));
    const done = cs.filter((c) => summaryRe.test(c.subject));
    const end = Math.max(...(done.length ? done : cs).map((c) => c.at));
    // the plan's dispatch: the newest marker, or summary of a plan of an earlier wave, at or before its first commit
    const earlier = plans.filter((q) => waves.get(q.id) < waves.get(p.id)).flatMap((q) => own.get(q.id).filter((c) => summaryRe.test(c.subject)));
    const before = [...markers, ...earlier].filter((c) => c.ct <= first).map((c) => c.ct);
    const dispatch = before.length ? Math.max(...before) : null;
    const lead = dispatch === null ? null : (first - dispatch) / 60000;
    let waited = 0;
    if (!p.autonomous) {
      const times = cs.map((c) => c.at).sort((a, b) => a - b);
      for (let i = 1; i < times.length; i++) {
        const gap = (times[i] - times[i - 1]) / 60000;
        if (gap > maxGap) waited += gap;
      }
    }
    raw.set(p.id, { first, end, lead, dispatch, waited });
  }
  const goodLeads = [...raw.values()].map((r) => r.lead).filter((l) => l !== null && l <= maxLead);
  const fallback = median(goodLeads) ?? DEFAULT_LEAD_MINUTES;
  const times = new Map();
  for (const [id, r] of raw) {
    const est = r.lead === null || r.lead > maxLead;
    const lead = est ? fallback : r.lead;
    const start = r.first - lead * 60000;
    times.set(id, { start, end: r.end, minutes: round1(Math.max(0, (r.end - start) / 60000 - r.waited)), est, waited: round1(r.waited), dispatch: est ? null : r.dispatch });
  }
  return { times, tails: boundaryTails(plans, waves, times, (t) => t.dispatch) };
}

// The measured tails: at each boundary between two waves that both have times, the next wave's first dispatch minus the
// wave's last end, when that lies within 0..MAX_TAIL_MINUTES. [{ after: <wave>, minutes }].
function boundaryTails(plans, waves, times, dispatchOf) {
  const numbers = [...new Set(plans.map((p) => waves.get(p.id)))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < numbers.length; i++) {
    const ends = plans.filter((p) => waves.get(p.id) === numbers[i]).map((p) => times.get(p.id)?.end);
    const starts = plans.filter((p) => waves.get(p.id) === numbers[i + 1]).map((p) => (times.has(p.id) ? dispatchOf(times.get(p.id)) : null)).filter((x) => x != null);
    if (!starts.length || ends.some((e) => e == null)) continue;
    const m = (Math.min(...starts) - Math.max(...ends)) / 60000;
    if (m >= 0 && m <= MAX_TAIL_MINUTES) out.push({ after: numbers[i], minutes: round1(m) });
  }
  return out;
}

// --- transcripts ---

const tsOf = (e) => (e && typeof e.timestamp === 'string' && Number.isFinite(Date.parse(e.timestamp)) ? Date.parse(e.timestamp) : null);
function lastTimestamp(file) {
  const { entries } = tailEntries(file, { max: 64 * 1024 });
  for (let i = entries.length - 1; i >= 0; i--) if (tsOf(entries[i]) !== null) return tsOf(entries[i]);
  return null;
}
// Spans merged: total minutes of their union.
function unionMinutes(spans) {
  const s = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of s) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) total += cur[1] - cur[0];
  return total / 60000;
}

// The transcript directories of the project: its own spellings, and every project directory of its slots (and of
// executor worktrees under them). Subagent transcripts live in the directory of the session that dispatched them.
export function transcriptDirs(home, root, slotsBase) {
  const dirs = new Set(projectDirs(home, root));
  const prefixes = [projectKey(path.resolve(root)), slotsBase ? projectKey(path.resolve(slotsBase)) : null].filter(Boolean);
  for (const d of allProjectDirs(home)) if (prefixes.some((k) => path.basename(d) === k || path.basename(d).startsWith(`${k}-`))) dirs.add(d);
  return [...dirs];
}

// Per plan from the executor transcripts: Map id -> { start, end, minutes, agents }, and the measured tails.
// An agent counts when its type names an executor (or it has no type and its description executes or continues a
// plan), its description names a plan of this phase, and its first entry's cwd lies in the project or its slots.
export function transcriptTimes({ home, root, slotsBase = null, plans, waves }) {
  const byCanon = new Map(plans.map((p) => [canonId(p.id), p.id]));
  const spans = new Map();
  for (const [, found] of agentIndex(transcriptDirs(home, root, slotsBase))) {
    for (const { file } of found) {
      const meta = readMeta(file);
      const description = typeof meta.description === 'string' ? meta.description : '';
      const type = typeof meta.agentType === 'string' ? meta.agentType : '';
      if (type ? !/executor/i.test(type) : !/^\s*(execute|continue)\b/i.test(description)) continue;
      const id = byCanon.get(canonId(planOf(description).plan ?? ''));
      if (!id) continue;
      let head;
      let end;
      try {
        head = headEntry(file);
        end = lastTimestamp(file);
      } catch {
        continue; // gone meanwhile
      }
      const start = tsOf(head);
      if (start === null || end === null || end < start) continue;
      if (typeof head.cwd === 'string' && head.cwd && !cwdInside(head.cwd, root) && !(slotsBase && cwdInside(head.cwd, slotsBase))) continue;
      if (!spans.has(id)) spans.set(id, []);
      spans.get(id).push([start, end]);
    }
  }
  const times = new Map();
  for (const [id, s] of spans) {
    times.set(id, { start: Math.min(...s.map((x) => x[0])), end: Math.max(...s.map((x) => x[1])), minutes: round1(unionMinutes(s)), agents: s.length });
  }
  return { times, tails: boundaryTails(plans, waves, times, (t) => t.start) };
}

// --- the comparison ---

// Parses --minutes 32-07=12,32-09=8.5 into Map canon id -> minutes; a bad entry throws.
export function parseMinutes(text) {
  const out = new Map();
  for (const part of String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([^=\s]+)=(\d+(?:\.\d+)?)$/.exec(part);
    if (!m) throw new WhatifRefused(`--minutes takes <plan id>=<minutes>,…; got "${part}"`);
    out.set(canonId(m[1]), Number(m[2]));
  }
  return out;
}

// The whole what-if (spec §5.2). deps: { git, home, slotsBase }. opts: { maxExecutors, tail, merge, minutes (Map),
// kinds, transcripts (bool), maxLead, maxGap }. Returns the result object --json prints.
export function whatIf(root, phase, { git, home, slotsBase = null }, opts = {}) {
  const { rel, plans, left, unsummarized } = phasePlans(root, phase);
  const { deps, dropped } = resolveDeps(plans);
  const waves = gsdWaves(plans, deps);
  const kinds = opts.kinds ?? [...EDGE_KINDS];
  const g = gitTimes(git, { rel, plans, waves, maxLead: opts.maxLead ?? MAX_LEAD_MINUTES, maxGap: opts.maxGap ?? MAX_GAP_MINUTES });
  const t = opts.transcripts === false ? { times: new Map(), tails: [] } : transcriptTimes({ home, root, slotsBase, plans, waves });
  const overrides = opts.minutes ?? new Map();
  const minutes = new Map();
  const source = new Map();
  for (const p of plans) {
    if (overrides.has(canonId(p.id))) {
      minutes.set(p.id, overrides.get(canonId(p.id)));
      source.set(p.id, 'option');
    } else if (t.times.has(p.id)) {
      minutes.set(p.id, t.times.get(p.id).minutes);
      source.set(p.id, 'transcripts');
    } else if (g.times.has(p.id)) {
      minutes.set(p.id, g.times.get(p.id).minutes);
      source.set(p.id, g.times.get(p.id).est ? 'git~' : 'git');
    }
  }
  const missing = plans.filter((p) => !minutes.has(p.id)).map((p) => p.id);
  const fill = median([...minutes.values()]) ?? 10;
  for (const id of missing) {
    minutes.set(id, fill);
    source.set(id, 'median');
  }
  // the tail: the option, else measured (transcripts first), else the estimate
  const measured = t.tails.length ? { from: 'transcripts', list: t.tails } : g.tails.length ? { from: 'git', list: g.tails } : null;
  const tail = opts.tail != null
    ? { minutes: opts.tail, from: 'option', list: measured?.list ?? [] }
    : measured ? { minutes: round1(median(measured.list.map((x) => x.minutes))), from: measured.from, list: measured.list } : { minutes: DEFAULT_TAIL_MINUTES, from: 'estimate', list: [] };
  const merge = opts.merge != null ? { minutes: opts.merge, from: 'option' } : { minutes: tail.minutes, from: 'tail' };
  const maxK = Math.max(1, Math.min(opts.maxExecutors ?? 20, plans.length));
  const edges = planEdges(plans, kinds);
  const wavesSim = simulateWaves(plans, { minutes, tail: tail.minutes, maxExecutors: opts.maxExecutors ?? 20, waves });
  const declared = plans.every((p) => p.declaredWave !== null) && plans.some((p) => p.declaredWave !== waves.get(p.id))
    ? simulateWaves(plans, { minutes, tail: tail.minutes, maxExecutors: opts.maxExecutors ?? 20, waves: new Map(plans.map((p) => [p.id, p.declaredWave])) }).total
    : null;
  const table = [];
  for (let k = 1; k <= maxK; k++) {
    const r = simulateGraph(plans, edges, { minutes, merge: merge.minutes, maxExecutors: k });
    table.push({ k, total: r.total, gain: round1(wavesSim.total - r.total) });
  }
  const best = table.reduce((b, r) => (r.total < b.total ? r : b), table[0]);
  const run = simulateGraph(plans, edges, { minutes, merge: merge.minutes, maxExecutors: best.k });
  const half = simulateGraph(plans, edges, { minutes, merge: merge.minutes / 2, maxExecutors: best.k }).total;
  const dependsOnly = simulateGraph(plans, planEdges(plans, ['depends']), { minutes, merge: merge.minutes, maxExecutors: best.k }).total;
  const critical = criticalPath(plans, edges, { minutes, merge: merge.minutes });
  const costs = edgeCosts(plans, edges, { minutes, merge: merge.minutes, maxExecutors: best.k }).filter((e) => e.saves > 0).slice(0, 8);
  // what happened: the span of the executors' work, from the source most plans have
  const span = (m) => {
    const xs = [...m.values()];
    if (!xs.length) return null;
    const from = Math.min(...xs.map((x) => x.start));
    const to = Math.max(...xs.map((x) => x.end));
    return { from: iso(from), to: iso(to), minutes: round1((to - from) / 60000) };
  };
  const observed = t.times.size >= g.times.size && t.times.size ? { ...span(t.times), from_: 'transcripts' } : g.times.size ? { ...span(g.times), from_: 'git' } : null;
  return {
    phase: String(phase),
    plans: plans.map((p) => ({
      id: p.id,
      wave: waves.get(p.id),
      declaredWave: p.declaredWave,
      autonomous: p.autonomous,
      minutes: minutes.get(p.id),
      source: source.get(p.id),
      waited: g.times.get(p.id)?.waited || 0,
      agents: t.times.get(p.id)?.agents ?? 0,
      startWaves: wavesSim.start.get(p.id),
      startGraph: run.start.get(p.id),
    })),
    left,
    unsummarized,
    dropped,
    observed: observed && { from: observed.from, to: observed.to, minutes: observed.minutes, source: observed.from_ },
    busy: round1([...minutes.values()].reduce((s, x) => s + x, 0)),
    tail,
    merge,
    kinds,
    edges: Object.fromEntries(EDGE_KINDS.map((k) => [k, edges.filter((e) => e.kind === k).length])),
    waves: { total: wavesSim.total, list: wavesSim.waves, declaredTotal: declared },
    graph: table,
    best: { k: best.k, total: best.total, gain: best.gain, percent: pct(best.gain, wavesSim.total), halfMerge: half, dependsOnly },
    critical,
    costs,
    maxExecutors: maxK,
  };
}

const SOURCE_WORD = { transcripts: 'transcripts', git: 'git', 'git~': 'git, start estimated', option: '--minutes', median: 'no timing: median of the others' };

// The text the owner reads (English, like the other diagnostics).
export function formatWhatIf(r) {
  const lines = [];
  const counts = {};
  for (const p of r.plans) counts[p.source] = (counts[p.source] ?? 0) + 1;
  lines.push(`phase ${r.phase}: ${r.plans.length} plans${r.left.length ? ` · left out (gap closure): ${r.left.join(', ')}` : ''}`);
  lines.push(`timings: ${Object.entries(counts).map(([s, n]) => `${SOURCE_WORD[s]} ${n}`).join(' · ')}`);
  if (r.unsummarized.length) lines.push(`not finished: ${r.unsummarized.join(', ')} have no SUMMARY (their minutes are what was measured so far, or the median)`);
  if (r.dropped.length) lines.push(`depends_on dropped (no plan of the phase): ${r.dropped.map((d) => `${d.plan} → ${d.token}`).join(', ')}`);
  if (r.observed) lines.push(`measured: executors ran from ${r.observed.from} to ${r.observed.to} (${fmtMin(r.observed.minutes)} wall clock, ${r.observed.source}), busy ${fmtMin(r.busy)} in total`);
  const tailWhy = r.tail.from === 'estimate' ? 'estimate: no wave boundary measured'
    : r.tail.from === 'option' ? '--tail-minutes'
      : `median of ${r.tail.list.length} wave boundaries (${r.tail.from}): ${r.tail.list.map((x) => fmtMin(x.minutes)).join(' ')}`;
  lines.push(`assumptions: wave tail ${fmtMin(r.tail.minutes)} (${tailWhy}) · merge after each plan ${fmtMin(r.merge.minutes)} (${r.merge.from === 'tail' ? 'as a wave tail; --merge-minutes' : '--merge-minutes'}) · edges ${r.kinds.join('+')}: depends_on ${r.edges.depends}, files ${r.edges.files}, key_links ${r.edges.reads}`);
  lines.push('');
  lines.push(`GSD waves: ${fmtMin(r.waves.total)} (${r.waves.list.length} waves by depends_on)`);
  for (const w of r.waves.list) {
    const how = w.sequential ? ` one at a time (${w.overlap.a} and ${w.overlap.b} both change ${w.overlap.file})` : '';
    lines.push(`  wave ${w.wave}: ${w.ids.join(' ')}${how} · ${fmtMin(w.exec)} + tail ${fmtMin(w.tail)}`);
  }
  if (r.waves.declaredTotal !== null) lines.push(`  (by the plans' declared waves: ${fmtMin(r.waves.declaredTotal)})`);
  lines.push(`ready queue (graph), by executors at once:`);
  const rows = r.graph.filter((row, i) => i < TABLE_ROWS || row.total !== r.graph[i - 1].total || row.k === r.best.k);
  for (const row of rows) lines.push(`  ${String(row.k).padStart(2)}: ${fmtMin(row.total).padStart(6)}  ${row.gain >= 0 ? '−' : '+'}${fmtMin(Math.abs(row.gain))} (${row.gain >= 0 ? '−' : '+'}${Math.abs(pct(row.gain, r.waves.total))} %)`);
  if (rows.length < r.graph.length) lines.push(`  (rows not shown: the same time as the row above)`);
  lines.push(`gain: ${fmtMin(r.best.gain)} of ${fmtMin(r.waves.total)} (${r.best.percent} %) at ${r.best.k} executors · with a merge at half a wave tail: ${fmtMin(r.best.halfMerge)} · with depends_on edges only: ${fmtMin(r.best.dependsOnly)}`);
  const byId = new Map(r.plans.map((p) => [p.id, p]));
  lines.push(`critical path ${fmtMin(r.critical.minutes)}: ${r.critical.ids.map((id) => `${id} ${fmtMin(byId.get(id).minutes)}`).join(' → ')} (+ ${fmtMin(r.merge.minutes)} merge each)`);
  if (r.costs.length) {
    lines.push(`costliest edges (time the ready queue would save without it, at ${r.best.k} executors):`);
    for (const e of r.costs) lines.push(`  ${e.from} → ${e.to}  ${e.kind === 'depends' ? 'depends_on' : e.kind === 'files' ? `files: ${e.why}` : `key_links: ${e.why}`}  ${fmtMin(e.saves)}`);
  } else lines.push('costliest edges: none (no single edge holds the ready queue back)');
  lines.push('plans: id · wave · minutes · source · start in waves → in graph');
  for (const p of r.plans) {
    const extra = [p.autonomous ? '' : 'checkpoints', p.waited ? `${fmtMin(p.waited)} waits cut` : '', p.agents > 1 ? `${p.agents} agents` : ''].filter(Boolean).join(', ');
    lines.push(`  ${p.id} · ${p.wave} · ${fmtMin(p.minutes)} · ${SOURCE_WORD[p.source]}${extra ? ` (${extra})` : ''} · ${fmtMin(p.startWaves)} → ${fmtMin(p.startGraph)}`);
  }
  return lines;
}

export const WHATIF_USAGE = 'exec-whatif <phase> [--json] [--max-executors <k>] [--tail-minutes <m>] [--merge-minutes <m>] [--minutes <id>=<m>,…] [--edges depends,files,reads] [--no-transcripts] [--max-lead <m>] [--max-gap <m>]';
export const WHATIF_VALUE_FLAGS = ['--max-executors', '--tail-minutes', '--merge-minutes', '--minutes', '--edges', '--max-lead', '--max-gap'];

// turbo-run exec-whatif: parse, run, print. deps: { git, home, slotsBase, maxExecutors (the config's) }.
export function runExecWhatif(args, { root, out, err, deps }) {
  const pos = [];
  const v = new Map();
  for (let i = 0; i < args.length; i++) {
    if (WHATIF_VALUE_FLAGS.includes(args[i])) v.set(args[i], args[++i] ?? '');
    else if (args[i] === '--project') i++;
    else if (!args[i].startsWith('--')) pos.push(args[i]);
  }
  const usage = (why) => {
    err(`${why}\nusage: turbo-run ${WHATIF_USAGE}`);
    return 2;
  };
  if (!root) return usage('no .planning directory found');
  if (pos.length !== 1 || !/^[A-Za-z0-9._-]+$/.test(pos[0])) return usage('exec-whatif needs one phase');
  const num = (flag, { min = 0, int = false } = {}) => {
    if (!v.has(flag)) return undefined;
    const n = Number(v.get(flag));
    if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) throw new WhatifRefused(`${flag} takes a number${int ? ' (whole)' : ''} ≥ ${min}`);
    return n;
  };
  try {
    const kinds = v.has('--edges') ? v.get('--edges').split(',').map((s) => s.trim()).filter(Boolean) : [...EDGE_KINDS];
    const bad = kinds.filter((k) => !EDGE_KINDS.includes(k));
    if (bad.length || !kinds.includes('depends')) throw new WhatifRefused(`--edges takes depends (always) plus files and/or reads; got ${v.get('--edges')}`);
    const r = whatIf(root, pos[0], deps, {
      maxExecutors: num('--max-executors', { min: 1, int: true }) ?? deps.maxExecutors ?? 20,
      tail: num('--tail-minutes'),
      merge: num('--merge-minutes'),
      minutes: parseMinutes(v.get('--minutes')),
      kinds,
      transcripts: !args.includes('--no-transcripts'),
      maxLead: num('--max-lead', { min: 1 }),
      maxGap: num('--max-gap', { min: 1 }),
    });
    if (args.includes('--json')) out(JSON.stringify(r, null, 2));
    else for (const line of formatWhatIf(r)) out(line);
    return 0;
  } catch (e) {
    if (e instanceof WhatifRefused || /cycle/.test(e.message)) {
      err(`refused: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
