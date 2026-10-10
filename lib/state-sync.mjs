import fs from 'node:fs';
import path from 'node:path';

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const relTo = (root, p) => path.relative(root, p).split(path.sep).join('/');

// GSD's execute-phase starts with state.begin-phase. On a phase already mid-execution it keeps the plan
// position only when STATE.md's Status reads `Executing Phase <its phase token>`; otherwise it resets the plan
// to 1 (and plan-phase's planned-phase flips the phase line to READY TO EXECUTE). After a lane stop this
// writes the real position with GSD's own commands, in the lines begin-phase writes: the phase, executing,
// and the first plan without a SUMMARY. Never begin-phase, planned-phase, advance-plan or state sync.
// gsd(args) runs gsd-tools and returns its JSON answer. Returns { synced: false, reason } when there is no
// position to record.
export function stateSync({ root, phase, gsd, now = new Date() }) {
  const ask = (args) => {
    const r = gsd(args);
    if (!r || typeof r !== 'object' || r.error) throw new Error(`gsd-tools ${args.slice(0, 2).join(' ')}: ${r?.error ?? 'no JSON answer'}`);
    return r;
  };
  const init = ask(['init', 'execute-phase', String(phase)]);
  if (!init.phase_found || !init.phase_dir || !init.phase_number) return { synced: false, reason: `phase ${phase} has no phase directory` };
  // the token execute-phase hands begin-phase ("05" for phase 5): its resume check matches that text
  const n = String(init.phase_number);
  const index = ask(['phase-plan-index', n]);
  const plans = Array.isArray(index.plans) ? index.plans : [];
  if (!plans.length) return { synced: false, reason: 'no plans yet' };
  const open = (Array.isArray(index.incomplete) ? index.incomplete : plans.filter((p) => !p.has_summary).map((p) => p.id)).map(String);
  if (!open.length) return { synced: false, reason: 'every plan has a summary' };
  const next = open[0];
  const total = plans.length;
  const at = plans.findIndex((p) => String(p.id) === next) + 1 || total - open.length + 1;
  const done = total - open.length;
  const name = init.phase_name ? ` (${init.phase_name})` : '';
  // fields STATE.md lacks are left out by GSD itself (patch only replaces lines that exist)
  ask(['state', 'patch', JSON.stringify({
    Phase: `${n}${name} — EXECUTING`,
    Plan: `${at} of ${total}`,
    'Current Plan': String(at),
    'Total Plans in Phase': String(total),
    Status: `Executing Phase ${n}`,
    'Last activity': `${localDate(now)} — Phase ${n} stopped; next plan ${next}`,
  })]);
  // the resume pointer: the handoff gsd-pause-work wrote, else the next plan
  const dir = path.resolve(root, init.phase_dir);
  const resume = [path.join(dir, '.continue-here.md'), path.join(dir, `${next}-PLAN.md`)].find((f) => fs.existsSync(f));
  ask(['state', 'record-session', '--stopped-at', `Phase ${n}: ${done} of ${total} plans done; next plan ${next}`, ...(resume ? ['--resume-file', relTo(root, resume)] : [])]);
  // GSD's commit follows the project's commit_docs setting
  const commit = ask(['commit', `docs(phase-${n}): record the resume position in STATE.md`, '--files', '.planning/STATE.md']);
  return { synced: true, phase: n, next, at, total, commit: commit.committed ? 'committed' : String(commit.reason || 'not committed') };
}
