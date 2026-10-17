import { lanesSettings, loadConfig } from './config.mjs';
import { isSlot } from './paths.mjs';
import { SlotRefused, listSlots, removeSlot, setupSlots, sweepRemoving } from './slots.mjs';
import { claudeJsonPath, trustSlot } from './trust.mjs';

export const LANES_USAGE = 'lanes setup [--no-trust-write] | lanes trust [--no-trust-write] | lanes remove [<k>]';
const errLine = (e) => String(e?.message ?? e).split(/\r?\n/)[0];

function trustText(k, t) {
  if (t.status === 'trusted') return `lane-${k}: trusted`;
  if (t.status === 'already') return `lane-${k}: trusted (already)`;
  return `lane-${k}: ${t.line} (${t.why})`;
}

// Leftovers of earlier removes: deleted now, or still held (the next lanes setup or remove tries again).
function sweptText(swept, out) {
  for (const p of swept.removed) out(`leftover deleted: ${p}`);
  for (const { path: p, why } of swept.kept) out(`leftover kept: ${p} (${why}): close what holds it; the next turbo-run lanes setup or remove deletes it`);
}

function setup(root, config, d, out, err) {
  const r = setupSlots(root, config, d);
  sweptText(r.swept, out);
  let code = 0;
  for (const s of r.slots) {
    if (s.action === 'refused') {
      err(`lane-${s.k}: refused: ${s.why}`);
      code = 1;
      continue;
    }
    out(`lane-${s.k}: ${s.action} ${s.path}`);
    out(trustText(s.k, s.trust));
    if (s.trust.status === 'manual' && code === 0) code = 3;
  }
  if (r.backup) out(`backup of ${d.claudeJson}: ${r.backup}`);
  return code;
}

function trust(root, config, d, out) {
  const run = {};
  let code = 0;
  for (const s of listSlots(root, config, d)) {
    if (s.state === 'missing' || s.state === 'foreign') continue;
    const t = trustSlot(s.path, { file: d.claudeJson, write: d.trustWrite, run, lang: config.lang, now: d.now });
    out(trustText(s.k, t));
    if (t.status === 'manual') code = 3;
  }
  if (run.backup) out(`backup of ${d.claudeJson}: ${run.backup}`);
  return code;
}

function remove(root, config, k, d, out, err) {
  sweptText(sweepRemoving(root, config, d), out);
  const ks = k === null ? listSlots(root, config, d).filter((s) => s.state !== 'missing' && s.state !== 'foreign').map((s) => s.k) : [k];
  // one backup of .claude.json for the whole command, as setup and trust make: a backup per slot would let a remove of
  // more slots than the backups kept prune the one from before the command
  const trustRun = {};
  let code = 0;
  try {
    for (const n of ks) {
      try {
        const r = removeSlot(root, config, n, { ...d, trustRun });
        if (!r.removed) {
          out(`lane-${n}: nothing to remove`);
          continue;
        }
        out(`lane-${n}: removed ${r.path}`);
        if (r.leftover) out(`lane-${n}: ${r.leftover} could not be deleted entirely: close what holds it; the next turbo-run lanes setup or remove deletes it`);
        if (r.untrust?.status === 'manual') out(`lane-${n}: ${r.untrust.line} (${r.untrust.why})`);
      } catch (e) {
        if (!(e instanceof SlotRefused)) throw e;
        err(`lane-${n}: refused: ${e.message}`);
        code = 1;
      }
    }
  } finally {
    if (trustRun.backup) out(`backup of ${d.claudeJson}: ${trustRun.backup}`);
  }
  return code;
}

// spec §4, §4.1: the slot commands of the owner (and of the supervisor's start, through lib/slots.mjs directly).
// Exit 0: every slot ready; 1: a slot or the command refused; 2: usage; 3: a slot waits for the owner to accept its
// trust in Claude Code. Never inside a lane, never inside a slot.
export function runLanesCommand(args, { root, out = (l) => process.stdout.write(`${l}\n`), err = (l) => process.stderr.write(`${l}\n`), env = process.env, deps = {} } = {}) {
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project') i++;
    else if (!args[i].startsWith('--')) pos.push(args[i]);
  }
  const [sub, which, extra] = pos;
  const okWhich = which === undefined || (sub === 'remove' && /^[1-9]\d*$/.test(which));
  if (!['setup', 'trust', 'remove'].includes(sub) || !okWhich || extra !== undefined) {
    err(`usage: turbo-run ${LANES_USAGE}`);
    return 2;
  }
  if (env.TURBO_LANE) {
    err("refused: turbo-run lanes is the owner's and the supervisor's: a lane never runs it");
    return 1;
  }
  if (isSlot(root)) {
    err(`refused: ${root} is a lane slot: run turbo-run lanes in the main checkout`);
    return 1;
  }
  let config;
  let lanes;
  try {
    config = deps.config || loadConfig(root);
    lanes = lanesSettings(config.lanes);
  } catch (e) {
    err(`turbo-run lanes ${sub}: ${errLine(e)}`);
    return 1;
  }
  const claudeJson = deps.claudeJson || claudeJsonPath(env);
  const d = { ...deps, config, claudeJson, trustWrite: lanes.trust_write && !args.includes('--no-trust-write') };
  try {
    if (sub === 'setup') return setup(root, config, d, out, err);
    if (sub === 'trust') return trust(root, config, d, out);
    return remove(root, config, which === undefined ? null : Number(which), d, out, err);
  } catch (e) {
    if (!(e instanceof SlotRefused)) throw e;
    err(`turbo-run lanes ${sub}: ${e.message}`);
    return 1;
  }
}
