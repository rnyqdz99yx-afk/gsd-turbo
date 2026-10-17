import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gsdCoreDir, runDir } from './paths.mjs';
import { readJson } from './fsx.mjs';
import { loadConfig } from './config.mjs';
import { loadPhases, normalizePhaseId, runGsdJson } from './gsd.mjs';
import { createGsdConfig } from './gates.mjs';
import { doctor } from './doctor.mjs';
import { createClaude } from './claude.mjs';
import { isAgentAlive, readLaneStatus } from './run-status.mjs';
import { attendedPhases } from './attend.mjs';
import { AdoptRefused, AdoptUsage, adoptPlan, applyAdopt, formatOverview, formatPlan, nothingToAdopt, parseAnswers, reverifyResult, scanProject, staleClosedLine, supervisorState } from './adopt.mjs';

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

// spec §4.10: start's and status's line about the closed phases turbo skips, or null; never fails the command.
export function closedLineFor(root, lang = 'en') {
  try {
    const core = gsdCoreDir(root);
    if (!core) return null;
    const phases = loadPhases(root, core).phases;
    return staleClosedLine(root, phases, lang, { laneDone: (n) => readLaneStatus(root, n)?.status === 'done' });
  } catch {
    return null;
  }
}

const planJson = (p) => ({
  questions: p.questions, analysis: p.analysis, problems: p.problems,
  changes: p.changes.map((c) => ({ kind: c.kind, text: c.text, paths: c.paths, value: c.value })),
  reverify: p.reverify, forecast: p.forecast, owner: p.owner, plan: p.plan, ...(p.assumed ? { assumed: true } : {}),
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
