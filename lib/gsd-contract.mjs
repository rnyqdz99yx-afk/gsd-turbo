import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GSD_TESTED_RANGE, readVersion, runGsdJson, versionClass } from './gsd.mjs';

// What turbo's own code reads from GSD, as checks that only read: the gsd-tools calls of the supervisor and the build
// path with the fields they use, and the GSD files turbo's prompts name. doctor runs them on a GSD newer than the
// tested range instead of dropping to safe mode by the version number alone; the nightly compatibility check
// (scripts/gsd-compat.mjs) runs them on the newest GSD. Nothing here writes: the calls that write (state, roadmap,
// phase.complete, commit) are covered by the suites that run the installed GSD, on tested versions only.

// The GSD files turbo's roles, skills and code name: agents in the config directory, the rest inside gsd-core.
export const GSD_FILES = {
  agents: ['gsd-code-fixer.md', 'gsd-code-reviewer.md', 'gsd-planner.md', 'gsd-security-auditor.md', 'gsd-verifier.md'],
  core: [
    'references/checkpoints.md', 'references/planner-coupling.md', 'references/planner-revision.md', 'references/tdd.md',
    'templates/phase-prompt.md',
    'workflows/discuss-phase-assumptions.md', 'workflows/execute-phase/steps/verify-phase-goal.md', 'workflows/plan-phase.md',
    'workflows/plan-phase/steps/chunked-planning-mode.md', 'workflows/secure-phase.md',
  ],
};

const ABSENT = '__turbo_absent__';
const str = (v) => typeof v === 'string';
const bool = (v) => typeof v === 'boolean';
const TIMEOUT_MS = 60000;

function gsdRaw(core, root, args, exec) {
  return String(exec(process.execPath, [path.join(core, 'bin', 'gsd-tools.cjs'), ...args, '--cwd', root], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT_MS, killSignal: 'SIGKILL',
  }));
}

// A phase row of init manager as lib/gsd.mjs normalizePhases and the scheduler read it. -> null | why
function phaseRow(p) {
  if (p === null || typeof p !== 'object' || p.number === undefined || p.number === null) return 'a phase row without a number';
  if (!Array.isArray(p.dep_phases) && !str(p.deps_display)) return `phase ${p.number}: neither dep_phases nor deps_display`;
  if (!str(p.disk_status)) return `phase ${p.number}: no disk_status`;
  for (const k of ['phase_complete', 'roadmap_complete', 'implementation_complete', 'is_active']) if (!bool(p[k])) return `phase ${p.number}: ${k} is not true or false`;
  if (!('verification_status' in p)) return `phase ${p.number}: no verification_status`;
  return null;
}

// Each probe: name, run(c) -> null (passed) | why (failed) | undefined (nothing to check in this project).
// c: { json(args), text(args), phase (a phase number of the project or null), dir (its directory or null) }.
const PROBES = [
  ['init manager', (c) => {
    const o = c.json(['init', 'manager']);
    if (!Array.isArray(o?.phases)) return 'no phases list';
    for (const p of o.phases) {
      const why = phaseRow(p);
      if (why) return why;
    }
    c.phase = (o.phases.find((p) => p.phase_complete !== true) ?? o.phases[0])?.number ?? null;
    return null;
  }],
  ['init phase-op', (c) => {
    if (c.phase === null) return undefined;
    const o = c.json(['init', 'phase-op', String(c.phase)]);
    if (!str(o?.phase_name) || !str(o?.padded_phase)) return 'no phase_name or padded_phase';
    c.dir = str(o.phase_dir) && o.phase_dir ? o.phase_dir : null;
    return null;
  }],
  ['roadmap get-phase --pick section', (c) => {
    if (c.phase === null) return undefined;
    return c.text(['roadmap', 'get-phase', String(c.phase), '--pick', 'section']).trim() ? null : 'an empty section';
  }],
  ['phase-plan-index', (c) => {
    if (c.phase === null) return undefined;
    return Array.isArray(c.json(['phase-plan-index', String(c.phase)])?.plans) ? null : 'no plans list';
  }],
  ['verification status', (c) => {
    if (!c.dir) return undefined;
    return str(c.json(['verification', 'status', c.dir])?.status) ? null : 'no status';
  }],
  ['config-get --default --raw', (c) => {
    const v = c.text(['config-get', 'workflow.no_such_key_turbo', '--default', ABSENT, '--raw']).replace(/\r?\n$/, '');
    return v === ABSENT ? null : `a key that is not set printed ${JSON.stringify(v.slice(0, 40))}, not the default`;
  }],
  ['config-get workflow.security_enforcement', (c) => {
    const v = c.text(['config-get', 'workflow.security_enforcement']).trim();
    return /^(?:true|false)$/.test(v) ? null : `printed ${JSON.stringify(v.slice(0, 40))}, not true or false`;
  }],
  ['loop render-hooks verify:post', (c) => {
    const hooks = c.json(['loop', 'render-hooks', 'verify:post'])?.activeHooks;
    if (!Array.isArray(hooks)) return 'no activeHooks list';
    return hooks.every((h) => str(h?.kind) && str(h?.capId)) ? null : 'a hook without kind or capId';
  }],
];

