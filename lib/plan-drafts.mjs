import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { localRunDir } from './paths.mjs';
import { readJson, renameWithRetry, writeFileDurable, writeJsonAtomic } from './fsx.mjs';
import { findPhaseDir, outlineRows, phaseArtifacts, planFileNames, planOutline } from './phase-files.mjs';
import { planDraftsSettings } from './config.mjs';
import { extractRefs, gitRunner } from './staleness.mjs';

// Stage 5 §5 (plan drafts). GSD's chunked planning plans one Wave at a time: a planner reads the plans written before
// its own (G4). Inside the lane's step plan, the plans of the later Waves are first written as drafts, outside the phase
// directory, at the same time as the first Wave; at its Wave each draft is reconciled against the plans before it (now
// written and committed) by a planner revision, and only a reconciled draft becomes the plan, through promote. Any
// failure falls back to GSD's own single-plan call for that plan; GSD's plan checker and revision loop run unchanged.
//
// The record <localRunDir>/drafts-p<N>/drafts.json lives in the lane's own checkout (the slot, or the main checkout in
// checkout mode), next to the draft files, both ignored by git (.planning/turbo/.gitignore's run/): a slot prepared
// anew wipes them together. { v: 1, phase, outline: { file, sha256, plans, waves } | null, lastPlan: { use, why?, at },
// plans: { <id>: { wave, dependsOn, state, draft, blobs: { drafted?, reconciled?, promoted? }, against?: { <id>: <blob> },
// base?: { plans: [<plan files of the phase directory when the agent was sent>] }, reason?, at: { <state>: ISO } } } }. States: drafting → drafted → reconciling → reconciled →
// promoted; replanned (GSD plans it) from any of them. A blob is git's hash of a file (git hash-object, never the raw
// bytes: git's filters apply), the identity every check compares.

export const DRAFT_STATES = Object.freeze(['drafting', 'drafted', 'reconciling', 'reconciled', 'promoted', 'replanned']);
// A drafting record whose agent wrote nothing for this long is an agent a stopped session lost: drafted again.
export const DRAFTING_STALE_MS = 90 * 60 * 1000;
// A record that may have left its draft in the phase directory: never promoted, not handed to GSD.
const UNPROMOTED = new Set(['drafting', 'drafted', 'reconciling', 'reconciled']);
const ASSUMPTIONS_RE = /^##\s+Draft assumptions\s*$/i;
const FENCE_RE = /^\s*(?:```|~~~)/;
const CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

export const draftsDir = (root, phase) => path.join(localRunDir(root), `drafts-p${phase}`);
const recordFile = (root, phase) => path.join(draftsDir(root, phase), 'drafts.json');
export const draftFile = (root, phase, id) => path.join(draftsDir(root, phase), `${id}-PLAN.md`);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The record, or null when absent or not one (a hand-edited or foreign file reads as none).
export function readDrafts(root, phase) {
  const raw = readJson(recordFile(root, phase), null);
  if (!isObj(raw) || raw.v !== 1 || !isObj(raw.plans)) return null;
  const plans = Object.fromEntries(Object.entries(raw.plans).filter(([, e]) => isObj(e) && DRAFT_STATES.includes(e.state)).map(([id, e]) => [id, { ...e, blobs: isObj(e.blobs) ? e.blobs : {}, at: isObj(e.at) ? e.at : {} }]));
  return { ...raw, plans };
}

export function writeDrafts(root, phase, rec) {
  writeJsonAtomic(recordFile(root, phase), rec);
}

const freshRecord = (phase, ol) => ({ v: 1, phase: String(phase), outline: ol ? { file: ol.name, sha256: ol.sha256, plans: ol.rows.length, waves: wavesOf(ol.rows).length } : null, lastPlan: null, plans: {} });

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const planPath = (ol, id) => path.join(ol.dir, `${id}-PLAN.md`);
// GSD's resume check: a plan is written when its file starts with frontmatter (head -1 | grep -q '^---').
const written = (ol, id) => (readText(planPath(ol, id)) ?? '').startsWith('---');

// The phase's outline as drafts read it: { dir, name, file, sha256, prefix, columns, rows } or { why } when there is
// none drafts can use (no phase directory, no outline, several, unfinished).
export function readOutline(root, phase) {
  const dir = findPhaseDir(root, phase);
  if (!dir) return { why: 'no phase directory' };
  const o = planOutline(dir);
  if (!o.outlines.length) return { why: 'no chunked plan outline' };
  if (o.outlines.length > 1) return { why: `more than one plan outline: ${o.outlines.join(', ')}` };
  if (o.unfinished.length) return { why: `the outline ${o.outlines[0]} is unfinished (no ## OUTLINE COMPLETE line)` };
  const name = o.outlines[0];
  const file = path.join(dir, name);
  const text = readText(file) ?? '';
  const prefix = name.replace(/-PLAN-OUTLINE\.md$/i, '');
  return { dir, name, file, sha256: sha256(text), prefix, ...outlineRows(text, prefix) };
}

// What makes the outline unusable for drafts (spec §5.3, B4 order), or null.
function outlineProblem(ol) {
  if (!ol.columns.wave) return 'the outline has no Wave column';
  if (!ol.columns.dependsOn) return 'the outline has no Depends On column';
  if (!ol.rows.length) return 'the outline lists no plan';
  const noId = ol.rows.find((r) => r.id === null);
  if (noId) return `a row of the outline names no plan id: ${noId.row}`;
  const seen = new Set();
  for (const r of ol.rows) {
    if (seen.has(r.id)) return `plan ${r.id} is listed twice`;
    seen.add(r.id);
  }
  const bad = ol.rows.find((r) => !Number.isInteger(r.wave));
  if (bad) return `plan ${bad.id}: its wave is not a whole number from 1`;
  const waveOf = new Map(ol.rows.map((r) => [r.id, r.wave]));
  for (const r of ol.rows) {
    if (r.dependsOn === null) return `plan ${r.id}: its Depends On names no plan id`;
    for (const d of r.dependsOn) {
      if (!waveOf.has(d)) return `plan ${r.id} depends on ${d}, which the outline does not list`;
      if (waveOf.get(d) >= r.wave) return `plan ${r.id} (wave ${r.wave}) depends on ${d} of wave ${waveOf.get(d)}`;
    }
  }
  return null;
}

// The outline's waves in ascending order: [[ids]…] (rows in outline order within a wave).
function wavesOf(rows) {
  const nums = [...new Set(rows.map((r) => r.wave))].filter(Number.isInteger).sort((a, b) => a - b);
  return nums.map((w) => rows.filter((r) => r.wave === w).map((r) => r.id));
}

const mtimeMs = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -Infinity;
  }
};

