import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { installedVersion, latestRelease, liveSessions, newer, releaseNotes, runUpdateCommand } from '../lib/update.mjs';

// A stand-in for turbo's repository: an installer that writes the install manifest of the Claude home it is given, two
// released versions (0.9.0, then 0.10.0: a later version by number, not by spelling) and tags that are no release.
const INSTALLER = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  "const here = path.dirname(fileURLToPath(import.meta.url));",
  "const version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;",
  "const dry = process.argv.includes('--dry-run');",
  "const home = path.join(process.env.CLAUDE_CONFIG_DIR, 'turbo');",
  "if (process.env.TURBO_TEST_INSTALL_FAILS && !dry) { process.stderr.write('disk full\\n'); process.exit(1); }",
  "if (!dry) { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'install-manifest.json'), JSON.stringify({ version, files: [] })); }",
  "process.stdout.write(`${dry ? 'would install' : 'installed'} gsd-turbo ${version}: 1 files\\n`);",
].join('\n');
function releaseRepo() {
  const dir = tmpGitRepo();
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  for (const version of ['0.9.0', '0.10.0']) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'gsd-turbo', version }));
    fs.writeFileSync(path.join(dir, 'install.mjs'), INSTALLER);
    git('add', '-A');
    git('commit', '-q', '-m', `v${version}`);
    git('tag', `v${version}`);
  }
  git('tag', 'v1.0.0-beta');
  git('tag', 'stage-4');
  return dir;
}
const REPO = releaseRepo();
function machine(installed) {
  const home = tmpDir('upd-home');
  if (installed) {
    fs.mkdirSync(path.join(home, 'turbo'), { recursive: true });
    fs.writeFileSync(path.join(home, 'turbo', 'install-manifest.json'), JSON.stringify({ version: installed, files: [] }));
  }
  const lines = [];
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home, TURBO_UPDATE_REPO: REPO };
  const run = async (args = [], deps = {}, extra = {}) => { lines.length = 0; return runUpdateCommand(args, { out: (l) => lines.push(l), env: { ...env, ...extra }, deps }); };
  return { home, env, lines, run, version: () => installedVersion({ env }) };
}
const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('turbo-update-')).length;

test('newer compares versions by number', () => {
  assert.ok(newer('0.10.0', '0.9.0') && newer('v1.0.0', '0.99.99') && newer('0.8.1', 'v0.8.0'));
  assert.ok(!newer('0.8.0', '0.8.0') && !newer('0.7.3', '0.8.0') && !newer('1.0.0-beta', '0.1.0') && !newer('0.8.0', ''));
});

