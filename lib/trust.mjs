import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// spec §4.1 (S1): Claude Code keeps a folder's trust in its global config, projects[<folder>].hasTrustDialogAccepted.
// turbo writes that one value for its own slots and removes a slot's whole entry when the slot goes (Claude Code adds
// its own fields to it), with a backup, and changes nothing else. The file is Claude Code's internal format: a
// format turbo does not know is left alone and the owner gets one line instead.
export const CHANGE_TRIES = 5;
export const RENAME_TRIES = 10;
export const RENAME_PAUSE_MS = 500;
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const OFF = 'writing the trust is off: lanes.trust_write is false or --no-trust-write was given';
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const readText = (file) => fs.readFileSync(file, 'utf8');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const why = (err) => err?.code || String(err?.message ?? err).split(/\r?\n/)[0];

// Claude Code's global config: .claude.json in CLAUDE_CONFIG_DIR when that is set, else in the home directory.
export function claudeJsonPath(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR ? path.join(path.resolve(env.CLAUDE_CONFIG_DIR), '.claude.json') : path.join(home, '.claude.json');
}

// The key Claude Code writes for a folder (S1): its absolute path; on Windows with forward slashes and an upper-case
// drive letter.
export function trustKey(dir, platform = process.platform) {
  if (platform !== 'win32') return path.posix.resolve(String(dir));
  return path.win32.resolve(String(dir)).replace(/\\/g, '/').replace(/^([a-z]):/, (m, d) => `${d.toUpperCase()}:`);
}

export function trustLine(dir, lang = 'en') {
  return lang === 'ru' ? `откройте claude в ${dir} один раз и примите доверие к папке` : `open claude in ${dir} once and accept the trust dialog`;
}

// { data } when turbo knows the format: a JSON object whose projects is an object keyed by absolute paths in the form
// Claude Code writes on this system; else { why }. Keys are never echoed: they are the owner's paths.
function parse(text, platform) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    return { why: 'not JSON' };
  }
  if (!isObj(data)) return { why: 'not a JSON object' };
  if (!isObj(data.projects)) return { why: 'no projects object' };
  const re = platform === 'win32' ? /^[A-Z]:\// : /^\//;
  if (Object.keys(data.projects).some((k) => !re.test(k))) return { why: 'a projects key that is not an absolute path in the form Claude Code writes here' };
  return { data };
}

// The keys of projects that name the folder: its own key, and its real path's (a link, an 8.3 name); on Windows in
// any case.
function entryKeys(projects, dir, platform) {
  const want = new Set([trustKey(dir, platform)]);
  try {
    want.add(trustKey(fs.realpathSync.native(dir), platform));
  } catch {
    // a folder that does not exist (yet) has no other name
  }
  const norm = (k) => (platform === 'win32' ? k.toLowerCase() : k);
  const wanted = new Set([...want].map(norm));
  return Object.keys(projects).filter((k) => wanted.has(norm(k)));
}

export function trustState(dir, { file = claudeJsonPath(), platform = process.platform, read = readText } = {}) {
  let text;
  try {
    text = read(file);
  } catch {
    return 'unknown';
  }
  const p = parse(text, platform);
  if (!p.data) return 'unknown';
  return entryKeys(p.data.projects, dir, platform).some((k) => p.data.projects[k]?.hasTrustDialogAccepted === true) ? 'trusted' : 'untrusted';
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// One backup per command run: the bytes turbo read before its first write, next to the file.
function backupOnce(file, text, run, now) {
  if (run.backup) return;
  const base = `${file}.turbo-bak-${stamp(now())}`;
  for (let i = 0; i < 100; i++) {
    const target = i ? `${base}-${i}` : base;
    try {
      fs.writeFileSync(target, text, { flag: 'wx', mode: 0o600 });
      run.backup = target;
      pruneBackups(file);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`no free backup name next to ${file}`);
}

export const KEEP_BACKUPS = 5;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const siblings = (file, re) => {
  try {
    return fs.readdirSync(path.dirname(file)).map((n) => [n, re.exec(n)]).filter(([, m]) => m);
  } catch {
    return [];
  }
};
const removeQuietly = (p) => {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    // held or gone: the next write tries again
  }
};

// Only the KEEP_BACKUPS newest backups of turbo's exact name, <file>.turbo-bak-<stamp>[-<n>], stay; nothing else
// next to the file is touched.
function pruneBackups(file) {
  const re = new RegExp(`^${escapeRe(path.basename(file))}\\.turbo-bak-(\\d{8}T\\d{6}Z)(?:-(\\d+))?$`);
  const all = siblings(file, re).sort(([, a], [, b]) => a[1].localeCompare(b[1]) || Number(a[2] ?? 0) - Number(b[2] ?? 0));
  for (const [n] of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) removeQuietly(path.join(path.dirname(file), n));
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
};

// The temporary files a turbo-run that died mid-write left next to the file: <file>.turbo-tmp-<pid> of a dead pid.
function removeStaleTmps(file) {
  const re = new RegExp(`^${escapeRe(path.basename(file))}\\.turbo-tmp-(\\d+)$`);
  for (const [n, m] of siblings(file, re)) if (Number(m[1]) !== process.pid && !pidAlive(Number(m[1]))) removeQuietly(path.join(path.dirname(file), n));
}

function realTarget(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink() ? fs.realpathSync(file) : file;
  } catch {
    return file; // missing: the read below says so
  }
}