// A drafting record still at work: its agent wrote the draft, or was started, within DRAFTING_STALE_MS.
function inFlight(root, phase, id, entry, now) {
  if (entry?.state !== 'drafting') return false;
  const last = Math.max(Date.parse(entry.at.drafting) || -Infinity, mtimeMs(draftFile(root, phase, id)));
  return now.getTime() - last <= DRAFTING_STALE_MS;
}

// The record for this outline: reset when the outline changed (another sha256) since the drafts were written (§5.7).
function recordFor(root, phase, ol) {
  const rec = readDrafts(root, phase);
  if (rec && rec.outline?.sha256 === ol.sha256) return rec;
  return freshRecord(phase, ol);
}

// --- git: blobs, commits, and what changed while an agent worked ---

const tryGit = (git, args) => {
  try {
    return String(git(args));
  } catch {
    return null;
  }
};
// A file's blob (git hash-object: files git does not track, and outside a repository too).
export const blobOf = (git, file) => String(git(['hash-object', '--', file])).trim();
// The blob of text as git would store it at file (its path picks the filters, as for the file itself).
export function blobOfText(git, root, phase, text, file) {
  const tmp = path.join(draftsDir(root, phase), `.hash-${process.pid}`);
  try {
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, text);
    return String(git(['hash-object', '--path', rel(root, file), '--', tmp])).trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
// B2: the file's blob when it is committed as it is (nothing to commit, HEAD holds these bytes), else null.
function committedBlob(git, root, file) {
  if (!fs.existsSync(file)) return null;
  const r = rel(root, file);
  const status = tryGit(git, ['status', '--porcelain', '--', r]);
  if (status === null || status.trim()) return null;
  const head = tryGit(git, ['rev-parse', '--verify', '-q', `HEAD:./${r}`])?.trim();
  return head && head === blobOf(git, file) ? head : null;
}
// The blob of the newest commit that added the file (git log -1 --diff-filter=A), or null when none did.
function addedBlob(git, root, file) {
  const r = rel(root, file);
  const c = tryGit(git, ['log', '-1', '--diff-filter=A', '--format=%H', '--', r])?.trim();
  return c ? tryGit(git, ['rev-parse', '--verify', '-q', `${c}:./${r}`])?.trim() || null : null;
}

// The phase directory's plan files (flat <name>-PLAN.md, or GSD's nested plans/) when an agent is sent (--drafting,
// --reconcile). Review C1: GSD's own chunked planners update ROADMAP.md and commit on their own (gsd-planner.md
// update_roadmap, git_commit), so ROADMAP.md, STATE.md and commits tell nothing about a draft agent; only plan-shaped
// files in the phase directory do.
const baseOf = (ol) => ({ plans: planFileNames(ol.dir) });
// Plan files that appeared in the phase directory since base and are no plan of the outline (GSD writes only
// <outline id>-PLAN.md in a chunked run; an outline id's own file is removeStrays' to judge). [] without a base.
const outlineFiles = (ol) => new Set(ol.rows.map((r) => `${r.id}-PLAN.md`));
function newPlanFiles(ol, base) {
  if (!Array.isArray(base?.plans)) return [];
  const before = new Set(base.plans);
  const own = outlineFiles(ol);
  return planFileNames(ol.dir).filter((f) => !before.has(f) && !own.has(f)).map((f) => path.join(ol.dir, ...f.split('/')));
}

// Removes a file an agent wrote into the phase directory: git rm and a commit when it was committed, else unlink.
function removeFile(git, root, ol, file, what) {
  const r = rel(root, file);
  if (tryGit(git, ['ls-files', '--', r])?.trim()) {
    const inHead = Boolean(tryGit(git, ['rev-parse', '--verify', '-q', `HEAD:./${r}`])?.trim());
    git(['rm', '-q', '-f', '--', r]);
    if (inHead) git(['commit', '-q', '-m', `docs(${ol.prefix}): drop ${what}: a draft agent wrote it into the phase directory`, '--', r]);
  } else fs.rmSync(file, { force: true });
  return r;
}

// A draft in the phase directory (critical 1): the plan file of a record of this outline that never promoted it, or any
// whose blob is a recorded drafted or reconciled blob, whatever the record says. turbo removes it (git rm and a commit
// when the agent committed it), so GSD's resume never takes it for a written plan. Returns the removed paths.
function removeStrays(git, root, phase, ol, rec, ids = Object.keys(rec.plans)) {
  const same = rec.outline?.sha256 === ol.sha256;
  const removed = [];
  for (const id of ids) {
    const e = rec.plans[id];
    const file = planPath(ol, id);
    if (!e || !fs.existsSync(file)) continue;
    const blob = tryGit(git, ['hash-object', '--', file])?.trim();
    const draftBlob = [e.blobs.drafted, e.blobs.reconciled].filter(Boolean).includes(blob);
    if (!(same && UNPROMOTED.has(e.state)) && !draftBlob) continue;
    removed.push(removeFile(git, root, ol, file, `plan ${id}`));
  }
  return removed;
}

// Everything the agent sent for id left in the phase directory, removed: its own <id>-PLAN.md and any other new plan
// file that is no plan of the outline (a misnamed 33-02-auth-PLAN.md, say). Returns the removed paths.
function removeAgentFiles(git, root, phase, ol, rec, id, base) {
  const removed = removeStrays(git, root, phase, ol, rec, [id]);
  for (const f of newPlanFiles(ol, base)) if (fs.existsSync(f)) removed.push(removeFile(git, root, ol, f, path.basename(f)));
  return removed;
}

// Promoted plans not committed yet (a session stopped between --promote and GSD's commit) whose file is still the
// promoted one: the lane commits them first, with GSD's message.
function commitFirst(git, root, ol, rec) {
  return ol.rows.map((r) => r.id).filter((id) => {
    const e = rec.plans[id];
    const file = planPath(ol, id);
    return e?.state === 'promoted' && fs.existsSync(file) && !committedBlob(git, root, file) && tryGit(git, ['hash-object', '--', file])?.trim() === e.blobs.promoted;
  });
}

// GSD's plan checker switch (init plan-phase's plan_checker_enabled; GSD 1.16's config-loader reads the flat
// plan_checker, else workflow.plan_check, default on): off, drafts have no checker behind them (review 11).
const planCheckOff = (root) => {
  const c = readJson(path.join(root, '.planning', 'config.json'), null);
  return isObj(c) && (c.plan_checker !== undefined ? c.plan_checker : c.workflow?.plan_check) === false;
};

// The eligibility rule without writing anything: { use: false, why } or { use: true, ol, rec, waves, draftNow, rest,
// open } (open: the first wave holding a plan not written yet; it is GSD's to plan now).
function assess(root, phase, settings, now) {
  if (planCheckOff(root)) return { use: false, why: 'plan checker disabled (plan_checker or workflow.plan_check false in GSD\'s config)', ol: null };
  const ol = readOutline(root, phase);
  if (ol.why) return { use: false, why: ol.why, ol: null };
  const rec = recordFor(root, phase, ol);
  const why = outlineProblem(ol);
  if (why) return { use: false, why, ol, rec };
  const waves = wavesOf(ol.rows);
  const unwritten = ol.rows.filter((r) => !written(ol, r.id));
  const openWaves = [...new Set(unwritten.map((r) => r.wave))];
  // the decision to start drafting; once drafts exist, the run goes on with them whatever is left
  if (!Object.keys(rec.plans).length && openWaves.length < settings.min_waves) {
    return { use: false, why: `${plural(openWaves.length, 'wave')} hold plans not written yet, fewer than plan_drafts.min_waves (${settings.min_waves})`, ol, rec };
  }
  const open = Math.min(...openWaves);
  const free = (r) => !rec.plans[r.id] || (rec.plans[r.id].state === 'drafting' && !inFlight(root, phase, r.id, rec.plans[r.id], now));
  const candidates = unwritten.filter((r) => r.wave > open && free(r)).sort((a, b) => a.wave - b.wave || ol.rows.indexOf(a) - ol.rows.indexOf(b));
  const busy = unwritten.filter((r) => inFlight(root, phase, r.id, rec.plans[r.id], now)).length;
  const n = Math.max(0, settings.max_parallel - busy);
  return { use: true, ol, rec, waves, open, draftNow: candidates.slice(0, n).map((r) => r.id), rest: candidates.slice(n).map((r) => r.id) };
}

// turbo-run plan-drafts N --plan (B4): whether drafts are used for this phase and which plans to draft now (at most
// max_parallel, dispatched once with the first Wave; the rest GSD plans at their Waves). First, on a resume, it removes
// drafts an agent left in the phase directory and names promoted plans still to commit. Writes the answer to the
// record's lastPlan (and resets the record on an outline change), plan_drafts.enabled false too: the measurement line
// then says why drafts were off.
export function draftsPlan(root, phase, { config = {}, now = new Date(), git = gitRunner(root) } = {}) {
  const settings = planDraftsSettings(config.plan_drafts);
  const ol = readOutline(root, phase);
  const old = readDrafts(root, phase);
  const removed = old && !ol.why ? removeStrays(git, root, phase, ol, old) : [];
  const first = old && !ol.why && old.outline?.sha256 === ol.sha256 ? commitFirst(git, root, ol, old) : [];
  const tidy = { removed, commitFirst: first };
  const a = settings.enabled ? assess(root, phase, settings, now) : { use: false, why: 'plan_drafts.enabled is false' };
  const rec = a.rec ?? old ?? freshRecord(phase, ol.why ? null : ol);
  // review I-a: drafts off on a resume (disabled, or GSD's checker off, meanwhile): every draft of this outline not
  // promoted yet is GSD's to plan, so the guard never takes GSD's plan for an unreconciled draft
  if (!a.use && !ol.why && rec.outline?.sha256 === ol.sha256) {
    for (const [id, e] of Object.entries(rec.plans)) {
      if (e.state === 'promoted' || e.state === 'replanned') continue;
      if (e.state === 'drafting' || e.state === 'reconciling') removed.push(...removeAgentFiles(git, root, phase, ol, rec, id, e.base));
      rec.plans[id] = stamp(e, 'replanned', now, { reason: `drafts off: ${a.why}` });
    }
  }
  rec.lastPlan = { use: a.use, ...(a.use ? {} : { why: a.why }), at: now.toISOString() };
  writeDrafts(root, phase, rec);
  return a.use ? { use: true, waves: a.waves, draftNow: a.draftNow, rest: a.rest, ...tidy } : { use: false, why: a.why, ...tidy };
}

const clean = (s) => String(s ?? '').replace(CONTROL_RE, ' ');

// The paragraph the lane adds unchanged at the end of GSD's single-plan prompt for a draft (B6, review critical 2).
export function draftParagraph(root, phase, id, ol = readOutline(root, phase)) {
  const row = ol.rows.find((r) => r.id === id);
  const earlier = ol.rows.filter((r) => r.wave < row.wave);
  return [
    `**Draft (gsd-turbo).** The plans before this one are not written yet. Plan from their outline rows below and from the code as it is now. Write exactly one file, ${draftFile(root, phase, id)}, instead of ${rel(root, ol.dir)}/${id}-PLAN.md, and write nothing in the phase directory. Skip your update_roadmap and git_commit steps; do not edit ROADMAP.md or STATE.md; do not commit. Keep the frontmatter wave: ${row.wave} and depends_on: [${row.dependsOn.join(', ')}] of the outline row. End the plan with a section ## Draft assumptions: per earlier plan, each thing this plan takes from it (a file it creates or changes, a function, type or command it adds, a decision), one line each, starting with that plan's id.`,
    'Outline rows of the earlier plans:',
    '| Plan ID | Objective | Wave | Depends On | Requirements |',
    '|---|---|---|---|---|',
    ...earlier.map((r) => r.row),
  ].map(clean).join('\n');
}

const stamp = (entry, state, now, extra = {}) => ({ ...entry, ...extra, state, at: { ...entry.at, [state]: now.toISOString() } });

// turbo-run plan-drafts N --drafting <id>: records drafting (with the phase directory's plan files) and returns the
// paragraph, or { refused }. A drafting record whose agent was lost (DRAFTING_STALE_MS) loses its partial draft first.
export function startDraft(root, phase, id, { config = {}, now = new Date(), git = gitRunner(root) } = {}) {
  const settings = planDraftsSettings(config.plan_drafts);
  if (!settings.enabled) return { refused: 'drafts off: plan_drafts.enabled is false' };
  const a = assess(root, phase, settings, now);
  if (!a.use) return { refused: `drafts off: ${a.why}` };
  const row = a.ol.rows.find((r) => r.id === id);
  if (written(a.ol, id)) return { refused: `${id} is written already (${rel(root, planPath(a.ol, id))})` };
  if (row.wave <= a.open) return { refused: `${id} is in wave ${row.wave}, the wave GSD plans now: GSD plans it` };
  const entry = a.rec.plans[id];
  if (entry?.state === 'replanned') return { refused: `${id} is replanned: GSD plans it at its wave` };
  if (entry && entry.state !== 'drafting') return { refused: `${id} is ${entry.state} already` };
  if (entry && !inFlight(root, phase, id, entry, now)) fs.rmSync(draftFile(root, phase, id), { force: true });
  const base = baseOf(a.ol);
  a.rec.plans[id] = stamp({ blobs: {}, at: {}, ...entry }, 'drafting', now, { wave: row.wave, dependsOn: row.dependsOn, draft: `${id}-PLAN.md`, base });
  writeDrafts(root, phase, a.rec);
  return { paragraph: draftParagraph(root, phase, id, a.ol) };
}

// --- frontmatter, as GSD's plans write it (agents/gsd-planner.md: wave: N, depends_on: [], files_modified: []) ---

function frontLines(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(text ?? ''));
  return m ? m[1].split(/\r?\n/) : null;
}
const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
const noComment = (s) => s.replace(/(^|\s)#.*$/, '');
// A key's scalar, or null.
export function frontScalar(text, key) {
  const line = frontLines(text)?.find((l) => l.startsWith(`${key}:`));
  return line === undefined ? null : unquote(noComment(line.slice(key.length + 1)));
}
// A key's list (inline [a, b], a block list of - items, or one plain scalar), or null without the key.
export function frontList(text, key) {
  const lines = frontLines(text);
  if (!lines) return null;
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at < 0) return null;
  const rest = noComment(lines[at].slice(key.length + 1)).trim();
  const inline = /^\[(.*)\]$/.exec(rest);
  if (inline) return inline[1].split(',').map(unquote).filter(Boolean);
  if (rest) return [unquote(rest)];
  const out = [];
  for (const l of lines.slice(at + 1)) {
    const m = /^\s*-\s+(.*)$/.exec(l);
    if (!m) break;
    out.push(unquote(noComment(m[1])));
  }
  return out;
}

