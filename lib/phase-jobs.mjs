// plan-phase.md §5.6: the AI-integration nudge fires on these goal keywords (G3).
export const AI_GOAL_RE = /\b(agent|llm|rag|chatbot|embedding|langchain|llamaindex|crewai|langgraph|openai|anthropic|vector|llm eval)\b/i;

// Gate id -> key of phaseArtifacts() holding the artifact the gate writes.
export const JOB_ARTIFACT = Object.freeze({ security: 'security', ui: 'uiReview', 'code-review': 'review', nyquist: 'validation' });

export function prologueJobs({ phase, hooks = [], artifacts, frontend = false, goal = '' }) {
  if (artifacts.plans?.length) return [];
  const active = (capId) => hooks.find((h) => h.kind === 'step' && h.capId === capId);
  const jobs = [];
  if (active('research') && !artifacts.research) jobs.push({ id: 'research', skill: 'gsd-plan-phase', args: `--research-phase ${phase}` });
  if (active('ui') && frontend && !artifacts.uiSpec) jobs.push({ id: 'ui', skill: 'gsd-ui-phase', args: `${phase} --auto` });
  if (active('ai-integration') && !artifacts.aiSpec && AI_GOAL_RE.test(goal)) jobs.push({ id: 'ai', skill: 'gsd-ai-integration-phase', args: `${phase} --auto` });
  const intel = active('intel');
  if (intel?.ref?.command) jobs.push({ id: 'intel', gsdTools: String(intel.ref.command).split(/\s+/).filter(Boolean) });
  return jobs;
}

// blocking mirrors the capability registry's onError: halt for nyquist and security, skip for ui and code-review (G6).
export function fanoutJobs({ phase, active = [], artifacts = {} }) {
  const on = (c) => active.includes(c);
  const jobs = [];
  if (on('security')) jobs.push({ id: 'security', skill: 'gsd-secure-phase', args: `${phase}`, isolation: 'none', produces: 'SECURITY.md', blocking: true });
  if (on('ui') && artifacts.uiSpec) jobs.push({ id: 'ui', skill: 'gsd-ui-review', args: `${phase}`, isolation: 'none', produces: 'UI-REVIEW.md', blocking: false });
  if (on('code-review')) jobs.push({ id: 'code-review', skill: 'gsd-code-review', args: `${phase}`, isolation: 'none', produces: 'REVIEW.md', blocking: false });
  if (on('nyquist')) jobs.push({ id: 'nyquist', skill: 'gsd-validate-phase', args: `${phase}`, isolation: 'worktree', produces: 'VALIDATION.md', blocking: true });
  return jobs;
}

const count = (v) => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isInteger(n) && n >= 0 ? n : null;
};

// plan-phase seeds VALIDATION.md as a draft; only gsd-validate-phase sets status: validated.
const present = (id, f) => Boolean(f) && (id !== 'nyquist' || String(f.status) === 'validated');

export function gateOutcome({ jobs = [], fm = {} }) {
  const missing = jobs.filter((j) => !present(j.id, fm[j.id])).map((j) => j.id);
  const blockingMissing = jobs.filter((j) => j.blocking && missing.includes(j.id)).map((j) => j.id);
  let reviewFindings = 0;
  const review = fm['code-review'];
  if (review && review.status === 'issues_found') {
    const f = review.findings && typeof review.findings === 'object' ? review.findings : {};
    const critical = count(f.critical ?? f.blocker);
    const warning = count(f.warning);
    reviewFindings = critical === null && warning === null ? 1 : (critical ?? 0) + (warning ?? 0);
  }
  const securityOpen = fm.security ? (count(fm.security.threats_open) ?? 1) : 0;
  const nyquist = fm.nyquist ? { status: String(fm.nyquist.status || ''), compliant: String(fm.nyquist.nyquist_compliant) === 'true' } : null;
  const next = blockingMissing.length ? 'retry' : reviewFindings > 0 || securityOpen > 0 ? 'fix' : 'final-gate';
  return { missing, blockingMissing, reviewFindings, securityOpen, nyquist, next };
}