const firstLine = (e) => String(e?.stderr || e?.message || e).split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 200) ?? 'failed';

// The read checks on the project at root with the GSD at core. -> [{ name, ok, why }] (checks with nothing to look at
// in this project are left out). Never throws.
export function probeGsd({ core, root, exec = execFileSync }) {
  const c = {
    phase: null,
    dir: null,
    json: (args) => runGsdJson(core, args, { cwd: root, exec }),
    text: (args) => gsdRaw(core, root, args, exec),
  };
  const out = [];
  for (const [name, run] of PROBES) {
    let why;
    try {
      why = run(c);
    } catch (e) {
      why = firstLine(e);
    }
    if (why !== undefined) out.push({ name, ok: why === null, why: why ?? '' });
  }
  // a local install keeps its agents beside gsd-core (.claude/agents), a global one in the config directory
  const agentsDir = path.join(path.dirname(core), 'agents');
  const missing = [
    ...GSD_FILES.agents.filter((f) => !fs.existsSync(path.join(agentsDir, f))).map((f) => `agents/${f}`),
    ...GSD_FILES.core.filter((f) => !fs.existsSync(path.join(core, ...f.split('/')))),
  ];
  out.push({ name: 'gsd files', ok: !missing.length, why: missing.length ? `missing: ${missing.join(', ')}` : '' });
  return out;
}

const usableCache = new Map();

// Whether turbo's full mode may run on the GSD at core, for the project at root.
// -> { ok, cls: 'tested' | 'newer' | 'other', version, detail, checks }
// tested: in the tested range. newer: above it, the same major: the read checks decide (a pass is remembered per
// process, version and project). other (older, another major, no version): no.
export function gsdUsable(core, root, { exec = execFileSync } = {}) {
  const version = core ? readVersion(core) : null;
  const cls = version ? versionClass(version) : 'other';
  const shown = `${version || '?'} (tested ${GSD_TESTED_RANGE})`;
  if (cls === 'tested') return { ok: true, cls, version, detail: shown, checks: [] };
  if (cls !== 'newer' || !root) return { ok: false, cls, version, detail: shown, checks: [] };
  const key = `${core}|${version}|${root}`;
  if (exec === execFileSync && usableCache.has(key)) return usableCache.get(key);
  const checks = probeGsd({ core, root, exec });
  const failed = checks.filter((x) => !x.ok);
  const r = failed.length
    ? { ok: false, cls, version, checks, detail: `${shown}; on this version: ${failed.map((f) => `${f.name}: ${f.why}`).join('; ')}` }
    : { ok: true, cls, version, checks, detail: `${version} is newer than the tested range (${GSD_TESTED_RANGE}): ${checks.length} read checks of what turbo uses passed; what turbo writes through GSD is not checked on this version` };
  // only a pass is remembered: a failure may be a timeout
  if (r.ok && exec === execFileSync) usableCache.set(key, r);
  return r;
}