// The plan ids a depends_on list names, read as the outline's (review 13): a long form 33-01-auth is 33-01, a bare 01
// or 1 is 33-01; an entry naming none stays as written, so it never matches.
export function dependIds(list, prefix) {
  const re = new RegExp(`(?:^|[^\\w.])(${escapeRe(prefix)}-\\d+[A-Za-z]?)(?!\\w)`);
  return [...new Set((list ?? []).map((d) => {
    const bare = /^(\d+)([A-Za-z]?)$/.exec(d);
    return bare ? `${prefix}-${bare[1].padStart(2, '0')}${bare[2]}` : re.exec(d)?.[1] ?? d;
  }))];
}
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

// What keeps a plan text from matching its outline row (frontmatter, wave, depends_on), or null.
function rowMismatch(text, row, prefix) {
  if (!String(text).startsWith('---') || !frontLines(text)) return 'it has no frontmatter';
  const wave = frontScalar(text, 'wave');
  if (!/^\d+$/.test(wave ?? '') || Number(wave) !== row.wave) return `its wave is ${wave || 'missing'}, its outline row says ${row.wave}`;
  const deps = dependIds(frontList(text, 'depends_on') ?? [], prefix);
  if (!sameSet(deps, row.dependsOn)) return `its depends_on is [${deps.join(', ')}], its outline row says [${row.dependsOn.join(', ')}]`;
  return null;
}

