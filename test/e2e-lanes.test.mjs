import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { A, P, annotated, freshLanes, lanesHarness } from './helpers/lanes.mjs';
import { resumableLanes, runDaemon, tick } from '../lib/supervisor.mjs';
import { writeLaneStatus } from '../lib/run-status.mjs';
import { readJson } from '../lib/fsx.mjs';
import { laneSessionName } from '../lib/claude.mjs';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ISOLATED, gitIn, mainProject, slotFixture } from './helpers/slots.mjs';
import { fakeDigest } from './helpers/lane-merge.mjs';
import { listSlots, prepareSlot, releaseSlot, setupSlots, slotForPhase, slotGit } from '../lib/slots.mjs';
import { mergeFollowUp, mergeHolds, mergeReady, mergeState } from '../lib/merge.mjs';
import { finishJob, jobPrompts, pendingJobs } from '../lib/prep.mjs';
import { readLanesFile, writeLanesFile } from '../lib/lanes-file.mjs';
import { integrateFile } from '../lib/integrate.mjs';
import { createGit } from '../lib/push.mjs';
import { pushSettings } from '../lib/config.mjs';

// L2's fake (reconcile R5): merged marks the phase complete in main and its merge state merged; the harness's
// mergeFollowUp releases the slot at the next tick, as L2 does after push and CI
const mergeOnce = (lane, h) => {
  h.phases.find((p) => p.number === lane.phase).complete = true;
  h.mergeStates[lane.phase] = { state: 'merged' };
  return { outcome: 'merged' };
};

test('e2e (spec §13): two independent phases run together, the third waits for its dependency; a failed lane stops alone', async () => {
  const h = lanesHarness({
    phases: [P('1'), P('2'), P('3', ['1'])],
    lanes: annotated({ 1: A('src/a/**'), 2: A('src/b/**'), 3: A('src/a/**') }),
    merge: mergeOnce,
  });
  let ticks = 0;
  // one step per tick, run inside GSD's phase list (the tick's first read); then the clock moves a minute
  const script = [
    () => {},
    () => { h.agentOf('2').state = 'failed'; },
    () => { writeLaneStatus(h.root, '1', 'ready', { at: h.at() }); h.agentOf('1').state = 'blocked'; },
    () => {}, // the follow-up releases phase 1's slot; phase 3 starts in it
    () => { writeLaneStatus(h.root, '3', 'ready', { at: h.at() }); h.agentOf('3').state = 'blocked'; },
  ];
  const load = h.ctx.deps.loadPhases;
  h.ctx.deps.loadPhases = () => {
    script[ticks]?.();
    ticks++;
    h.advance(1);
    return load();
  };
  const statePath = path.join(h.root, '.planning', 'turbo', 'run', 'supervisor.json');
  let sleeps = 0;
  // every fake resolves as a microtask: a daemon that never stops would hang the suite
  const sleep = async () => { if (++sleeps > 20) throw new Error(`runaway daemon after ${sleeps} iterations; last log ${h.logs.slice(-5).join(' | ')}`); };
  const final = await runDaemon({ ctx: h.ctx, statePath, initial: freshLanes(), intervalMs: 0, sleep });
  assert.deepEqual([final.halted, final.finished], [true, false]);
  assert.deepEqual(h.events, ['launch 1', 'launch 2', 'merge 1', 'launch 3', 'merge 3']);
  assert.deepEqual(h.launched.map((l) => l.cwd), [h.slots[0].path, h.slots[1].path, h.slots[0].path], 'phase 3 reuses the slot phase 1 freed');
  assert.deepEqual(h.notes.map((x) => [x.key, x.vars.phase]), [['laneStopped', '2'], ['phaseDone', '1'], ['phaseDone', '3']]);
  assert.deepEqual(Object.keys(final.lanes), ['2']);
  assert.equal(final.lanes['2'].halted.why, 'failed');
  assert.deepEqual(h.released, [[1, 'merged'], [1, 'merged']]);
  assert.equal(h.slots[1].job.state, 'active', 'the failed lane keeps its slot and its work');
  const saved = readJson(statePath);
  assert.equal(saved.lanesMode, 'slots');
  assert.equal(Object.hasOwn(saved, 'lane'), false);
});

