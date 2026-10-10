import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readProgress } from './phase-progress.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Where GSD 1.16's state patch would write `field` in a STATE.md body (state-document.cjs stateReplaceField):
// the first bold field line (`**Field:**` or `**Field**:`, outside code fences), else the first plain
// `Field:` line, else the first two-cell table row `| Field | value |`; case-insensitive. -1 when none.
function firstMatch(body, field) {
  const want = field.toLowerCase();
  let fenced = false;
  let at = 0;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) {
      const m = /^\s*\*\*([^*\r\n]+?)(?::\*\*|\*\*:)/.exec(line);
      if (m && m[1].trim().toLowerCase() === want) return at;
    }
    at += line.length + 1;
  }
  const plain = new RegExp(`^${escapeRe(field)}:`, 'im').exec(body);
  if (plain) return plain.index;
  at = 0;
  for (const line of body.split('\n')) {
    const text = line.replace(/\r$/, '');
    const cells = text.split('|');
    if (text.startsWith('|') && cells.length === 4 && text.trimEnd().endsWith('|') && !/^[\s:-]+$/.test(cells[1]) && cells[1].replace(/\*\*/g, '').trim().toLowerCase() === want) return at;
    at += line.length + 1;
  }
  return -1;
}

// The span of the Current Position section (an h2 or h3 heading up to the next heading of its level or
// above) in a STATE.md body, or null.
function currentPosition(body) {
  const head = /^(#{2,3})[ \t]+Current Position[ \t]*\r?$/im.exec(body);
  if (!head) return null;
  const from = head.index + head[0].length;
  const next = new RegExp(`^#{1,${head[1].length}}[ \\t]`, 'm').exec(body.slice(from));
  return { start: head.index, end: next ? from + next.index : body.length };
}

// Splits the patch into the fields GSD would write inside Current Position, and those it would write
// elsewhere (an archive, a summary at the top: GSD #2956). Fields STATE.md does not have are left out.
function scopedPatch(stateText, fields) {
  const body = stateText.replace(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const cp = currentPosition(body);
  const patch = {};
  const outside = [];
  for (const [field, value] of Object.entries(fields)) {
    const at = firstMatch(body, field);
    if (at < 0) continue;
    if (cp && at >= cp.start && at < cp.end) patch[field] = value;
    else outside.push(field);
  }
  return { patch, outside };
}

// When a file last changed: its last commit time, else (never committed) its mtime; in ms.
function changedAt(root, file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', relTo(root, file)], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30000 }).trim();
    if (/^\d+$/.test(out)) return Number(out) * 1000;
  } catch { /* not a repository, or git failed: the mtime below */ }
  return fs.statSync(file).mtimeMs;
}

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
  // before execution starts, begin-phase must take its first-run branch: executing would make it skip that
  if (open.length === plans.length && !readProgress(root, phase).done.includes('gates-off')) {
    return { synced: false, reason: `execution of phase ${n} has not started: no plan has a SUMMARY and step gates-off is not done` };
  }
  const next = open[0];
  const total = plans.length;
  const at = plans.findIndex((p) => String(p.id) === next) + 1 || total - open.length + 1;
  const done = total - open.length;
  const name = init.phase_name ? ` (${init.phase_name})` : '';
  const stateFile = path.join(root, '.planning', 'STATE.md');
  // the bytes STATE.md had: put back when anything below fails, so a stop never leaves a half-synced or
  // uncommitted STATE.md behind (a dirty tree blocks the next /turbo-autonomous)
  const before = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
  const { patch, outside } = scopedPatch(before ? before.toString('utf8') : '', {
    Phase: `${n}${name} — EXECUTING`,
    Plan: `${at} of ${total}`,
    'Current Plan': String(at),
    'Total Plans in Phase': String(total),
    Status: `Executing Phase ${n}`,
    'Last activity': `${localDate(now)} — Phase ${n} stopped; next plan ${next}`,
  });
  // the resume pointer: the handoff gsd-pause-work wrote when it is newer than every SUMMARY (an older one is
  // left over from an earlier pause), else the next plan
  const dir = path.resolve(root, init.phase_dir);
  const handoff = path.join(dir, '.continue-here.md');
  const summaries = fs.readdirSync(dir).filter((f) => f.endsWith('-SUMMARY.md')).map((f) => changedAt(root, path.join(dir, f)));
  const fresh = fs.existsSync(handoff) && changedAt(root, handoff) > Math.max(-Infinity, ...summaries);
  const resume = [fresh ? handoff : null, path.join(dir, `${next}-PLAN.md`)].find((f) => f && fs.existsSync(f));
  let commit;
  try {
    if (Object.keys(patch).length) ask(['state', 'patch', JSON.stringify(patch)]);
    ask(['state', 'record-session', '--stopped-at', `Phase ${n}: ${done} of ${total} plans done; next plan ${next}`, ...(resume ? ['--resume-file', relTo(root, resume)] : [])]);
    // GSD's commit follows the project's commit_docs setting: skipped on purpose is no failure
    commit = ask(['commit', `docs(phase-${n}): record the resume position in STATE.md`, '--files', '.planning/STATE.md']);
    if (!commit.committed && !commit.skipped && commit.reason !== 'nothing_to_commit') throw new Error(`gsd-tools commit: ${commit.reason || 'not committed'}`);
  } catch (err) {
    if (before) fs.writeFileSync(stateFile, before);
    throw new Error(`${String(err?.message ?? err).split(/\r?\n/)[0]}; STATE.md was put back as it was`);
  }
  return { synced: true, phase: n, next, at, total, outside, commit: commit.committed ? 'committed' : String(commit.reason || 'not committed') };
}