// The lines of the draft's ## Draft assumptions section, its heading excluded ([] without one): from its heading to the
// next heading of the same or a higher level, outside code fences.
function assumptionsSpan(lines) {
  let fence = false;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (start < 0 && ASSUMPTIONS_RE.test(lines[i])) start = i;
    else if (start >= 0 && /^#{1,2}\s/.test(lines[i])) return { start, end: i };
  }
  return start < 0 ? null : { start, end: lines.length };
}
const assumptionLines = (text) => {
  const lines = String(text ?? '').split(/\r?\n/);
  const s = assumptionsSpan(lines);
  return s ? lines.slice(s.start + 1, s.end).filter((l) => l.trim()) : [];
};

// The draft without its ## Draft assumptions section (B10), line endings kept, one final newline.
export function stripAssumptions(text) {
  const t = String(text ?? '');
  const nl = t.includes('\r\n') ? '\r\n' : '\n';
  const lines = t.split(/\r?\n/);
  const s = assumptionsSpan(lines);
  if (!s) return t;
  const out = [...lines.slice(0, s.start), ...lines.slice(s.end)];
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return `${out.join(nl)}${nl}`;
}

// B7: what is wrong with the draft the agent returned, or null.
export function checkDraft(root, phase, id, ol = readOutline(root, phase)) {
  if (ol.why) return `drafts off: ${ol.why}`;
  const row = ol.rows.find((r) => r.id === id);
  const target = planPath(ol, id);
  if (fs.existsSync(target)) return `the draft agent wrote into the phase directory: ${rel(root, target)}`;
  const text = readText(draftFile(root, phase, id));
  if (text === null) return `no draft file ${draftFile(root, phase, id)}`;
  const bad = rowMismatch(text, row, ol.prefix);
  if (bad) return `the draft does not match its outline row: ${bad}`;
  if (!assumptionsSpan(text.split(/\r?\n/))) return 'the draft has no ## Draft assumptions section';
  return null;
}

