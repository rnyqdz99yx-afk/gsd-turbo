// Placeholder: the integrator takes L1's file. B3 (lib/roles.mjs, lib/slice-lint.mjs) consumes these bindings; every B3
// test passes info/signals itself, so nothing depends on these empty answers.

// -> { phase, goal, successCriteria: string[], requirements: [{ id, text }], contextText, discussionLogText,
//      needsResearchItems: string[], plannedFiles: string[] }
export function readPhaseInfo(root, phase) {
  return { phase: String(phase), goal: '', successCriteria: [], requirements: [], contextText: '', discussionLogText: '', needsResearchItems: [], plannedFiles: [] };
}

// -> { yes: bool, why: string }
export function needsResearch() {
  return { yes: false, why: '' };
}

// -> { yes: bool, why: string }
export function needsSecurity() {
  return { yes: false, why: '' };
}
