import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeHome, turboHome, gsdCoreDir } from './paths.mjs';
import { readJson, writeJsonAtomic, ensureDir } from './fsx.mjs';
import { maskSecrets } from './secrets.mjs';
import { whichAbsolute } from './which.mjs';
import { readVersion } from './gsd.mjs';
import { resolveBin } from './claude.mjs';
import { loadConfig } from './config.mjs';

// turbo's own failures, written up as reports (v0.8): a crash of turbo-run, a supervisor check that fails with a
// programming error or keeps failing, and what the Claude Code agent of a session sees turbo do wrong. A report is a
// record under turbo's own directory (<Claude home>/turbo/reports), never in a project. Nothing leaves the machine by
// itself: the agent checks the failure, shows the report to the owner, and `turbo-run report send <id>` files it as an
// issue of turbo's repository with the owner's own gh, after the owner's yes.
// A report holds a fixed set of fields: the versions, the system, turbo's own error text and code locations, and the
// agent's short description. Every text goes through scrub (paths, the project's and the user's names, secrets); no
// log, transcript, test output or project file is ever read into it.

const INSTALL = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPORT_REPO = 'rnyqdz99yx-afk/gsd-turbo';
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
// TURBO_REPORT_REPO: another owner/name on github.com (a fork, a test); anything else is ignored
export const reportRepo = (env = process.env) => (REPO_RE.test(String(env.TURBO_REPORT_REPO ?? '')) ? env.TURBO_REPORT_REPO : REPORT_REPO);
export const reportsDir = (env = process.env) => path.join(turboHome(env), 'reports');