// turbo-run plan-drafts N --drafted <id>: the draft passed checkDraft and the agent wrote no plan file into the phase
// directory → drafted with its blob; or { refused } (plan files the agent wrote there are removed first: removed). The
// draft's blob is recorded either way, so the guard knows a copy of it anywhere in the phase directory (review I2).
export function markDrafted(root, phase, id, { now = new Date(), git = gitRunner(root) } = {}) {
  const ol = readOutline(root, phase);
  if (ol.why) return { refused: `drafts off: ${ol.why}` };
  const rec = recordFor(root, phase, ol);
  const entry = rec.plans[id];
  const file = draftFile(root, phase, id);
  if (entry?.state === 'drafted' && fs.existsSync(file) && blobOf(git, file) === entry.blobs.drafted) return { ok: true };
  if (entry?.state !== 'drafting') return { refused: `${id} is ${entry ? entry.state : 'not drafted'}, not drafting (run --drafting first)` };
  const blob = fs.existsSync(file) ? blobOf(git, file) : null;
  const removed = removeAgentFiles(git, root, phase, ol, rec, id, entry.base);
  const why = removed.length ? `the draft agent wrote into the phase directory: removed ${removed.join(', ')}` : checkDraft(root, phase, id, ol);
  rec.plans[id] = why ? { ...entry, blobs: { ...entry.blobs, ...(blob ? { drafted: blob } : {}) } } : stamp(entry, 'drafted', now, { blobs: { ...entry.blobs, drafted: blob } });
  writeDrafts(root, phase, rec);
  return why ? { refused: why, removed } : { ok: true };
}