test('e2e (spec §9, §13): a restart keeps the recorded lanes, adopts their sessions, and resumes an orphan slot job in its slot; nothing launches twice (Review Focus 1)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2'), P('4')], maxLanes: 2, lanes: annotated({ 1: A('a/**'), 2: A('b/**'), 4: A('c/**') }) });
  let s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1', '2']);
  // the supervisor dies right after preparing slot 3 for phase 4 and launching its session, before its state write
  h.ctx.config.max_lanes = 3;
  h.ctx.deps.slots.prepare(h.slots[2], { kind: 'phase', phase: '4' });
  h.agents.push({ id: 'orphan', name: laneSessionName(h.root, '4'), cwd: h.slots[2].path, state: 'working' });
  const lanes = resumableLanes(s, null, h.ctx);
  assert.deepEqual(Object.keys(lanes), ['1', '2', '4']);
  assert.deepEqual([lanes['4'].slot, lanes['4'].sessionId, lanes['4'].launch, lanes['4'].branch], [3, null, 'resume', 'turbo/p4']);
  h.advance(1);
  s = await tick({ ...s, lanes }, h.ctx);
  assert.equal(h.launched.length, 2, 'no new session: 1 and 2 keep theirs, 4 adopts the one in its slot');
  assert.equal(s.lanes['4'].sessionId, 'orphan');
  assert.ok(h.logs.includes('adopt phase 4 session orphan'), h.logs.join('\n'));
  assert.deepEqual(h.prepared.map((p) => p[2]), ['1', '2', '4'], 'no second slot for phase 4');
  // a lane outside the new range, and a lane whose slot no longer holds its job, are not resumed
  h.release(2, 'abandoned');
  assert.deepEqual(Object.keys(resumableLanes(s, { from: '4', to: null }, h.ctx)), ['4']);
  assert.ok(h.logs.some((l) => l === 'lane 1 is outside the range 4–end; not resumed (session s1 and slot 1 kept)'));
  assert.deepEqual(Object.keys(resumableLanes(s, null, h.ctx)), ['1', '4']);
  assert.ok(h.logs.includes('lane 2: no slot holds its job any more; not resumed'));
  // a lane that was stopped is tried again by a new start
  s.lanes['1'].halted = { why: 'failed', at: h.at() };
  s.lanes['1'].launchFailures = 4;
  const retried = resumableLanes(s, null, h.ctx)['1'];
  assert.deepEqual([retried.halted, retried.forceRelaunch, retried.restarts, retried.launchFailures], [undefined, true, 0, undefined]);
  // Gap 2 (review I2): a start at logon tries again only a lane stopped by its session's failure (a crash); the others
  // stay stopped for the owner's resume
  s.lanes['1'].halted = { why: 'noProgress', at: h.at(), restarts: 3 };
  const kept = resumableLanes(s, null, h.ctx, { logon: true })['1'];
  assert.deepEqual([kept.halted.why, Boolean(kept.forceRelaunch)], ['noProgress', false]);
  assert.ok(h.logs.includes('lane 1 stays stopped (noProgress) at logon: turbo-run resume 1 tries it again'), h.logs.join('\n'));
  s.lanes['1'].halted = { why: 'failed', at: h.at(), id: 's1' }; // the lane's own failed record
  assert.equal(resumableLanes(s, null, h.ctx, { logon: true })['1'].halted.why, 'failed');
  s.lanes['1'].halted = { why: 'failed', at: h.at(), id: 's1', sessionFailed: true };
  const crashed = resumableLanes(s, null, h.ctx, { logon: true })['1'];
  assert.deepEqual([crashed.halted, crashed.forceRelaunch], [undefined, true]);
  // a checkout-mode lane is never resumed in slots mode; a finished run resumes nothing
  const other = lanesHarness({ phases: [P('7')] });
  assert.deepEqual(resumableLanes({ lane: { phase: '7', sessionId: 'x' }, finished: false }, null, other.ctx), {});
  assert.ok(other.logs.some((l) => l.startsWith('a checkout-mode lane of phase 7 is recorded; slots mode does not resume it')));
  assert.deepEqual(resumableLanes({ lanes: { 7: { key: '7', job: 'phase', phase: '7', slot: 1 } }, finished: true }, null, other.ctx), {});
});

// ---- Stage 4 integration: L0 slots, L1 supervisor, L2 merge, L3 prep, with real git ----

