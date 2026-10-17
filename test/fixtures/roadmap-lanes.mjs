// A synthetic ROADMAP in GSD 1.16's shape (templates/roadmap.md): a summary list, a shipped milestone in <details>,
// the phase sections, a Progress table. Phase 2 has a two-line Goal, phase 3 the **Depends on:** label form, phase 4
// no Depends on line.
export const ROADMAP = [
  '# Roadmap: Demo',
  '',
  '## Phases',
  '',
  '- [x] **Phase 1: Base** - the skeleton',
  '- [ ] **Phase 2: Api** - the API',
  '- [ ] **Phase 3: Web** - the web client',
  '- [ ] **Phase 4: Docs** - the docs',
  '',
  '<details>',
  '<summary>v0.1 (shipped)</summary>',
  '',
  '### Phase 0.5: Spike',
  '**Goal**: An old spike',
  '',
  '</details>',
  '',
  '## Phase Details',
  '',
  '### Phase 1: Base',
  '**Goal**: The skeleton builds',
  '**Depends on**: Nothing (first phase)',
  '**Requirements**: BASE-01',
  '**Plans**: 1/1 plans complete',
  '',
  '### Phase 2: Api',
  '**Goal**: Serve the API',
  'with sessions and tokens.',
  '**Depends on**: Phase 1',
  '**Requirements**: API-01, API-02',
  '**Success Criteria** (what must be TRUE):',
  '  1. A client signs in',
  '**Plans**: 0/2 plans',
  '',
  '### Phase 3: Web',
  '**Goal**: A web client',
  '**Depends on:** Phase 2 (the API must exist)',
  '**Requirements**: WEB-01',
  '',
  '### Phase 4: Docs',
  '**Goal**: Docs for the API',
  'and the client.',
  '',
  'Notes on the docs.',
  '',
  '## Progress',
  '',
  '| Phase | Plans | Status |',
  '|---|---|---|',
  '| 1. Base | 1/1 | Complete |',
  '',
].join('\n');

// The phases as lib/gsd.mjs normalizePhases returns them for this ROADMAP.
export const PHASES = [
  { number: '1', name: 'Base', deps: [], complete: true, closed: true },
  { number: '2', name: 'Api', deps: ['1'], complete: false, closed: false },
  { number: '3', name: 'Web', deps: ['2'], complete: false, closed: false },
  { number: '4', name: 'Docs', deps: [], complete: false, closed: false },
];

// GSD 1.16 readers, mirrored in substance: roadmap.cjs collectAnalyzePhases (a section runs from its heading to the
// next phase heading), its Depends on regex, roadmap-parser.cjs extractPhaseFieldMultiline (the Goal), and the
// Phase-word dependency scan of phase-id.cjs (G4).
export function gsdSection(text, n) {
  const at = text.search(new RegExp(`^ {0,3}#{2,4}\\s*Phase\\s+${n.replace('.', '\\.')}\\s*:`, 'm'));
  if (at < 0) return null;
  const rest = text.slice(at);
  const next = rest.slice(1).search(/\n {0,3}#{2,4}\s+Phase\s+[A-Za-z]?\d/i);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

export function gsdDepends(section) {
  return /\*\*Depends on(?::\*\*|\*\*:)\s*([^\n]+)/i.exec(section)?.[1].trim() ?? null;
}

export function gsdGoal(section) {
  const m = /^[ \t]*\*\*Goal(?::\*\*|\*\*\s*:?)\s*([^\n]+)/im.exec(section);
  if (!m) return null;
  const out = [m[1].trim()];
  const rest = section.slice(m.index + m[0].length).split('\n');
  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i];
    if (i === 0 && !raw.trim()) continue;
    if (!raw.trim() || /^\s*[-*+]\s/.test(raw) || /^\s*\*\*[A-Za-z][A-Za-z ]*:?(\*\*)?:?\s/.test(raw) || /^\s*#{1,4}\s/.test(raw) || /^\s*\|/.test(raw) || /^\s*(?:`{3,}|~{3,})/.test(raw)) break;
    out.push(raw.trim());
  }
  return out.join(' ').trim();
}

export function gsdDeps(value) {
  return [...String(value ?? '').matchAll(/\bphases?\s+(\d+[A-Z]?(?:\.\d+)*)/gi)].map((m) => m[1]);
}