const KINDS = new Set(['crash', 'tick', 'stuck', 'agent']);
const ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{10}$/;
const GH_TIMEOUT_MS = 30000;
const VERSION_TIMEOUT_MS = 5000;
const LINK_BODY = 5000;
const cut = (s, n) => [...String(s ?? '')].slice(0, n).join('');
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function userName() {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

function ctxOf(deps = {}) {
  const env = deps.env ?? process.env;
  return {
    env, root: deps.root ?? null, now: deps.now ?? (() => new Date()), exec: deps.exec ?? execFileSync, install: deps.install ?? INSTALL,
    home: deps.home ?? os.homedir(), user: deps.user ?? userName(), platform: deps.platform ?? process.platform,
    claudeHome: deps.claudeHome ?? claudeHome(env), versions: deps.versions, ghBin: deps.ghBin,
  };
}

// --- scrub -----------------------------------------------------------------------------------------------------------

const REST = '[^\\s"\'<>|*?`]*';
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// a directory as a pattern: either slash between its parts
const dirSrc = (dir) => esc(String(dir).replace(/[\\/]+$/, '')).replace(/\\\\|\//g, '[\\\\/]+');
// a lane's slot next to the project (<project>.turbo/lane-k) reads as the project
const SLOT = '(?:\\.turbo[\\\\/]+lane-\\d+)?';
const mainOf = (root) => String(root).replace(/\.turbo[\\/]+lane-\d+[\\/]*$/, '');
// names that say nothing about anyone, or that turbo's own words are made of
const GENERIC = new Set(['turbo', 'gsd-core', 'gsd', 'project', 'projects', 'claude', 'path', 'user', 'users', 'secret', 'test', 'tests', 'node', 'main', 'master', 'code', 'work', 'repo', 'repos', 'app', 'src', 'dev', 'home', 'admin', 'root', 'lane', 'phase', 'build', 'report']);
const named = (name) => (name && name.length >= 3 && !GENERIC.has(name.toLowerCase()) ? new RegExp(`(?<![A-Za-z0-9])${esc(name)}(?![A-Za-z0-9])`, 'gi') : null);

// What a text may say about the machine: turbo's own files (<turbo>/…), GSD's (<gsd-core>/…), the project's .planning
// files with the phase names cut (<project>/.planning/…); every other path loses everything but what it was under
// (<project>/<…>, <claude>/<…>, ~/<…>, <path>). The project folder's name and the user's name go too, then secrets.
// c: { root, home, user, install, claudeHome, platform }.
export function scrub(text, c = {}) {
  let s = typeof text === 'string' ? text : String(text ?? '');
  const flags = (c.platform ?? process.platform) === 'win32' ? 'gi' : 'g';
  const sub = (dir, to, pre = '') => {
    if (!dir || String(dir).replace(/[\\/]+$/, '').length < 3) return;
    s = s.replace(new RegExp(`${dirSrc(dir)}${pre}(?![\\w.-])((?:[\\\\/]${REST})?)`, flags), (_, rest) => to(rest.replace(/\\+/g, '/')));
  };
  const roots = [...new Set([c.root, c.root && mainOf(c.root)].filter(Boolean))].sort((a, b) => b.length - a.length);
  sub(c.install, (rest) => `<turbo>${rest}`);
  for (const dir of [c.claudeHome && path.join(c.claudeHome, 'gsd-core'), ...roots.map((r) => `${r}/.claude/gsd-core`)]) sub(dir, (rest) => `<gsd-core>${rest}`);
  for (const root of roots) sub(root, (rest) => (/^\/+\.planning(\/|$)/.test(rest) ? `<project>${rest}` : rest ? '<project>/<…>' : '<project>'), SLOT);
  sub(c.claudeHome, (rest) => (rest ? '<claude>/<…>' : '<claude>'));
  sub(c.home, (rest) => (rest ? '~/<…>' : '~'));
  s = s
    .replace(new RegExp(`(?<![\\w<])[A-Za-z]:[\\\\/]+${REST}`, 'g'), '<path>')
    .replace(new RegExp(`(?<![\\w:\\\\/])\\\\{2}[^\\s\\\\/"'<>|*?\`]+\\\\${REST}`, 'g'), '<path>')
    .replace(/(?<![\w<>.:\\/~-])\/(?:[^\s"'<>|*?`/]+\/)+[^\s"'<>|*?`/]*/g, '<path>')
    .replace(/(\.planning[\\/]+phases[\\/]+\d+(?:\.\d+)*)-[^\\/\s"'<>|*?`]+/g, '$1-…');
  for (const root of roots) {
    const folder = named(path.posix.basename(root.replace(/\\/g, '/').replace(/\/+$/, '')));
    if (folder) s = s.replace(folder, '<project>');
  }
  const user = named(c.user);
  if (user) s = s.replace(user, '<user>');
  return maskSecrets(s);
}

// --- the failure's own facts -----------------------------------------------------------------------------------------

// The stack's frames inside turbo's own directory, as `fn (lib/x.mjs:12)`: no other file is named.
export function turboFrames(err, { install = INSTALL, max = 8 } = {}) {
  const frames = [];
  for (const line of String(err?.stack ?? '').split(/\r?\n/)) {
    const m = /(file:\/\/[^\s)]+?):(\d+):\d+\)?\s*$/.exec(line);
    if (!m) continue;
    let file;
    try {
      file = fileURLToPath(m[1]);
    } catch {
      continue;
    }
    const rel = path.relative(install, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const fn = /^\s*at (?:async )?([^\s(]+) \(/.exec(line)?.[1] ?? '<anonymous>';
    frames.push(`${fn} (${rel.split(path.sep).join('/')}:${m[2]})`);
    if (frames.length >= max) break;
  }
  return frames;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\b[0-9a-f]{7,}\b/g, 'H').replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 160);
// One failure, one fingerprint: an engine failure by its error and the turbo functions it came through (no numbers, no
// line numbers: the same on every machine and in every phase), an agent's report by its title.
export function fingerprint({ kind, name = '', message = '', frames = [], title = '' }) {
  const key = kind === 'agent' ? ['agent', norm(title)] : ['engine', name, norm(message), ...frames.map((f) => f.replace(/:\d+\)$/, ')'))];
  return crypto.createHash('sha256').update(key.join('|')).digest('hex').slice(0, 10);
}

function turboVersion(install) {
  return String(readJson(path.join(install, 'package.json'), null)?.version ?? 'unknown');
}
function readVersions(c, turbo) {
  let claude = 'unknown';
  try {
    const bin = resolveBin('claude', { platform: c.platform });
    if (!bin.unsupported) claude = /\d+\.\d+\.\d+/.exec(String(c.exec(bin.cmd, [...(bin.prefix || []), '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false, timeout: VERSION_TIMEOUT_MS })))?.[0] ?? 'unknown';
  } catch {
    // claude cannot be run: the report says unknown
  }
  const core = gsdCoreDir(c.root, c.env);
  return { turbo, gsd: (core && readVersion(core)) || 'unknown', claude, node: process.version, os: `${c.platform} ${os.release()} ${process.arch}` };
}
function setupLine(c) {
  if (!c.root) return null;
  try {
    const config = loadConfig(c.root);
    return `lanes ${config.lanes?.mode} · build path ${config.build?.enabled ? 'on' : 'off'} · lean ${config.lean?.enabled ? 'on' : 'off'} · push ${config.push?.mode} · lang ${config.lang}`;
  } catch {
    return null; // a config that cannot be read is no part of the report
  }
}

// Node's message for a failed child process is its whole command line: a commit message, a plan's title, file names.
// Only what turbo itself wrote stays: the program (its name alone), a script of turbo's or GSD's, and the subcommand.
function commandOnly(line) {
  const m = /^(.*?\bCommand failed(?: with [A-Z0-9_ ]+)?: )(\S+)(.*)$/.exec(line);
  if (!m) return line;
  const rest = m[3].trim().split(/\s+/).filter(Boolean);
  const kept = [m[2].startsWith('<') ? m[2] : m[2].replace(/^.*[\\/]/, '')]; // a path scrub masked stays masked
  if (/^<(?:turbo|gsd-core)>\//.test(rest[0] ?? '')) kept.push(rest.shift());
  if (/^[a-z][a-z0-9._-]*$/.test(rest[0] ?? '')) kept.push(rest.shift());
  return `${m[1]}${kept.join(' ')}${rest.length ? ' …' : ''}`;
}

function engineFields(kind, { err, cmd, minutes }, c) {
  const name = /^[A-Za-z]\w{0,40}$/.test(String(err?.name ?? '')) ? err.name : 'Error';
  const code = /^[A-Z][A-Z0-9_]{1,40}$/.test(String(err?.code ?? '')) ? ` [${err.code}]` : '';
  const message = cut(commandOnly(scrub(String(err?.message ?? err ?? '').split(/\r?\n/)[0], c)), 300).replace(/`/g, "'");
  const frames = turboFrames(err, { install: c.install });
  const error = `${name}${code}: ${message}`;
  const verb = /^[a-z][a-z-]{0,30}$/.test(String(cmd ?? '')) ? `turbo-run ${cmd}` : 'turbo-run';
  const what = kind === 'crash' ? `\`${verb}\` ended with an unexpected error`
    : kind === 'stuck' ? `the supervisor could not go on for ${Number.isFinite(Number(minutes)) ? Number(minutes) : '?'} min: the same error at every check`
      : "the supervisor's check failed with a programming error";
  return { fp: fingerprint({ kind, name, message, frames }), title: cut(error, 100), what, error, frames, summary: null };
}
function agentSummary(text, c) {
  const summary = cut(scrub(String(text ?? '').trim(), c), 1500);
  if (!summary) throw new ReportUsage('a report needs a summary: what happened, what was expected, what turbo did');
  return summary;
}
function agentFields({ title, summary }, c) {
  const body = agentSummary(summary, c);
  const head = cut(oneLine(scrub(oneLine(title) || oneLine(body).split(/(?<=[.!?])\s/)[0], c)), 100);
  return { fp: fingerprint({ kind: 'agent', title: head }), title: head, what: 'turbo misbehaved; the Claude Code agent of the session checked it and wrote it up', error: null, frames: [], summary: body };
}

// --- records ---------------------------------------------------------------------------------------------------------

export class ReportUsage extends Error {}
const recordFile = (id, c) => path.join(reportsDir(c.env), `${id}.json`);
const validRecord = (r) => r && typeof r === 'object' && ID_RE.test(String(r.id)) && typeof r.fp === 'string' && typeof r.title === 'string';

export function readRecords(deps = {}) {
  const c = ctxOf(deps);
  let names = [];
  try {
    names = fs.readdirSync(reportsDir(c.env));
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.json') && ID_RE.test(n.slice(0, -5))).sort().map((n) => readJson(path.join(reportsDir(c.env), n), null)).filter(validRecord);
}
// by its id, or by its fingerprint (the newest record with it)
export function findRecord(key, deps = {}) {
  const records = readRecords(deps);
  return records.find((r) => r.id === key) ?? records.filter((r) => r.fp === key).at(-1) ?? null;
}
export const pendingReports = (deps = {}) => readRecords(deps).filter((r) => !r.sent && !r.dropped);

// Writes the report of a failure; nothing is sent. The same failure on the same turbo version has one record:
// { id, duplicate, record }. input: { kind: crash|tick|stuck, err, cmd?, minutes? } or { kind: agent, title?, summary }.
export function draftReport(input, deps = {}) {
  const c = ctxOf(deps);
  const kind = KINDS.has(input?.kind) ? input.kind : 'agent';
  const fields = kind === 'agent' ? agentFields(input ?? {}, c) : engineFields(kind, input, c);
  const version = c.versions?.turbo ?? turboVersion(c.install);
  const same = readRecords(c).find((r) => r.fp === fields.fp && r.version === version);
  if (same) return { id: same.id, duplicate: true, record: same };
  const at = c.now().toISOString();
  const record = { id: `${at.replace(/[-:]|\.\d+/g, '')}-${fields.fp}`, at, kind, version, ...fields, versions: c.versions ?? readVersions(c, version), setup: setupLine(c), sent: null, dropped: null };
  ensureDir(reportsDir(c.env));
  writeJsonAtomic(recordFile(record.id, c), record);
  return { id: record.id, duplicate: false, record };
}

// The issue a record becomes: every line of it comes from the record's fixed fields.
export function renderReport(record) {
  const v = record.versions ?? {};
  const cell = (x) => String(x ?? 'unknown').replace(/[|\r\n]/g, ' ');
  const body = [
    `**What happened:** ${record.what}`,
    ...(record.error ? ['', `**Error:** \`${record.error}\``] : []),
    ...(record.frames?.length ? ['', "**Where, in turbo's own code:**", '', '```text', ...record.frames, '```'] : []),
    ...(record.summary ? ['', "**Described by the Claude Code agent on the reporter's machine:**", '', ...String(record.summary).split(/\r?\n/).map((l) => `> ${l}`)] : []),
    '', '| turbo | GSD core | Claude Code | Node | OS |', '|---|---|---|---|---|',
    `| ${cell(v.turbo)} | ${cell(v.gsd)} | ${cell(v.claude)} | ${cell(v.node)} | ${cell(v.os)} |`,
    ...(record.setup ? ['', `Setup: ${record.setup}`] : []),
    '', '---',
    `Filed with \`turbo-run report\` after the reporter agreed. It holds only what is above: no project code, file contents or logs. Fingerprint \`${record.fp}\`.`,
  ].join('\n');
  return { title: `[turbo-report ${record.fp}] ${record.title}`, body };
}

// The agent's check of a failure turbo recorded itself, added to its record (it replaces an earlier one).
export function describeRecord(key, summary, deps = {}) {
  const c = ctxOf(deps);
  const record = findRecord(key, c);
  if (!record || record.sent) return null;
  const next = { ...record, summary: agentSummary(summary, c) };
  writeJsonAtomic(recordFile(record.id, c), next);
  return next;
}
// The owner said no: the record stays, off the waiting list.
export function dropReport(key, deps = {}) {
  const c = ctxOf(deps);
  const record = findRecord(key, c);
  if (!record || record.sent) return null;
  const next = { ...record, dropped: c.now().toISOString() };
  writeJsonAtomic(recordFile(record.id, c), next);
  return next;
}

// Files a record as an issue of turbo's repository with the owner's own gh, after the owner's yes: a failure that has
// an open issue (its fingerprint in the title) is added to it as a comment. -> { url, comment?, already? }, or
// { url: null, why, link } with a link that opens the same issue, filled in, in a browser; { missing } for no record.
export function sendReport(key, deps = {}) {
  const c = ctxOf(deps);
  const record = findRecord(key, c);
  if (!record) return { url: null, missing: true, why: `no report ${oneLine(key).slice(0, 60)}` };
  if (record.sent) return { url: record.sent.url, already: true };
  const repo = reportRepo(c.env);
  const { title, body } = renderReport(record);
  const link = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body.slice(0, LINK_BODY))}`;
  // never a gh inside the project: Windows looks for a bare program name in the working directory first
  const bin = c.ghBin !== undefined ? c.ghBin : whichAbsolute('gh', { env: c.env, platform: c.platform, exclude: [c.root].filter(Boolean) });
  if (!bin) return { url: null, why: 'the GitHub CLI (gh) is not installed', link };
  const gh = (args, input = '') => String(c.exec(bin, args, {
    cwd: os.tmpdir(), encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: GH_TIMEOUT_MS, killSignal: 'SIGKILL',
    env: { ...c.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
  }));
  const target = `github.com/${repo}`; // the host named: a GH_HOST of the owner's never moves the report elsewhere
  try {
    let found = [];
    try {
      found = JSON.parse(gh(['issue', 'list', '-R', target, '--state', 'open', '--search', `${record.fp} in:title`, '--json', 'number,url', '--limit', '1']));
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err; // output that is no JSON: no known issue
    }
    const open = Array.isArray(found) && Number.isInteger(found[0]?.number) ? found[0].number : null;
    let url = `https://github.com/${repo}/issues/${open}`;
    if (open !== null) gh(['issue', 'comment', String(open), '-R', target, '--body-file', '-'], body);
    else {
      url = new RegExp(`https://github\\.com/${esc(repo)}/issues/\\d+`).exec(gh(['issue', 'create', '-R', target, '--title', title, '--body-file', '-'], body))?.[0];
      if (!url) throw new Error('gh issue create printed no issue link');
    }
    writeJsonAtomic(recordFile(record.id, c), { ...record, dropped: null, sent: { at: c.now().toISOString(), url, ...(open !== null ? { comment: true } : {}) } });
    return { url, ...(open !== null ? { comment: true } : {}) };
  } catch (err) {
    const tail = String(err?.stderr ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-2).join(' ');
    const why = err?.code === 'ENOENT' ? 'the GitHub CLI (gh) is not installed'
      : err?.code === 'ETIMEDOUT' ? `gh timed out after ${GH_TIMEOUT_MS / 1000} s`
        : cut(scrub(tail || (typeof err?.status === 'number' ? `gh exit status ${err.status}` : String(err?.message ?? err)), c), 300);
    return { url: null, why, link };
  }
}

// --- the engine's side -----------------------------------------------------------------------------------------------

let recording = false;
// A failure of turbo's own, recorded from inside the engine (the crash handler of turbo-run, the supervisor): the line
// for the log, or null (nothing recorded, or the same failure told before; again: tell it every time). Never throws,
// and never records under `node --test`, with TURBO_REPORT=off, or for a closed output pipe.
export function recordFailure(input, deps = {}) {
  if (recording) return null;
  recording = true;
  try {
    const env = deps.env ?? process.env;
    if (String(env.TURBO_REPORT ?? '').toLowerCase() === 'off' || env.NODE_TEST_CONTEXT || input?.err?.code === 'EPIPE') return null;
    const r = draftReport(input, deps);
    if (r.duplicate && !deps.again) return null;
    if (r.record.sent) return `turbo failure report ${r.id}: this failure was reported before (${r.record.sent.url})`;
    if (r.record.dropped) return null;
    // a lane has no owner to ask: the owner's session finds the report in turbo-run status
    if (env.TURBO_LANE) return `turbo failure report ${r.id} recorded, not sent: the owner's session offers it to the owner; go on as the step says`;
    return `turbo failure report ${r.id} recorded, not sent: check it and offer the owner to send it (turbo-run report show ${r.id})`;
  } catch {
    return null; // a report never adds a failure to the one it is about
  } finally {
    recording = false;
  }
}

// The line turbo-run status ends with while reports wait for the owner's yes; null when none does, in a lane (the
// owner's session is the one that offers them) and under `node --test` (a test's status never reads the real home).
export function reportsLine(lang, deps = {}) {
  const env = deps.env ?? process.env;
  if (env.TURBO_LANE || env.NODE_TEST_CONTEXT) return null;
  let n = 0;
  try {
    n = pendingReports(deps).length;
  } catch {
    return null;
  }
  if (!n) return null;
  return lang === 'ru'
    ? `отчёты об ошибках turbo: не отправлено ${n} — проверьте каждый и предложите владельцу отправить (turbo-run report list)`
    : `turbo failure reports: ${n} not sent — check each and offer the owner to send it (turbo-run report list)`;
}

// --- turbo-run report ------------------------------------------------------------------------------------------------

export const REPORT_USAGE = 'usage: turbo-run report --summary <text> [--title <text>] | report list | report show <id> | report describe <id> --summary <text> | report send <id> | report drop <id>';

function printRecord(record, out, env) {
  const { title, body } = renderReport(record);
  out(`--- the report as it goes to github.com/${reportRepo(env)} (a public issue, from the owner's GitHub account) ---`);
  out(`title: ${title}`);
  out(body);
  out('--- end ---');
}
const NEXT = (id, env) => (env.TURBO_LANE
  ? "next: nothing here: the owner's session offers it to the owner (a lane never sends or drops a report)"
  : `next: show it to the owner and ask; yes: turbo-run report send ${id} · no: turbo-run report drop ${id}`);
// The owner's yes or no is given in the owner's session: a lane or a role session (TURBO_LANE in every process of
// theirs) runs without anyone to ask, so it can write a report up and read it, never send, drop or change one.
const OWNER_VERBS = new Set(['send', 'drop', 'describe']);

export function runReportCommand(args, { root = null, out = (l) => process.stdout.write(`${l}\n`), deps = {} } = {}) {
  const d = { root, ...deps };
  const env = d.env ?? process.env;
  const value = (name) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : undefined; };
  const usage = (line = REPORT_USAGE) => { out(line); return 2; };
  const verb = args[0] === undefined ? 'list' : args[0].startsWith('--') ? 'write' : args[0];
  const key = args[1];
  if (env.TURBO_LANE && OWNER_VERBS.has(verb)) { out(`refused: report ${verb} is the owner's: a lane never runs it`); return 1; }
  try {
    switch (verb) {
      case 'write': {
        if (value('--summary') === undefined) return usage();
        const r = draftReport({ kind: 'agent', title: value('--title'), summary: value('--summary') }, d);
        if (r.record.sent) { out(`already reported: ${r.record.sent.url}`); return 0; }
        out(r.duplicate ? `already recorded: ${r.id} (not sent${r.record.dropped ? '; the owner said no before' : ''})` : `recorded: ${r.id} (not sent: nothing leaves this machine before the owner's yes)`);
        printRecord(r.record, out, env);
        out(NEXT(r.id, env));
        return 0;
      }
      case 'list': {
        const records = readRecords(d);
        if (!records.length) { out('turbo failure reports: none'); return 0; }
        const waiting = records.filter((r) => !r.sent && !r.dropped);
        const sent = records.filter((r) => r.sent);
        out(`turbo failure reports: ${waiting.length} waiting for the owner's yes, ${sent.length} sent, ${records.length - waiting.length - sent.length} dropped · directory: ${reportsDir(env)}`);
        for (const r of waiting) out(`  waiting  ${r.id}  ${r.kind}  ${r.title}`);
        for (const r of sent.slice(-10)) out(`  sent     ${r.id}  ${r.sent.url}`);
        if (waiting.length) out('for each waiting one: turbo-run report show <id>, check it, then ask the owner (send <id> or drop <id>)');
        return 0;
      }
      case 'show': {
        if (!key) return usage();
        const record = findRecord(key, d);
        if (!record) { out(`no report ${oneLine(key).slice(0, 60)}`); return 1; }
        out(`${record.id}: ${record.sent ? `sent ${record.sent.url}` : record.dropped ? 'dropped (the owner said no)' : 'not sent'}`);
        printRecord(record, out, env);
        if (!record.sent) out(NEXT(record.id, env));
        return 0;
      }
      case 'describe': {
        if (!key || value('--summary') === undefined) return usage();
        const record = describeRecord(key, value('--summary'), d);
        if (!record) { out(`no unsent report ${oneLine(key).slice(0, 60)}`); return 1; }
        out(`described: ${record.id}`);
        printRecord(record, out, env);
        out(NEXT(record.id, env));
        return 0;
      }
      case 'send': {
        if (!key) return usage();
        const r = sendReport(key, d);
        if (r.url) { out(r.already ? `already sent: ${r.url}` : r.comment ? `added to the open issue of the same failure: ${r.url}` : `sent: ${r.url}`); return 0; }
        out(`not sent: ${r.why}`);
        if (r.link) out(`to file it by hand, the owner opens this link in a browser: ${r.link}`);
        return 1;
      }
      case 'drop': {
        if (!key) return usage();
        const record = dropReport(key, d);
        out(record ? `dropped: ${record.id} (kept on this machine, not sent)` : `no unsent report ${oneLine(key).slice(0, 60)}`);
        return record ? 0 : 1;
      }
      default:
        return usage();
    }
  } catch (err) {
    if (err instanceof ReportUsage) return usage(`refused: ${err.message}`);
    throw err;
  }
}
