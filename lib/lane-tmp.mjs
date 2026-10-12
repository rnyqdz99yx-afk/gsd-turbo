import fs from 'node:fs';
import path from 'node:path';
import { projectHash } from './claude.mjs';
import { turboHome } from './paths.mjs';

// A lane's own temp directory: the TMP, TEMP and TMPDIR of its session. It lives under turbo's own directory
// (<Claude config dir>/turbo/tmp, then the project's key: two GSD projects never share it), outside the checkout
// and its git directory: linters and type checkers that glob the tree never see it, nothing in it can be committed,
// and a project test that checks that os.tmpdir() lies outside its checkout passes inside a lane too.
// anchor: the directory the base is built under (turbo's own directory).
function tmpBase(root) {
  const anchor = turboHome();
  return { base: path.join(anchor, 'tmp', projectHash(path.resolve(root))), anchor };
}

export const laneTmpBase = (root) => tmpBase(root).base;
export const laneTmpDir = (root, phase) => path.join(laneTmpBase(root), `p${phase}`);

const key = (p) => {
  const k = p.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? k.toLowerCase() : k;
};

// The base must resolve to itself below its anchor: a link anywhere between them (the base, or turbo/tmp) would
// put p<N> somewhere else. The anchor itself may be reached through a link (a config directory behind one).
function checkBase({ base, anchor }) {
  let p = base;
  while (key(p) !== key(anchor) && !fs.existsSync(p) && path.dirname(p) !== p) p = path.dirname(p);
  const expected = path.join(fs.realpathSync(anchor), path.relative(anchor, p));
  if (key(fs.realpathSync(p)) !== key(expected)) throw new Error(`${base} is a link or lies under one; its lane directories are not touched`);
}

// Removes p<phase> under the base and nothing else: a p<phase> that is a link, or that resolves anywhere but
// directly inside the base, is refused, and so is a base that is a link. Returns the removed directory, null
// when there was none; throws on a refusal.
export function removeLaneTmp(root, phase) {
  const t = tmpBase(root);
  const dir = path.join(t.base, `p${phase}`);
  if (path.dirname(dir) !== t.base) throw new Error(`${dir} not removed: it is not directly inside ${t.base}`);
  let link;
  try {
    link = fs.lstatSync(dir).isSymbolicLink(); // a junction too
  } catch {
    return null; // nothing there
  }
  checkBase(t);
  let inside = false;
  try {
    inside = !link && key(path.dirname(fs.realpathSync(dir))) === key(fs.realpathSync(t.base));
  } catch { /* unresolvable: refused below */ }
  if (!inside) throw new Error(`${dir} not removed: it resolves outside ${t.base}`);
  // Renamed away as a whole first: Windows refuses to delete a directory a process (a stand an earlier session
  // left running) has as its cwd or holds open, and a plain recursive delete would remove the files around it
  // first. While anything holds it, the rename fails and nothing is deleted.
  const gone = path.join(t.base, `p${phase}.removing-${process.pid}-${Date.now()}`);
  try {
    fs.renameSync(dir, gone);
  } catch (err) {
    throw new Error(`${dir} not removed: ${err.code || err.message} (in use?)`);
  }
  fs.rmSync(gone, { recursive: true, force: true });
  return dir;
}

// Before a launch: what an earlier session of the phase left is removed, then the directory is created.
// Best effort about the old directory: a removal that fails or is refused is logged, and the lane gets the
// directory as it is (a failed removal is never a launch failure). A base that is a link still throws.
export function prepareLaneTmp(root, phase, log = () => {}) {
  const t = tmpBase(root);
  // turbo's directory may not exist yet (a fresh config directory): the checks resolve it
  fs.mkdirSync(t.anchor, { recursive: true });
  checkBase(t);
  const dir = path.join(t.base, `p${phase}`);
  try {
    removeLaneTmp(root, phase);
  } catch (err) {
    log(`lane temp directory ${dir} kept: ${err.message}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  checkBase(t);
  return dir;
}
