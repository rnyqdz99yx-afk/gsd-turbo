import fs from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.mjs';
import { readJsonState, renameWithRetry } from './fsx.mjs';

// supervisor.json told apart (lib/fsx.mjs readJsonState): missing is a project that never started a run; damaged is a
// file that exists but holds no supervisor state: a machine that crashed right after a rename whose data never reached
// the disk leaves it empty or full of zero bytes (seen after a bugcheck: 526 NUL bytes). Read as missing it would say
// "never started": the watchdog silent, the view without a word, and a start that forgets the lanes. Damaged, the view
// and status say so, the watchdog tells the owner once, and the owner's start keeps the file aside and rebuilds the
// lanes (lib/sup-recover.mjs).
export const supervisorFile = (root) => path.join(runDir(root), 'supervisor.json');

// { state: 'missing' | 'valid' | 'damaged', sup (the object, or null), damaged: { why, at, unreadable } or null }; at is
// the file's last change (ISO, null when unknown): with why it names one damaged file, so the owner is told once of it.
export function readSupervisor(root) {
  const file = supervisorFile(root);
  const r = readJsonState(file);
  if (r.state !== 'damaged') return { state: r.state, sup: r.value, damaged: null };
  let at = null;
  try {
    at = fs.statSync(file).mtime.toISOString();
  } catch { /* unknown */ }
  return { state: 'damaged', sup: null, damaged: { why: r.why, at, ...(r.unreadable ? { unreadable: true } : {}) } };
}

// The name a damaged file is kept under, next to it: supervisor.json.damaged-20261014T122043Z (-2, -3 … when taken).
const stamp = (now) => now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
export function setAside(root, { now = new Date() } = {}) {
  const file = supervisorFile(root);
  const base = `${file}.damaged-${stamp(now)}`;
  let to = base;
  for (let n = 2; fs.existsSync(to); n++) to = `${base}-${n}`;
  renameWithRetry(file, to);
  return to;
}
