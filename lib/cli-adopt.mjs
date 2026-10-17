import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gsdCoreDir, runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { loadConfig } from './config.mjs';
import { loadPhases, normalizePhaseId, runGsdJson } from './gsd.mjs';
import { createGsdConfig } from './gates.mjs';
import { effortApply, leanApply, leanChanges } from './lean.mjs';
import { doctor } from './doctor.mjs';
import { createClaude } from './claude.mjs';
import { isAgentAlive, readLaneStatus } from './run-status.mjs';
import { attendedPhases } from './attend.mjs';
import { AdoptRefused, AdoptUsage, adoptFile, adoptPlan, applyAdopt, closedLine, formatOverview, formatPlan, nothingToAdopt, parseAnswers, readRecord, reverifyResult, scanProject, staleClosedIds, supervisorState } from './adopt.mjs';

// spec §7: turbo-run adopt, the owner's command (/turbo-adopt runs it; a lane never does).
export const ADOPT_USAGE = 'adopt scan [--json] [--lang en|ru] | adopt plan [--answers <id>=<value>,…] [--json] [--lang en|ru] | adopt reverify <phase> | adopt apply --answers <id>=<value>,… --plan-sha <sha256> [--lang en|ru]';
const PHASE_ID = /^[A-Za-z0-9._-]+$/;
const GIT_TIMEOUT_MS = 120000;
const firstLine = (e) => String(e?.message ?? e).split(/\r?\n/)[0];

function parse(args, valued) {
  const pos = [];
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    if (valued.includes(args[i])) values.set(args[i], args[++i] ?? '');
    else if (!args[i].startsWith('--')) pos.push(args[i]);
  }
  return { pos, values };
}

