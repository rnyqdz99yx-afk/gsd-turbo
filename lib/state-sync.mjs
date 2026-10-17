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

// --- Stage 6 §5.4: STATE.md within lean.state_budget_kb ---
// Sections are h2/h3 headings outside code fences, each up to the next h2 or h3 (an h2's nested h3s are sections of
// their own). Protected (never trimmed): GSD's template sections that carry the position and the decisions; history:
// GSD's log sections and any heading that says history, archive or changelog (EN/RU). Protected names win.
const PROTECTED_RE = /^(?:project reference|current position|decisions(?: made)?|accumulated context|pending todos|blockers(?:\/concerns| & concerns)?|session continuity|deferred items)$/i;
const HISTORY_RE = /^(?:performance metrics|recently completed|quick tasks completed|session (?:log|history)|previous sessions?)$/i;
const HISTORY_WORD_RE = /\b(?:history|archived?|changelog)\b/i;
const HISTORY_RU_RE = /(?<!\p{L})(?:истори|архив|журнал)/iu;
const POINTER_RE = /^_Older entries moved to STATE-ARCHIVE\.md by turbo state-sync \(\d{4}-\d{2}-\d{2}\)\._$/;
const pointerLine = (date) => `_Older entries moved to STATE-ARCHIVE.md by turbo state-sync (${date})._`;
// GSD's own prune file header (bin/lib/state.cjs cmdStatePrune)
const ARCHIVE_HEAD = '# STATE Archive\n\nPruned entries from STATE.md. Recoverable but no longer loaded into agent context.\n\n';
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const bytesOf = (s) => Buffer.byteLength(s, 'utf8');

function stateSections(lines) {
  const out = [];
  let fenced = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    const m = !fenced && /^(#{2,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(l);
    if (!m) return;
    const name = m[2].trim();
    const bare = name.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    const kind = PROTECTED_RE.test(bare) ? 'protected' : HISTORY_RE.test(bare) || HISTORY_WORD_RE.test(bare) || HISTORY_RU_RE.test(bare) ? 'history' : 'other';
    out.push({ start: i, end: lines.length, name, kind });
  });
  for (let k = 0; k + 1 < out.length; k++) out[k].end = out[k + 1].start;
  return out;
}

// A history section's trimmable lines (indices): the data rows of its markdown tables when it has one (headers stay),
// else every non-blank body line but a pointer line; with the table headers the archive keeps for each table.
function trimmable(lines, s) {
  const rows = [];
  const heads = [];
  let i = s.start + 1;
  while (i < s.end) {
    if (!lines[i].trim().startsWith('|')) {
      i++;
      continue;
    }
    const from = i;
    while (i < s.end && lines[i].trim().startsWith('|')) i++;
    const sep = lines.slice(from, i).findIndex((l) => TABLE_SEP_RE.test(l));
    if (sep < 0) continue;
    heads.push(...Array.from({ length: sep + 1 }, (_, k) => from + k));
    for (let k = from + sep + 1; k < i; k++) rows.push(k);
  }
  if (heads.length) return { idx: rows, heads };
  const idx = [];
  for (let k = s.start + 1; k < s.end; k++) if (lines[k].trim() && !POINTER_RE.test(lines[k].trim())) idx.push(k);
  return { idx, heads: [] };
}

