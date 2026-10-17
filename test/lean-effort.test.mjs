import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { effortHome } from './helpers/effort-gsd.mjs';
import { LEAN_EFFORT, agentEffort, effortApply, effortOffHint, effortPaths, leanLines } from '../lib/lean.mjs';

const THREE = [
  { agent: 'gsd-assumptions-analyzer', from: 'xhigh', to: 'high' },
  { agent: 'gsd-phase-researcher', from: 'high', to: 'medium' },
  { agent: 'gsd-planner', from: 'xhigh', to: 'high' },
];

test('effort apply writes the three overrides into defaults.json, keeps its other keys, and runs GSD\'s effort sync as a dry run, then with --apply', () => {
  const h = effortHome({ defaults: { model_profile: 'adaptive' } });
  const root = tmpDir('effort-root');
  const r = effortApply({ root, env: h.env, home: h.home });
  const defaults = JSON.parse(fs.readFileSync(path.join(h.home, '.gsd', 'defaults.json'), 'utf8'));
  assert.equal(defaults.model_profile, 'adaptive');
  assert.deepEqual(defaults.effort.agent_overrides, LEAN_EFFORT);
  assert.deepEqual(h.argv(), [
    ['effort', 'sync', '--config-dir', h.claudeDir, '--cwd', root],
    ['effort', 'sync', '--apply', '--config-dir', h.claudeDir, '--cwd', root],
  ]);
  const agents = path.join(h.claudeDir, 'agents');
  assert.deepEqual(['gsd-planner', 'gsd-assumptions-analyzer', 'gsd-phase-researcher'].map((a) => agentEffort(agents, a)), ['high', 'high', 'medium']);
  assert.equal(agentEffort(agents, 'gsd-executor'), 'high');
  assert.equal(r.defaultsChanged, true);
  assert.deepEqual(r.changes, THREE);
});

test('a second effort apply writes nothing and runs only the dry run', () => {
  const h = effortHome({ defaults: { model_profile: 'adaptive' } });
  const root = tmpDir('effort-root');
  effortApply({ root, env: h.env, home: h.home });
  const file = path.join(h.home, '.gsd', 'defaults.json');
  const bytes = fs.readFileSync(file, 'utf8');
  const r = effortApply({ root, env: h.env, home: h.home });
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(h.argv().length, 3);
  assert.deepEqual(h.argv()[2], ['effort', 'sync', '--config-dir', h.claudeDir, '--cwd', root]);
  assert.deepEqual(r, { defaultsChanged: false, changes: [] });
});

test('no GSD agents in the Claude config directory: skipped, defaults.json never created, GSD never run', () => {
  const h = effortHome({ efforts: {}, tool: false });
  const root = tmpDir('effort-root');
  const r = effortApply({ root, env: h.env, home: h.home });
  assert.deepEqual(r, { skipped: `GSD agents not found in ${path.join(h.claudeDir, 'agents')}; agent effort left as it is` });
  assert.equal(fs.existsSync(path.join(h.home, '.gsd')), false);
  assert.deepEqual(h.argv(), []);
  // the agents without the tool: skipped as well
  const noTool = effortHome({ tool: false });
  assert.match(effortApply({ root, env: noTool.env, home: noTool.home }).skipped, /^GSD agents not found in /);
  assert.equal(fs.existsSync(path.join(noTool.home, '.gsd')), false);
});

test('an unparsable defaults.json is left as it is', () => {
  const h = effortHome({ defaults: '{ "model_profile": ' });
  const file = path.join(h.home, '.gsd', 'defaults.json');
  const r = effortApply({ root: tmpDir('effort-root'), env: h.env, home: h.home });
  assert.deepEqual(r, { skipped: `${file} cannot be parsed; agent effort left as it is` });
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "model_profile": ');
  assert.deepEqual(h.argv(), []);
});

test('effort apply as a dry run lists the agents that would change and writes nothing', () => {
  const h = effortHome();
  const r = effortApply({ root: tmpDir('effort-root'), env: h.env, home: h.home, dryRun: true });
  assert.deepEqual(r, { defaultsChanged: true, changes: [THREE[2], THREE[0], THREE[1]], dryRun: true });
  assert.equal(fs.existsSync(path.join(h.home, '.gsd')), false);
  assert.deepEqual(h.argv(), []);
});

test('the owner\'s own overrides of these agents are named when lean replaces them', () => {
  const h = effortHome({ defaults: { effort: { agent_overrides: { 'gsd-planner': 'max', 'gsd-executor': 'low', 'gsd-phase-researcher': 'medium' } } } });
  const file = path.join(h.home, '.gsd', 'defaults.json');
  const r = effortApply({ root: tmpDir('effort-root'), env: h.env, home: h.home });
  assert.deepEqual(r.replaced, { file, agents: [{ agent: 'gsd-planner', from: 'max', to: 'high' }] });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).effort.agent_overrides['gsd-executor'], 'low');
  assert.ok(leanLines({ changed: [], effort: r }).includes(`lean: effort.agent_overrides in ${file}: your gsd-planner max is now high`));
  // a second apply replaces nothing
  assert.equal(effortApply({ root: tmpDir('effort-root'), env: h.env, home: h.home }).replaced, undefined);
});

test('agentEffort: the frontmatter effort line, inherit without one, null without the file', () => {
  const h = effortHome({ efforts: { 'gsd-planner': 'xhigh', 'gsd-verifier': 'inherit' } });
  const agents = path.join(h.claudeDir, 'agents');
  assert.equal(agentEffort(agents, 'gsd-planner'), 'xhigh');
  assert.equal(agentEffort(agents, 'gsd-verifier'), 'inherit');
  assert.equal(agentEffort(agents, 'gsd-nobody'), null);
});

test('effortOffHint names the defaults file and GSD\'s sync command', () => {
  const h = effortHome();
  const hint = effortOffHint({ env: h.env, home: h.home });
  assert.match(hint, /effort\.agent_overrides.*defaults\.json.*gsd-tools\.cjs" effort sync --apply --config-dir/);
  const p = effortPaths({ env: h.env, home: h.home });
  assert.deepEqual(p, {
    claudeDir: h.claudeDir,
    agentsDir: path.join(h.claudeDir, 'agents'),
    tool: path.join(h.claudeDir, 'gsd-core', 'bin', 'gsd-tools.cjs'),
    defaultsFile: path.join(h.home, '.gsd', 'defaults.json'),
  });
  assert.ok(hint.includes(p.defaultsFile) && hint.includes(p.tool) && hint.includes(p.claudeDir), hint);
  // without CLAUDE_CONFIG_DIR: <home>/.claude
  assert.equal(effortPaths({ env: {}, home: h.home }).claudeDir, path.join(h.home, '.claude'));
});
