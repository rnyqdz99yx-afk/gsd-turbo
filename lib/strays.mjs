import fs from 'node:fs';
import path from 'node:path';
import { REMOVING_RE, SLOT_RE, slotsDir } from './slots.mjs';

// Smoke F2, the supervisor's half: the write guard (lib/lane-guard.mjs) sees only the file tools, never a Bash redirect
// or a script that writes. While lanes run, the supervisor looks at the folders right around the project, where a
// relative path from a slot or the checkout lands (../x, ../../x): the folder above the project, and in slots mode the
// slots folder and the folder above it. A new entry there since the lanes started is reported: in the log always, and to
// the owner once when its name looks like a lane's scratch file (GSD's executor folders exec-<phase>-<plan>, TDD
// captures). It is never moved or deleted: the folder is the owner's (the Desktop, say), the entry may be the owner's
// own or still in use by a lane's process, and the lane's temporary folder, the only safe place to move it to, is
// deleted when the lane ends, so a move would be a delete.
export const SCRATCH_RE = /^(?:exec-\d|capture|red-|green-|mut-|mutant|scratch|tdd-|tmp-|temp-)/i;

const inside = (root, p) => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// The folders to look at, each with its own entries turbo never reports: the project itself, the slots folder, the
// slots and their leftovers. A folder inside the project is the project's own: not looked at.
export function strayWatch(root, config, { slots = false } = {}) {
  const abs = path.resolve(root);
  const out = new Map();
  const add = (dir, own = () => false) => {
    if (inside(abs, dir)) return;
    const prev = out.get(dir);
    out.set(dir, prev ? (n) => prev(n) || own(n) : own);
  };
  add(path.dirname(abs), (n) => n === path.basename(abs));
  if (slots) {
    const sd = slotsDir(abs, config);
    add(sd, (n) => SLOT_RE.test(n) || REMOVING_RE.test(n));
    add(path.dirname(sd), (n) => n === path.basename(sd));
  }
  return [...out].map(([dir, own]) => ({ dir, own }));
}

// The entries of the watched folders created at or after sinceMs (birth time; the change time where the file system
// keeps none), other than turbo's own and the ones in seen (their paths): { dir, name, path, scratch }. A folder that
// cannot be read is skipped.
export function findStrays({ watch, sinceMs, seen = [], fsApi = fs }) {
  const known = new Set(seen);
  const found = [];
  for (const { dir, own } of watch) {
    let names;
    try {
      names = fsApi.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const p = path.join(dir, name);
      if (own(name) || known.has(p)) continue;
      let st;
      try {
        st = fsApi.lstatSync(p);
      } catch {
        continue;
      }
      const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
      if (born >= sinceMs) found.push({ dir, name, path: p, scratch: SCRATCH_RE.test(name) });
    }
  }
  return found;
}