// Trims history sections, largest first, until STATE.md is within budgetKb; each trimmed heading gets one pointer line
// (dated). Pure: archiveText is STATE-ARCHIVE.md now ('' when new) and archive what it becomes. Byte counts.
// -> { text, archive, moved: [heading], before, after, over }
export function trimStateHistory(text, { budgetKb, date, archiveText = '' }) {
  const budget = budgetKb * 1024;
  const before = bytesOf(text);
  if (before <= budget) return { text, archive: archiveText, moved: [], before, after: before, over: false };
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const sections = stateSections(lines);
  const candidates = sections
    .filter((s) => s.kind === 'history')
    .map((s) => ({ ...s, ...trimmable(lines, s) }))
    .filter((s) => s.idx.length)
    .map((s) => ({ ...s, bytes: s.idx.reduce((n, k) => n + bytesOf(lines[k]) + eol.length, 0) }))
    .sort((a, b) => b.bytes - a.bytes || a.start - b.start);
  const render = (chosen) => {
    const by = new Map(chosen.map((s) => [s.start, s]));
    const out = [];
    for (let i = 0; i < lines.length;) {
      const s = by.get(i);
      if (!s) {
        out.push(lines[i]);
        i++;
        continue;
      }
      const drop = new Set(s.idx);
      const keep = lines.slice(s.start + 1, s.end).filter((l, k) => !drop.has(s.start + 1 + k) && !POINTER_RE.test(l.trim()));
      while (keep.length && !keep[0].trim()) keep.shift();
      out.push(lines[s.start], '', pointerLine(date), ...(keep.length ? ['', ...keep] : ['']));
      i = s.end;
    }
    return out.join(eol);
  };
  const chosen = [];
  let next = text;
  for (const s of candidates) {
    chosen.push(s);
    next = render(chosen);
    if (bytesOf(next) <= budget) break;
  }
  if (!chosen.length) return { text, archive: archiveText, moved: [], before, after: before, over: true };
  const block = chosen.map((s) => `### ${s.name}\n\n${[...s.heads, ...s.idx].sort((a, b) => a - b).map((k) => lines[k]).join('\n')}\n\n`).join('');
  const archive = `${archiveText || ARCHIVE_HEAD}## Trimmed ${date} by turbo state-sync (STATE.md budget ${budgetKb} KB)\n\n${block}`;
  const after = bytesOf(next);
  return { text: next, archive, moved: chosen.map((s) => s.name), before, after, over: after > budget };
}

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

const STATE_REL = '.planning/STATE.md';
const ARCHIVE_REL = '.planning/STATE-ARCHIVE.md';
const pad2 = (n) => String(n).padStart(2, '0');

// The budget's steps for one state-sync: trim() writes STATE.md and its archive in place and names the archive for the
// commit; putBack() returns the archive's bytes (the caller puts STATE.md back); alone(gsd) trims and commits by itself.
function stateBudget(root, budgetKb, now) {
  const stateFile = path.join(root, '.planning', 'STATE.md');
  const archiveFile = path.join(root, '.planning', 'STATE-ARCHIVE.md');
  // the local date, as GSD's own prune dates its blocks
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f) : null);
  let saved = null;
  const b = {
    result: null,
    trim() {
      saved = { state: read(stateFile), archive: read(archiveFile), wrote: false };
      if (!saved.state) return [];
      const t = trimStateHistory(saved.state.toString('utf8'), { budgetKb, date, archiveText: saved.archive ? saved.archive.toString('utf8') : '' });
      b.result = { moved: t.moved, before: t.before, after: t.after, over: t.over };
      if (!t.moved.length) return [];
      saved.wrote = true;
      fs.writeFileSync(stateFile, t.text);
      fs.writeFileSync(archiveFile, t.archive);
      return [ARCHIVE_REL];
    },
    putBack({ state = false } = {}) {
      if (!saved?.wrote) return;
      if (state) fs.writeFileSync(stateFile, saved.state);
      if (saved.archive) fs.writeFileSync(archiveFile, saved.archive);
      else fs.rmSync(archiveFile, { force: true });
    },
    alone(gsd) {
      if (!b.trim().length) return b.result;
      try {
        const c = gsd(['commit', `docs(state): keep STATE.md within its ${budgetKb} KB budget`, '--files', STATE_REL, ARCHIVE_REL]);
        if (!c || typeof c !== 'object' || c.error || (!c.committed && !c.skipped && c.reason !== 'nothing_to_commit')) throw new Error(`gsd-tools commit: ${c?.error || c?.reason || 'not committed'}`);
      } catch (err) {
        b.putBack({ state: true });
        throw new Error(`${String(err?.message ?? err).split(/\r?\n/)[0]}; STATE.md was put back as it was`);
      }
      return b.result;
    },
  };
  return b;
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