const CLI = path.resolve('bin/turbo-run.mjs');
const PHASE_DIRS = { 1: '01-alpha', 2: '02-beta', 3: '03-gamma' };
const CODE = { 1: 'src/a/one.js', 2: 'src/b/two.js', 3: 'src/c/three.js' };
const ROADMAP = [
  '# Roadmap', '', '## Progress', '', '<!-- progress -->', '', '## Phases', '',
  '### Phase 1: Alpha', '', '**Goal**: the a part', '**Depends on**: Nothing', '',
  '### Phase 2: Beta', '', '**Goal**: the b part', '**Depends on**: Nothing', '',
  '### Phase 3: Gamma', '', '**Goal**: the c part', '**Depends on**: Phase 1, Phase 2', '',
].join('\n');
const put = (dir, rel, text) => {
  const f = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

// gsd-tools as lib/merge.mjs calls it: the verification fingerprint over the files of cwd, and phase.complete, which
// marks the phase in the ROADMAP's progress block (outside every phase section: the lane markup stays fresh) and STATE.
function e2eGsd(calls) {
  return (args, { cwd }) => {
    calls.push(args.join(' '));
    const key = args.slice(0, 2).join(' ');
    if (key === 'query verification.fingerprint') return `${fakeDigest(cwd, args.slice(3).filter((a) => a !== '--raw'), args[2])}\n`;
    if (key === 'query phase.complete') {
      const f = path.join(cwd, '.planning', 'ROADMAP.md');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('<!-- progress -->', `- [x] Phase ${args[2]} complete\n<!-- progress -->`));
      fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), `# State\n\nStatus: Phase ${args[2]} complete\n`);
      return JSON.stringify({ completed_phase: args[2], roadmap_updated: true, state_updated: true, warnings: [] });
    }
    throw new Error(`fake gsd-tools: unexpected call ${args.join(' ')}`);
  };
}

