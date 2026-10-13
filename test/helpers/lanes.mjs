import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './tmp.mjs';
import { DEFAULTS } from '../../lib/config.mjs';
import { laneSessionName } from '../../lib/claude.mjs';

// lane temp directories live under turbo's own directory: a throwaway Claude home for the whole test file
process.env.CLAUDE_CONFIG_DIR = tmpDir('lanes-home');

export const P = (number, deps = [], complete = false) => ({ number, deps, complete, verification: null });
export const A = (areas, gates = [], confidence = 'high') => ({ areas: Array.isArray(areas) ? areas : [areas], gates, confidence });
export const annotated = (phases) => ({ fresh: true, phases });
export const freshLanes = () => ({ lanesMode: 'slots', lanes: {}, finished: false, halted: false });

const branchOf = (job) => (job.kind === 'phase' ? `turbo/p${job.phase}` : job.kind === 'prep' ? `turbo/prep-${job.phase}` : 'turbo/annotate');

// A slots-mode supervisor context with every outside dependency faked: claude sessions, slots (in memory, with real
// empty directories), L2's merge, L3's jobs and annotation. Nothing reaches git, a real claude or the network.
// h.trust[k] = false: slot k is not trusted; h.refuse[k] = why: its preparation throws; h.launchFail(opts, cwd) → why.
// merge(lane, h), followUp(lane, h), jobs(options, h), finish(lane, h): the fakes of mergeReady, mergeFollowUp,
// pendingJobs and finishJob (null: absent). Reconcile R5: L2's merge is two calls; h.mergeStates[N] is what
// mergeState(root, N) returns and h.holds what mergeHolds(root) returns. Without followUp, a merge harness releases
// at the first follow-up, as L2 does after a green CI (or with push off).
export function lanesHarness({ phases, slots = 3, maxLanes = 3, lanes = null, merge = null, followUp = null, jobs = null, finish = null } = {}) {
  const base = tmpDir('lanes');
  const root = path.join(base, 'app');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  let clock = Date.parse('2026-01-01T00:00:00Z');
  let n = 0;
  const prefix = laneSessionName(root, '');
  const h = {
    root, phases, annotation: lanes,
    agents: [], launched: [], removed: [], stopped: [], resumed: [], notes: [], logs: [], events: [],
    merges: [], followUps: [], finishes: [], released: [], prepared: [], mergeStates: {}, holds: [],
    trust: {}, refuse: {}, fp: 'A', launchFail: () => null,
    advance(min) { clock += min * 60000; },
    at() { return new Date(clock).toISOString(); },
    slots: Array.from({ length: slots }, (_, i) => {
      const p = path.join(base, 'app.turbo', `lane-${i + 1}`);
      fs.mkdirSync(p, { recursive: true });
      return { k: i + 1, path: p, job: null };
    }),
  };
  const slotOf = (k) => h.slots.find((x) => x.k === k);
  const active = (x) => x.job?.state === 'active';
  h.release = (k, outcome) => {
    const x = slotOf(k);
    x.job = { ...x.job, state: 'done', outcome };
    h.released.push([k, outcome]);
  };
  h.agentOf = (key) => h.agents.find((a) => a.name === laneSessionName(root, key) && a.state !== 'gone');
  h.ctx = {
    root, lanes: 'slots', mode: 'full', turboRun: 'node x',
    config: { ...structuredClone(DEFAULTS), max_lanes: maxLanes },
    deps: {
      loadPhases: () => h.phases,
      claude: {
        launchBg: (opts, cwd) => {
          const why = h.launchFail(opts, cwd);
          if (why) throw new Error(why);
          const id = `s${++n}`;
          h.launched.push({ id, cwd, ...opts });
          h.events.push(`launch ${opts.name.slice(prefix.length)}`);
          h.agents.push({ id, name: opts.name, cwd, state: 'working' });
          return id;
        },
        list: () => h.agents,
        stop: (id) => {
          h.stopped.push(id);
          const a = h.agents.find((x) => x.id === id);
          if (a) a.state = 'stopped';
        },
        rm: (id) => {
          h.removed.push(id);
          if (!h.agents.some((a) => a.id === id)) throw new Error(`claude rm failed: no session ${id}`);
          h.agents = h.agents.filter((a) => a.id !== id);
        },
        resume: (id, prompt, cwd) => {
          h.resumed.push({ id, prompt, cwd });
          // parseResume reads ids of 6+ characters: the transcript session id of job s<n> (s<n>-0000-…)
          return `note: woke session ${id}-0000-4000-8000-000000000000`;
        },
      },
      lanes: { session: (id) => id, activity: () => ({ lastMs: clock, active: 0 }), replied: () => false },
      slots: {
        list: () => h.slots.map((x) => ({ k: x.k, path: x.path, state: active(x) ? 'busy' : 'free', record: { control: root, job: x.job }, dirty: [] })),
        free: ({ skip = [] } = {}) => {
          const x = h.slots.find((y) => !active(y) && !skip.includes(y.k) && h.trust[y.k] !== false);
          return x ? { k: x.k, path: x.path, state: 'free' } : null;
        },
        untrusted: () => h.slots.filter((y) => !active(y) && h.trust[y.k] === false).map((y) => ({ k: y.k, path: y.path, line: `open claude in ${y.path} once and accept the trust dialog` })),
        prepare: (slot, job) => {
          h.prepared.push([slot.k, job.kind, job.phase]);
          if (h.refuse[slot.k]) throw Object.assign(new Error(h.refuse[slot.k]), { name: 'SlotRefused', code: 'dirty' });
          const x = slotOf(slot.k);
          x.job = { kind: job.kind, phase: job.phase, branch: branchOf(job), state: 'active' };
          return { k: x.k, path: x.path, branch: x.job.branch, base: { branch: 'main', sha: 'a'.repeat(40) } };
        },
        release: (k, outcome) => h.release(k, outcome),
        forJob: (phase, kind) => {
          const x = h.slots.find((y) => active(y) && y.job.kind === kind && (y.job.phase ?? null) === (phase ?? null));
          return x ? { k: x.k, path: x.path } : null;
        },
      },
      mergeReady: merge ? async (ctx, lane) => { h.merges.push(lane.key); h.events.push(`merge ${lane.key}`); return merge(lane, h); } : null,
      mergeFollowUp: merge ? async (ctx, lane) => {
        h.followUps.push(lane.key);
        const r = followUp ? followUp(lane, h) : { outcome: 'released' };
        if (r.outcome === 'released') {
          h.release(lane.slot, 'merged');
          h.mergeStates[lane.phase] = { state: 'released' };
        }
        return r;
      } : null,
      mergeState: merge ? (root2, phase) => h.mergeStates[phase] ?? null : null,
      mergeHolds: merge ? () => h.holds : null,
      // reconcile R7: pendingJobs({ root, config, lanes, range, mode, failed }, phases)
      pendingJobs: jobs ? async (options) => jobs(options, h) : null,
      jobPrompts: ({ lane, resume, wake }) => ({ prompt: `${wake ? `Wake ${wake.kind}` : resume ? 'Resume' : 'Run'} ${lane.job} ${lane.phase ?? ''}`.trim(), systemPrompt: `job ${lane.key}` }),
      finishJob: finish ? async (ctx, lane) => { h.finishes.push(lane.key); return finish(lane, h); } : null,
      lanesFile: () => h.annotation,
      fingerprint: () => h.fp,
      notify: async (key, vars) => { h.notes.push({ key, vars }); },
      now: () => new Date(clock),
      log: (line) => { h.logs.push(line); },
    },
  };
  return h;
}