// The real deps of lib/adopt.mjs. supervisorAlive(sup): bin's heartbeat check of supervisor.json.
export function adoptDeps(root, { supervisorAlive = () => false } = {}) {
  const core = gsdCoreDir(root);
  const git = (args) => String(execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' }));
  return {
    core,
    gsd: (args) => {
      if (!core) throw new Error('gsd-core not found');
      return runGsdJson(core, args, { cwd: root });
    },
    gsdGet: (key) => createGsdConfig({ root, core }).get(key),
    git,
    supervisor: () => {
      const sup = readJson(path.join(runDir(root), 'supervisor.json'), null);
      return supervisorState({ sup, alive: supervisorAlive(sup), attended: attendedPhases(root), listAgents: () => createClaude({ root }).list(), isAlive: isAgentAlive });
    },
    doctorMode: () => doctor({ root }).mode,
    // Stage 6 §5.1: lean mode's keys in adopt's one commit; GSD's agent effort through GSD's own effort sync
    ...(core ? {
      lean: {
        changes: () => leanChanges({ cfg: createGsdConfig({ root, core }) }),
        apply: () => leanApply({ root, core, commit: false, effort: () => effortApply({ root, env: process.env }) }),
      },
    } : {}),
  };
}

// The language of adopt's texts: the turbo config's once it exists, else the one the skill passes (spec §4.3).
function langOf(root, asked) {
  if (fs.existsSync(path.join(root, '.planning', 'turbo', 'config.json'))) {
    try {
      return loadConfig(root).lang === 'ru' ? 'ru' : 'en';
    } catch {
      // a broken config is a refusal of scan
    }
  }
  return asked;
}

const stamp = (f) => {
  try {
    const s = fs.statSync(f);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '-';
  }
};
const names = (dir) => {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
};
// What the line depends on: the ROADMAP, adopt.json, every phase directory and its files (plans, summaries, reports),
// and the lanes' records (a lane that said done). A change of any of them reads GSD's phases again.
function closedKey(root) {
  const phasesDir = path.join(root, '.planning', 'phases');
  const parts = [stamp(path.join(root, '.planning', 'ROADMAP.md')), stamp(adoptFile(root))];
  for (const d of names(phasesDir)) parts.push(d, stamp(path.join(phasesDir, d)), ...names(path.join(phasesDir, d)).map((f) => `${f}=${stamp(path.join(phasesDir, d, f))}`));
  for (const f of names(runDir(root)).filter((n) => /^p[^-]+\.json$/.test(n))) parts.push(f, stamp(path.join(runDir(root), f)));
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}
export const closedCacheFile = (root) => path.join(runDir(root), 'closed-phases.json');

// spec §4.10: start's and status's line about the closed phases turbo skips, or null; never fails the command. Review 3:
// nothing while the supervisor runs (running), nothing to read after an adopt that recorded its finished phases, and
// GSD's phase list read only when what the line depends on changed (a cache in run/).
export function closedLineFor(root, lang = 'en', { running = false } = {}) {
  try {
    if (running) return null;
    if (Array.isArray(readRecord(root)?.finished)) return null;
    const core = gsdCoreDir(root);
    if (!core) return null;
    const key = closedKey(root);
    const cached = readJson(closedCacheFile(root), null);
    if (cached?.key === key && Array.isArray(cached.ids)) return closedLine(cached.ids, lang);
    const phases = loadPhases(root, core).phases;
    const ids = staleClosedIds(root, phases, { laneDone: (n) => readLaneStatus(root, n)?.status === 'done' });
    try {
      writeJsonAtomic(closedCacheFile(root), { key, ids });
    } catch { /* a cache only */ }
    return closedLine(ids, lang);
  } catch {
    return null;
  }
}

const planJson = (p) => ({
  questions: p.questions, analysis: p.analysis, problems: p.problems,
  changes: p.changes.map((c) => ({ kind: c.kind, text: c.text, paths: c.paths, value: c.value })),
  reverify: p.reverify, reverifyPending: p.reverifyPending, forecast: p.forecast, owner: p.owner, plan: p.plan, ...(p.assumed ? { assumed: true } : {}),
});

export function runAdoptCommand(args, { root, out = (l) => process.stdout.write(`${l}\n`), err = (l) => process.stderr.write(`${l}\n`), deps = null, supervisorAlive } = {}) {
  const { pos, values } = parse(args, ['--answers', '--plan-sha', '--lang', '--project']);
  const sub = pos[0];
  const lang = values.get('--lang') ?? 'en';
  const usage = (why = '') => {
    err(`${why ? `${why}\n` : ''}usage: turbo-run ${ADOPT_USAGE}`);
    return 2;
  };
  if (!root) {
    err('no .planning directory found');
    return 1;
  }
  if (!['scan', 'plan', 'reverify', 'apply'].includes(sub) || !['en', 'ru'].includes(lang)) return usage();
  if (sub === 'reverify' ? pos.length !== 2 || !PHASE_ID.test(pos[1]) : pos.length !== 1) return usage();
  if (sub === 'apply' && !/^[0-9a-f]{64}$/.test(values.get('--plan-sha') ?? '')) return usage('apply needs --plan-sha <the sha256 that adopt plan printed>');
  const refused = (lines) => {
    for (const l of lines) err(`refused: ${l}`);
    return 1;
  };
  const d = deps ?? adoptDeps(root, { supervisorAlive });
  const json = args.includes('--json');
  try {
    if (sub === 'scan') {
      const r = scanProject(root, { deps: d });
      if (r.refused.length) return refused(r.refused);
      if (json) out(JSON.stringify(r.overview));
      else for (const l of formatOverview(r.overview, langOf(root, lang))) out(l);
      return 0;
    }
    if (sub === 'reverify') {
      const r = reverifyResult(root, normalizePhaseId(pos[1]), { deps: d });
      out(r.kept ? `phase ${r.phase}: re-verified: passed` : `phase ${r.phase}: re-verified: ${r.status}${r.report ? ` (kept closed; report ${r.report})` : ' (kept closed)'}`);
      if (r.reason) out(`  ${r.reason}`);
      if (r.others.length) out(`left by the verifier: ${r.others.join(', ')}: adopt apply refuses until you commit or remove them`);
      return 0;
    }
    const answers = values.has('--answers') ? parseAnswers(values.get('--answers')) : null;
    if (sub === 'plan') {
      const p = adoptPlan(root, { answers, lang: langOf(root, lang), deps: d });
      if (p.refused) return refused(p.refused);
      if (json) out(JSON.stringify(planJson(p)));
      else {
        if (nothingToAdopt(p.overview)) out('nothing to adopt: every phase is done');
        for (const l of formatPlan(p)) out(l);
      }
      return 0;
    }
    const r = applyAdopt(root, { answers: answers ?? {}, plan: values.get('--plan-sha'), lang: langOf(root, lang), deps: d });
    if (r.refused) return refused(r.refused);
    out(r.noChanges ? 'no changes: already adopted' : r.committed ? `committed ${r.committed} chore(turbo): adopt` : `not committed: ${r.commit?.reason ?? 'unknown reason'}`);
    for (const l of r.report) out(l);
    return 0;
  } catch (e) {
    if (e instanceof AdoptUsage) return usage(e.message);
    if (e instanceof AdoptRefused) return refused([e.message]);
    if (/^invalid turbo config /.test(String(e?.message))) return refused([firstLine(e)]);
    throw e;
  }
}