// The temporary file over the original, retried while Windows refuses; before every attempt the original is read
// again: false when it changed (Claude Code wrote it during a pause), and the caller starts over from the new bytes.
function renameIfUnchanged(file, tmp, before, { rename, sleep, read }) {
  for (let attempt = 1; ; attempt++) {
    if (read(file) !== before) return false;
    try {
      rename(tmp, file);
      return true;
    } catch (err) {
      if (attempt >= RENAME_TRIES || !RETRY_CODES.has(err.code)) throw err;
      sleep(RENAME_PAUSE_MS);
    }
  }
}

// The spec §4.1 write: read, change in memory, write a temporary file next to it, then rename with retries while
// Windows refuses; before every rename attempt the original is read again, and a change (Claude Code wrote it
// meanwhile) starts the round over. change returns
// the new object, or null when nothing needs writing.
function rewrite(link, change, { platform, run, now, sleep, rename, read }) {
  // a config that is a link (dotfiles kept elsewhere) is written at its real target: a rename over the link would
  // replace it with a plain file
  const file = realTarget(link);
  const tmp = `${file}.turbo-tmp-${process.pid}`;
  removeStaleTmps(file);
  for (let round = 1; round <= CHANGE_TRIES; round++) {
    let before;
    try {
      before = read(file);
    } catch (err) {
      return { ok: false, missing: err?.code === 'ENOENT', why: `cannot read ${file} (${why(err)})` };
    }
    const p = parse(before, platform);
    if (!p.data) return { ok: false, why: `the format of ${file} is not one turbo knows (${p.why})` };
    const next = change(p.data);
    if (next === null) return { ok: true, changed: false };
    try {
      backupOnce(file, before, run, now);
      let mode = 0o600;
      try {
        mode = fs.statSync(file).mode & 0o777;
      } catch {
        // keep the private default
      }
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
      if (renameIfUnchanged(file, tmp, before, { rename, sleep, read })) return { ok: true, changed: true };
      fs.rmSync(tmp, { force: true });
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      return { ok: false, why: `cannot write ${file} (${why(err)})` };
    }
  }
  return { ok: false, why: `${file} kept changing while turbo wrote it (${CHANGE_TRIES} tries)` };
}

const defaults = (o) => ({
  file: o.file ?? claudeJsonPath(),
  platform: o.platform ?? process.platform,
  write: o.write ?? true,
  run: o.run ?? {},
  lang: o.lang ?? 'en',
  now: o.now ?? (() => new Date()),
  sleep: o.sleep ?? sleepSync,
  rename: o.rename ?? fs.renameSync,
  read: o.read ?? readText,
});

export function trustSlot(dir, options = {}) {
  const o = defaults(options);
  const key = trustKey(dir, o.platform);
  const manual = (reason) => ({ status: 'manual', key, why: reason, line: trustLine(dir, o.lang) });
  if (trustState(dir, o) === 'trusted') return { status: 'already', key };
  if (!o.write) return manual(OFF);
  const r = rewrite(o.file, (data) => {
    const keys = entryKeys(data.projects, dir, o.platform);
    if (keys.some((k) => data.projects[k]?.hasTrustDialogAccepted === true)) return null;
    // an entry Claude Code already keeps for the folder keeps its key and its fields
    const k = keys[0] ?? key;
    const entry = isObj(data.projects[k]) ? data.projects[k] : {};
    return { ...data, projects: { ...data.projects, [k]: { ...entry, hasTrustDialogAccepted: true } } };
  }, o);
  if (!r.ok) return manual(r.why);
  if (trustState(dir, o) !== 'trusted') return manual(`${o.file} did not keep the trust after the write`);
  return { status: r.changed ? 'trusted' : 'already', key, backup: o.run.backup ?? null };
}

export function untrustSlot(dir, options = {}) {
  const o = defaults(options);
  const key = trustKey(dir, o.platform);
  const manual = (reason) => ({ status: 'manual', key, why: reason, line: `remove the entry ${key} from projects in ${o.file}, or leave it: it only marks a folder that is gone as trusted` });
  if (!o.write) return manual(OFF);
  const r = rewrite(o.file, (data) => {
    const keys = entryKeys(data.projects, dir, o.platform);
    if (!keys.length) return null;
    const projects = { ...data.projects };
    for (const k of keys) delete projects[k];
    return { ...data, projects };
  }, o);
  if (!r.ok) return r.missing ? { status: 'absent', key } : manual(r.why);
  if (trustState(dir, o) === 'trusted') return manual(`${o.file} still trusts the folder after the write`);
  return { status: r.changed ? 'removed' : 'absent', key, backup: o.run.backup ?? null };
}
