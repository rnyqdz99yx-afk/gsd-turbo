import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULTS, viewRefreshSeconds } from './config.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { claudeHome, runDir } from './paths.mjs';
import { nextStep, readProgress } from './phase-progress.mjs';
import { readLaneStatus } from './run-status.mjs';
import { comparePhase } from './scheduler.mjs';
import { maskSecrets } from './secrets.mjs';
import { laneAgents, laneTranscript, projectDirs } from './transcripts.mjs';
import { whichAbsolute } from './which.mjs';

// What view keeps between calls (git-ignored run directory): per transcript file, the transcript layer's last result.
const CACHE_FILE = 'view-cache.json';
const CACHE_VERSION = 1;
const COMMITS = 5;
const GIT_TIMEOUT_MS = 5000;
const QUESTIONS_RE = /^p([A-Za-z0-9._-]+)-questions\.json$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Minutes without a transcript write before a subagent or a lane reads as quiet (config stall_minutes, at least 1).
export function stallMs(config) {
  const n = Math.floor(Number(config?.stall_minutes));
  return (Number.isFinite(n) && n >= 1 ? n : DEFAULTS.stall_minutes) * 60000;
}

// Repository data (commit subjects, reasons, questions, agent actions) can hold terminal escapes and bidi controls:
// OSC 52 rewrites the clipboard, ESC[2J clears the screen, U+202E reverses what follows. clean drops escape
// sequences, C0/C1 controls except tab and newline, and bidi overrides and isolates, where view reads the text, so
// view --json, view and status --watch never pass them on (the turbo-view mod cleans again on its side).
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[@-Z\\-_])/g;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
export const clean = (text) => String(text ?? '').replace(ESCAPES, '').replace(CONTROLS, '');
// what view shows of a text from the repository: cleaned, then secrets masked
const shown = (text) => maskSecrets(clean(text));

// The text of a question as view shows it: cleaned and secrets masked in what is read (question, context, header,
// condition, an option's label, description and signal). view only displays: an answer is taken from the questions
// file. Ids, rev, state, plan, task and agentId stay as written, so a button in the view still names its question.
const QUESTION_TEXT = ['question', 'context', 'header', 'condition'];
const OPTION_TEXT = ['label', 'description', 'signal'];
const maskFields = (o, keys) => ({ ...o, ...Object.fromEntries(keys.filter((k) => typeof o[k] === 'string').map((k) => [k, shown(o[k])])) });

function shownQuestion(q) {
  const out = maskFields(q, QUESTION_TEXT);
  if (Array.isArray(q.options)) out.options = q.options.map((o) => (isObj(o) ? maskFields(o, OPTION_TEXT) : o));
  return out;
}

// The owner questions still open, in phase order, their text masked (shownQuestion). S1 writes them to
// run/p<N>-questions.json as a JSON array of question objects whose state is "open" until answered; any other file
// content is skipped.
export function openQuestions(root) {
  let names = [];
  try {
    names = fs.readdirSync(runDir(root));
  } catch {
    return [];
  }
  const files = names.map((n) => QUESTIONS_RE.exec(n)).filter(Boolean).sort((a, b) => comparePhase(a[1], b[1]));
  const out = [];
  for (const m of files) {
    const list = readJson(path.join(runDir(root), m[0]), null);
    if (Array.isArray(list)) for (const q of list) if (isObj(q) && q.state === 'open' && typeof q.id === 'string') out.push(shownQuestion(q));
  }
  return out;
}