// --- reconcile and promote (§5.5) ---

const normPath = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');

// B5 (review 9): the plans a draft builds on: its depends_on, every earlier plan its ## Draft assumptions names, every
// earlier plan whose files_modified meets the draft's files_modified or the paths it cites, and every earlier plan not
// written yet (its files are unknown). In outline order: [{ id, file }].
export function predecessors(root, phase, id, ol = readOutline(root, phase)) {
  const row = ol.rows.find((r) => r.id === id);
  const draft = readText(draftFile(root, phase, id)) ?? '';
  const named = new Set(dependIds(assumptionLines(draft).join(' ').match(new RegExp(`${escapeRe(ol.prefix)}-\\d+[A-Za-z]?`, 'g')) ?? [], ol.prefix));
  const touched = new Set([...(frontList(draft, 'files_modified') ?? []), ...extractRefs(draft).paths].map(normPath));
  return ol.rows.filter((q) => {
    if (q.wave >= row.wave) return false;
    if (row.dependsOn.includes(q.id) || named.has(q.id) || !written(ol, q.id)) return true;
    return (frontList(readText(planPath(ol, q.id)), 'files_modified') ?? []).some((f) => touched.has(normPath(f)));
  }).map((q) => ({ id: q.id, file: planPath(ol, q.id) }));
}

// Any use: gsd answer hands the plan to GSD: the record says replanned, so the guard never mistakes GSD's plan for an
// unreconciled draft.
// A lost agent's plan files in the phase directory go first (second review C1: with the entry's own base).
function handToGsd(root, phase, rec, id, why, now, { git, ol } = {}) {
  const e = rec.plans[id];
  if (e && git && ol && (e.state === 'drafting' || e.state === 'reconciling')) removeAgentFiles(git, root, phase, ol, rec, id, e.base);
  if (e && e.state !== 'replanned') {
    rec.plans[id] = stamp(e, 'replanned', now, { reason: why });
    writeDrafts(root, phase, rec);
  }
  return { gsd: why };
}

// B8: turbo-run plan-drafts N --reconcile <id>. { gsd: why } (GSD's own single-plan call), { refused }, or { block }:
// the record turns reconciling with each predecessor's committed blob.
export function startReconcile(root, phase, id, { now = new Date(), git = gitRunner(root) } = {}) {
  const ol = readOutline(root, phase);
  if (ol.why) return { gsd: ol.why };
  const old = readDrafts(root, phase);
  const rec = recordFor(root, phase, ol);
  if (old && old.outline?.sha256 !== ol.sha256) {
    writeDrafts(root, phase, rec);
    return { gsd: 'the outline changed since the drafts were written' };
  }
  if (written(ol, id)) return { refused: `${id} is written already (${rel(root, planPath(ol, id))})` };
  const e = rec.plans[id];
  if (!e) return { gsd: 'no draft' };
  if (e.state === 'replanned') return { gsd: `replanned${e.reason ? `: ${e.reason}` : ''}` };
  if (e.state === 'drafting') return handToGsd(root, phase, rec, id, 'the draft agent never returned', now, { git, ol });
  if (e.state === 'promoted') return handToGsd(root, phase, rec, id, 'promoted before, and its plan file is gone', now, { git, ol });
  const file = draftFile(root, phase, id);
  if (!fs.existsSync(file)) return handToGsd(root, phase, rec, id, 'the draft file is gone', now, { git, ol });
  const blob = blobOf(git, file);
  if (e.state === 'drafted' && blob !== e.blobs.drafted) return handToGsd(root, phase, rec, id, 'the draft changed after its check', now, { git, ol });
  if (e.state === 'reconciled' && blob !== e.blobs.reconciled) return handToGsd(root, phase, rec, id, 'the draft changed after its reconcile', now, { git, ol });
  // a reconcile run again: what its lost agent wrote since its own base goes first
  if (e.state === 'reconciling') removeAgentFiles(git, root, phase, ol, rec, id, e.base);
  const preds = predecessors(root, phase, id, ol);
  const against = {};
  for (const p of preds) {
    const b = committedBlob(git, root, p.file);
    if (!b) return { refused: `${p.id} is not committed yet: reconcile ${id} after its commit` };
    against[p.id] = b;
  }
  rec.plans[id] = stamp(e, 'reconciling', now, { against, base: baseOf(ol) });
  writeDrafts(root, phase, rec);
  const context = phaseArtifacts(ol.dir).context;
  return {
    block: [
      `reconcile ${id}: ${plural(preds.length, 'plan')} before it`,
      `draft: ${file}`,
      ...preds.map((p) => `before: ${p.file}`),
      `outline: ${ol.file}`,
      `row: ${ol.rows.find((r) => r.id === id).row}`,
      `context: ${context ? path.join(ol.dir, context) : 'none'}`,
      'assumptions:',
      ...assumptionLines(readText(file)),
    ].map(clean).join('\n'),
  };
}

