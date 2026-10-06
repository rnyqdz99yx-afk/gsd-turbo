import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { phaseArtifacts } from './phase-files.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';

export const BASE_FILE = 'turbo-base.json';
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SPLIT_RE = /[\s`'"()<>[\]{},;|*]+/;
// a repo path, then an optional line reference: ":12", ":12-30", "#L12", "#L12-L30"
const REF_RE = /^(?:\.\/)?([\w@+-][\w@.+-]*(?:\/[\w@.+-]+)*)((?::\d+(?:[-–]\d+)?)|(?:#L\d+(?:-L?\d+)?))?:?$/;
const GIT = ['-c', 'core.quotepath=false', '--literal-pathspecs'];
const CHUNK = 200;
const lines = (s) => String(s).split(/\r?\n/).filter(Boolean);

export function extractRefs(text) {
  const paths = new Set();
  const lineRefs = new Set();
  for (const raw of String(text ?? '').replace(/\\/g, '/').split(SPLIT_RE)) {
    const m = REF_RE.exec(raw.replace(/[.,:;!?]+$/, ''));
    if (!m) continue;
    const p = m[1];
    if (!p.includes('/') && !/\.[A-Za-z0-9]{1,8}$/.test(p)) continue;
    paths.add(p);
    if (m[2]) lineRefs.add(p);
  }
  return { paths: [...paths], lineRefs: [...lineRefs] };
}

export function classifyArtifact({ kind, refs, lineRefs = [], changes }) {
  const cited = new Set(lineRefs);
  const reasons = [];
  let action = 'fresh';
  for (const p of [...refs].sort()) {
    const st = changes.get(p);
    if (!st) continue;
    if (st === 'D') {
      action = 'rebuild';
      reasons.push(`${p}: deleted or renamed`);
    } else if (kind !== 'context' && (st === 'A' || cited.has(p))) {
      if (action === 'fresh') action = 'reground';
      reasons.push(st === 'A' ? `${p}: created since the artifact was written` : `${p}: changed at a referenced line`);
    }
  }
  return { action, reasons };
}

export function gitRunner(root) {
  return (args) => execFileSync('git', [...GIT, ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60000, maxBuffer: 256 * 1024 * 1024,
  });
}

export function diffStatus(git, base, paths) {
  const out = new Map();
  for (let i = 0; i < paths.length; i += CHUNK) {
    for (const l of lines(git(['diff', '--name-status', '--no-renames', '--relative', base, 'HEAD', '--', ...paths.slice(i, i + CHUNK)]))) {
      const [st, p] = l.split('\t');
      out.set(p, st[0]);
    }
  }
  return out;
}

export function artifactBase({ git, phaseDir, rel }) {
  const raw = readJson(path.join(phaseDir, BASE_FILE), null);
  const rec = raw && typeof raw === 'object' ? raw[path.posix.basename(rel)] : null;
  if (rec && SHA_RE.test(String(rec.base_sha))) {
    try {
      git(['cat-file', '-e', `${rec.base_sha}^{commit}`]);
      return { sha: rec.base_sha, source: 'record' };
    } catch {
      // the recorded commit is gone (rewritten history): fall back to the artifact's own commit
    }
  }
  let last = '';
  try {
    last = git(['log', '-1', '--format=%H', '--', rel]).trim();
  } catch {
    // no history yet
  }
  return last ? { sha: last, source: 'commit' } : { sha: null, source: 'uncommitted' };
}

export function recordBases(phaseDir, files, sha, now = new Date()) {
  const f = path.join(phaseDir, BASE_FILE);
  const raw = readJson(f, null);
  const cur = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const name of files) cur[name] = { base_sha: sha, recorded_at: now.toISOString() };
  writeJsonAtomic(f, Object.fromEntries(Object.entries(cur).sort(([a], [b]) => a.localeCompare(b))));
  return f;
}

export function stalenessReport({ root, phaseDir, plans = [], git = gitRunner(root), readText = (f) => fs.readFileSync(f, 'utf8') }) {
  const pending = plans.filter((p) => !p.has_summary);
  if (plans.length && !pending.length) return { head: null, skipped: 'every plan has a summary', artifacts: [] };
  const a = phaseArtifacts(phaseDir);
  const head = git(['rev-parse', 'HEAD']).trim();
  const relDir = path.relative(root, phaseDir).split(path.sep).join('/');
  const items = [];
  for (const kind of ['context', 'research', 'patterns']) if (a[kind]) items.push({ kind, file: a[kind], extra: [] });
  const onDisk = new Set(a.plans.map((p) => p.file));
  for (const p of pending) {
    const file = `${p.id}-PLAN.md`;
    if (onDisk.has(file)) items.push({ kind: 'plan', file, extra: [...(p.files_modified || []), ...(p.files_deleted || [])] });
  }
  const tracked = new Set(lines(git(['ls-files'])));
  const knownAt = new Map();
  const known = (sha) => {
    if (!knownAt.has(sha)) knownAt.set(sha, new Set([...tracked, ...lines(git(['ls-tree', '-r', '--name-only', sha]))]));
    return knownAt.get(sha);
  };
  const artifacts = items.map(({ kind, file, extra }) => {
    const base = artifactBase({ git, phaseDir, rel: `${relDir}/${file}` });
    const row = { kind, file, base: base.sha, baseSource: base.source, action: 'fresh', reasons: [] };
    if (!base.sha || base.sha === head) return row;
    const { paths, lineRefs } = extractRefs(readText(path.join(phaseDir, file)));
    const set = known(base.sha);
    const refs = [...new Set([...extra, ...paths.filter((p) => set.has(p))])];
    return { ...row, ...classifyArtifact({ kind, refs, lineRefs, changes: diffStatus(git, base.sha, refs) }) };
  });
  return { head, skipped: null, artifacts };
}