test('latestRelease: the highest vX.Y.Z tag; other tags are no release', () => {
  const git = (a) => String(execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.deepEqual(latestRelease(REPO, { git }), { tag: 'v0.10.0', version: '0.10.0' });
  assert.equal(latestRelease(tmpGitRepo(), { git }), null);
});

test('update --check tells of a newer version and changes nothing', async () => {
  const m = machine('0.9.0');
  assert.equal(await m.run(['--check']), 0);
  assert.deepEqual(m.lines, ['installed: 0.9.0 · latest: 0.10.0', 'update available: 0.9.0 → 0.10.0 (/turbo-update, or turbo-run update)']);
  assert.equal(m.version(), '0.9.0');
});

test('update installs the newest version with its own installer and leaves no temporary copy', async () => {
  const m = machine('0.9.0');
  const before = leftovers();
  assert.equal(await m.run(), 0);
  assert.deepEqual(m.lines.slice(0, 4), ['installed: 0.9.0 · latest: 0.10.0', 'would install gsd-turbo 0.10.0: 1 files', 'installed gsd-turbo 0.10.0: 1 files', 'updated: 0.9.0 → 0.10.0']);
  assert.match(m.lines.at(-1), /^next: turbo-run doctor/);
  assert.equal(m.version(), '0.10.0');
  assert.equal(leftovers(), before);
  // the newest already: nothing to do
  assert.equal(await m.run(), 0);
  assert.deepEqual(m.lines, ['installed: 0.10.0 · latest: 0.10.0', 'turbo is up to date']);
});

test('update refuses while turbo runs, and --dry-run changes nothing', async () => {
  const m = machine('0.9.0');
  assert.equal(await m.run([], { busy: () => 'the supervisor of this project is running' }), 3);
  assert.match(m.lines.at(-1), /^refused: the supervisor of this project is running; turbo is never replaced while it runs/);
  assert.equal(await m.run(['--dry-run']), 0);
  assert.deepEqual(m.lines.slice(-2), ['would install gsd-turbo 0.10.0: 1 files', 'dry run: nothing changed']);
  assert.equal(m.version(), '0.9.0');
  assert.equal(await m.run(['--force']), 2);
});

test('a failing installer keeps the new version on disk and names the command that finishes by hand', async () => {
  const m = machine('0.9.0');
  assert.equal(await m.run([], {}, { TURBO_TEST_INSTALL_FAILS: '1' }), 1);
  assert.equal(m.lines.at(-2), 'update failed: disk full');
  const kept = /^the new version is kept in (.+); to finish by hand: node "(.+)"$/.exec(m.lines.at(-1));
  assert.ok(kept && fs.existsSync(kept[2]));
  fs.rmSync(kept[1], { recursive: true, force: true });
});

test('a source that cannot be read fails with one line', async () => {
  const m = machine('0.9.0');
  assert.equal(await m.run([], {}, { TURBO_UPDATE_REPO: path.join(m.home, 'no-such-repo') }), 1);
  assert.match(m.lines[0], /^cannot look for a newer turbo at /);
  assert.equal(m.lines.length, 1);
});

test('liveSessions counts the role sessions whose holder lives and whose heartbeat is fresh', () => {
  const m = machine();
  const dir = path.join(m.home, 'turbo', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(liveSessions({ env: m.env }), 0);
  fs.writeFileSync(path.join(dir, 'slot-1.json'), JSON.stringify({ pid: process.pid, token: 't' }));
  fs.writeFileSync(path.join(dir, 'slot-2.json'), JSON.stringify({ pid: process.pid, token: 't' }));
  fs.writeFileSync(path.join(dir, 'slot-3.json'), 'not json');
  assert.equal(liveSessions({ env: m.env }), 2);
  assert.equal(liveSessions({ env: m.env, alive: () => false }), 0);
  assert.equal(liveSessions({ env: m.env, now: Date.now() + 31 * 60000 }), 0);
});

test('releaseNotes: the versions after the installed one up to the newest, oldest first; silent when GitHub does not answer', async () => {
  const list = [
    { tag_name: 'v0.8.1', name: 'v0.8.1 — a fix', body: 'one\n\ntwo' },
    { tag_name: 'v0.9.0', name: 'v0.9.0', body: '' },
    { tag_name: 'v0.8.0', name: 'v0.8.0 — reports', body: 'old' },
    { tag_name: 'nightly', name: 'x', body: 'x' },
  ];
  const asked = [];
  const fetchImpl = async (url) => { asked.push(url); return { ok: true, json: async () => list }; };
  assert.deepEqual(await releaseNotes('https://github.com/o/r', '0.8.0', '0.8.1', { fetchImpl }), ['v0.8.1 — a fix', '  one', '  two']);
  assert.deepEqual(asked, ['https://api.github.com/repos/o/r/releases?per_page=30']);
  assert.deepEqual(await releaseNotes('https://github.com/o/r.git', '0.8.0', '0.9.0', { fetchImpl }), ['v0.8.1 — a fix', '  one', '  two', 'v0.9.0']);
  assert.deepEqual(await releaseNotes('/local/path', '0.8.0', '0.9.0', { fetchImpl }), []);
  assert.deepEqual(await releaseNotes('https://github.com/o/r', '0.8.0', '0.9.0', { fetchImpl: async () => { throw new Error('offline'); } }), []);
  assert.deepEqual(await releaseNotes('https://github.com/o/r', '0.8.0', '0.9.0', { fetchImpl: async () => ({ ok: false }) }), []);
});