// The first predecessor whose committed blob is no longer the one the reconcile started from, or null.
function movedPredecessor(git, root, ol, e) {
  return Object.entries(e.against ?? {}).find(([pid, b]) => committedBlob(git, root, planPath(ol, pid)) !== b)?.[0] ?? null;
}

// B9: turbo-run plan-drafts N --reconciled <id> --verdict passed|failed. { ok: state } or { refused }.
export function finishReconcile(root, phase, id, verdict, { reason = '', now = new Date(), git = gitRunner(root) } = {}) {
  const ol = readOutline(root, phase);
  if (ol.why) return { refused: `drafts off: ${ol.why}` };
  const rec = recordFor(root, phase, ol);
  const e = rec.plans[id];
  if (e?.state !== 'reconciling') return { refused: `${id} is ${e ? e.state : 'not drafted'}, not reconciling (run --reconcile first)` };
  const removed = removeAgentFiles(git, root, phase, ol, rec, id, e.base);
  if (verdict === 'failed') {
    rec.plans[id] = stamp(e, 'replanned', now, { reason: reason || 'reconcile failed' });
    writeDrafts(root, phase, rec);
    return { ok: 'replanned', removed };
  }
  if (removed.length) return { refused: `the reconcile agent wrote into the phase directory: removed ${removed.join(', ')}`, removed };
  const moved = movedPredecessor(git, root, ol, e);
  if (moved) return { refused: `${moved} changed since the reconcile started` };
  const file = draftFile(root, phase, id);
  if (!fs.existsSync(file)) return { refused: `no draft file ${file}` };
  rec.plans[id] = stamp(e, 'reconciled', now, { blobs: { ...e.blobs, reconciled: blobOf(git, file) } });
  writeDrafts(root, phase, rec);
  return { ok: 'reconciled' };
}

