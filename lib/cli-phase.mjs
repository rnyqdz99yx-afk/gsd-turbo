import path from 'node:path';
import { gsdCoreDir } from './paths.mjs';
import { normalizePhaseId, runGsdJson } from './gsd.mjs';
import { STEPS, completeStep, nextStep, readProgress, resetProgress } from './phase-progress.mjs';
import { phaseDirMatches, phasesDir } from './phase-files.mjs';
import { artifactFiles, gitRunner, headSha, recordBases, stalenessReport } from './staleness.mjs';
import { createGsdConfig, docsCommitsOff, docsCommitsRestore, ensureChunkedParallel, gatesOff, gatesRestore } from './gates.mjs';

// Stage-2 subcommands. bin/turbo-run.mjs routes these names here.
export const PHASE_COMMANDS = new Set(['phase-step', 'staleness', 'gates', 'jobs', 'uat']);

// No path separators: a phase id only ever names files inside turbo's own directories.
const PHASE_ID = /^[A-Za-z0-9._-]+$/;
const VALUE_FLAGS = new Set(['--project', '--done', '--note', '--results', '--log']);

class UsageError extends Error {}
export const usage = (text) => { throw new UsageError(text); };
export const fail = (text) => { throw new Error(text); };

export function parseArgs(args) {
  const pos = [];
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) flags.set(a, args[++i] ?? '');
    else if (a.startsWith('--')) flags.set(a, true);
    else pos.push(a);
  }
  return { pos, flags };
}

export function phaseArg(pos, i, text) {
  const p = pos[i];
  if (!p || !PHASE_ID.test(p)) usage(text);
  return normalizePhaseId(p);
}

export const coreOrFail = (root) => gsdCoreDir(root) || fail('gsd-core not found (run turbo-run doctor)');
export const relTo = (root, p) => path.relative(root, p).split(path.sep).join('/');

// One entry per subcommand; later tasks add theirs.
export const HANDLERS = {
  'phase-step': phaseStep,
  staleness,
  gates,
};

export async function runPhaseCommand(cmd, args, { root, out = (l) => process.stdout.write(`${l}\n`), err = (l) => process.stderr.write(`${l}\n`), deps = {} } = {}) {
  try {
    const handler = Object.hasOwn(HANDLERS, cmd) ? HANDLERS[cmd] : usage(`<${[...PHASE_COMMANDS].join('|')}> ... (unknown command ${cmd})`);
    return (await handler({ root, out, err, deps, ...parseArgs(args) })) ?? 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`usage: turbo-run ${e.message}`);
      return 2;
    }
    err(`turbo-run ${cmd}: ${String(e?.message ?? e).split(/\r?\n/)[0]}`);
    return 1;
  }
}

function phaseStep({ root, pos, flags, out }) {
  const phase = phaseArg(pos, 0, 'phase-step <phase> [--done <step> [--note <text>] | --reset] [--json]');
  if (flags.has('--reset')) {
    resetProgress(root, phase);
    out(`phase ${phase}: progress reset`);
    return 0;
  }
  let p = readProgress(root, phase);
  if (flags.has('--done')) p = completeStep(root, phase, String(flags.get('--done')), { note: String(flags.get('--note') || '') });
  const next = nextStep(p);
  if (flags.has('--json')) out(JSON.stringify({ phase, done: p.done, next, steps: STEPS }));
  else out(`phase ${phase}: next ${next ?? 'none'}${p.done.length ? ` (done: ${p.done.join(', ')})` : ''}`);
  return 0;
}

// Several matches mean unrelated projects share .planning/phases (GSD #2237): name them, never pick one.
export function phaseDirOrFail(root, phase) {
  const hit = phaseDirMatches(root, phase);
  if (hit.length > 1) fail(`phase ${phase} is ambiguous: ${hit.join(', ')} — resolve it in .planning/phases`);
  if (!hit.length) fail(`no phase directory for phase ${phase} under .planning/phases`);
  return path.join(phasesDir(root), hit[0]);
}

function planIndex(root, phase, deps) {
  if (deps.planIndex) return deps.planIndex(phase);
  // A missing or ambiguous phase still exits 0 with `{error, plans: []}`: never read that as no plans.
  const r = runGsdJson(coreOrFail(root), ['phase-plan-index', phase], { cwd: root });
  if (r.error) fail(`gsd-tools phase-plan-index ${phase}: ${r.error}`);
  return r.plans || [];
}

// An artifact named on the command line, as artifactFiles names it: "plans/<file>" for the nested
// layout, the bare file name otherwise.
const artifactName = (f) => {
  const n = String(f).replace(/\\/g, '/');
  return /(?:^|\/)(plans\/[^/]+)$/.exec(n)?.[1] ?? path.posix.basename(n);
};

function staleness({ root, pos, flags, out, deps }) {
  const phase = phaseArg(pos, 0, 'staleness <phase> [--json] | staleness <phase> --record <file>... | staleness <phase> --record-all');
  const dir = phaseDirOrFail(root, phase);
  if (flags.has('--record') || flags.has('--record-all')) {
    const all = artifactFiles(dir);
    const names = flags.has('--record-all') ? all : pos.slice(1).map(artifactName);
    if (!names.length) usage('staleness <phase> --record <file>...');
    for (const n of names) if (!all.includes(n)) fail(`not a planning artifact of phase ${phase}: ${n}`);
    const head = headSha(gitRunner(root));
    if (!head) {
      out('no commit yet: nothing recorded');
      return 0;
    }
    const file = recordBases(dir, names, head);
    out(`recorded base ${head.slice(0, 12)} for ${names.length} artifact(s) in ${relTo(root, file)}`);
    return 0;
  }
  const report = stalenessReport({ root, phaseDir: dir, plans: planIndex(root, phase, deps) });
  if (flags.has('--json')) {
    out(JSON.stringify(report));
    return 0;
  }
  if (report.skipped) out(`phase ${phase}: ${report.skipped}`);
  else if (!report.artifacts.length) out(`phase ${phase}: no planning artifacts yet`);
  for (const x of report.artifacts) out(`${x.action.padEnd(8)} ${x.file}${x.reasons.length ? `: ${x.reasons.join('; ')}` : ''}`);
  return 0;
}

const GATE_SUBS = { off: gatesOff, restore: gatesRestore, 'docs-off': docsCommitsOff, 'docs-restore': docsCommitsRestore };

function gates({ root, pos, out, deps }) {
  const [sub] = pos;
  if (sub !== 'chunked' && !Object.hasOwn(GATE_SUBS, sub)) usage('gates <off|restore|docs-off|docs-restore> <phase> | gates chunked');
  const cfg = deps.gsdConfig || createGsdConfig({ root, core: coreOrFail(root) });
  if (sub === 'chunked') {
    const r = ensureChunkedParallel({ root, cfg });
    out(r.note || `planning.chunked_parallel: true${r.changed ? ' (set and committed)' : ''}`);
    return 0;
  }
  const phase = phaseArg(pos, 1, `gates ${sub} <phase>`);
  const r = GATE_SUBS[sub]({ root, phase, cfg });
  const commit = r.commit ? `; ${r.commit.committed ? 'committed' : r.commit.reason}` : '';
  out(`gates ${sub} ${phase}: ${r.changed ? 'done' : 'nothing to do'}${commit}`);
  return 0;
}
