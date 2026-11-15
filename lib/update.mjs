import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { turboHome } from './paths.mjs';
import { readJson, writeJsonAtomic, ensureDir } from './fsx.mjs';
import { whichAbsolute } from './which.mjs';
import { processAlive } from './merge-lock.mjs';
import { SLOT } from './headless.mjs';

// v0.8: `turbo-run update` (the /turbo-update skill). The newest released turbo is the highest vX.Y.Z tag of turbo's
// repository, read with git alone (no gh, no npm); it is cloned into a temporary directory and installed by its own
// installer, the way the first install was done (git clone, node install.mjs). turbo is never replaced while it runs:
// the caller's busy check (this project's supervisor and builds) and the role sessions of the whole machine refuse it.

const INSTALL = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const UPDATE_SOURCE = 'https://github.com/rnyqdz99yx-afk/gsd-turbo';
export const UPDATE_USAGE = 'usage: turbo-run update [--check] [--dry-run]';
const GIT_TIMEOUT_MS = 120000;
const NOTES_TIMEOUT_MS = 8000;
const NOTE_LINES = 12;
const CHECK_EVERY_MS = 24 * 3600 * 1000;

const parts = (v) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim()) || []).slice(1).map(Number);
// a is a later version than b; false when either is no X.Y.Z
export function newer(a, b) {
  const x = parts(a);
  const y = parts(b);
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// What is installed in the Claude home (its install manifest); a checkout that was never installed names its own.
export function installedVersion({ env = process.env, install = INSTALL } = {}) {
  return String(readJson(path.join(turboHome(env), 'install-manifest.json'), null)?.version ?? readJson(path.join(install, 'package.json'), null)?.version ?? '');
}

// The newest vX.Y.Z tag of the source: { tag, version }; null when it has none. Any other tag is no release.
export function latestRelease(source, { git }) {
  let best = null;
  for (const line of git(['ls-remote', '--tags', '--refs', source]).split(/\r?\n/)) {
    const tag = /\trefs\/tags\/(v\d+\.\d+\.\d+)$/.exec(line)?.[1];
    if (tag && (!best || newer(tag, best))) best = tag;
  }
  return best ? { tag: best, version: best.slice(1) } : null;
}

// How many role sessions of turbo run on this machine now, whatever their project (lib/headless.mjs: the slot files
// under <turbo home>/sessions, each live while its holder's pid is and its heartbeat is fresh).
export function liveSessions({ env = process.env, alive = processAlive, now = Date.now() } = {}) {
  const dir = path.join(turboHome(env), 'sessions');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  return names.filter((n) => /^slot-\d+\.json$/.test(n)).filter((n) => {
    const pid = readJson(path.join(dir, n), null)?.pid;
    try {
      return Number.isInteger(pid) && pid > 0 && now - fs.statSync(path.join(dir, n)).mtimeMs <= SLOT.staleMs && alive(pid);
    } catch {
      return false;
    }
  }).length;
}

// The release notes of the versions after `from` up to `to`, oldest first, as lines; [] when the source is not a
// GitHub repository or GitHub does not answer (the notes are a courtesy: the update never waits on them).
export async function releaseNotes(source, from, to, { fetchImpl = globalThis.fetch } = {}) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(String(source));
  if (!m || !fetchImpl) return [];
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${m[1]}/${m[2]}/releases?per_page=30`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'gsd-turbo-update' }, signal: AbortSignal.timeout(NOTES_TIMEOUT_MS) });
    if (!r?.ok) return [];
    const list = await r.json();
    if (!Array.isArray(list)) return [];
    const mine = list.filter((x) => parts(x?.tag_name).length === 3 && (!from || newer(x.tag_name, from)) && !newer(x.tag_name, to)).sort((a, b) => (newer(a.tag_name, b.tag_name) ? 1 : -1));
    return mine.flatMap((x) => {
      const name = String(x.name ?? '').replace(/\s+/g, ' ').trim();
      const body = String(x.body ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
      return [`${x.tag_name}${name && name !== x.tag_name ? ` — ${name.replace(new RegExp(`^${x.tag_name}\\s*[—-]\\s*`), '')}` : ''}`, ...body.slice(0, NOTE_LINES).map((l) => `  ${l.slice(0, 200)}`), ...(body.length > NOTE_LINES ? ['  …'] : [])];
    });
  } catch {
    return [];
  }
}

// What the last look at the repository found: { checkedAt, latest }, in <turbo home>/update-check.json.
const checkFile = (env) => path.join(turboHome(env), 'update-check.json');
export const readUpdateCheck = (env = process.env) => readJson(checkFile(env), null) ?? {};
function writeUpdateCheck(env, patch) {
  try {
    ensureDir(turboHome(env));
    writeJsonAtomic(checkFile(env), { ...readUpdateCheck(env), ...patch });
  } catch {
    // a look that cannot be remembered is made again
  }
}

// The line turbo-run status adds while a newer turbo is known, and the daily look that keeps it true: at most once a
// day a detached `turbo-run update --check` asks the repository (git ls-remote of its tags: nothing about the machine
// is sent) and writes what it found for the next status. Never in a lane, under `node --test`, or with
// TURBO_UPDATE_CHECK=off.
export function updateNotice(lang, { env = process.env, script = null, installed = installedVersion({ env }), now = Date.now(), spawnImpl = spawn } = {}) {
  if (env.TURBO_LANE || env.NODE_TEST_CONTEXT || String(env.TURBO_UPDATE_CHECK ?? '').toLowerCase() === 'off') return null;
  const seen = readUpdateCheck(env);
  if (script && !(now - Date.parse(seen.checkedAt) < CHECK_EVERY_MS)) {
    // the time of the try: a machine without a network looks once a day too
    writeUpdateCheck(env, { checkedAt: new Date(now).toISOString() });
    try {
      const child = spawnImpl(process.execPath, [script, 'update', '--check'], { cwd: os.tmpdir(), env, detached: true, windowsHide: true, stdio: 'ignore' });
      child.on?.('error', () => {});
      child.unref?.();
    } catch {
      // tomorrow's status looks again
    }
  }
  if (!newer(seen.latest, installed)) return null;
  return lang === 'ru' ? `вышел turbo ${seen.latest} (у вас ${installed}): обновить — /turbo-update` : `turbo ${seen.latest} is out (installed: ${installed}): /turbo-update installs it`;
}

class UpdateError extends Error {}
const reason = (err) => {
  const tail = String(err?.stderr ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-2).join(' ');
  return (tail || String(err?.message ?? err).split(/\r?\n/)[0]).slice(0, 300);
};

// turbo-run update [--check] [--dry-run] -> exit code: 0 done (or nothing to do), 1 failed, 2 usage, 3 refused (turbo
// runs). deps: { busy: () => why | null, exec, fetchImpl, installed }.
export async function runUpdateCommand(args, { root = null, out = (l) => process.stdout.write(`${l}\n`), env = process.env, deps = {} } = {}) {
  const flags = args.filter((a, i) => a !== '--project' && args[i - 1] !== '--project');
  if (flags.some((a) => a !== '--check' && a !== '--dry-run')) { out(UPDATE_USAGE); return 2; }
  const exec = deps.exec ?? execFileSync;
  const source = env.TURBO_UPDATE_REPO || UPDATE_SOURCE; // another git URL or a local path: a fork, a test
  const installed = deps.installed ?? installedVersion({ env });
  let git;
  let latest;
  try {
    // git by its absolute path from PATH, never one placed in the project (lib/which.mjs)
    const bin = whichAbsolute('git', { env, exclude: [root].filter(Boolean) });
    if (!bin) throw new UpdateError('git is not installed or not on PATH');
    git = (a) => String(exec(bin, a, { cwd: os.tmpdir(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: GIT_TIMEOUT_MS, env: { ...env, GIT_TERMINAL_PROMPT: '0' } }));
    latest = latestRelease(source, { git });
  } catch (err) {
    out(`cannot look for a newer turbo at ${source}: ${reason(err)}`);
    return 1;
  }
  if (!latest) { out(`cannot look for a newer turbo at ${source}: it has no released version (a vX.Y.Z tag)`); return 1; }
  writeUpdateCheck(env, { checkedAt: new Date().toISOString(), latest: latest.version });
  out(`installed: ${installed || 'unknown'} · latest: ${latest.version}`);
  if (installed && !newer(latest.version, installed)) { out('turbo is up to date'); return 0; }
  const notes = await releaseNotes(source, installed, latest.version, { fetchImpl: deps.fetchImpl });
  const printNotes = () => {
    if (!notes.length) return;
    out('what changed:');
    for (const l of notes) out(l);
  };
  if (flags.includes('--check')) {
    out(`update available: ${installed || 'unknown'} → ${latest.version} (/turbo-update, or turbo-run update)`);
    printNotes();
    return 0;
  }
  const sessions = liveSessions({ env });
  const busy = deps.busy?.() ?? (sessions ? `${sessions} turbo role session(s) run on this machine now (a project's phase is being built)` : null);
  if (busy) {
    out(`refused: ${busy}; turbo is never replaced while it runs: stop it at a pause (/turbo-autonomous stop), update, then start it again`);
    return 3;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-update-'));
  let keep = false;
  try {
    git(['clone', '--quiet', '--depth', '1', '--branch', latest.tag, source, dir]);
    const pkg = readJson(path.join(dir, 'package.json'), null);
    const installer = path.join(dir, 'install.mjs');
    if (pkg?.name !== 'gsd-turbo' || pkg.version !== latest.version || !fs.existsSync(installer)) throw new UpdateError(`the tag ${latest.tag} does not hold gsd-turbo ${latest.version}`);
    const install = (a) => String(exec(process.execPath, [installer, ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: GIT_TIMEOUT_MS, env })).trim();
    out(install(['--dry-run']));
    if (flags.includes('--dry-run')) { out('dry run: nothing changed'); return 0; }
    keep = true; // from here on a failure leaves the new version on disk, for a second try by hand
    out(install([]));
    keep = false;
    out(`updated: ${installed || 'unknown'} → ${latest.version}`);
    printNotes();
    out('next: turbo-run doctor (the new version against this machine: Claude Code, GSD core); Claude Code sessions opened before the update keep the old pane and skills until they are restarted');
    return 0;
  } catch (err) {
    out(`update failed: ${reason(err)}`);
    if (keep) out(`the new version is kept in ${dir}; to finish by hand: node "${path.join(dir, 'install.mjs')}"`);
    return 1;
  } finally {
    if (!keep) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // a temporary directory the system clears later
      }
    }
  }
}