// B10: turbo-run plan-drafts N --promote <id>: the reconciled draft, without its assumptions, becomes <id>-PLAN.md in
// the phase directory (written atomically, never over a file). { promoted: rel path } or { refused }.
export function promote(root, phase, id, { now = new Date(), git = gitRunner(root) } = {}) {
  const ol = readOutline(root, phase);
  if (ol.why) return { refused: `drafts off: ${ol.why}` };
  const rec = recordFor(root, phase, ol);
  const e = rec.plans[id];
  if (e?.state !== 'reconciled') return { refused: `${id} is ${e ? e.state : 'not drafted'}, not reconciled` };
  const file = draftFile(root, phase, id);
  const text = readText(file);
  if (text === null) return { refused: `no draft file ${file}` };
  // the blob of the very bytes read (and, below, of the bytes written): no file can change in between
  if (blobOfText(git, root, phase, text, file) !== e.blobs.reconciled) return { refused: 'the draft changed after its reconcile' };
  const moved = movedPredecessor(git, root, ol, e);
  if (moved) return { refused: `${moved} changed since the reconcile started` };
  const row = ol.rows.find((r) => r.id === id);
  const bad = rowMismatch(text, row, ol.prefix);
  if (bad) return { refused: `the draft does not match its outline row: ${bad}` };
  const target = planPath(ol, id);
  if (fs.existsSync(target)) return { refused: `${rel(root, target)} exists already` };
  const mine = new Set((frontList(text, 'files_modified') ?? []).map(normPath));
  for (const q of ol.rows.filter((r) => r.wave === row.wave && r.id !== id && written(ol, r.id))) {
    const both = (frontList(readText(planPath(ol, q.id)), 'files_modified') ?? []).map(normPath).filter((f) => mine.has(f));
    if (both.length) return { refused: `its files_modified overlaps ${q.id} of the same wave: ${both.join(', ')}` };
  }
  // the temp file beside the phase directory, never in it: nothing reads a half-written plan there
  const tmp = path.join(path.dirname(ol.dir), `.${id}-PLAN.md.tmp-${process.pid}`);
  const out = stripAssumptions(text);
  try {
    writeFileDurable(tmp, out);
    renameWithRetry(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  rec.plans[id] = stamp(e, 'promoted', now, { blobs: { ...e.blobs, promoted: blobOfText(git, root, phase, out, target) } });
  writeDrafts(root, phase, rec);
  return { promoted: rel(root, target) };
}

// turbo-run plan-drafts N --replan <id>: GSD plans it; the draft file stays for the record. A draft the agent left in
// the phase directory is removed (removed).
export function replan(root, phase, id, { reason = '', now = new Date(), git = gitRunner(root) } = {}) {
  const ol = readOutline(root, phase);
  const rec = ol.why ? readDrafts(root, phase) ?? freshRecord(phase, null) : recordFor(root, phase, ol);
  const row = ol.why ? null : ol.rows.find((r) => r.id === id);
  // an agent's base only while its agent may have been at work (second review C1): a later base would take GSD's own
  // revision plans (planner-revision.md scope_sanity splits) for an agent's
  const live = ['drafting', 'reconciling'].includes(rec.plans[id]?.state);
  const removed = ol.why ? [] : removeAgentFiles(git, root, phase, ol, rec, id, live ? rec.plans[id].base : null);
  const e = rec.plans[id] ?? { wave: row?.wave ?? null, dependsOn: row?.dependsOn ?? [], draft: `${id}-PLAN.md`, blobs: {}, at: {} };
  rec.plans[id] = stamp(e, 'replanned', now, { reason: reason || 'replanned by the lane' });
  writeDrafts(root, phase, rec);
  return { removed };
}

// B11 (review critical 1, 5): why the phase's plan set holds a plan that came from a draft without a passed reconcile,
// or null. Over every plan file of the phase (review I2): none may be a recorded drafted or reconciled blob, whatever
// the record says (or its outline); for a record of this outline not replanned whose <id>-PLAN.md exists, the blob of
// the newest commit that added it (its working blob while uncommitted) must be the promoted blob. A plan file no outline
// row names is not refused: GSD's revision loop splits plans into new ones (planner-revision.md scope_sanity, second
// review C1); the agents' own plan files are removed while their windows are known (--drafted, --reconciled, a lost
// agent's --reconcile, --replan of a live entry). No record: null.
export function draftsGuard(root, phase, { git = gitRunner(root) } = {}) {
  const rec = readDrafts(root, phase);
  if (!rec || !Object.keys(rec.plans).length) return null;
  const dir = findPhaseDir(root, phase);
  if (!dir) return null;
  // the record's states speak for its own outline only; a replaced outline's plans are GSD's
  const ol = readOutline(root, phase);
  const same = !ol.why && rec.outline?.sha256 === ol.sha256;
  const bad = (id) => `plan ${id} came from a draft without a passed reconcile: delete it and plan it again (turbo-run plan-drafts ${phase} --replan ${id})`;
  // review I2: every plan file of the phase, under any name: none may be a recorded draft
  const draftOf = new Map(Object.entries(rec.plans).flatMap(([id, e]) => [e.blobs.drafted, e.blobs.reconciled].filter(Boolean).map((b) => [b, id])));
  for (const f of planFileNames(dir)) {
    const file = path.join(dir, ...f.split('/'));
    const work = tryGit(git, ['hash-object', '--', file])?.trim() ?? null;
    const added = addedBlob(git, root, file);
    const hit = draftOf.get(work) ?? draftOf.get(added);
    if (hit) return f === `${hit}-PLAN.md` ? bad(hit) : `plan file ${f} is the draft of ${hit}, not a plan: delete it, commit the deletion and plan ${hit} again (turbo-run plan-drafts ${phase} --replan ${hit})`;
    const m = /^(.+)-PLAN\.md$/.exec(f);
    const e = m ? rec.plans[m[1]] : null;
    if (same && e && e.state !== 'replanned' && (added ?? work) !== e.blobs.promoted) return bad(m[1]);
  }
  return null;
}

// The planning summary of the measurement line (B12): drafts on: … from a record that drafted, drafts off: <why> from
// the last --plan answer, drafts off: not asked without a record.
export function draftsSummary(root, phase) {
  const rec = readDrafts(root, phase);
  if (!rec) return 'drafts off: not asked';
  const entries = Object.values(rec.plans);
  if (!entries.length && !rec.lastPlan?.use) return `drafts off: ${rec.lastPlan?.why || 'not asked'}`;
  const count = (f) => entries.filter(f).length;
  return `drafts on: ${rec.outline?.plans ?? '?'} plans in ${rec.outline?.waves ?? '?'} waves, ${count((e) => e.at.drafted)} drafted, ${count((e) => e.at.reconciled)} reconciled, ${count((e) => e.state === 'replanned')} replanned`;
}
