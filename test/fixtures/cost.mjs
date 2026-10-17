import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORK, SESSION, entry, projectDirFor, setMtime, writeAgent, writeJob, writeSession } from '../helpers/transcripts.mjs';

// Synthetic cost data for test/cost.test.mjs and test/cli-cost.test.mjs (Stage 6 M). Never a real transcript.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Phase 4 on the build path: run/cost-p4.json (four headless sessions) and two PLAN files.
export function writeBuildPhase4(root) {
  const run = path.join(root, '.planning', 'turbo', 'run');
  fs.mkdirSync(run, { recursive: true });
  fs.copyFileSync(path.join(HERE, 'cost-p4.json'), path.join(run, 'cost-p4.json'));
  const dir = path.join(root, '.planning', 'phases', '04-build');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '04-01-PLAN.md'), '# plan 04-01\n');
  fs.writeFileSync(path.join(dir, '04-02-PLAN.md'), '# plan 04-02\n');
}

const T = (hms) => `2026-10-17T${hms}.000Z`;
const u = (i, w, r, o) => ({ input_tokens: i, cache_creation_input_tokens: w, cache_read_input_tokens: r, output_tokens: o });
let uuids = 0;
// every user entry carries a uuid, as Claude Code writes it
const withUuid = (e) => ({ ...e, uuid: `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}` });
const tool = (name, input, id) => ({ name, input, ...(id ? { id } : {}) });
const call = (hms, id, usage, t = null, extra = {}) => entry.assistant({ ts: T(hms), id, usage, ...(t ? { tool: t } : { text: 'ok' }), ...extra });
const sideCall = (hms, id, usage, t = null) => call(hms, id, usage, t, { sidechain: true });

function writeLog(root, lines) {
  const dir = path.join(root, '.planning', 'turbo', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'supervisor.log'), lines.map(([hms, text]) => `${T(hms)} ${text}\n`).join(''));
}

// Phase 3 on the lane path: job 11111111 launched, later woken. Its first transcript (SESSION) runs the freshness and
// discuss steps with one subagent; the woken one (FORK) replays that history, then works in the plan step.
export function writeLanePhase3({ home, root }) {
  writeLog(root, [['10:00:00', 'launch phase 3 session 11111111'], ['10:59:59', 'wake phase 3: woke session 11111111']]);
  writeJob(home, '11111111', { sessionId: SESSION, resumeSessionId: FORK });
  const run = path.join(root, '.planning', 'turbo', 'run');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'phase-p3.json'), JSON.stringify({ phase: '3', done: ['freshness', 'discuss'], attempts: { fix: 2 } }));
  const dir = projectDirFor(home, root);
  const first = [
    withUuid(entry.user('Run the turbo-phase skill with arguments: 3', T('10:00:00'))),
    call('10:00:10', 'm1', u(100, 1000, 0, 50), tool('Skill', { skill: 'turbo-phase' })),
    call('10:00:20', 'm2', u(10, 0, 2000, 20), tool('Bash', { command: 'node "$T" phase-step 3' }, 'toolu_ps1')),
    withUuid(entry.toolResult('toolu_ps1', 'phase 3: next discuss (done: freshness)', T('10:00:30'))),
    call('10:01:30', 'm3', u(0, 500, 3000, 100), tool('Agent', { subagent_type: 'gsd-assumptions-analyzer', description: 'assumptions', prompt: 'p' }, 'toolu_ag1')),
    withUuid(entry.launched('toolu_ag1', 'a0123456789abcdef', T('10:01:40'))),
    withUuid(entry.note('a0123456789abcdef', 'completed', T('10:20:00'))),
    call('10:20:10', 'm4', u(0, 0, 4000, 30), tool('Bash', { command: 'node "$T" phase-step 3 --done discuss' }, 'toolu_ps2')),
    call('10:20:11', 'm4', u(0, 0, 4000, 30)),
    withUuid(entry.toolResult('toolu_ps2', 'phase 3: next plan (done: freshness, discuss)', T('10:20:15'))),
  ];
  const woken = [
    ...first,
    withUuid(entry.user('The owner answered ask-1.', T('11:00:00'))),
    call('11:00:05', 'm5', u(0, 0, 5000, 40)),
    call('11:00:10', 'm6', u(0, 0, 1000, 10), tool('Read', { file_path: 'notes.md' }, 'toolu_rd1')),
    withUuid(entry.toolResult('toolu_rd1', 'phase 3: next uat', T('11:00:12'))),
    call('11:00:20', 'm7', u(0, 0, 1000, 10)),
  ];
  setMtime(writeSession(dir, SESSION, first), new Date(T('10:20:15')));
  setMtime(writeSession(dir, FORK, woken), new Date(T('11:00:20')));
  writeAgent(dir, SESSION, 'a0123456789abcdef', [
    withUuid(entry.agentUser('a0123456789abcdef', 'Analyze phase 3', T('10:01:41'))),
    sideCall('10:02:41', 's1', u(200, 4000, 0, 300)),
    sideCall('10:04:41', 's2', u(0, 0, 8000, 200)),
  ], { agentType: 'gsd-assumptions-analyzer', toolUseId: 'toolu_ag1', spawnDepth: 1 });
}

export const SESSION5 = '22222222-3333-4444-8555-666666666666';

// Phase 5: an adopted session without job state, a GSD skill, a nested subagent listed before its parent, a subagent
// whose dispatch is not found, and a synthetic message.
export function writeLanePhase5({ home, root }) {
  writeLog(root, [['09:00:00', 'adopt phase 5 session 22222222']]);
  const dir = projectDirFor(home, root);
  const synthetic = call('09:00:30', 'syn1', u(1000, 0, 0, 1000));
  synthetic.message.model = '<synthetic>';
  writeSession(dir, SESSION5, [
    withUuid(entry.user('Run the turbo-phase skill with arguments: 5', T('09:00:00'))),
    call('09:00:10', 'g1', u(1, 0, 0, 1), tool('Skill', { skill: '/gsd:execute-phase' })),
    call('09:00:20', 'g2', u(1, 0, 0, 1), tool('Agent', { subagent_type: 'gsd-executor', description: 'Execute plan 01 of phase 5', prompt: 'p' }, 'toolu_x')),
    synthetic,
  ]);
  writeAgent(dir, SESSION5, 'a1000000000000001', [
    sideCall('09:00:31', 'a1', u(1, 0, 0, 1), tool('Agent', { subagent_type: 'Explore', description: 'look', prompt: 'p' }, 'toolu_y')),
  ], { agentType: 'gsd-executor', toolUseId: 'toolu_x', spawnDepth: 1 });
  writeAgent(dir, SESSION5, 'a0000000000000002', [sideCall('09:00:42', 'b1', u(1, 0, 0, 1))], { agentType: 'Explore', toolUseId: 'toolu_y', spawnDepth: 2 });
  writeAgent(dir, SESSION5, 'a3000000000000003', [sideCall('09:01:00', 'c1', u(1, 0, 0, 1))], { agentType: 'general-purpose', toolUseId: 'toolu_gone', spawnDepth: 1 });
}
