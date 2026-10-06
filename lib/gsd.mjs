import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function readVersion(coreDir) {
  try {
    return fs.readFileSync(path.join(coreDir, 'VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
}

const parseV = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(String(v)) || []).slice(1).map(Number);
const cmpV = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

export function versionInRange(v, range = '>=1.16.0 <1.17.0') {
  const pv = parseV(v);
  if (pv.length !== 3) return false;
  return range.split(/\s+/).every((part) => {
    const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(part);
    if (!m) return false;
    const c = cmpV(pv, parseV(m[2]));
    return { '>=': c >= 0, '<=': c <= 0, '>': c > 0, '<': c < 0, '=': c === 0, undefined: c === 0 }[m[1]];
  });
}

export function runGsdJson(coreDir, args, { cwd, exec = execFileSync } = {}) {
  const tool = path.join(coreDir, 'bin', 'gsd-tools.cjs');
  const out = String(exec(process.execPath, [tool, ...args, '--raw', '--cwd', cwd], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  }));
  const start = out.search(/[{[]/);
  if (start < 0) throw new Error(`gsd-tools ${args.join(' ')}: no JSON in output`);
  try {
    return JSON.parse(out.slice(start));
  } catch (err) {
    throw new Error(`gsd-tools ${args.join(' ')}: invalid JSON in output: ${err.message}`);
  }
}

// Mirrors GSD 1.16 init.cjs cmdInitManager's local normalizePhaseNumber.
export function normalizePhaseId(id) {
  return String(id).split('.').map((part) => {
    const m = /^(\d+)([A-Z]?)$/i.exec(part);
    return m ? `${Number(m[1])}${m[2].toUpperCase()}` : part;
  }).join('.');
}

// Mirrors GSD 1.16 phase-id.cjs isSentinelPhaseId(id) without convention, as init manager calls it:
// leading int after an optional CODE- prefix in SENTINEL_RANGES [0, 999] (so a bare Phase 0 is a sentinel too).
export function isSentinelPhase(number) {
  const m = String(number).replace(/^[A-Z][A-Z0-9_]*-(?=\d)/i, '').match(/^0*(\d+)/);
  return m !== null && [0, 999].includes(parseInt(m[1], 10));
}

export function normalizePhases(json) {
  return (json.phases || []).filter((p) => !isSentinelPhase(p.number)).map((p) => {
    const raw = Array.isArray(p.dep_phases)
      ? p.dep_phases
      : String(p.deps_display || '').split(',').map((s) => s.trim()).filter((s) => /^\d+[A-Z]?(\.\d+)*$/i.test(s));
    // Numbers are normalized the same way, so a normalized dep equals the matching phase's number.
    const deps = raw.map(normalizePhaseId);
    return {
      number: normalizePhaseId(p.number),
      name: p.name || '',
      deps,
      complete: p.phase_complete === true || p.disk_status === 'complete',
      diskStatus: p.disk_status || '',
      verification: p.verification_status || null,
      isActive: p.is_active === true,
    };
  });
}

export function loadPhases(root, coreDir, { exec } = {}) {
  const json = runGsdJson(coreDir, ['init', 'manager'], { cwd: root, exec });
  return { milestone: json.milestone_version || '', phases: normalizePhases(json) };
}
