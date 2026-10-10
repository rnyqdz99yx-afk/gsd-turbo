import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A lane's own temp directory: the TMP, TEMP and TMPDIR of its session. It lives in the git directory
// (`git rev-parse --git-path turbo/tmp`), outside the working tree, so linters and type checkers that glob the
// tree never see it and nothing in it can be committed. Outside a repository: .planning/turbo/run/tmp.
// anchor: the directory the base is built under (the git directory, or the project root).
function tmpBase(root) {
  const abs = path.resolve(root);
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'turbo/tmp'], { cwd: abs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30000 }).trim();
    if (out) {
      const base = path.resolve(abs, out);
      return { base, anchor: path.dirname(path.dirname(base)) };
    }
  } catch { /* not a repository, or git failed */ }
  return { base: path.join(abs, '.planning', 'turbo', 'run', 'tmp'), anchor: abs };
}

export const laneTmpBase = (root) => tmpBase(root).base;
export const laneTmpDir = (root, phase) => path.join(laneTmpBase(root), `p${phase}`);

const key = (p) => {
  const k = p.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? k.toLowerCase() : k;
};

// The base must resolve to itself below its anchor: a link anywhere between them (the base, or a folder such
// as .planning/turbo/run or <git dir>/turbo) would put p<N> somewhere else. The anchor itself may be reached
// through a link (a project opened through one).
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
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

// Before a launch: what an earlier session of the phase left is removed, then the directory is created.
export function prepareLaneTmp(root, phase) {
  const t = tmpBase(root);
  checkBase(t);
  removeLaneTmp(root, phase);
  const dir = path.join(t.base, `p${phase}`);
  fs.mkdirSync(dir, { recursive: true });
  checkBase(t);
  return dir;
}
