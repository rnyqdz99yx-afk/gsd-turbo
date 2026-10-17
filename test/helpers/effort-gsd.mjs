import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './tmp.mjs';

// A temp home and Claude config directory for GSD's agent effort (Stage 6 D8): <claudeDir>/agents/<agent>.md with an
// effort: line each, and a stub <claudeDir>/gsd-core/bin/gsd-tools.cjs that answers `effort sync` the way GSD 1.17's
// cmdEffortSync does (os.homedir()/.gsd/defaults.json effort.agent_overrides against the agents of --config-dir; a dry
// run unless --apply; JSON { synced, skipped, changes, dry_run, agents_dir }). Every call's argv goes to
// <claudeDir>/effort-argv.jsonl. efforts {} and tool false: an empty Claude config directory. Never the real ~/.claude.
export function effortHome({ efforts = { 'gsd-planner': 'xhigh', 'gsd-assumptions-analyzer': 'xhigh', 'gsd-phase-researcher': 'high', 'gsd-executor': 'high' }, defaults = null, tool = true } = {}) {
  const home = tmpDir('effort-home');
  const claudeDir = tmpDir('effort-claude');
  for (const [agent, e] of Object.entries(efforts)) {
    fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'agents', `${agent}.md`), `---\nname: ${agent}\n${e === 'inherit' ? '' : `effort: ${e}\n`}---\n\nbody\n`);
  }
  if (tool) {
    fs.mkdirSync(path.join(claudeDir, 'gsd-core', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'gsd-core', 'bin', 'gsd-tools.cjs'), STUB);
  }
  if (defaults !== null) {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), typeof defaults === 'string' ? defaults : JSON.stringify(defaults, null, 2));
  }
  const argvFile = path.join(claudeDir, 'effort-argv.jsonl');
  return {
    home,
    claudeDir,
    env: { CLAUDE_CONFIG_DIR: claudeDir },
    argv: () => (fs.existsSync(argvFile) ? fs.readFileSync(argvFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

const STUB = String.raw`'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, '..', '..', 'effort-argv.jsonl'), JSON.stringify(argv) + '\n');
if (argv[0] !== 'effort' || argv[1] !== 'sync') {
  process.stderr.write('effort stub: unsupported ' + argv.join(' ') + '\n');
  process.exit(2);
}
let configDir = null;
let apply = false;
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === '--config-dir') configDir = argv[++i];
  else if (argv[i] === '--apply') apply = true;
  else if (argv[i] === '--cwd') i++;
}
let overrides = {};
try {
  overrides = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.gsd', 'defaults.json'), 'utf8')).effort.agent_overrides || {};
} catch (e) { /* none */ }
const agentsDir = path.join(configDir, 'agents');
const changes = [];
for (const f of fs.readdirSync(agentsDir).filter((n) => /^gsd-.*\.md$/.test(n)).sort()) {
  const agent = f.slice(0, -3);
  const want = overrides[agent];
  if (!want) continue;
  const file = path.join(agentsDir, f);
  const text = fs.readFileSync(file, 'utf8');
  const m = /^effort:[ \t]*(.+?)[ \t]*$/m.exec(text);
  const from = m ? m[1] : null;
  if (from === want) continue;
  changes.push({ agent, from, to: want });
  if (apply) fs.writeFileSync(file, m ? text.replace(/^effort:.*$/m, 'effort: ' + want) : text.replace(/^---\n/, '---\neffort: ' + want + '\n'));
}
process.stdout.write(JSON.stringify({ synced: changes.length, skipped: 0, changes, dry_run: !apply, agents_dir: agentsDir }, null, 2) + '\n');
`;