test('e2e (Stage 4 integration): two independent phases run in two slots at once and merge (the second reintegrates), a prep job is merged, the dependent phase follows, the milestone ends — real git, real slots, the lanes\' own turbo-run commands', async () => {
  const main = mainProject({
    files: {
      '.planning/ROADMAP.md': ROADMAP,
      '.planning/STATE.md': '# State\n\nStatus: Ready\n',
      '.planning/REQUIREMENTS.md': '# Requirements\n\n- [ ] REQ-1\n',
    },
  });
  const root = main.root;
  const fx = slotFixture(root, { max: 3 });
  put(root, '.planning/turbo/config.json', `${JSON.stringify({ max_lanes: 3, lanes: { mode: 'slots', dir: fx.dir }, push: { mode: 'off' } })}\n`);
  writeLanesFile(root, { phases: { 1: { areas: ['src/a/**'], confidence: 'high' }, 2: { areas: ['src/b/**'], confidence: 'high' }, 3: { areas: ['src/c/**'], confidence: 'high' } } });
  main.git('add', '-A');
  main.git('commit', '-q', '-m', 'config and lane markup');
  assert.equal(readLanesFile(root).fresh, true);
  const setup = setupSlots(root, fx.config, fx.deps);
  assert.deepEqual(setup.slots.map((x) => x.action), ['created', 'created', 'created']);

  const config = { ...fx.config, push: pushSettings({ mode: 'off' }) };
  const agents = [];
  const launched = [];
  const resumed = [];
  const notes = [];
  const logs = [];
  const events = [];
  const gsdCalls = [];
  let n = 0;
  const roadmap = () => fs.readFileSync(path.join(root, '.planning', 'ROADMAP.md'), 'utf8');
  const ctx = {
    root, lanes: 'slots', mode: 'full', turboRun: 'node turbo-run', config,
    deps: {
      loadPhases: () => [P('1'), P('2'), P('3', ['1', '2'])].map((p) => ({ ...p, complete: roadmap().includes(`- [x] Phase ${p.number} complete`) })),
      claude: {
        launchBg: (o, cwd) => {
          const id = `s${++n}`;
          launched.push({ id, cwd, ...o });
          agents.push({ id, name: o.name, cwd, state: 'working' });
          return id;
        },
        list: () => agents,
        stop: (id) => {
          const a = agents.find((x) => x.id === id);
          if (a) a.state = 'stopped';
        },
        rm: (id) => {
          const i = agents.findIndex((a) => a.id === id);
          if (i < 0) throw new Error(`claude rm failed: no session ${id}`);
          agents.splice(i, 1);
        },
        resume: (id, prompt, cwd) => {
          resumed.push({ id, prompt, cwd });
          const a = agents.find((x) => x.id === id);
          if (a) a.state = 'working';
          return `note: woke session ${id}-0000-4000-8000-000000000000`;
        },
      },
      lanes: { session: (id) => id, activity: () => ({ lastMs: Date.now(), active: 0 }), replied: () => false },
      // L0's slots as bin/turbo-run.mjs slotDeps builds them (the trust check is L0's, tested there)
      slots: {
        list: () => listSlots(root, config, fx.deps),
        free: ({ skip = [] } = {}) => listSlots(root, config, fx.deps).find((x) => x.state === 'free' && !skip.includes(x.k)) || null,
        untrusted: () => [],
        prepare: (slot, job) => prepareSlot(root, slot, job, fx.deps),
        release: (k, outcome) => releaseSlot(root, k, { outcome, config }),
        forJob: (phase, kind) => slotForPhase(root, config, phase, { kind }),
      },
      mergeReady: async (c, lane) => {
        const r = await mergeReady(c, lane);
        if (r.outcome !== 'wait') events.push(`merge ${lane.key}: ${r.outcome}`);
        return r;
      },
      mergeFollowUp: async (c, lane) => {
        const r = await mergeFollowUp(c, lane);
        if (r.outcome !== 'wait') events.push(`follow-up ${lane.key}: ${r.outcome}`);
        return r;
      },
      mergeState,
      mergeHolds,
      pendingJobs,
      jobPrompts,
      finishJob: async (c, lane) => {
        const r = await finishJob(c, lane);
        if (r.outcome !== 'wait') events.push(`finish ${lane.key}: ${r.outcome}`);
        return r;
      },
      lanesFile: () => readLanesFile(root),
      gitAt: slotGit(ISOLATED),
      git: createGit(root, { env: ISOLATED }),
      gsd: e2eGsd(gsdCalls),
      stateSync: () => ({ synced: false, reason: 'test' }),
      mergeLockWaitMs: 200,
      fingerprint: () => 'A',
      notify: async (key, vars) => { notes.push({ key, vars }); },
      now: () => new Date(),
      log: (line) => { logs.push(line); },
    },
  };

  // What each lane's session does in its slot, through the lane's own turbo-run commands.
  const turbo = (cwd, ...args) => execFileSync(process.execPath, [CLI, ...args], { cwd, env: ISOLATED, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (slot, message) => {
    gitIn(slot, 'add', '-A');
    gitIn(slot, 'commit', '-q', '-m', message);
  };
  const phaseWork = (slot, N) => {
    const dir = `.planning/phases/${PHASE_DIRS[N]}`;
    put(slot, CODE[N], `export const phase${N} = ${N};\n`);
    put(slot, `${dir}/0${N}-01-PLAN.md`, `---\nphase: ${PHASE_DIRS[N]}\nplan: 01\n---\n# Plan\n`);
    put(slot, `${dir}/0${N}-01-SUMMARY.md`, `---\nphase: ${PHASE_DIRS[N]}\nplan: 01\n---\n# Summary\n`);
    const digest = fakeDigest(slot, [CODE[N]], path.join(slot, ...dir.split('/')));
    put(slot, `${dir}/0${N}-VERIFICATION.md`, ['---', `phase: ${PHASE_DIRS[N]}`, 'status: passed', 'covered_files:', `  - ${CODE[N]}`, `covered_digest: "${digest}"`, '---', '', '# Verification', ''].join('\n'));
    commit(slot, `feat(0${N}): phase ${N}`);
  };
  const integrateAndReady = (slot, N) => {
    assert.match(turbo(slot, 'integrate', N), /^integrated main at [0-9a-f]{12}/);
    const base = readJson(integrateFile(root, N)).base;
    assert.match(turbo(slot, 'lane-status', N, 'ready', '--base', base), new RegExp(`^lane ${N}: ready`));
  };
  const acted = {};
  const actions = [];
  const laneActs = (sup) => {
    for (const lane of Object.values(sup?.lanes ?? {})) {
      const agent = agents.find((a) => a.id === lane.sessionId);
      const turn = `${lane.sessionId}|${lane.launchedAt}`;
      if (!agent || agent.state !== 'working' || acted[lane.key] === turn) continue;
      const first = !Object.keys(acted).some((k) => k === lane.key);
      acted[lane.key] = turn;
      if (lane.job === 'prep') {
        put(lane.slotPath, `.planning/phases/${PHASE_DIRS[lane.phase]}/0${lane.phase}-CONTEXT.md`, '# Context\n');
        commit(lane.slotPath, `docs(0${lane.phase}): context`);
        assert.match(turbo(lane.slotPath, 'lane-status', lane.phase, 'prepped', '--job', 'prep'), /prep 3: prepped/);
        actions.push(`prep ${lane.phase} in slot ${lane.slot}`);
      } else {
        if (first) phaseWork(lane.slotPath, lane.phase);
        integrateAndReady(lane.slotPath, lane.phase);
        actions.push(`${first ? 'work and ' : ''}ready ${lane.phase} in slot ${lane.slot}`);
      }
      agent.state = 'blocked';
    }
  };

  const statePath = path.join(root, '.planning', 'turbo', 'run', 'supervisor.json');
  let sleeps = 0;
  const seen = [];
  const sleep = async () => {
    if (++sleeps > 30) throw new Error(`runaway daemon; events ${events.join(' | ')}; last log ${logs.slice(-6).join(' | ')}`);
    const sup = readJson(statePath, null);
    seen.push(Object.keys(sup?.lanes ?? {}).sort().join(','));
    laneActs(sup);
  };
  const final = await runDaemon({ ctx, statePath, initial: freshLanes(), intervalMs: 0, sleep });

  // the run: 1 and 2 at once in two slots, prep of 3 in the third; then 3 alone once both are merged
  assert.equal(seen[0], '1,2,prep-3', `the first tick launches both phases and the prep job: ${seen.join(' / ')}`);
  assert.deepEqual(launched.slice(0, 3).map((l) => l.cwd), [1, 2, 3].map((k) => listSlots(root, config, fx.deps)[k - 1].path));
  assert.deepEqual(events, [
    'merge 1: merged', 'merge 2: reintegrate', 'finish prep-3: merged', 'follow-up 1: released',
    'merge 2: merged', 'follow-up 2: released', 'merge 3: merged', 'follow-up 3: released',
  ], logs.join('\n'));
  assert.equal(resumed.length, 1, 'phase 2 is woken once to integrate again');
  assert.match(resumed[0].prompt, /turbo-run inbox 2/);
  assert.deepEqual(actions, ['work and ready 1 in slot 1', 'work and ready 2 in slot 2', 'prep 3 in slot 3', 'ready 2 in slot 2', 'work and ready 3 in slot 1']);
  assert.deepEqual([final.finished, final.halted], [true, false]);
  assert.deepEqual(notes.map((x) => x.key), ['phaseDone', 'phaseDone', 'phaseDone', 'milestoneDone']);
  assert.deepEqual(notes.slice(0, 3).map((x) => x.vars.phase), ['1', '2', '3']);

  // main: three phase merges, each completed in one commit, the prep merged; clean, with every lane's work
  const subjects = main.git('log', '--format=%s').split('\n');
  for (const s of ['Merge phase 1 (turbo lane 1)', 'Merge phase 2 (turbo lane 2)', 'Merge prep 3 (turbo lane 3)', 'Merge phase 3 (turbo lane 1)',
    'docs(phase-1): complete phase (turbo merge)', 'docs(phase-2): complete phase (turbo merge)', 'docs(phase-3): complete phase (turbo merge)']) {
    assert.ok(subjects.includes(s), `${s} in ${subjects.join(' | ')}`);
  }
  assert.ok(subjects.indexOf('Merge phase 3 (turbo lane 1)') < subjects.indexOf('Merge phase 2 (turbo lane 2)'), 'newest first');
  const tree = main.git('ls-files').split('\n');
  for (const f of [...Object.values(CODE), '.planning/phases/03-gamma/03-CONTEXT.md', '.planning/phases/02-beta/02-VERIFICATION.md']) assert.ok(tree.includes(f), f);
  assert.equal(main.git('status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(main.git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  for (const N of ['1', '2', '3']) assert.ok(roadmap().includes(`- [x] Phase ${N} complete`));
  assert.equal(readLanesFile(root).fresh, true, 'phase.complete left the lane markup fresh');
  assert.deepEqual(gsdCalls.filter((c) => c.startsWith('query phase.complete')), ['query phase.complete 1', 'query phase.complete 2', 'query phase.complete 3']);

  // the slots: every job done and merged, nothing held; supervisor.json has no lanes left
  const slots = listSlots(root, config, fx.deps);
  assert.deepEqual(slots.map((x) => [x.k, x.state, x.record.job.state, x.record.job.outcome]), [[1, 'free', 'done', 'merged'], [2, 'free', 'done', 'merged'], [3, 'free', 'done', 'merged']]);
  assert.deepEqual(slots.map((x) => x.record.job.kind), ['phase', 'phase', 'prep']);
  for (const N of ['1', '2', '3']) assert.equal(mergeState(root, N).state, 'released');
  assert.deepEqual(mergeHolds(root), []);
  const saved = readJson(statePath);
  assert.deepEqual([saved.lanes, saved.finished, saved.jobsFailed ?? {}], [{}, true, {}]);
  assert.deepEqual(agents, [], 'every finished session is removed');
});
