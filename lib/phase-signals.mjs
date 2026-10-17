// L1 stub (stage 6): replaced by L1's lib/phase-signals.mjs at integration. Same exports and shapes.
export function readPhaseInfo(root, phase) {
  return { phase: String(phase), goal: '', successCriteria: [], requirements: [], contextText: '', discussionLogText: '', needsResearchItems: [], plannedFiles: [], hasResearch: false };
}

export function needsResearch(info) {
  return { yes: info.needsResearchItems.length > 0, why: 'stub' };
}

export function needsSecurity() {
  return { yes: false, why: 'stub' };
}
