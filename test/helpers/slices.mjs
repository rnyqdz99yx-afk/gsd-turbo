import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpGitRepo } from './tmp.mjs';

// A GSD project at phase 5 of the build path: ROADMAP, REQUIREMENTS, STATE and the phase's CONTEXT (decisions D-NN),
// no plans yet, all committed. decisions: 'D-NN: text' each; context: false leaves CONTEXT.md out.
export function slicePhase({ slug = 'demo', decisions = ['D-01: greet takes a name', 'D-02: farewell prints bye'], context = true } = {}) {
  const root = tmpGitRepo();
  const planning = path.join(root, '.planning');
  const dir = path.join(planning, 'phases', `05-${slug}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(planning, 'config.json'), '{}\n');
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), [
    '# Roadmap: Demo', '', '## Phases', '', '- [ ] **Phase 5: Demo Feature** - the demo', '', '## Phase Details', '',
    '### Phase 5: Demo Feature', '**Goal**: Ship the demo', '**Depends on**: Nothing (first phase)', '**Requirements**: DEMO-01, DEMO-02',
    '**Success Criteria** (what must be TRUE):', '  1. greet() returns a greeting', '', '## Progress', '',
    '| Phase | Plans Complete | Status | Completed |', '|-------|----------------|--------|-----------|', '| 5. Demo Feature | 0/0 | Not started | - |', '',
  ].join('\n'));
  fs.writeFileSync(path.join(planning, 'REQUIREMENTS.md'), [
    '# Requirements: Demo', '', '## v1 Requirements', '', '- [ ] **DEMO-01**: greet works', '- [ ] **DEMO-02**: farewell works', '',
    '## Traceability', '', '| Requirement | Phase | Status |', '|-------------|-------|--------|', '| DEMO-01 | Phase 5 | Pending |', '| DEMO-02 | Phase 5 | Pending |', '',
  ].join('\n'));
  fs.writeFileSync(path.join(planning, 'STATE.md'), [
    '---', "gsd_state_version: '1.0'", 'status: planning', '---', '', '# Project State', '', '## Current Position', '',
    'Phase: 5 of 5 (Demo Feature)', 'Plan: 0 of 0 in current phase', 'Status: Ready to plan', 'Last activity: 2026-01-01 — context gathered', '',
    '## Session Continuity', '', 'Last session: 2026-01-01', 'Stopped at: context gathered', 'Resume file: None', '',
  ].join('\n'));
  if (context) {
    const bullets = decisions.map((d) => {
      const at = d.indexOf(': ');
      return `- **${d.slice(0, at)}:** ${d.slice(at + 2)}`;
    });
    fs.writeFileSync(path.join(dir, '05-CONTEXT.md'), [
      '# Phase 5: Demo Feature - Context', '', '**Gathered:** 2026-01-01', '**Status:** Ready for planning', '',
      '<domain>', '## Phase Boundary', '', 'Ship the demo.', '', '</domain>', '',
      '<decisions>', '## Implementation Decisions', '', '### Demo', ...bullets, '', "### Claude's Discretion", 'Naming.', '', '</decisions>', '',
    ].join('\n'));
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'phase 5 context');
  return root;
}

export const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const TASK = (n, files, decisions) => [
  '<task type="auto">',
  `  <name>Task ${n}: action-oriented name</name>`,
  `  <files>${files.join(', ')}</files>`,
  `  <action>Concrete: identifiers, values, behaviour, what to avoid (${decisions.join(', ')}).</action>`,
  `  <verify>node --test ${files.find((f) => f.startsWith('test/')) ?? files[0] ?? 'test'}</verify>`,
  '  <done>Measurable result.</done>',
  '</task>',
];

// A slice plan in the slicer template's shape (roles/slicer.md). extra: frontmatter lines before the closing ---.
export function compactPlan({ id = '05-01', wave = 1, deps = [], files = ['src/a.js', 'test/a.test.js'], deleted = [], reqs = ['DEMO-01'], decisions = ['D-01'], tasks = 1, extra = [] } = {}) {
  const nn = id.slice(id.lastIndexOf('-') + 1);
  const list = (xs) => `[${xs.join(', ')}]`;
  return [
    '---', 'phase: 05-demo', `plan: ${nn}`, 'type: execute', `wave: ${wave}`, `depends_on: [${deps.map((d) => `"${d}"`).join(', ')}]`,
    `files_modified: ${list(files)}`, `files_deleted: ${list(deleted)}`, 'autonomous: true', `requirements: ${list(reqs)}`,
    'must_haves:', '  truths:', `    - "works (${decisions.join(', ')})"`, ...extra, '---', '',
    '<objective>', `What the slice delivers and why. Decisions: ${decisions.join(', ')}.`, '</objective>', '',
    '<tasks>', ...Array.from({ length: tasks }, (_, i) => TASK(i + 1, files, decisions)).flat(), '</tasks>', '',
    '<verification>', `- \`node --test ${files.find((f) => f.startsWith('test/')) ?? 'test'}\` passes`, '</verification>', '',
  ].join('\n');
}

// Writes a plan of phase 5 -> its absolute path.
export function writePlan(root, id, text, slug = 'demo') {
  const file = path.join(root, '.planning', 'phases', `05-${slug}`, `${id}-PLAN.md`);
  fs.writeFileSync(file, text);
  return file;
}

// What L1's readPhaseInfo answers for slicePhase()'s phase 5.
export const DEMO_INFO = Object.freeze({
  phase: '5',
  goal: 'Ship the demo',
  successCriteria: ['greet() returns a greeting'],
  requirements: [{ id: 'DEMO-01', text: 'greet works' }, { id: 'DEMO-02', text: 'farewell works' }],
  contextText: '',
  discussionLogText: '',
  needsResearchItems: [],
  plannedFiles: [],
});
