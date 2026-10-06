#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeHome as defaultHome } from './lib/paths.mjs';
import { writeJsonAtomic } from './lib/fsx.mjs';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join('turbo', 'install-manifest.json');

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
// under turbo/, skills/turbo-*/ or agents/turbo-*; anything else is never touched.
const TURBO_OWNED = /^(turbo\/.+|skills\/turbo-[^/]+\/.+|agents\/turbo-[^/]+)$/;
function ownedPath(home, rel) {
  if (typeof rel !== 'string' || /[\\:\0]/.test(rel) || rel.startsWith('/')) return null;
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

export function uninstall({ claudeHome = defaultHome() } = {}) {
  const home = path.resolve(claudeHome);
  const mf = path.join(home, MANIFEST);
  if (!fs.existsSync(mf)) return 0;
  const { files } = JSON.parse(fs.readFileSync(mf, 'utf8'));
  if (!Array.isArray(files)) throw new Error(`invalid install manifest (no files list): ${mf}`);
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
    fs.rmSync(p);
    n++;
  }
  fs.rmSync(mf);
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--uninstall')) {
    process.stdout.write(`removed ${uninstall()} files\n`);
  } else {
    const m = install({ dryRun: args.includes('--dry-run') });
    process.stdout.write(`${args.includes('--dry-run') ? 'would install' : 'installed'} gsd-turbo ${m.version}: ${m.files.length} files into ${defaultHome()}\n`);
  }
}
