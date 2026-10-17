import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readProgress } from './phase-progress.mjs';
// Stage 6 §5.4: the STATE.md budget (lib/state-budget.mjs)
import { stateBudget, trimStateHistory } from './state-budget.mjs';

export { trimStateHistory };

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

// The value on the body line at `at`: a table row's second cell, else what follows the bold or plain label.
function valueAt(body, at) {
  const line = body.slice(at).split('\n')[0].replace(/\r$/, '');
  if (line.startsWith('|')) return line.split('|')[2].trim();
  const bold = /^\s*\*\*[^*\r\n]+?(?::\*\*|\*\*:)[ \t]*(.*)$/.exec(line);
  return (bold ? bold[1] : line.slice(line.indexOf(':') + 1)).trim();
}

// The fields GSD's state patch would write inside Current Position, with their values now; and those it would
// write elsewhere (an archive, a summary at the top: GSD #2956). Fields STATE.md does not have are left out.
const POSITION = ['Phase', 'Plan', 'Current Plan', 'Total Plans in Phase', 'Status', 'Last activity'];
function positionFields(stateText) {
  const body = stateText.replace(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const cp = currentPosition(body);
  const inside = {};
  const outside = [];
  for (const field of POSITION) {
    const at = firstMatch(body, field);
    if (at < 0) continue;
    if (cp && at >= cp.start && at < cp.end) inside[field] = valueAt(body, at);
    else outside.push(field);
  }
  return { inside, outside };
}

// Status values GSD writes itself (state-document.cjs KNOWN_TEMPLATE_DEFAULTS and KNOWN_STATUS_PATTERNS); any
// other Status is the owner's or a controller's text.
const GSD_STATUS = /^(?:ready to (?:execute|plan)|planning complete|defining requirements|executing|in progress|planning|verifying|completed?\s*[✓✔✅☑]?|done|active|paused|unknown|all phases complete|\S+\s+milestone complete|phase complete\b.*|phase\s+\d+\s+complete\b.*|(?:executing|planning|verifying) phase\s+\S+.*)$/iu;
// Last activity values GSD writes itself: a bare date, or a date and one of its transition notes (and the note
// state-sync wrote up to 0.3.1).
const GSD_ACTIVITY = /^\d{4}-\d{2}-\d{2}(?:\s+—\s+Phase\s+\S+\s+(?:execution started|execution resumed \(wave continue\)|stopped; next plan \S+|marked complete|planning complete|complete(?:, transitioned to Phase \S+)?))?$/i;
// The owner's words in a Status: without the executing marker, at its end or (as GSD writes it) at its start.
const ownStatus = (status) => status.replace(/\s*\(Executing Phase\s+[^)\s]+\)$/i, '').replace(/^Executing Phase\s+\S+(?:\s*[—–-]\s*|$)/i, '').trim();
const gsdWrote = {
  Status: (v) => !ownStatus(v) || GSD_STATUS.test(ownStatus(v)),
  'Last activity': (v) => GSD_ACTIVITY.test(v),
};

// The Status state-sync sends, or undefined to leave it. begin-phase resumes (keeps the plan) when the Status
// contains `Executing Phase <n>` anywhere. The owner's text stays first and the marker goes at its end:
// advance-plan and planned-phase replace a Status that starts with `Executing Phase`, and keep other text.
function statusFor(current, n) {
  const text = ownStatus(current);
  const want = !text || GSD_STATUS.test(text) ? `Executing Phase ${n}` : `${text} (Executing Phase ${n})`;
  return want === current ? undefined : want;
}

// The lines GSD's begin-phase writes over Status and Last activity on every run (and the Last activity
// state-sync wrote up to 0.3.1): never the owner's words.
const BEGUN = {
  Status: /^Executing Phase\s+\S+$/i,
  'Last activity': /^\d{4}-\d{2}-\d{2}\s+—\s+Phase\s+\S+\s+(?:execution started|execution resumed \(wave continue\)|stopped; next plan \S+)$/i,
};
const begun = (fields) => Object.keys(BEGUN).filter((f) => f in fields && BEGUN[f].test(fields[f]));

// The owner's text begin-phase replaced: for each of `inside`'s fields that carries begin-phase's line, its value
// in the newest of the last 50 commits of STATE.md (HEAD first) where that field does not carry it, when that
// value is the owner's (not one GSD wrote itself) and differs from now.
const gitOut = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });

// The Current Position fields of STATE.md as HEAD has them; {} when there is no such commit.
function headFields(root, stateFile) {
  try {
    return positionFields(gitOut(root, ['show', `HEAD:./${relTo(root, stateFile)}`])).inside;
  } catch {
    return {};
  }
}

function replacedText(root, stateFile, inside) {
  const marked = begun(inside);
  if (!marked.length) return {};
  const rel = relTo(root, stateFile);
  const git = (args) => gitOut(root, args);
  let commits;
  try {
    commits = git(['log', '-n', '50', '--format=%H', '--', rel]).split(/\s+/).filter(Boolean);
  } catch {
    return {}; // not a repository, or git failed: nothing to take back
  }
  const found = {};
  for (const sha of commits) {
    if (marked.every((f) => f in found)) break;
    let old;
    try {
      old = positionFields(git(['show', `${sha}:./${rel}`])).inside;
    } catch {
      continue;
    }
    for (const f of marked) if (!(f in found) && f in old && !BEGUN[f].test(old[f])) found[f] = old[f];
  }
  return Object.fromEntries(Object.entries(found).filter(([f, v]) => !gsdWrote[f](v) && v !== inside[f]));
}

// When a file last changed: its last commit time, else (never committed) its mtime; in ms.
function changedAt(root, file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', relTo(root, file)], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30000 }).trim();
    if (/^\d+$/.test(out)) return Number(out) * 1000;
  } catch { /* not a repository, or git failed: the mtime below */ }
  return fs.statSync(file).mtimeMs;
}

const relTo = (root, p) => path.relative(root, p).split(path.sep).join('/');

// GSD's execute-phase starts with state.begin-phase. On a phase already mid-execution it keeps the plan
// position only when STATE.md's Status reads `Executing Phase <its phase token>`; otherwise it resets the plan
// to 1 (and plan-phase's planned-phase flips the phase line to READY TO EXECUTE). After a lane stop this
// writes the real position with GSD's own commands, in the lines begin-phase writes: the phase, the plan (the
// first one without a SUMMARY), and the executing marker in Status (after the owner's text, which stays).
// Never Last activity. Never begin-phase, planned-phase, advance-plan or state sync.
// gsd(args) runs gsd-tools and returns its JSON answer. Returns { synced: false, reason } when there is no
// position to record.
// budgetKb (Stage 6 §5.4, lean.state_budget_kb; null: none): every exit trims STATE.md's history within it, in the
// position's own GSD commit (with .planning/STATE-ARCHIVE.md), else in a commit of its own; the result gains trimmed.
export function stateSync({ root, phase, gsd, budgetKb = null, now = new Date() }) {
  const budget = Number.isInteger(budgetKb) && budgetKb > 0 ? stateBudget(root, budgetKb, now) : null;
  const r = syncPosition({ root, phase, gsd, budget });
  if (!budget) return r;
  return { ...r, trimmed: r.synced ? budget.result : budget.alone(gsd) };
}

