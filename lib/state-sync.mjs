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

// Status values GSD writes itself (state-document.cjs KNOWN_TEMPLATE_DEFAULTS and KNOWN_STATUS_PATTERNS, in
// short); any other Status is the owner's or a controller's text.
const GSD_STATUS = /^(?:ready to (?:execute|plan)|planning complete|defining requirements|executing|in progress|planning|verifying|completed?|done|phase complete\b.*|(?:executing|planning|verifying) phase\s+\S+|phase\s+\S+\s+complete)$/i;
const MARKER = /\s*\(Executing Phase\s+[^)\s]+\)$/i;

// The Status state-sync sends, or undefined to leave it. begin-phase resumes (keeps the plan) when the Status
// contains `Executing Phase <n>` anywhere. The owner's text stays first and the marker goes at its end:
// advance-plan and planned-phase replace a Status that starts with `Executing Phase`, and keep other text.
function statusFor(current, n) {
  if (new RegExp(`Executing Phase\\s+${escapeRe(n)}\\b`, 'i').test(current)) return undefined;
  const text = current.replace(MARKER, '').trim();
  return !text || GSD_STATUS.test(text) ? `Executing Phase ${n}` : `${text} (Executing Phase ${n})`;
}

// The lines GSD's begin-phase writes over Status and Last activity on every run (and the Last activity
// state-sync wrote up to 0.3.1): never the owner's words.
const BEGUN = {
  Status: /^Executing Phase\s+\S+$/i,
  'Last activity': /^\d{4}-\d{2}-\d{2}\s+—\s+Phase\s+\S+\s+(?:execution started|execution resumed \(wave continue\)|stopped; next plan \S+)$/i,
};
const begun = (fields) => Object.keys(BEGUN).filter((f) => f in fields && BEGUN[f].test(fields[f]));

// The text begin-phase replaced: for each of `inside`'s fields that carries begin-phase's line (and each of
// `also` once one does), its value in the newest of the last 50 commits of STATE.md whose Current Position
// carries none of those lines, where it differs; {} when there is no such commit.
function replacedText(root, stateFile, inside, also = []) {
  const marked = begun(inside);
  if (marked.length) marked.push(...also.filter((f) => f in inside));
  if (!marked.length) return {};
  const rel = relTo(root, stateFile);
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  let commits;
  try {
    commits = git(['log', '-n', '50', '--format=%H', '--', rel]).split(/\s+/).filter(Boolean);
  } catch {
    return {}; // not a repository, or git failed: nothing to take back
  }
  for (const sha of commits) {
    let old;
    try {
      old = positionFields(git(['show', `${sha}:./${rel}`])).inside;
    } catch {
      continue;
    }
    if (begun(old).length) continue;
    return Object.fromEntries(marked.filter((f) => f in old && old[f] !== inside[f]).map((f) => [f, old[f]]));
  }
  return {};
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
export function stateSync({ root, phase, gsd }) {
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
      const commit = ask(['commit', message, '--files', '.planning/STATE.md']);
      if (!commit.committed && !commit.skipped && commit.reason !== 'nothing_to_commit') throw new Error(`gsd-tools commit: ${commit.reason || 'not committed'}`);
      return commit.committed ? 'committed' : String(commit.reason || 'not committed');
    } catch (err) {
      if (before) fs.writeFileSync(stateFile, before);
      throw new Error(`${String(err?.message ?? err).split(/\r?\n/)[0]}; STATE.md was put back as it was`);
    }
  };
  if (!open.length) {
    // every plan has a SUMMARY: nothing to resume. A re-run of execute-phase (final-gate's, for example) still
    // runs begin-phase, which leaves its Status line; then the position and the text it reset go back
    if (!begun(inside).includes('Status')) return { synced: false, reason: 'every plan has a summary' };
    const planAt = /^(\d+)/.exec(inside.Plan ?? '')?.[1];
    const fix = {
      Plan: planAt !== undefined && Number(planAt) !== total ? `${total} of ${total}` : undefined,
      'Current Plan': 'Current Plan' in inside && inside['Current Plan'] !== String(total) ? String(total) : undefined,
      ...replacedText(root, stateFile, inside, ['Phase']),
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
  const next = open[0];
  const at = plans.findIndex((p) => String(p.id) === next) + 1 || total - open.length + 1;
  const done = total - open.length;
  const name = init.phase_name ? ` (${init.phase_name})` : '';
  // what begin-phase wrote over the owner's text goes back first
  const text = replacedText(root, stateFile, inside);
  const status = text.Status ?? inside.Status ?? '';
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
  return { synced: true, phase: n, next, at, total, restored: Object.keys(text), outside: outside.filter((f) => f in want && f !== 'Last activity'), commit };
}
