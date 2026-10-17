import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpGitRepo } from './helpers/tmp.mjs';
import { fakeGsdCore } from './helpers/fake-gsd.mjs';
import { effortHome } from './helpers/effort-gsd.mjs';
import { LEAN_KEYS, LEAN_PREV_REL } from '../lib/lean.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const write = (root, rel, text) => {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const git = (root, ...args) => String(execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })).trim();

// A git project on GSD (fake core in .claude/, ignored) with .planning/config.json committed, and a temp home and Claude
// config directory with GSD's agents (effortHome): never the developer's real ~/.claude or ~/.gsd.
function cliProject({ config = { workflow: { auto_advance: true }, context_window: 1000000 }, turbo = null, effort = {} } = {}) {
  const root = tmpGitRepo();
  write(root, '.gitignore', '.claude/\n');
  write(root, '.planning/config.json', JSON.stringify(config, null, 2));
  write(root, '.planning/turbo/.gitignore', 'run/\nlogs/\nlocks/\n');
  if (turbo) write(root, '.planning/turbo/config.json', JSON.stringify(turbo));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'project');
  fakeGsdCore(root);
  const h = effortHome(effort);
  const env = { ...process.env, TURBO_LANE: '', GIT_CONFIG_GLOBAL: path.join(root, '.git', 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1', CLAUDE_CONFIG_DIR: h.claudeDir, HOME: h.home, USERPROFILE: h.home };
  delete env.TURBO_CONTROL_ROOT;
  const cli = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    return { code: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.split(/\r?\n/).filter(Boolean) };
  };
  return { root, h, cli };
}
const count = (lines, re) => lines.filter((l) => re.test(l)).length;

test('lean apply, status, off: lines, commits, exit 0', () => {
  const { root, h, cli } = cliProject();
  const apply = cli(['lean', 'apply']);
  assert.equal(apply.code, 0, apply.err);
  assert.ok(apply.lines.includes('lean: workflow.nyquist_validation absent → false'), apply.out);
  assert.ok(apply.lines.some((l) => l.startsWith('lean: committed ')), apply.out);
  assert.ok(apply.lines.includes('lean: effort gsd-planner xhigh → high (GSD effort sync, every project on this machine)'), apply.out);
  assert.deepEqual(h.argv(), [
    ['effort', 'sync', '--config-dir', h.claudeDir, '--cwd', root],
    ['effort', 'sync', '--apply', '--config-dir', h.claudeDir, '--cwd', root],
  ]);
  const status = cli(['lean', 'status']);
  assert.equal(status.code, 0, status.err);
  assert.equal(status.lines[0], 'lean: on');
  assert.deepEqual([/^5\.1 /, /^5\.2 /, /^5\.3 /, /^5\.4 /, /^5\.5 /].map((re) => count(status.lines, re)), [10, 3, 3, 8, 2], status.out);
  assert.ok(status.lines.includes('5.1 context_window (GSD): 400000 (ok, turbo 1000000 for pauses)'), status.out);
  assert.ok(status.lines.includes('5.4 effort gsd-planner: high (ok)'), status.out);
  assert.ok(status.lines.includes('5.5 lane markup: 0 independent phases (off, needs 3)'), status.out);
  assert.ok(!status.out.includes('differing GSD settings'), status.out);
  const json = JSON.parse(cli(['lean', 'status', '--json']).out);
  assert.equal(json.enabled, true);
  assert.equal(json.items.length, 26);
  const off = cli(['lean', 'off']);
  assert.equal(off.code, 0, off.err);
  assert.match(off.lines.at(-1), /^effort: GSD's agents keep gsd-planner high/);
  const after = cli(['lean', 'status']);
  assert.equal(after.lines[0], 'lean: off (lean.enabled false in .planning/turbo/config.json)');
  assert.ok(after.lines.includes('5.1 workflow.nyquist_validation: absent (differs: lean false)'), after.out);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'chore(turbo): lean mode off, GSD settings restored');
});

test('lean apply and off are refused inside a lane; status is not', () => {
  const { cli } = cliProject();
  for (const sub of ['apply', 'off']) {
    const r = cli(['lean', sub], { TURBO_LANE: '1' });
    assert.equal(r.code, 1);
    assert.equal(r.err.trim(), `refused: lean ${sub} is the owner's: a lane never runs it`);
  }
  assert.equal(cli(['lean', 'status'], { TURBO_LANE: '1' }).code, 0);
});

test('lean apply --dry-run writes nothing', () => {
  const { root, h, cli } = cliProject();
  const head = git(root, 'rev-parse', 'HEAD');
  const r = cli(['lean', 'apply', '--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.lines.includes('lean: workflow.pattern_mapper absent → false'), r.out);
  assert.equal(r.lines.at(-1), 'lean: dry run, nothing written');
  assert.equal(fs.existsSync(path.join(root, LEAN_PREV_REL)), false);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.deepEqual(h.argv(), []);
});

test('lean apply refused while gates are off: exit 1, the refusal line', () => {
  const { root, cli } = cliProject();
  write(root, '.planning/turbo/gates/p3.json', JSON.stringify({ phase: '3', original: {} }));
  const r = cli(['lean', 'apply']);
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), "refused: phase 3 has GSD's built-in gates off (.planning/turbo/gates/p3.json): run turbo-run gates restore 3 first; nothing was changed");
  // lean off too: that restore would put lean's values back after it
  const off = cli(['lean', 'off']);
  assert.equal(off.code, 1);
  assert.equal(off.err.trim(), "refused: phase 3 has GSD's built-in gates off (.planning/turbo/gates/p3.json): run turbo-run gates restore 3 first; nothing was changed");
});

test('unknown subcommand: usage, exit 2', () => {
  const { cli } = cliProject();
  for (const args of [['lean', 'frob'], ['lean']]) {
    const r = cli(args);
    assert.equal(r.code, 2);
    assert.equal(r.err.trim(), 'usage: turbo-run lean status [--json] | lean apply [--dry-run] | lean off');
  }
});

test('init applies lean mode: GSD keys set, lean lines printed, nothing committed, the temp HOME gets no .gsd when the Claude config directory has no GSD agents', () => {
  const { root, h, cli } = cliProject({ effort: { efforts: {}, tool: false } });
  const head = git(root, 'rev-parse', 'HEAD');
  const r = cli(['init']);
  assert.equal(r.code, 0, r.err);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.planning', 'config.json'), 'utf8'));
  for (const [k, v] of LEAN_KEYS) assert.equal(k.split('.').reduce((x, s) => x?.[s], cfg), v, k);
  assert.ok(r.lines.includes('lean: workflow.nyquist_validation absent → false'), r.out);
  assert.ok(r.lines.includes(`lean: effort not changed: GSD agents not found in ${path.join(h.claudeDir, 'agents')}; agent effort left as it is`), r.out);
  assert.match(r.lines.at(-1), /^created /);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.existsSync(path.join(root, LEAN_PREV_REL)), true);
  assert.equal(fs.existsSync(path.join(h.home, '.gsd')), false);
});

test('start stops on an invalid lanes.effort with the config error', () => {
  const { cli } = cliProject({ turbo: { lanes: { effort: 'turbo' } } });
  const r = cli(['start']);
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid turbo config lanes\.effort: must be one of low, medium, high, xhigh, max/);
});
