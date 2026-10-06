#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeHome as defaultHome } from './lib/paths.mjs';
import { writeJsonAtomic } from './lib/fsx.mjs';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = 'turbo/install-manifest.json';

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

function plan(repoDir) {
  const pairs = [];
  for (const sub of ['bin', 'lib']) for (const f of walk(path.join(repoDir, sub))) pairs.push([f, path.join('turbo', path.relative(repoDir, f))]);
  pairs.push([path.join(repoDir, 'package.json'), path.join('turbo', 'package.json')]);
  for (const d of fs.existsSync(path.join(repoDir, 'skills')) ? fs.readdirSync(path.join(repoDir, 'skills')) : []) {
    if (!d.startsWith('turbo-')) continue;
    for (const f of walk(path.join(repoDir, 'skills', d))) pairs.push([f, path.join('skills', path.relative(path.join(repoDir, 'skills'), f))]);
  }
  for (const f of walk(path.join(repoDir, 'agents'))) if (path.basename(f).startsWith('turbo-')) pairs.push([f, path.join('agents', path.basename(f))]);
  return pairs;
}

// A manifest entry is deletable only as a relative POSIX path inside claudeHome
// under turbo/, skills/turbo-*/ or agents/turbo-* (never the manifest itself);
// anything else is never touched.
const TURBO_OWNED = /^(turbo\/.+|skills\/turbo-[^/]+\/.+|agents\/turbo-[^/]+)$/;
function ownedPath(home, rel) {
  if (typeof rel !== 'string' || rel === MANIFEST || /[\\:\0]/.test(rel) || rel.startsWith('/')) return null;
  if (rel.split('/').some((s) => s === '' || s === '.' || s === '..') || !TURBO_OWNED.test(rel)) return null;
  const abs = path.resolve(home, rel);
  const inside = path.relative(home, abs);
  return inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? abs : null;
}

function turboOwnedDir(home, dir) {
  const rel = path.relative(home, dir).split(path.sep).join('/');
  return rel === 'turbo' || rel.startsWith('turbo/') || /^skills\/turbo-[^/]+(\/|$)/.test(rel);
}

export function install({ repoDir = REPO, claudeHome = defaultHome(), dryRun = false } = {}) {
  const home = path.resolve(claudeHome);
  const pairs = plan(repoDir);
  for (const [, rel] of pairs) if (/(^|[\\/])gsd-/.test(rel)) throw new Error(`refusing to write a gsd-* path: ${rel}`);
  const version = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')).version;
  const manifest = { version, installedAt: new Date().toISOString(), files: pairs.map(([, rel]) => rel.replace(/\\/g, '/')) };
  for (const rel of manifest.files) if (!ownedPath(home, rel)) throw new Error(`refusing to write outside the turbo namespace: ${rel}`);
  if (dryRun) return manifest;
  if (fs.existsSync(path.join(home, MANIFEST))) uninstall({ claudeHome: home });
  // Manifest first: a partially failed copy stays uninstallable.
  writeJsonAtomic(path.join(home, MANIFEST), manifest);
  for (const [src, rel] of pairs) {
    const dst = path.join(home, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return manifest;
}

function readManifest(mf) {
  const invalid = (why) => new Error(`invalid install manifest ${mf}: ${why}; delete it to reinstall`);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(mf, 'utf8'));
  } catch (e) {
    throw invalid(e.message.replace(/\s*\r?\n\s*/g, ' '));
  }
  if (!Array.isArray(data?.files)) throw invalid('no files list');
  return data;
}

// Returns the number of files removed (or, with dryRun, that would be removed), or null when
// claudeHome holds no install manifest.
export function uninstall({ claudeHome = defaultHome(), dryRun = false } = {}) {
  const home = path.resolve(claudeHome);
  const mf = path.join(home, MANIFEST);
  if (!fs.existsSync(mf)) return null;
  const { files } = readManifest(mf);
  const targets = [];
  for (const rel of files) {
    const abs = ownedPath(home, rel);
    if (abs) targets.push(abs);
    else process.stderr.write(`turbo uninstall: skipped manifest entry outside the turbo namespace: ${JSON.stringify(rel)}\n`);
  }
  let n = 0;
  for (const p of targets) {
    if (!fs.existsSync(p)) continue;
    if (fs.lstatSync(p).isDirectory()) {
      process.stderr.write(`turbo uninstall: skipped directory manifest entry: ${p}\n`);
      continue;
    }
    if (!dryRun) fs.rmSync(p);
    n++;
  }
  if (dryRun) return n;
  fs.rmSync(mf, { force: true });
  const dirs = [...new Set(targets.map((p) => path.dirname(p)))].sort((a, b) => b.length - a.length);
  for (const d of dirs) {
    let cur = d;
    while (turboOwnedDir(home, cur) && fs.existsSync(cur) && fs.readdirSync(cur).length === 0) {
      fs.rmdirSync(cur);
      cur = path.dirname(cur);
    }
  }
  return n;
}

// Compare realpaths: run through a symlink/junction, argv[1] keeps the link path
// while import.meta.url is the resolved one.
function isMain() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main(args) {
  const unknown = args.filter((a) => a !== '--uninstall' && a !== '--dry-run');
  if (unknown.length) {
    process.stderr.write(`unknown argument: ${unknown.join(' ')}\nusage: node install.mjs [--uninstall] [--dry-run]\n`);
    return 2;
  }
  const dryRun = args.includes('--dry-run');
  if (args.includes('--uninstall')) {
    const n = uninstall({ dryRun });
    if (n === null) {
      process.stderr.write(`no gsd-turbo install manifest in ${defaultHome()}\n`);
      return 1;
    }
    process.stdout.write(`${dryRun ? 'would remove' : 'removed'} ${n} files\n`);
    return 0;
  }
  const m = install({ dryRun });
  process.stdout.write(`${dryRun ? 'would install' : 'installed'} gsd-turbo ${m.version}: ${m.files.length} files into ${defaultHome()}\n`);
  return 0;
}

if (isMain()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e?.message || e}\n`);
    process.exitCode = 1;
  }
}
