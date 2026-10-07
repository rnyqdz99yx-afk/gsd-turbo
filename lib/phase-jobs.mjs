// plan-phase.md §5.6: the AI-integration nudge fires on these goal keywords (G3); GSD matches them as
// substrings, so plural forms ("agents", "LLMs") count too.
export const AI_GOAL_RE = /\b(agent|llm|rag|chatbot|embedding|langchain|llamaindex|crewai|langgraph|openai|anthropic|vector|llm eval)s?\b/i;

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

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Only a non-negative integer, or a string of digits (GSD's frontmatter values are strings), is a count.
const count = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  return typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
};
const notCount = (name, v) => (v === undefined ? `${name} is missing` : `${name} ${JSON.stringify(v)} is not a count`);

// plan-phase seeds VALIDATION.md as a draft; only gsd-validate-phase sets status: validated. A status is a string:
// GSD's frontmatter get answers `status: [validated]` with a list and an empty `status:` with {}.
const present = (id, f) => Boolean(f) && (id !== 'nyquist' || f.status === 'validated');

// The statuses gsd-code-reviewer writes (G11).
const REVIEW_STATUSES = new Set(['clean', 'issues_found', 'skipped']);

// Why a written gate report cannot be read at all, or null. GSD's `frontmatter get` answers an empty
// file or broken YAML with exit 0 and {error, path}; a REVIEW.md without a reviewer status proves no review.
function unreadableWhy(id, f) {
  if (!f) return null;
  if (!isObj(f)) return 'no frontmatter';
  if (Object.hasOwn(f, 'error')) return String(f.error);
  if (id === 'code-review' && (typeof f.status !== 'string' || !REVIEW_STATUSES.has(f.status))) return `status ${JSON.stringify(f.status) ?? 'missing'}, not one of ${[...REVIEW_STATUSES].join(', ')}`;
  return null;
}

// Critical (GSD also accepts blocker) plus warning findings, counted whatever the status says; info is
// never fixed. A tier that is not a count counts one; issues_found with a tier left out counts at least one.
function reviewCount(r, defect) {
  const f = r.findings;
  if (f !== undefined && !isObj(f)) {
    defect(`findings ${JSON.stringify(f)} is not a map of counts`);
    return 1;
  }
  const critical = f?.critical !== undefined ? ['critical', f.critical] : ['blocker', f?.blocker];
  let n = 0;
  const absent = [];
  for (const [tier, v] of [critical, ['warning', f?.warning]]) {
    if (v === undefined) {
      absent.push(tier === 'blocker' ? 'findings.critical' : `findings.${tier}`);
      continue;
    }
    const c = count(v);
    if (c === null) defect(notCount(`findings.${tier}`, v));
    n += c ?? 1;
  }
  if (r.status === 'issues_found' && absent.length) {
    defect(`status issues_found without ${absent.join(' or ')}`);
    n = Math.max(n, 1);
  }
  return n;
}

// `files` maps a gate id to its report's file name, for the `unreadable` reasons.
export function gateOutcome({ jobs = [], fm = {}, files = {} }) {
  // Every defect is named; an unreadable report never reads as clean: it stays missing, and the
  // counts read from it count one.
  const unreadable = [];
  const fileOf = (id) => String(files[id] || (isObj(fm[id]) && fm[id].path) || jobs.find((j) => j.id === id)?.produces || id).split(/[\\/]/).pop();
  const defect = (id, text) => unreadable.push(`${id}: ${fileOf(id)} ${text}`);
  const bad = new Set();
  for (const id of new Set([...jobs.map((j) => j.id), ...Object.keys(fm)])) {
    const why = unreadableWhy(id, fm[id]);
    if (why === null) continue;
    bad.add(id);
    defect(id, `is unreadable (${why})`);
  }
  const missing = jobs.filter((j) => bad.has(j.id) || !present(j.id, fm[j.id])).map((j) => j.id);
  const blockingMissing = jobs.filter((j) => j.blocking && missing.includes(j.id)).map((j) => j.id);
  const review = fm['code-review'];
  const reviewFindings = bad.has('code-review') ? 1 : review ? reviewCount(review, (t) => defect('code-review', t)) : 0;
  let securityOpen = 0;
  if (bad.has('security')) securityOpen = 1;
  else if (fm.security) {
    securityOpen = count(fm.security.threats_open);
    if (securityOpen === null) {
      defect('security', notCount('threats_open', fm.security.threats_open));
      securityOpen = 1;
    }
  }
  const ns = fm.nyquist?.status;
  if (fm.nyquist && !bad.has('nyquist')) {
    if (ns === undefined || ns === '' || (isObj(ns) && !Object.keys(ns).length)) defect('nyquist', 'status is missing');
    else if (typeof ns !== 'string') defect('nyquist', `status ${JSON.stringify(ns)} is not a string`);
  }
  const nyquist = fm.nyquist ? { status: typeof ns === 'string' ? ns : '', compliant: String(fm.nyquist.nyquist_compliant) === 'true' } : null;
  const next = blockingMissing.length ? 'retry' : reviewFindings > 0 || securityOpen > 0 ? 'fix' : 'final-gate';
  return { missing, blockingMissing, reviewFindings, securityOpen, nyquist, unreadable, next };
}