function syncPosition({ root, phase, gsd, budget = null }) {
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
  const total = plans.length;
  const stateFile = path.join(root, '.planning', 'STATE.md');
  // the bytes STATE.md had: put back when anything below fails, so a stop never leaves a half-synced or
  // uncommitted STATE.md behind (a dirty tree blocks the next /turbo-autonomous)
  const before = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
  // the position fields only: Last activity, and the owner's text in Status, are not state-sync's to replace
  const { inside, outside } = positionFields(before ? before.toString('utf8') : '');
  // runs the GSD state commands, then GSD's commit (it follows the project's commit_docs setting: skipped on
  // purpose is no failure); on any failure STATE.md gets its bytes back
  const record = (steps, message) => {
    try {
      steps();
      // Stage 6 §5.4: the STATE.md budget rides in the same commit
      const extra = budget ? budget.trim() : [];
      const commit = ask(['commit', message, '--files', '.planning/STATE.md', ...extra]);
      if (!commit.committed && !commit.skipped && commit.reason !== 'nothing_to_commit') throw new Error(`gsd-tools commit: ${commit.reason || 'not committed'}`);
      return commit.committed ? 'committed' : String(commit.reason || 'not committed');
    } catch (err) {
      budget?.putBack();
      if (before) fs.writeFileSync(stateFile, before);
      throw new Error(`${String(err?.message ?? err).split(/\r?\n/)[0]}; STATE.md was put back as it was`);
    }
  };
  if (!open.length) {
    // every plan has a SUMMARY: nothing to resume. A re-run of execute-phase (final-gate's, for example) still
    // runs begin-phase, which leaves its Status line; then the plan goes back, and the Status reads the owner's
    // text or GSD's own end of execution. The phase line stays: begin-phase wrote the phase executing, as it was.
    if (!begun(inside).includes('Status')) return { synced: false, reason: 'every plan has a summary' };
    const text = replacedText(root, stateFile, inside);
    const headStatus = headFields(root, stateFile).Status;
    const planAt = /^(\d+)/.exec(inside.Plan ?? '')?.[1];
    const fix = {
      Plan: planAt !== undefined && Number(planAt) !== total ? `${total} of ${total}` : undefined,
      'Current Plan': 'Current Plan' in inside && inside['Current Plan'] !== String(total) ? String(total) : undefined,
      // the owner's words; else HEAD's Status when begin-phase had not written it (GSD's own, such as
      // `Verifying Phase <N>`: never a step back); else GSD's end of execution
      Status: text.Status ?? (headStatus && !BEGUN.Status.test(headStatus) ? headStatus : 'Phase complete — ready for verification'),
      'Last activity': text['Last activity'],
    };
    const patch = Object.fromEntries(POSITION.filter((f) => fix[f] !== undefined).map((f) => [f, fix[f]]));
    if (!Object.keys(patch).length) return { synced: false, reason: 'every plan has a summary' };
    const commit = record(() => ask(['state', 'patch', JSON.stringify(patch)]), `docs(phase-${n}): put back the STATE.md position that begin-phase reset`);
    return { synced: true, repaired: true, phase: n, fields: Object.keys(patch), commit };
  }
  // before execution starts, begin-phase must take its first-run branch: executing would make it skip that
  if (open.length === plans.length && !readProgress(root, phase).done.includes('gates-off')) {
    return { synced: false, reason: `execution of phase ${n} has not started: no plan has a SUMMARY and step gates-off is not done` };
  }
  // the next plan: the open plan of the lowest wave (GSD's waves follow depends_on), the first of them on a tie
  const waveOf = (id) => Number(plans.find((p) => String(p.id) === id)?.wave) || 0;
  const next = open.reduce((a, b) => (waveOf(b) < waveOf(a) ? b : a));
  const done = total - open.length;
  const at = done + 1;
  const name = init.phase_name ? ` (${init.phase_name})` : '';
  // what begin-phase wrote over the owner's text goes back first
  const text = replacedText(root, stateFile, inside);
  const status = text.Status ?? inside.Status ?? '';
  // statusFor leaves a Status that already reads as it should: the owner's text taken back still goes in
  const want = {
    Phase: `${n}${name} — EXECUTING`,
    Plan: `${at} of ${total}`,
    'Current Plan': String(at),
    'Total Plans in Phase': String(total),
    Status: statusFor(status, n) ?? text.Status,
    'Last activity': text['Last activity'],
  };
  const patch = Object.fromEntries(Object.entries(want).filter(([f, v]) => f in inside && v !== undefined));
  // the resume pointer: the handoff gsd-pause-work wrote when it is newer than every SUMMARY (an older one is
  // left over from an earlier pause), else the next plan
  const dir = path.resolve(root, init.phase_dir);
  const handoff = path.join(dir, '.continue-here.md');
  const summaries = fs.readdirSync(dir).filter((f) => f.endsWith('-SUMMARY.md')).map((f) => changedAt(root, path.join(dir, f)));
  const fresh = fs.existsSync(handoff) && changedAt(root, handoff) > Math.max(-Infinity, ...summaries);
  const resume = [fresh ? handoff : null, path.join(dir, `${next}-PLAN.md`)].find((f) => f && fs.existsSync(f));
  const commit = record(() => {
    if (Object.keys(patch).length) ask(['state', 'patch', JSON.stringify(patch)]);
    ask(['state', 'record-session', '--stopped-at', `Phase ${n}: ${done} of ${total} plans done; next plan ${next}`, ...(resume ? ['--resume-file', relTo(root, resume)] : [])]);
  }, `docs(phase-${n}): record the resume position in STATE.md`);
  return { synced: true, phase: n, next, at, total, restored: Object.keys(text).filter((f) => patch[f] !== undefined && patch[f] !== inside[f]), outside: outside.filter((f) => f in want && f !== 'Last activity'), commit };
}
