import { isSlot } from './paths.mjs';
import { readSlotRecord } from './slots.mjs';
import { normalizePhaseId } from './gsd.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { JOB_STATUSES, writeAnnotateAttempt, writeJobStatus } from './run-status.mjs';
import { readLanesFile, readRoadmap } from './lanes-file.mjs';
import { roadmapDigest } from './roadmap-lanes.mjs';
import { outOfScope } from './prep.mjs';

const PHASE_ID = /^[A-Za-z0-9._-]+$/;
const stdoutLine = (l) => process.stdout.write(`${l}\n`);
const stderrLine = (l) => process.stderr.write(`${l}\n`);
const firstLine = (e) => String(e?.message ?? e).split(/\r?\n/)[0];

export const JOB_USAGE = `lane-status <phase> <${JOB_STATUSES.prep.join('|')}> --job prep [--reason <text>] | lane-status annotate <${JOB_STATUSES.annotate.join('|')}> [--reason <text>]`;

// Positional arguments and the values of the flags named.
function parse(args, valued) {
  const pos = [];
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    if (valued.includes(args[i])) values.set(args[i], args[++i] ?? '');
    else if (!args[i].startsWith('--')) pos.push(args[i]);
  }
  return { pos, values };
}

// D11: what keeps a job from its last status (prepped, annotated), or null. The base is the slot record's (L0).
export function finishBlocker(root, job, deps = {}) {
  const base = isSlot(root) ? readSlotRecord(root)?.job?.base?.sha ?? null : null;
  const { dirty, outside } = outOfScope(root, job, { base, ...(deps.git ? { git: deps.git } : {}) });
  if (dirty.length) return `uncommitted changes: ${dirty.join(', ')}; commit them or put them back first`;
  if (outside.length) {
    const where = job.kind === 'prep' ? `the phase directory of phase ${job.phase}` : 'the markup files';
    return `outside ${where}: ${outside.join(', ')} (base ${base}); put each back as it is at the base, commit, and run this again`;
  }
  if (job.kind === 'prep') {
    const dir = findPhaseDir(root, job.phase);
    if (!dir || !phaseArtifacts(dir).context) return `phase ${job.phase} has no CONTEXT.md: prep is not done`;
  }
  if (job.kind === 'annotate' && !readLanesFile(root)?.fresh) return 'lanes.json is missing or does not match the ROADMAP: run turbo-run annotate apply first';
  return null;
}

// turbo-run lane-status <N> <status> --job prep | lane-status annotate <status> (spec §6.1, §6.2).
export function jobLaneStatus(args, { root, out = stdoutLine, err = stderrLine, deps = {} } = {}) {
  const { pos, values } = parse(args, ['--job', '--reason', '--project']);
  const annotate = pos[0] === 'annotate';
  const kind = annotate ? 'annotate' : values.get('--job');
  const status = pos[1];
  const bad = !root || pos.length !== 2 || !Object.hasOwn(JOB_STATUSES, kind) || !JOB_STATUSES[kind].includes(status)
    || (annotate && values.has('--job') && values.get('--job') !== 'annotate') || (!annotate && !PHASE_ID.test(pos[0] ?? ''));
  if (bad) {
    err(`usage: turbo-run ${JOB_USAGE}`);
    return 2;
  }
  const job = { kind, phase: annotate ? null : normalizePhaseId(pos[0]) };
  try {
    if (status === 'prepped' || status === 'annotated') {
      const why = finishBlocker(root, job, deps);
      if (why) {
        err(`refused: ${why}`);
        return 1;
      }
    }
    writeJobStatus(root, job, status, { reason: values.get('--reason') || '' });
    if (kind === 'annotate') {
      const text = readRoadmap(root);
      writeAnnotateAttempt(root, { status, roadmapSha256: text === null ? null : roadmapDigest(text) });
    }
    out(kind === 'annotate' ? `annotate: ${status}` : `prep ${job.phase}: ${status}`);
    return 0;
  } catch (e) {
    err(`turbo-run lane-status: ${firstLine(e)}`);
    return 1;
  }
}