// The last commits of the checkout, newest first: [{ sha, subject }]; none outside a git repository or before the
// first commit.
export function recentCommits(root, n = COMMITS) {
  // git by its absolute path from PATH, never one placed in the project (whichAbsolute)
  const git = whichAbsolute('git', { exclude: [root] });
  if (!git) return [];
  let text = '';
  try {
    text = execFileSync(git, ['log', `-${n}`, '--format=%h%x1f%s'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' });
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map((line) => {
    const [sha, ...rest] = line.split('\x1f');
    return { sha: clean(sha), subject: shown(rest.join(' ')).slice(0, 200) };
  });
}

function loadCache(file) {
  const c = readJson(file, null);
  return isObj(c) && c.v === CACHE_VERSION && isObj(c.files) ? c.files : {};
}

// Written only where the run directory already exists: view never creates turbo's directories in a project. The
// cache is an optimization, so a failed write changes nothing.
function saveCache(file, files, before) {
  if (!fs.existsSync(path.dirname(file)) || JSON.stringify(files) === JSON.stringify(before)) return;
  try {
    writeJsonAtomic(file, { v: CACHE_VERSION, files });
  } catch { /* next call reads the transcripts again */ }
}

// The phase's push as the supervisor recorded it (S2: run/p<N>-push.json, written by lib/push.mjs), reduced to what
// the live view shows. S2 keeps the latest request's outcome and time at the top and the last push with its CI watch
// in lastPush, which later requests carry over: { outcome, at (the latest request's), sha (7 characters), ci (the CI
// state) of the last push, or null before any push }; null without a readable record.
const PUSH_OUTCOMES = new Set(['pushed', 'refused', 'diverged', 'failed']);
export function pushOf(root, phase) {
  const rec = readJson(path.join(runDir(root), `p${phase}-push.json`), null);
  if (!isObj(rec) || !PUSH_OUTCOMES.has(rec.outcome)) return null;
  const text = (v) => (typeof v === 'string' && v ? clean(v) : null);
  const last = isObj(rec.lastPush) ? rec.lastPush : null;
  return { outcome: rec.outcome, at: text(rec.at), sha: text(last?.sha)?.slice(0, 7) ?? null, ci: isObj(last?.ci) ? text(last.ci.state) : null };
}

// A subagent as view shows it: the text read from its transcript (type, description, plan, task, action) cleaned.
const textOrNull = (v) => (typeof v === 'string' ? clean(v) : v);
function shownAgent(a) {
  const out = { ...a, type: textOrNull(a.type), description: textOrNull(a.description), plan: textOrNull(a.plan), task: textOrNull(a.task) };
  if (isObj(a.action)) out.action = { ...a.action, tool: textOrNull(a.action.tool), detail: textOrNull(a.action.detail) };
  return out;
}

function laneView({ root, lane, home, now, stall, cache, used }) {
  const phase = String(lane.phase);
  const progress = readProgress(root, phase);
  const record = readLaneStatus(root, phase);
  // a lane record counts only when written since this lane's launch, as the supervisor reads it
  const fresh = Boolean(record && lane.launchedAt && Date.parse(record.at) >= Date.parse(lane.launchedAt));
  // supervisor.json lane.sessionId is the background job id claude --bg printed; the job state names the transcript
  const sessionId = typeof lane.sessionId === 'string' ? lane.sessionId : '';
  const main = sessionId ? laneTranscript({ home, root, jobId: sessionId }) : null;
  const t = laneAgents({ dirs: projectDirs(home, root), main, root, now, stallMs: stall, cache, used });
  const launched = Date.parse(lane.launchedAt);
  return {
    phase,
    step: nextStep(progress),
    done: progress.done,
    notes: Object.fromEntries(Object.entries(progress.notes).map(([k, v]) => [k, shown(v)])),
    status: fresh ? clean(record.status) : 'running',
    reason: fresh ? shown(record.reason || '') : '',
    sessionId,
    mode: lane.mode === 'full' ? 'full' : 'safe',
    launchedAt: lane.launchedAt || null,
    elapsedMs: Number.isFinite(launched) ? Math.max(0, now.getTime() - launched) : null,
    transcript: t.transcript,
    lastAt: t.lastAt,
    quiet: t.lastAt ? now.getTime() - Date.parse(t.lastAt) > stall : false,
    agents: t.agents.map(shownAgent),
    push: pushOf(root, phase),
  };
}

// Everything turbo-run view shows (spec §4) as one JSON-ready object: supervisor, range, lanes with their step and
// subagents, open questions, the last commits. sup is supervisor.json (null when absent); running says whether its
// daemon is alive (the caller owns the heartbeat rules).
export function buildView({ root, sup, running = false, config = {}, env = process.env, now = new Date(), commits = recentCommits }) {
  const home = claudeHome(env);
  const stall = stallMs(config);
  const cacheFile = path.join(runDir(root), CACHE_FILE);
  const cache = loadCache(cacheFile);
  const used = {};
  const lanes = (sup?.lane ? [sup.lane] : []).map((lane) => laneView({ root, lane, home, now, stall, cache, used }));
  saveCache(cacheFile, used, cache);
  return {
    v: 1,
    at: now.toISOString(),
    supervisor: sup ? { running: Boolean(running), pid: running ? sup.pid ?? null : null, finished: Boolean(sup.finished), halted: Boolean(sup.halted), failingSince: sup.failingSince || null, updatedAt: sup.updatedAt || null } : null,
    range: sup?.range ? { from: sup.range.from ?? null, to: sup.range.to ?? null } : null,
    lanes,
    questions: openQuestions(root),
    commits: commits(root),
    // what the turbo-view mod (S3) reads from the owner's config: the language it draws in and how often it reads
    ui: { lang: config?.lang === 'ru' ? 'ru' : 'en', refreshSeconds: viewRefreshSeconds(config) },
  };
}

// 45s, 6m, 1h 12m; '-' when unknown.
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// 950, 41k, 166k; '-' when unknown.
export const fmtTokens = (n) => (!Number.isFinite(n) ? '-' : n < 1000 ? String(n) : `${Math.round(n / 1000)}k`);

const planLabel = (x) => (x.plan ? `${x.plan}${x.task ? ` Task ${x.task}` : ''}` : '-');

function agentLine(a) {
  const doing = a.state === 'running' && a.action ? `${a.action.tool} ${a.action.detail}`.trim() : a.state;
  return `  ${a.type || 'agent'} · ${planLabel(a)} · ${doing} · ${fmtDuration(a.elapsedMs)} · ${fmtTokens(a.tokens)}`;
}

// The text form of buildView's result: what turbo-run view prints without --json.
export function formatView(v) {
  const sup = v.supervisor;
  const lines = [`supervisor: ${!sup ? 'not running (never started)' : sup.running ? `running pid ${sup.pid}` : 'not running'}${sup?.finished ? ' · finished' : ''}${sup?.halted ? ' · halted' : ''}`];
  if (v.range) lines.push(`range: phases ${v.range.from ?? 'start'}–${v.range.to ?? 'end'}`);
  for (const l of v.lanes) {
    lines.push(`p${l.phase} · ${l.step ?? 'all steps done'} · lane ${l.status}${l.quiet ? ' (quiet)' : ''} · session ${l.sessionId || '-'} · ${fmtDuration(l.elapsedMs)}`);
    if (l.reason) lines.push(`  reason: ${l.reason}`);
    for (const a of l.agents) lines.push(agentLine(a));
  }
  if (v.questions.length) {
    lines.push(`questions: ${v.questions.length} open`);
    for (const q of v.questions) lines.push(`  ${q.id} · ${planLabel(q)} · ${String(q.question ?? '').slice(0, 100)}`);
  }
  if (v.commits.length) {
    lines.push('commits:');
    for (const c of v.commits) lines.push(`  ${c.sha} ${c.subject}`);
  }
  // a view built elsewhere (a test, an older cache) is drawn clean as well
  return lines.map(clean).join('\n');
}
