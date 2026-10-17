import fs from 'node:fs';
import path from 'node:path';
import { claudeHome, gsdCoreDir, isSlot, runDir } from './paths.mjs';
import { normalizePhaseId, runGsdJson } from './gsd.mjs';
import { PREP_STEPS, STEPS, completeStep, completePrepStep, countAttempt, nextPrepStep, nextStep, phaseLean, pinLean, readPrepProgress, readProgress, recordPlanCheck, resetProgress } from './phase-progress.mjs';
import { anySummary, findPhaseDir, phaseArtifacts, phaseDirMatches, phasesDir, planFileNames, planOutline } from './phase-files.mjs';
import { artifactFiles, changedSince, gitRunner, headSha, lastCommitOf, recordBases, stalenessReport, verificationRoute } from './staleness.mjs';
import { createGsdConfig, docsCommitsOff, docsCommitsRestore, ensureChunkedParallel, gatesActive, gatesOff, gatesRel, gatesRestore, gsdText } from './gates.mjs';
import { JOB_ARTIFACT, fanoutJobs, gateOutcome, prologueJobs, regateJobs } from './phase-jobs.mjs';
import { loadConfig, pushSettings } from './config.mjs';
import { needsResearch, needsSecurity, readPhaseInfo } from './phase-signals.mjs';
import { formatInboxMessage, markRead, unreadInbox } from './inbox.mjs';
import { UNHANDLED_MS, allowFile, createGit, listFindings, readAllowed, recordFile, requestPush, short, waitPush } from './push.mjs';
import { SECRET_RULES } from './secrets.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { laneCwd, laneLabel, supervisorLanes } from './lanes-state.mjs';
import { laneSessionIds } from './transcripts.mjs';
import { msg } from './messages.mjs';
import { notify } from './notify.mjs';
import { itemText, uatPlan } from './uat-classify.mjs';
import { deferUat, ownerRequest, parseUat, recordUat, settleUat, signUat } from './uat.mjs';
import { cleanupStand, evidenceDir, netViolations, prepareStand, readStandSecrets, standCheck } from './uat-stand.mjs';
import { stateSync } from './state-sync.mjs';
import { clean, openQuestions } from './view.mjs';
import { AGENT_ID, ASK_ID, QUESTION_ID, askOwner, classifyQuestions, liveAnswer, markDelivered, readAnswers, readQuestions, refreshQuestions, stopQuestion } from './questions.mjs';
import { LIVE_CHECK_OPTION, leanReviewNext, loopSentence, ownerGapsText, reviewLoop, reviewVersions } from './review-loop.mjs';
import { agentTail, formatAgentTail } from './agent-tail.mjs';
import { GAP_STEPS, gapRound } from './gap-rounds.mjs';
import { attendedPhases } from './attend.mjs';
import { IntegrateRefused, integrateMain, setMergeHold } from './integrate.mjs';
import { slotForPhase, slotGit } from './slots.mjs';
import { AnswerRefused, QuestionChanged, answerQuestion, applyStandingRule, deliveries, describeAnswer, preAnswerText, undoAutoAnswer } from './answers.mjs';
import { logsDir } from './paths.mjs';
import { markPlanStarted, planTiming, prefixStepNote } from './phase-progress.mjs';
import { draftsGuard, draftsPlan, draftsSummary, finishReconcile, markDrafted, promote, readOutline, replan, startDraft, startReconcile } from './plan-drafts.mjs';

// Stage-2 subcommands. bin/turbo-run.mjs routes these names here.
export const PHASE_COMMANDS = new Set(['phase-step', 'staleness', 'gates', 'jobs', 'uat', 'state-sync', 'inbox', 'push-request', 'push-allow', 'questions', 'answer', 'ask', 'owner-gaps', 'agent-tail', 'integrate', 'plan-drafts']);

// No path separators: a phase id only ever names files inside turbo's own directories.
const PHASE_ID = /^[A-Za-z0-9._-]+$/;
// Flags whose next argument is their value; bin's projectArg skips them too, so a value never reads as --project.
export const VALUE_FLAGS = new Set([
  '--project', '--done', '--note', '--results', '--log', '--attempt', '--at', '--check',
  '--class', '--preanswers', '--stop', '--agent', '--kind', '--question', '--delivered', '--path', '--option', '--text', '--by', '--rev',
  '--context', '--recommended', '--action', '--review', '--gap', '--sign', '--answer',
  // plan-drafts (Stage 5 §7): its --plan takes no value
  '--drafting', '--drafted', '--reconcile', '--reconciled', '--verdict', '--promote', '--replan', '--reason',
]);

class UsageError extends Error {}
export const usage = (text) => { throw new UsageError(text); };
export const fail = (text) => { throw new Error(text); };

// flags keeps a flag's last value; values every value of a flag that repeats (ask's --option), in order.
export function parseArgs(args) {
  const pos = [];
  const flags = new Map();
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      const v = args[++i] ?? '';
      flags.set(a, v);
      values.set(a, [...(values.get(a) || []), v]);
    } else if (a.startsWith('--')) flags.set(a, true);
    else pos.push(a);
  }
  return { pos, flags, values };
}

export function phaseArg(pos, i, text) {
  const p = pos[i];
  if (!p || !PHASE_ID.test(p)) usage(text);
  return normalizePhaseId(p);
}

export const coreOrFail = (root) => gsdCoreDir(root) || fail('gsd-core not found (run turbo-run doctor)');
export const relTo = (root, p) => path.relative(root, p).split(path.sep).join('/');

// One entry per subcommand; later tasks add theirs.
export const HANDLERS = {
  'phase-step': phaseStep,
  staleness,
  gates,
  jobs,
  uat,
  'state-sync': syncState,
  inbox,
  'push-request': pushRequest,
  'push-allow': pushAllow,
  questions,
  answer,
  ask,
  'owner-gaps': ownerGaps,
  'agent-tail': agentTailCommand,
  integrate: integrateCommand,
  'plan-drafts': planDraftsCommand,
};

// gsd-tools' JSON answer (printed without --raw), or null.
function gsdAnswer(text) {
  const at = text.indexOf('{');
  try {
    return at < 0 ? null : JSON.parse(text.slice(at));
  } catch {
    return null;
  }
}

function syncState({ root, pos, flags, out, err, deps }) {
  const phase = phaseArg(pos, 0, 'state-sync <phase> [--no-commit]');
  const gsd = deps.gsd || ((args) => gsdAnswer(gsdText(coreOrFail(root), root, args)));
  let r;
  try {
    r = stateSync({ root, phase, gsd, commit: !flags.has('--no-commit') });
  } catch (e) {
    // best effort: every caller is a stop or a step's end, which must not fail on it
    err(`warn: state-sync: ${String(e?.message ?? e).split(/\r?\n/)[0]}`);
    return 0;
  }
  const restored = r.restored?.length ? `; put back the text begin-phase replaced: ${r.restored.join(', ')}` : '';
  const outside = r.outside?.length ? `; not written, their first match lies outside Current Position: ${r.outside.join(', ')}` : '';
  if (r.repaired) out(`STATE.md: every plan of phase ${r.phase} has a summary; put back what begin-phase reset: ${r.fields.join(', ')}; ${r.commit}`);
  else out(r.synced ? `STATE.md: phase ${r.phase} executing, next plan ${r.next} (${r.at} of ${r.total}); ${r.commit}${restored}${outside}` : `STATE.md: left as it is (${r.reason})`);
  return 0;
}

export async function runPhaseCommand(cmd, args, { root, out = (l) => process.stdout.write(`${l}\n`), err = (l) => process.stderr.write(`${l}\n`), deps = {} } = {}) {
  try {
    const handler = Object.hasOwn(HANDLERS, cmd) ? HANDLERS[cmd] : usage(`<${[...PHASE_COMMANDS].join('|')}> ... (unknown command ${cmd})`);
    return (await handler({ root, out, err, deps, ...parseArgs(args) })) ?? 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`usage: turbo-run ${e.message}`);
      return 2;
    }
    err(`turbo-run ${cmd}: ${String(e?.message ?? e).split(/\r?\n/)[0]}`);
    return 1;
  }
}

// A YAML scalar as written after its key: a quoted one up to its closing quote, a plain one up to an inline comment
// (` #…`, as YAML and GSD's frontmatter reader take it).
function scalar(raw) {
  const v = raw.trim();
  const q = /^(["'])(.*?)\1/.exec(v);
  return q ? q[2] : v.replace(/(^|\s)#.*$/, '').trim();
}

// A YAML frontmatter key's plain value, or null.
function frontField(text, key) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
    const at = lines[i].indexOf(':');
    if (at > 0 && lines[i].slice(0, at) === key) return scalar(lines[i].slice(at + 1));
  }
  return null;
}

// What keeps the close step from being marked done, or null: VERIFICATION.md must read passed, and SECURITY.md, when
// the phase has one, must count no open threat. (GSD's uat-passed check needs gsd-tools: the skill runs it.)
export function closeBlocker(root, phase) {
  const dir = findPhaseDir(root, phase);
  const a = dir ? phaseArtifacts(dir) : {};
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      return null;
    }
  };
  const v = a.verification ? read(a.verification) : null;
  if (v === null) return 'no VERIFICATION.md';
  const status = frontField(v, 'status');
  if (status !== 'passed') return `VERIFICATION.md status is ${status || 'missing'}, not passed`;
  if (a.security) {
    const open = frontField(read(a.security), 'threats_open');
    if (!/^\d+$/.test(open ?? '')) return 'SECURITY.md threats_open is not a count';
    if (Number(open) > 0) return `SECURITY.md has ${Number(open)} open threat(s)`;
  }
  return null;
}

// The plan step's done check beyond GSD's has_plans (true from the first plan on): a chunked planning run that stopped
// part-way left an outline that is unfinished or lists plans not written yet. { why } when the set is incomplete,
// { ok } otherwise; without an outline has_plans decides alone.
export function planSetCheck(root, phase) {
  const dir = findPhaseDir(root, phase);
  const o = dir ? planOutline(dir) : { outlines: [] };
  if (!o.outlines.length) return { ok: 'no chunked plan outline (gsd-tools has_plans decides)' };
  const what = `GSD's chunked plan outline ${o.outlines.join(', ')}`;
  // GSD writes plans only after the outline is finished: plans beside an unfinished outline, or none of its plans among
  // the phase's plans, mean an outline an earlier planning run left (GSD reuses it only on a chunked resume)
  if (o.plans && (o.unfinished.length || (o.ids.length && o.missing.length === o.ids.length))) return { ok: `${what} does not match the phase's plans: a leftover of an earlier planning run (gsd-tools has_plans decides)` };
  if (o.unfinished.length) return { why: `GSD's chunked plan outline ${o.unfinished.join(', ')} is unfinished (no ## OUTLINE COMPLETE line)` };
  if (o.missing.length) return { why: `${what} lists ${o.ids.length} plans, ${o.missing.length} not written yet: ${o.missing.join(', ')}` };
  // Stage 5 §5.5 (B11): a plan of the set that came from a plan draft without a passed reconcile is no plan yet
  const drafts = draftsGuard(root, phase);
  if (drafts) return { why: drafts };
  return { ok: o.ids.length ? `${what} lists ${o.ids.length} plans, all written` : `${what} names no plan id turbo can read (gsd-tools has_plans decides)` };
}

// GSD 1.16's plan-phase runs its plan-checker (and the planner's revisions, steps 10-12) after the last plan's commit;
// only after them it records the planning (13b state.planned-phase, 13c roadmap.annotate-dependencies) and, with
// commit_docs, commits `docs(<padded phase>): create phase plan` (13d). A session cut before that leaves a whole plan set
// nobody checked. { state, line }: incomplete (planSetCheck), unchecked, complete. Checked: turbo's own record
// (recordPlanCheck, --plan-checked, which the skill writes once gsd-plan-phase returned or its checker pass ran) covering
// every plan file; GSD's create-phase-plan commit at or after the last commit of a plan file (planned by hand, or by a
// session cut after it); GSD's checker off (plan_checker, else workflow.plan_check, false: the keys GSD reads); a phase
// whose execution began (a plan summary: planned before turbo kept the record, or checked then).
export function planCheckState(root, phase) {
  const set = planSetCheck(root, phase);
  if (set.why) return { state: 'incomplete', line: `plan set incomplete: ${set.why}` };
  const dir = findPhaseDir(root, phase);
  const plans = dir ? planFileNames(dir) : [];
  const done = (how) => ({ state: 'complete', line: `plan set complete: ${set.ok}; plan check: ${how}` });
  if (!plans.length) return done('no plan files (gsd-tools has_plans decides)');
  if (anySummary(dir)) return done('execution has begun (a plan has its SUMMARY)');
  if (gsdPlanChecker(root) === false) return done("off in GSD's config (plan_checker / workflow.plan_check false)");
  const rec = readProgress(root, phase).checks.plan;
  const later = rec ? plans.filter((f) => !rec.plans.includes(f)) : plans;
  if (rec && !later.length) return done(`verdict recorded ${rec.at}${rec.note ? ` (${rec.note})` : ''}`);
  const created = createPlanCommit(root, phase, dir, plans);
  if (created) return done(`GSD's commit ${created.slice(0, 12)} (create phase plan) follows the last plan's commit`);
  if (!rec) return { state: 'unchecked', line: `plan set unchecked: ${set.ok}; no plan-checker verdict on record for its ${plans.length} plan(s) and no create-phase-plan commit after them (a session may have stopped before GSD's plan-checker ran)` };
  return { state: 'unchecked', line: `plan set unchecked: ${later.join(', ')} written after the plan-checker's verdict of ${rec.at}` };
}

// GSD's checker switch as GSD 1.16 reads the project config (config-loader: the flat plan_checker, else
// workflow.plan_check); undefined when neither is set (GSD's default: on).
function gsdPlanChecker(root) {
  const c = readJson(path.join(root, '.planning', 'config.json'), null);
  if (!c || typeof c !== 'object') return undefined;
  return c.plan_checker !== undefined ? c.plan_checker : c.workflow?.plan_check;
}

// GSD's step 13d commit, `docs(<padded phase>): create phase plan`, at or after the newest commit that touched a plan
// file of the phase (walking back from HEAD to that commit, itself included): its sha, else null (no git, no commit).
// GSD's step 13d commit (plan-phase.md: --files <phase dir>/*-PLAN.md .planning/STATE.md .planning/ROADMAP.md, after
// state.planned-phase) changes STATE.md and adds no plan file; a gsd-planner's own git_commit (gsd-planner.md: the
// phase's PLAN files and ROADMAP.md, never STATE.md) adds its plan, or in a concurrent chunked run, when another
// planner's commit took its plan, holds ROADMAP.md alone (Stage 5 reviews I3, I-b).
function stepThirteenCommit(git, sha) {
  const changed = String(git(['diff-tree', '--no-commit-id', '-r', '--root', '--name-only', '-z', sha])).split('\0').filter(Boolean);
  const added = String(git(['diff-tree', '--no-commit-id', '-r', '--root', '--diff-filter=A', '--name-only', '-z', sha])).split('\0');
  const addsPlan = added.some((f) => /-PLAN\.md$/i.test(f) || /(?:^|\/)plans\/[^/]+\.md$/i.test(f));
  return !addsPlan && changed.some((f) => /(?:^|\/)\.planning\/STATE\.md$/.test(f));
}
function createPlanCommit(root, phase, dir, plans) {
  try {
    const git = gitRunner(root);
    const rel = plans.map((f) => path.relative(root, path.join(dir, f)).replace(/\\/g, '/'));
    const last = String(git(['log', '-1', '--format=%H', '--', ...rel])).trim();
    if (!last) return null;
    const want = normalizePhaseId(phase);
    for (const line of String(git(['log', '--format=%H%x09%s', '-n', '2000', 'HEAD'])).split('\n')) {
      const [sha, subject = ''] = line.split('\t');
      const m = /^docs\(([^)\s]+)\): create phase plan\b/.exec(subject);
      // a gsd-planner's own git_commit has the same subject: only GSD's step 13d commit counts (stepThirteenCommit)
      if (m && normalizePhaseId(m[1]) === want && stepThirteenCommit(git, sha)) return sha;
      if (sha === last) break;
    }
  } catch {
    // no git or no history: turbo's own record decides
  }
  return null;
}

function phaseStep({ root, pos, flags, out, err }) {
  const text = 'phase-step <phase> [--done <step> [--note <text>] | --attempt <step> | --check plan | --plan-checked [--note <text>] | --reset] [--json] | phase-step <phase> --prep [--done <step> [--note <text>]] [--json]';
  const phase = phaseArg(pos, 0, text);
  if (flags.has('--prep')) return prepStep({ phase, root, flags, out, err, text });
  if (flags.has('--check')) {
    if (flags.get('--check') !== 'plan') usage(text);
    out(`phase ${phase}: ${planCheckState(root, phase).line}`);
    return 0;
  }
  // the plan-checker gave its verdict on the phase's whole plan set (the skill's step plan)
  if (flags.has('--plan-checked')) {
    const set = planSetCheck(root, phase);
    if (set.why) fail(`phase ${phase}: no plan check to record: plan set incomplete: ${set.why}`);
    const dir = findPhaseDir(root, phase);
    const plans = dir ? planFileNames(dir) : [];
    if (!plans.length) fail(`phase ${phase}: no plan check to record: the phase has no plan files`);
    const rec = recordPlanCheck(root, phase, { plans, note: String(flags.get('--note') || '') });
    out(`phase ${phase}: plan check recorded for ${rec.plans.length} plan(s)`);
    return 0;
  }
  if (flags.has('--reset')) {
    resetProgress(root, phase);
    out(`phase ${phase}: progress reset`);
    return 0;
  }
  if (flags.has('--attempt')) {
    const step = String(flags.get('--attempt'));
    if (!step) usage(text);
    // spec §8 (S4): execute's and uat's gap-closure rounds: at most gap_rounds, each with new evidence
    if (GAP_STEPS.includes(step)) {
      const r = gapRound(root, phase, step, { config: loadConfig(root) });
      const resumed = r.resumed.length ? ` (round ${r.n} resumed: its gap plans ${r.resumed.join(', ')} have no SUMMARY yet)` : '';
      out(`attempt ${step} ${r.n} of ${r.max}: ${r.go ? `go${resumed}` : `stop: ${r.reason}`}`);
      return 0;
    }
    out(`attempt ${step} ${countAttempt(root, phase, step)}`);
    return 0;
  }
  let p = readProgress(root, phase);
  if (flags.has('--done')) {
    const step = String(flags.get('--done'));
    // Stage 4 §7.2: in a slot the supervisor marks integrate done once it merged the phase and its CI is green
    if (step === 'integrate' && isSlot(root)) fail(`phase ${phase}: step integrate is marked by the supervisor after it merges the phase into main; report ready with turbo-run lane-status ${phase} ready --base <sha>`);
    // review 1: close is the phase's last gate; a lane that marks it done past a failed verification or an open
    // threat (an owner's "go on", say) is refused here
    const why = step === 'close' ? closeBlocker(root, phase) : null;
    if (why) fail(`phase ${phase} cannot close: ${why}`);
    // a lane interrupted inside chunked planning resumes it instead of executing part of the plans
    // ... and one cut between the last plan's commit and GSD's plan-checker runs the checker pass first
    const plans = step === 'plan' && nextStep(readProgress(root, phase)) === 'plan' ? planCheckState(root, phase) : null;
    if (plans?.state === 'incomplete') fail(`phase ${phase} cannot finish planning: ${plans.line.replace(/^plan set incomplete: /, '')}`);
    if (plans?.state === 'unchecked') fail(`phase ${phase} cannot finish planning: ${plans.line.replace(/^plan set unchecked: /, '')}; run GSD's plan-checker over the plans, then turbo-run phase-step ${phase} --plan-checked`);
    // Stage 6 L2 (D10): lean is pinned when execution starts, so a later change of lean.enabled leaves the phase alone
    const lean = step === 'gates-off' && nextStep(readProgress(root, phase)) === 'gates-off' ? leanOf(root, phase, err) : null;
    p = completeStep(root, phase, step, { note: String(flags.get('--note') || '') });
    if (lean !== null) pinLean(root, phase, lean);
  }
  if (flags.get('--done') === 'plan') measurePlanning(root, phase);
  // outside a slot (lanes.mode checkout, a hand run) there is nothing to integrate: the step passes as soon as it is next.
  // Review I6: not for a phase whose job runs in a slot, when the owner runs this in the control root (shared progress)
  if (nextStep(p) === 'integrate' && !isSlot(root) && !slotForPhase(root, loadConfig(root), phase)) p = completeStep(root, phase, 'integrate', { note: 'not a slot: nothing to integrate (checkout mode)' });
  const next = nextStep(p);
  if (next === 'plan') markPlanStarted(root, phase);
  if (flags.has('--json')) out(JSON.stringify({ phase, done: p.done, next, steps: STEPS, attempts: p.attempts, timings: { plan: planTiming(root, phase) } }));
  else {
    if (leanOf(root, phase, err)) out('lean: on');
    out(`phase ${phase}: next ${next ?? 'none'}${p.done.length ? ` (done: ${p.done.join(', ')})` : ''}`);
  }
  return 0;
}

// Stage 6 L2: whether phase N runs lean (phaseLean). A config turbo cannot read leaves it off, with a warning.
function leanOf(root, phase, err) {
  try {
    return phaseLean(root, phase);
  } catch (e) {
    err?.(`warn: lean: ${String(e?.message ?? e).split(/\r?\n/)[0]}`);
    return false;
  }
}

// Stage 5 §5.8 (B12): the plan step's measurement line, once the step is done: its wall clock from the first time
// phase-step named it next, and how the plans were written (draftsSummary), in the control root's supervisor.log and
// before the lane's own note of the step.
function measurePlanning(root, phase) {
  const t = planTiming(root, phase);
  const clock = t.ms === null ? 'wall clock unknown' : `${Math.floor(t.ms / 3600000)}h${String(Math.floor(t.ms / 60000) % 60).padStart(2, '0')}m wall clock`;
  const line = `phase ${phase} plan: ${clock} · ${draftsSummary(root, phase)}`;
  try {
    fs.mkdirSync(logsDir(root), { recursive: true });
    fs.appendFileSync(path.join(logsDir(root), 'supervisor.log'), `${new Date().toISOString()} ${line}\n`);
  } catch { /* the log is best-effort */ }
  prefixStepNote(root, phase, 'plan', line);
}

// Stage 5 §5, §7: the lane's plan drafts (lib/plan-drafts.mjs), one action per call. A refusal prints refused: <why>
// and exits 1: the lane then takes GSD's own path for that plan.
const PLAN_DRAFTS_USAGE = 'plan-drafts <phase> --plan [--json] | --drafting <id> | --drafted <id> | --reconcile <id> | --reconciled <id> --verdict passed|failed [--reason <text>] | --promote <id> | --replan <id> [--reason <text>]';
const DRAFT_ACTIONS = ['--plan', '--drafting', '--drafted', '--reconcile', '--reconciled', '--promote', '--replan'];
const idsOrNone = (ids) => (ids.length ? ids.join(', ') : 'none');

function planDraftsCommand({ root, pos, flags, out }) {
  const phase = phaseArg(pos, 0, PLAN_DRAFTS_USAGE);
  const actions = DRAFT_ACTIONS.filter((a) => flags.has(a));
  if (actions.length !== 1) usage(PLAN_DRAFTS_USAGE);
  const action = actions[0];
  if (flags.has('--verdict') !== (action === '--reconciled')) usage(PLAN_DRAFTS_USAGE);
  if (flags.has('--reason') && !['--reconciled', '--replan'].includes(action)) usage(PLAN_DRAFTS_USAGE);
  const refused = (why) => {
    out(`refused: ${why}`);
    return 1;
  };
  if (action === '--plan') {
    const r = draftsPlan(root, phase, { config: loadConfig(root) });
    if (flags.has('--json')) {
      out(JSON.stringify(r));
      return 0;
    }
    out(r.use ? `drafts on: ${r.waves.length} waves, ${r.waves.flat().length} plans · draft now: ${idsOrNone(r.draftNow)} · left to GSD: ${idsOrNone(r.rest)}` : `drafts off: ${r.why}`);
    for (const f of r.removed) out(`removed: ${f} (a draft an agent wrote into the phase directory)`);
    if (r.commitFirst.length) out(`commit first: ${r.commitFirst.join(', ')}`);
    return 0;
  }
  const id = String(flags.get(action));
  const ol = readOutline(root, phase);
  if (!id || ol.why || !ol.rows.some((r) => r.id === id)) usage(`${PLAN_DRAFTS_USAGE} (${id || '<id>'}: not a plan id of the phase's outline${ol.why ? `: ${ol.why}` : ''})`);
  if (action === '--drafting') {
    const r = startDraft(root, phase, id, { config: loadConfig(root) });
    if (r.refused) return refused(r.refused);
    out(r.paragraph);
    return 0;
  }
  if (action === '--drafted') {
    const r = markDrafted(root, phase, id);
    if (r.refused) return refused(r.refused);
    out(`drafted ${id}`);
    return 0;
  }
  if (action === '--reconcile') {
    const r = startReconcile(root, phase, id);
    if (r.refused) return refused(r.refused);
    out(r.gsd ? `use: gsd (${r.gsd})` : r.block);
    return 0;
  }
  if (action === '--reconciled') {
    const verdict = String(flags.get('--verdict'));
    if (!['passed', 'failed'].includes(verdict)) usage(PLAN_DRAFTS_USAGE);
    const r = finishReconcile(root, phase, id, verdict, { reason: String(flags.get('--reason') || '') });
    if (r.refused) return refused(r.refused);
    out(`${r.ok} ${id}`);
    return 0;
  }
  if (action === '--promote') {
    const r = promote(root, phase, id);
    if (r.refused) return refused(r.refused);
    out(`promoted ${id}: ${r.promoted}`);
    return 0;
  }
  const r = replan(root, phase, id, { reason: String(flags.get('--reason') || '') });
  out(`replanned ${id}`);
  for (const f of r.removed) out(`removed: ${f} (a draft an agent wrote into the phase directory)`);
  return 0;
}

// spec §6.1 (L3, D1): /turbo-prep's own record of freshness, discuss and prologue.
function prepStep({ phase, root, flags, out, err, text }) {
  if (flags.has('--attempt') || flags.has('--reset')) usage(text);
  let p = readPrepProgress(root, phase);
  if (flags.has('--done')) p = completePrepStep(root, phase, String(flags.get('--done')), { note: String(flags.get('--note') || '') });
  const next = nextPrepStep(p);
  if (flags.has('--json')) out(JSON.stringify({ phase, prep: true, done: p.done, next, steps: [...PREP_STEPS] }));
  else {
    if (leanOf(root, phase, err)) out('lean: on');
    out(`phase ${phase}: prep next ${next ?? 'none'}${p.done.length ? ` (done: ${p.done.join(', ')})` : ''}`);
  }
  return 0;
}

const QUESTIONS_USAGE = 'questions <phase> [--json] | questions <phase> --class <id>=<class>[,<id>=<class>…] | questions <phase> --preanswers <plan> | questions <phase> --stop <id> --agent <agent id> [--unmet] [--kind human-verify|human-action] [--question <text> [--context <text>]] | questions <phase> --deliver [--json] | questions <phase> --delivered <id> --path same-agent|continuation|lane | questions --open [--json]';
const ANSWER_USAGE = 'answer <phase> <question id> (--option <k> | --text <text>) --by <session|pane|telegram> [--rev <n>] | answer <phase> <question id> --undo';

// A lane works in this checkout when the supervisor runs and has one, whatever its phase: the lane then commits the
// whole answers directory at its step boundaries (an answer to another phase included), and turbo-run answer commits
// nothing, so two git commits never race in the shared checkout; otherwise turbo-run answer commits it (spec §5.4).
// spec §8 (S4): while a phase is attended no lane runs (attend stopped them, and a supervisor started meanwhile holds
// every lane), so the owner's session commits its answers itself
// Stage 4 (L0 D14): slots-mode lanes (supervisor.json lanes) work in their own clones, never here: false for them.
export function laneRuns(root, deps) {
  const sup = readJson(path.join(runDir(root), 'supervisor.json'), null);
  return Boolean(sup?.lane) && Boolean(deps.supervisorAlive?.()) && !attendedPhases(root).length;
}

// An answered question names its answer, channel and time: what an attended sitting takes ahead (a released stop keeps it).
const answerOf = (a) => (a ? ` (${clean(String(a.label ?? a.answer ?? '')).replace(/\s+/g, ' ').trim().slice(0, 60)}, ${clean(a.by)}, ${clean(a.at)})` : '');
function questionLine(q) {
  const cls = q.classified ? `class ${q.class}${q.topic ? `:${q.topic}` : ''}` : 'unclassified';
  return `${q.id} · ${q.kind} · ${q.state}${answerOf(q.answer)}${q.stopped ? ' (stopped)' : ''} · ${cls} · ${q.question}`;
}

// The lane's side of the owner questions (spec §5.1–§5.3, §5.5): list and classify, the pre-answers for a plan, a
// stop at a checkpoint, the answers to deliver and their delivery. --open lists every phase's open questions.
function questions({ root, pos, flags, out, err, deps }) {
  if (flags.has('--open')) {
    const list = openQuestions(root);
    out(flags.has('--json') ? JSON.stringify(list) : list.length ? list.map((q) => `p${q.phase} ${questionLine(q)}`).join('\n') : 'no open questions');
    return 0;
  }
  const phase = phaseArg(pos, 0, QUESTIONS_USAGE);
  const config = loadConfig(root);
  const now = deps.now ? deps.now() : new Date();
  const laneRunning = laneRuns(root, deps);
  const standing = () => applyStandingRule({ root, phase, config, now, laneRunning, ...(deps.commit ? { commit: deps.commit } : {}) });
  if (flags.has('--preanswers')) {
    const plan = String(flags.get('--preanswers'));
    if (!QUESTION_ID.test(plan)) usage(QUESTIONS_USAGE);
    const text = preAnswerText(root, phase, plan);
    if (text) out(text);
    return 0;
  }
  if (flags.has('--deliver')) {
    const list = deliveries(root, phase);
    if (flags.has('--json')) out(JSON.stringify(list));
    else if (!list.length) out(`phase ${phase}: nothing to deliver`);
    else for (const d of list) out(`${d.id} · ${d.lane ? 'your own question (take it yourself, no agent)' : `plan ${d.plan} task ${d.task} · agent ${d.agentId}`}\n  message: ${d.message}`);
    return 0;
  }
  if (flags.has('--delivered')) {
    const q = markDelivered(root, phase, String(flags.get('--delivered')), String(flags.get('--path') || ''), { now });
    out(`${q.id}: delivered (${q.delivery.path})`);
    return 0;
  }
  if (flags.has('--stop')) {
    const r = stopQuestion(root, phase, String(flags.get('--stop')), {
      agentId: String(flags.get('--agent') || ''),
      unmet: flags.has('--unmet'),
      kind: flags.has('--kind') ? String(flags.get('--kind')) : null,
      question: String(flags.get('--question') || ''),
      context: String(flags.get('--context') || ''),
      lang: config.lang,
      now,
    });
    const id = r.question.id;
    out(r.status === 'answered' || standing().includes(id)
      ? `answered: ${id}; deliver it now (turbo-run questions ${phase} --deliver)`
      : r.question.diagnosis
        ? `stopped: ${id} waits for the owner, its card in your words (diagnosis ${r.question.diagnosis}${r.question.diagnosis > 1 ? ': the same failure again' : ''}); stop for the owner with the reason: owner question ${id}${r.question.diagnosis > 1 ? ': <your diagnosis in one line>' : ''}`
        : `stopped: ${id} waits for the owner; stop for the owner with the reason: owner question ${id}`);
    return 0;
  }
  if (flags.has('--class')) classifyQuestions(root, phase, String(flags.get('--class')));
  else refreshQuestions(root, phase, { lang: config.lang, warn: (line) => err(`warn: ${line}`) });
  standing();
  const list = readQuestions(root, phase);
  if (flags.has('--json')) out(JSON.stringify(list));
  else {
    const count = (s) => list.filter((q) => q.state === s).length;
    out(`phase ${phase}: ${list.length} question(s) · ${count('open')} open · ${count('answered')} answered · ${count('deferred')} deferred`);
    for (const q of list) out(`  ${questionLine(q)}`);
  }
  return 0;
}

// F1: the session a command runs in, as Claude Code names it: CLAUDE_CODE_SESSION_ID (the Bash tool's, as turbo-run
// context reads it) and the job id of CLAUDE_JOB_DIR (a background job's). Either may be absent (a plain terminal).
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
function callerSessionIds(env) {
  const jobDir = String(env.CLAUDE_JOB_DIR ?? '');
  return [String(env.CLAUDE_CODE_SESSION_ID ?? ''), jobDir ? path.basename(jobDir) : ''].filter((id) => SESSION_ID.test(id));
}
// The lane supervisor.json records whose session one of ids is: its job id, a session its job state or its transcript
// names, or a session named after the job (a job's first transcript), else null. TURBO_LANE plays no part: an empty one
// still means "not a lane" everywhere else.
function laneOfSession(root, env, ids) {
  if (!ids.length) return null;
  const home = claudeHome(env);
  for (const lane of supervisorLanes(readJson(path.join(runDir(root), 'supervisor.json'), null), root)) {
    const job = String(lane.sessionId ?? '');
    if (!SESSION_ID.test(job)) continue;
    const known = laneSessionIds({ home, root: laneCwd(root, lane), jobId: job });
    if (ids.some((id) => known.has(id) || (job.length >= 8 && id.startsWith(job)))) return lane;
  }
  return null;
}

// The single arbiter for the owner's answers (spec §5.3): the first answer wins. --rev is the question's revision the
// channel showed; another revision records nothing (exit 4). Never from inside a lane.
function answer({ root, pos, flags, out, deps }) {
  const phase = phaseArg(pos, 0, ANSWER_USAGE);
  const id = pos[1];
  if (flags.has('--undo')) return undoAnswer({ root, phase, id, flags, out, deps });
  const by = String(flags.get('--by') || '');
  const hasOption = flags.has('--option');
  if (!id || !QUESTION_ID.test(id) || !['session', 'pane', 'telegram'].includes(by) || hasOption === flags.has('--text')) usage(ANSWER_USAGE);
  const option = hasOption ? Number(flags.get('--option')) : null;
  if (hasOption && !(Number.isInteger(option) && option >= 1)) usage(ANSWER_USAGE);
  const rev = flags.has('--rev') ? Number(flags.get('--rev')) : null;
  if (rev !== null && !(Number.isInteger(rev) && rev >= 1)) usage(ANSWER_USAGE);
  const env = deps.env || process.env;
  if (env.TURBO_LANE) {
    out("refused: a lane never answers the owner's questions; the owner answers them (/turbo-autonomous answer, the turbo-view pane or Telegram)");
    return 1;
  }
  // F1: a sign-off card signs UAT rows, so its answer also checks the calling session, a second marker a lane cannot
  // clear the way it can clear TURBO_LANE; the answer keeps the session for turbo-run uat sign
  let session = null;
  if (Array.isArray(readQuestions(root, phase).find((q) => q.id === id)?.sign)) {
    const ids = callerSessionIds(env);
    const lane = laneOfSession(root, env, ids);
    if (lane) {
      out(`refused: this is the session of the lane of ${laneLabel(lane)}: a sign-off card is the owner's to answer (/turbo-autonomous answer, the turbo-view pane or Telegram)`);
      return 1;
    }
    session = SESSION_ID.test(String(env.CLAUDE_CODE_SESSION_ID ?? '')) ? String(env.CLAUDE_CODE_SESSION_ID) : null;
  }
  let r;
  try {
    r = answerQuestion({
      root, phase, id, option, text: hasOption ? null : String(flags.get('--text')), by, rev, session,
      now: deps.now ? deps.now() : new Date(), laneRunning: laneRuns(root, deps), ...(deps.commit ? { commit: deps.commit } : {}),
    });
  } catch (err) {
    if (err instanceof QuestionChanged) {
      out(`changed: ${err.message}`);
      return 4;
    }
    if (!(err instanceof AnswerRefused)) throw err;
    out(`refused: ${err.message}`);
    return 1;
  }
  if (r.status === 'already') {
    out(`already answered: ${describeAnswer(r.record)}`);
    return 3;
  }
  out(`answered ${id}: ${describeAnswer(r.record)}${r.commit ? ` · ${r.commit}` : ''}`);
  return 0;
}

// v0.4.0: turbo-run answer N <id> --undo, the owner's: takes back an answer turbo took by itself (by auto). Not yet
// delivered: the question opens again; delivered: the lane gets an owner-correction in its inbox (answers.mjs).
function undoAnswer({ root, phase, id, flags, out, deps }) {
  if (!id || !QUESTION_ID.test(id) || ['--option', '--text', '--by', '--rev'].some((f) => flags.has(f))) usage(ANSWER_USAGE);
  if ((deps.env || process.env).TURBO_LANE) {
    out("refused: a lane never answers the owner's questions; the owner answers them (/turbo-autonomous answer, the turbo-view pane or Telegram)");
    return 1;
  }
  let r;
  try {
    r = undoAutoAnswer({ root, phase, id, now: deps.now ? deps.now() : new Date(), laneRunning: laneRuns(root, deps), ...(deps.commit ? { commit: deps.commit } : {}) });
  } catch (err) {
    if (!(err instanceof AnswerRefused)) throw err;
    out(`refused: ${err.message}`);
    return 1;
  }
  const what = `the automatic answer${r.record.label ? ` (${r.record.label})` : ''}`;
  if (r.status === 'reopened') {
    out(`reopened ${id}: ${what} is taken back; the question is open again and waits for your answer${r.commit ? ` · ${r.commit}` : ''}`);
    if (r.inbox) out('the phase also got a note in its inbox, in case an executor already holds it');
    return 0;
  }
  // review I1: say what really happens to an answer already taken
  const sup = readJson(path.join(runDir(root), 'supervisor.json'), null);
  const live = Boolean(deps.supervisorAlive?.()) && supervisorLanes(sup, root).some((l) => l.job === 'phase' && l.phase === String(phase));
  if (r.markup) out(`noted ${id}: the lane markup already took ${what}; to undo it, revert the commit of its decision record (.planning/turbo/DECISIONS.md or .planning/decisions/) and the ROADMAP change it made`);
  else if (live) out(`noted ${id}: phase ${phase} already took ${what}; it got your correction in its inbox and will ask you whether to keep that result or redo that part`);
  else out(`noted ${id}: phase ${phase} already took ${what} and no lane runs it now; your correction waits in its inbox for its next run, and the work done with that answer is in its commits`);
  return 0;
}

const ASK_USAGE = 'ask <phase> --question <text> [--context <text>] --option "<label>|<description>" (2 to 4 times) --recommended <n> [--about-review] [--auto-ok] [--json] | ask <phase> --action <text> [--context <text>] [--json] | ask <phase> --sign <test>[,<test>...] --question <text> [--context <text>] [--json]';

// v0.3.3 (D2, D7): the lane's stop for the owner, asked as an owner question in plain words (a decision with 2-4
// options, or owner-only work), and the lane's needs-owner record. --about-review: a question about review findings
// says so when the review keeps finding new edges in the same code, and offers the live check.
function ask({ root, pos, flags, values, out, deps }) {
  const phase = phaseArg(pos, 0, ASK_USAGE);
  const action = flags.has('--action') ? String(flags.get('--action')) : null;
  if ((action === null) === !flags.has('--question') || (action !== null && flags.has('--about-review'))) usage(ASK_USAGE);
  // F1: a sign-off card takes turbo's options (accept, not now) and is never answered automatically
  const sign = flags.has('--sign') ? String(flags.get('--sign')) : null;
  if (sign !== null && (action !== null || !/^\d+(,\d+)*$/.test(sign) || ['--option', '--recommended', '--auto-ok', '--about-review'].some((f) => flags.has(f)))) usage(ASK_USAGE);
  let rows = null;
  let signText = [];
  if (sign !== null) {
    rows = [...new Set(sign.split(',').map(Number))];
    // only the rows that wait for the owner's signature now: never one closed, skipped or blocked
    const { tests } = parseUat(readUatFile(phaseDirOrFail(root, phase)).text);
    const waiting = ownerRequest({ phase, tests }).sign;
    const not = rows.filter((n) => !waiting.includes(n));
    if (not.length) fail(`${not.length > 1 ? 'tests' : 'test'} ${not.join(', ')} ${not.length > 1 ? 'do' : 'does'} not wait for a signature (the rows that do: ${waiting.join(', ') || 'none'}; turbo-run uat owner-request ${phase} --json lists them as sign)`);
    // the rows as the card shows them; uat sign signs them only while they still read so
    signText = rows.map((n) => itemText(tests.find((t) => t.number === n)));
  }
  const options = (values.get('--option') || []).map((v) => {
    const at = v.indexOf('|');
    if (at < 0) usage(ASK_USAGE);
    return { label: v.slice(0, at), description: v.slice(at + 1) };
  });
  let recommended = null;
  if (flags.has('--recommended')) {
    recommended = Number(flags.get('--recommended'));
    if (!Number.isInteger(recommended)) usage(ASK_USAGE);
  }
  const config = loadConfig(root);
  let context = flags.has('--context') ? String(flags.get('--context')) : '';
  let loopLine = null;
  if (flags.has('--about-review')) {
    const loop = reviewLoop(reviewVersions(root, phase, deps.git));
    if (loop.rounds >= 2) {
      const opt = LIVE_CHECK_OPTION(config.lang);
      context = [loopSentence(config.lang, loop.rounds), context.trim()].filter(Boolean).join(' ');
      if (!options.some((o) => o.label.trim() === opt.label)) {
        if (options.length >= 4) fail(`the review loop adds the option «${opt.label}»: drop one of yours, 4 options at most`);
        options.push(opt);
      }
      loopLine = `review loop: ${loop.rounds} reviews in a row found new edges in the same code (${loop.files.join(', ')}); added the sentence and the option «${opt.label}»`;
    } else {
      loopLine = `review loop: none (${loop.rounds} review round${loop.rounds === 1 ? '' : 's'})`;
    }
  }
  // v0.4.0: --auto-ok lets turbo take the recommended option itself after owner.auto_answer_minutes (safe questions only)
  let input = action === null ? { question: String(flags.get('--question')), context, options, recommended, autoOk: flags.has('--auto-ok') } : { action, context, options, recommended };
  if (rows) input = { question: String(flags.get('--question')), context, sign: rows, signText };
  const r = askOwner(root, phase, input, { lang: config.lang, now: deps.now ? deps.now() : new Date() });
  if (flags.has('--json')) {
    out(JSON.stringify({ ...r, reviewLoop: loopLine }));
    return 0;
  }
  out(`asked: ${r.question.id} waits for the owner; now end your turn (the lane status is needs-owner)`);
  if (r.superseded.length) out(`superseded: ${r.superseded.join(', ')} (an older question of this phase)`);
  if (loopLine) out(loopLine);
  return 0;
}

const OWNER_GAPS_USAGE = 'owner-gaps <phase> [--review <code>,…] [--gap <n>,…]';

// v0.3.3 (D6): the paragraph for the gsd-planner prompt of gsd-plan-phase N --gaps that makes the owner-chosen REVIEW.md
// findings and VERIFICATION.md gaps the gaps of this round.
function ownerGaps({ root, pos, flags, out }) {
  const phase = phaseArg(pos, 0, OWNER_GAPS_USAGE);
  const list = (f) => (flags.has(f) ? String(flags.get(f)).split(',').map((x) => x.trim()).filter(Boolean) : []);
  const numbers = list('--gap').map(Number);
  if (numbers.some((n) => !Number.isInteger(n) || n < 1)) usage(OWNER_GAPS_USAGE);
  const dir = findPhaseDir(root, phase);
  const a = dir ? phaseArtifacts(dir) : {};
  const read = (name) => {
    if (!name) return null;
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      return null;
    }
  };
  out(ownerGapsText({ review: read(a.review), verification: read(a.verification), codes: list('--review'), numbers }));
  return 0;
}

// spec §5.5.3: the end of an agent's transcript for a continuation agent, as data.
function agentTailCommand({ root, pos, flags, out, deps }) {
  const id = pos[0];
  if (!id || !AGENT_ID.test(id)) usage('agent-tail <agent id> [--json]');
  const r = agentTail({ root, agentId: id, env: deps.env || process.env }) || fail(`agent ${id}: no transcript of it in this project's sessions`);
  out(flags.has('--json') ? JSON.stringify(r) : formatAgentTail(r));
  return 0;
}

// The lane's inbox (spec §6, S2): unread messages once, then marked read.
function inbox({ root, pos, flags, out }) {
  const phase = phaseArg(pos, 0, 'inbox <phase> [--json]');
  const unread = unreadInbox(root, phase);
  if (flags.has('--json')) out(JSON.stringify(unread));
  else if (!unread.length) out(`inbox ${phase}: nothing new`);
  else {
    const { ci_fix_rounds: ciFixRounds } = pushSettings(loadConfig(root).push);
    for (const m of unread) out(formatInboxMessage(m, { phase, ciFixRounds }));
  }
  if (unread.length) markRead(root, phase, unread.at(-1).seq);
  return 0;
}

// The lane's push request (spec §6, S2): only the supervisor pushes. --wait waits for the push and its CI, one slice per call.
async function pushRequest({ root, pos, flags, out, deps }) {
  const text = 'push-request <phase> [--at wave|phase] [--wait]';
  const phase = phaseArg(pos, 0, text);
  const point = flags.has('--at') ? String(flags.get('--at')) : null;
  if (point !== null && point !== 'wave' && point !== 'phase') usage(text);
  const config = loadConfig(root);
  const settings = pushSettings(config.push);
  // Stage 4 §7.3 (D20): a lane in a slot never pushes; the supervisor merges the phase and pushes main
  if (isSlot(root) && settings.mode !== 'off') {
    out(point === 'wave' ? 'push in slots: nothing requested at a wave; the supervisor pushes main after it merges this phase' : 'push in slots: nothing requested; the supervisor merges this phase in step integrate and pushes main');
    return 0;
  }
  const now = deps.now || (() => new Date());
  const alive = deps.supervisorAlive || (() => false);
  const r = requestPush({ root, phase, point, settings, git: deps.git || createGit(root), now: now() });
  out(r.line);
  if (!r.request) return r.code;
  if (!flags.has('--wait')) {
    if (!alive()) out('warn: no supervisor is running; the request waits for the next turbo-run start');
    return 0;
  }
  // a supervisor checks every poll_seconds (5–3600): three checks, never less than UNHANDLED_MS
  const poll = Math.min(3600, Math.max(5, Number(config.poll_seconds) || 20));
  const w = await waitPush({ root, phase, id: r.request.id, supervisorAlive: alive, now, sleep: deps.sleep, unhandledMs: Math.max(UNHANDLED_MS, 3 * poll * 1000) });
  out(w.line);
  return w.code;
}

// The owner clears the findings of a phase's last refused push that they checked and found clean. Without a refusal
// id it lists where each line is (commit, file, line; never the value) and writes nothing; with the id of that
// refusal (named in the notification and the list) the fingerprints of exactly those lines go into the allow file
// outside the checkout, and the supervisor scans that request again at its next check. An id of any other refusal
// allows nothing, so lines a later wave added are never allowed unseen. A forbidden file name, an unreadable name or
// an LFS pointer has no fingerprint: those still go by hand. Never in a lane.
const SECRET_KINDS = new Set(SECRET_RULES.map(([rule]) => rule));
const REFUSAL_ID = /^[0-9a-f]{8}$/;
const FINGERPRINT = /^[0-9a-f]{16}$/;
const PUSH_ALLOW_USAGE = 'push-allow <phase> [<refusal>]';
function pushAllow({ root, pos, out, deps }) {
  const phase = phaseArg(pos, 0, PUSH_ALLOW_USAGE);
  if ((deps.env || process.env).TURBO_LANE) {
    out("refused: a lane never clears the push scan's findings; the owner checks them and runs turbo-run push-allow");
    return 1;
  }
  const id = pos[1];
  if (id !== undefined && !REFUSAL_ID.test(id)) usage(PUSH_ALLOW_USAGE);
  const rec = readJson(recordFile(root, phase), null);
  if (rec?.outcome !== 'refused') {
    out(`push-allow ${phase}: the last push of phase ${phase} was not refused; nothing to allow`);
    return 1;
  }
  if (typeof rec.refusal !== 'string' || !REFUSAL_ID.test(rec.refusal)) {
    out(`push-allow ${phase}: the last refusal has no id (an earlier turbo wrote it); the lane's next push request is scanned afresh`);
    return 1;
  }
  // another id allows nothing; the current refusal is listed with its lines, never only its id to copy
  const mismatch = id !== undefined && id !== rec.refusal;
  if (mismatch) out(`push-allow ${phase}: ${id} is not the last refusal of phase ${phase}; nothing allowed`);
  const where = (Array.isArray(rec.lines) ? rec.lines : []).filter((l) => FINGERPRINT.test(String(l?.fp)));
  const others = (Array.isArray(rec.findings) ? rec.findings : []).filter((f) => !SECRET_KINDS.has(f.kind));
  // where each line is, never its value: the owner reads them in the commit before allowing
  out(`push-allow ${phase}: the last refusal is ${rec.refusal} (commit ${short(rec.sha)}); the lines the scan found:`);
  for (const l of where) out(`  ${short(l.commit) || '?'} ${l.file}:${l.line} (${l.kind})`);
  if (others.length) out(`not allowed (push these once by hand after checking them): ${listFindings(others)}`);
  if (!where.length) {
    out(`push-allow ${phase}: no line of this refusal can be allowed`);
    return mismatch ? 1 : 0;
  }
  if (id === undefined || mismatch) {
    out(`after checking them, allow these lines: turbo-run push-allow ${phase} ${rec.refusal}`);
    return mismatch ? 1 : 0;
  }
  const { allowed } = readAllowed(root);
  const fresh = where.filter((l) => !allowed.has(l.fp));
  if (!fresh.length) {
    out(`push-allow ${phase}: these lines are allowed already; the supervisor scans the request again at its next check`);
    return 0;
  }
  fs.mkdirSync(path.dirname(allowFile(root)), { recursive: true });
  const at = (deps.now ? deps.now() : new Date()).toISOString();
  const header = `# phase ${phase}, refusal ${rec.refusal}, ${at}: ${fresh.map((l) => `${l.file}:${l.line}`).join(', ')}`;
  fs.appendFileSync(allowFile(root), `${header.replace(/[\r\n]+/g, ' ')}\n${fresh.map((l) => l.fp).join('\n')}\n`);
  out(`push-allow ${phase}: allowed ${fresh.length} line${fresh.length === 1 ? '' : 's'} of refusal ${rec.refusal}; the supervisor scans the request again at its next check`);
  return 0;
}

const INTEGRATE_USAGE = 'integrate <phase> [--hold]';
const INTEGRATED = {
  merged: 'merged into the phase branch',
  shared: 'main had not moved; took STATE.md, ROADMAP.md and REQUIREMENTS.md from it',
  'up-to-date': 'already up to date',
};

// Stage 4 §7.1 p.1: the lane takes in the main branch in its slot; --hold is the owner's "wait" on the merge card (D16).
function integrateCommand({ root, pos, flags, out, deps }) {
  const phase = phaseArg(pos, 0, INTEGRATE_USAGE);
  const now = deps.now ? deps.now() : new Date();
  if (flags.has('--hold')) {
    try {
      setMergeHold(root, phase, { now });
    } catch (e) {
      if (e instanceof IntegrateRefused) fail(e.message);
      throw e;
    }
    out(`phase ${phase}: merge hold set; turbo starts no new phase until this one is merged`);
    return 0;
  }
  let r;
  try {
    r = integrateMain(root, phase, { git: deps.slotGit || slotGit(deps.env || process.env), now });
  } catch (e) {
    if (!(e instanceof IntegrateRefused)) throw e;
    out(`refused: ${e.message}`);
    return 1;
  }
  if (r.state === 'not-slot') {
    out(`integrate ${phase}: not a slot (lanes.mode checkout or a hand run): nothing to integrate`);
    return 0;
  }
  if (r.state === 'conflicts') {
    out(`conflicts: ${r.conflicts.join(', ')}`);
    out(`resolve them within phase ${phase}, git add each, then run turbo-run integrate ${phase} again (it commits the merge)`);
    return 4;
  }
  out(`integrated ${r.main} at ${r.base.slice(0, 12)} (${INTEGRATED[r.state]})`);
  out(`base ${r.base}`);
  out(`full test rounds allowed: ${pushSettings(loadConfig(root).push).ci_fix_rounds}`);
  return 0;
}

// Several matches mean unrelated projects share .planning/phases (GSD #2237): name them, never pick one.
export function phaseDirOrFail(root, phase) {
  const hit = phaseDirMatches(root, phase);
  if (hit.length > 1) fail(`phase ${phase} is ambiguous: ${hit.join(', ')} — resolve it in .planning/phases`);
  if (!hit.length) fail(`no phase directory for phase ${phase} under .planning/phases`);
  return path.join(phasesDir(root), hit[0]);
}

function planIndex(root, phase, deps) {
  if (deps.planIndex) return deps.planIndex(phase);
  // A missing or ambiguous phase still exits 0 with `{error, plans: []}`: never read that as no plans.
  const r = runGsdJson(coreOrFail(root), ['phase-plan-index', phase], { cwd: root });
  if (r.error) fail(`gsd-tools phase-plan-index ${phase}: ${r.error}`);
  return r.plans || [];
}

// An artifact named on the command line, as artifactFiles names it: "plans/<file>" for the nested
// layout, the bare file name otherwise.
const artifactName = (f) => {
  const n = String(f).replace(/\\/g, '/');
  return /(?:^|\/)(plans\/[^/]+)$/.exec(n)?.[1] ?? path.posix.basename(n);
};

function staleness({ root, pos, flags, out, deps }) {
  const phase = phaseArg(pos, 0, 'staleness <phase> [--json] | staleness <phase> --record <file>... | staleness <phase> --record-all | staleness <phase> --verification [--json]');
  const dir = phaseDirOrFail(root, phase);
  if (flags.has('--verification')) {
    const v = verificationRoute({ root, phaseDir: dir });
    const sha = v.since ? v.since.slice(0, 12) : '';
    const more = v.code.length > 10 ? ` (+${v.code.length - 10} more)` : '';
    if (flags.has('--json')) out(JSON.stringify(v));
    else if (v.route === 'verifier-only') out(`verifier-only: no code changed since the report's commit ${sha} (${v.planning.length} planning file(s) changed); ${v.note}`);
    else if (!v.code.length) out(`full: ${v.reason}`);
    else if (v.reason === 'code changed after the last code review') out(`full: code changed after the last code review (${v.review.slice(0, 12)}): ${v.code.slice(0, 10).join(', ')}${more}`);
    else out(`full: code changed since the report's commit ${sha}: ${v.code.slice(0, 10).join(', ')}${more}`);
    return 0;
  }
  if (flags.has('--record') || flags.has('--record-all')) {
    const all = artifactFiles(dir);
    const names = flags.has('--record-all') ? all : pos.slice(1).map(artifactName);
    if (!names.length) usage('staleness <phase> --record <file>...');
    for (const n of names) if (!all.includes(n)) fail(`not a planning artifact of phase ${phase}: ${n}`);
    const head = headSha(gitRunner(root));
    if (!head) {
      out('no commit yet: nothing recorded');
      return 0;
    }
    const file = recordBases(dir, names, head);
    out(`recorded base ${head.slice(0, 12)} for ${names.length} artifact(s) in ${relTo(root, file)}`);
    return 0;
  }
  const report = stalenessReport({ root, phaseDir: dir, plans: planIndex(root, phase, deps) });
  if (flags.has('--json')) {
    out(JSON.stringify(report));
    return 0;
  }
  if (report.skipped) out(`phase ${phase}: ${report.skipped}`);
  else if (!report.artifacts.length) out(`phase ${phase}: no planning artifacts yet`);
  for (const x of report.artifacts) out(`${x.action.padEnd(8)} ${x.file}${x.reasons.length ? `: ${x.reasons.join('; ')}` : ''}`);
  return 0;
}

const GATE_SUBS = { off: gatesOff, restore: gatesRestore, 'docs-off': docsCommitsOff, 'docs-restore': docsCommitsRestore };

function gates({ root, pos, out, deps }) {
  const [sub] = pos;
  if (sub !== 'chunked' && !Object.hasOwn(GATE_SUBS, sub)) usage('gates <off|restore|docs-off|docs-restore> <phase> | gates chunked');
  const phase = sub === 'chunked' ? null : phaseArg(pos, 1, `gates ${sub} <phase>`);
  const cfg = deps.gsdConfig || createGsdConfig({ root, core: coreOrFail(root) });
  const outcome = (c) => (c.committed ? 'committed' : c.reason);
  if (sub === 'chunked') {
    const r = ensureChunkedParallel({ root, cfg });
    out(r.note || `planning.chunked_parallel: true${r.changed ? ` (set; ${outcome(r.commit)})` : ''}`);
    return 0;
  }
  const r = GATE_SUBS[sub]({ root, phase, cfg });
  // a refusal (docs-off for a decimal phase) is an answer, not a failure: exit 0 with its reason
  const status = r.changed ? 'done' : r.reason ? `not done: ${r.reason}` : 'nothing to do';
  out(`gates ${sub} ${phase}: ${status}${r.commit ? `; ${outcome(r.commit)}` : ''}`);
  return 0;
}

function gsdQueries(root) {
  const core = coreOrFail(root);
  const json = (args) => runGsdJson(core, args, { cwd: root });
  return {
    hooks: (point) => json(['loop', 'render-hooks', point]).activeHooks || [],
    // a failing ui-plan-gate is left to plan-phase §5.6, which stops on it with GSD's own message
    frontend: (phase) => { try { return json(['check', 'ui-plan-gate', phase]).frontend === true; } catch { return false; } },
    // plain text: with --raw this verb prints the roadmap section, not JSON (G15)
    goal: (phase) => { try { return gsdText(core, root, ['roadmap', 'get-phase', phase, '--pick', 'goal']).trim(); } catch { return ''; } },
    frontmatter: (file) => json(['frontmatter', 'get', file]),
  };
}

const describeJob = (j) => (j.direct ? `${j.id}: direct audit by secure-phase.md (${j.why})` : `${j.id}: ${j.skill ? `Skill ${j.skill} ${j.args}` : `gsd-tools ${j.gsdTools.join(' ')}`}${j.isolation === 'worktree' ? ' (own worktree)' : ''}`);

// Stage 6 L2 (spec §5.2): the phase's research and security verdicts, L1's predicates over its GSD files by default.
const SIGNALS = {
  research: (root, phase) => needsResearch(readPhaseInfo(root, phase)),
  security: (root, phase) => needsSecurity(readPhaseInfo(root, phase)),
};

// Stage 6 L2 (spec §5.3): the fan-out jobs whose inputs changed since their report's last commit (regateJobs).
function regate({ root, phase, dir, artifacts, list, git }) {
  const phaseRel = relTo(root, dir);
  const changes = {};
  for (const j of list) {
    const report = artifacts[JOB_ARTIFACT[j.id]];
    const since = report ? lastCommitOf(git, `${phaseRel}/${report}`) : null;
    changes[j.id] = since ? { since, ...changedSince(git, since) } : { since: null, code: [], planning: [] };
  }
  return regateJobs({ phase, phaseRel, jobs: list, changes, exists: (p) => fs.existsSync(path.join(root, p)) });
}

// Stage 6 L2 (spec §5.3): the lean fix loop's state, from git's commit order of REVIEW.md and REVIEW-FIX.md (a resumed
// session reads the same); a report git does not hold as it is on disk falls back to the stage-5 loop.
function reviewState({ root, dir, artifacts, git }) {
  const empty = { next: 'done', since: null, files: [], open: [], newCritical: 0, critical: 0, warning: 0, paragraph: '' };
  if (!artifacts.review) return empty;
  const rel = `${relTo(root, dir)}/${artifacts.review}`;
  const fixRel = rel.replace(/-REVIEW\.md$/i, '-REVIEW-FIX.md');
  const fallback = (why) => ({ ...empty, next: 'fallback', why });
  const dirty = (p) => {
    try {
      return String(git(['status', '--porcelain', '--', p])).trim() !== '';
    } catch {
      return true;
    }
  };
  const r = lastCommitOf(git, rel);
  if (!r) return fallback(`${artifacts.review} is not committed`);
  if (dirty(rel)) return fallback(`${artifacts.review} has uncommitted changes`);
  const fixName = path.posix.basename(fixRel);
  const hasFix = fs.existsSync(path.join(root, fixRel));
  const f = hasFix ? lastCommitOf(git, fixRel) : null;
  if (hasFix && !f) return fallback(`${fixName} is not committed`);
  if (hasFix && dirty(fixRel)) return fallback(`${fixName} has uncommitted changes`);
  let ancestor = false;
  try {
    git(['merge-base', '--is-ancestor', r, f || r]);
    ancestor = true;
  } catch { /* not an ancestor */ }
  const fixedAfterReview = Boolean(f) && f !== r && ancestor;
  const show = (sha, p) => {
    try {
      return String(git(['show', `${sha}:./${p}`]));
    } catch {
      return null;
    }
  };
  return leanReviewNext({
    review: fs.readFileSync(path.join(root, rel), 'utf8'),
    fixReport: hasFix ? fs.readFileSync(path.join(root, fixRel), 'utf8') : null,
    previousReview: f ? show(f, rel) : null,
    since: r,
    fixedAfterReview,
    diffReview: Boolean(f) && !fixedAfterReview,
    changedCode: changedSince(git, r).code,
    commitFiles: (sha) => {
      try {
        return String(git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', '--relative', sha])).split('\0').filter(Boolean);
      } catch {
        return null;
      }
    },
    exists: (p) => fs.existsSync(path.join(root, p)),
  });
}

function jobs({ root, pos, flags, out, err, deps }) {
  const text = 'jobs <phase> <prologue|fanout|outcome|research|regate|review> [--json]';
  const phase = phaseArg(pos, 0, text);
  const kind = pos[1];
  if (!['prologue', 'fanout', 'outcome', 'research', 'regate', 'review'].includes(kind)) usage(text);
  const dir = phaseDirOrFail(root, phase);
  const artifacts = phaseArtifacts(dir);
  if (kind === 'review') {
    const r = reviewState({ root, dir, artifacts, git: deps.git || gitRunner(root) });
    if (flags.has('--json')) out(JSON.stringify(r));
    else out(r.next === 'fallback' ? `review: fallback (${r.why})` : `review: ${r.next}; critical ${r.critical}, warning ${r.warning}, new critical ${r.newCritical}; open ${r.open.map((o) => o.code).join(', ') || 'none'}; files ${r.files.length}`);
    return 0;
  }
  const gsd = deps.gsd || gsdQueries(root);
  const signals = deps.signals || SIGNALS;
  const lean = leanOf(root, phase, err);
  const research = () => (!lean ? { yes: true, why: 'lean off: GSD decides' } : artifacts.research ? { yes: true, why: 'RESEARCH.md exists' } : signals.research(root, phase));
  let result;
  if (kind === 'research') {
    result = research();
    out(flags.has('--json') ? JSON.stringify(result) : `research: ${result.yes ? 'yes' : 'no'} (${result.why})`);
    return 0;
  }
  if (kind === 'prologue') {
    result = prologueJobs({ phase, hooks: gsd.hooks('plan:pre'), artifacts, frontend: gsd.frontend(phase), goal: gsd.goal(phase), lean: lean ? { research: research() } : null });
  } else {
    const active = gatesActive(root, phase) || fail(`GSD gates were never switched off for phase ${phase}: run turbo-run gates off ${phase} before execute`);
    // while they are off, GSD's gate skills exit without doing anything (G16)
    if (fs.existsSync(path.join(root, gatesRel(phase)))) fail(`GSD's built-in gates are still off for phase ${phase}: run turbo-run gates restore ${phase} before the fan-out`);
    const list = fanoutJobs({ phase, active, artifacts, lean: lean ? { security: signals.security(root, phase) } : null });
    if (kind === 'fanout') result = list;
    else if (kind === 'regate') result = regate({ root, phase, dir, artifacts, list, git: deps.git || gitRunner(root) });
    else {
      const fm = {};
      const files = {};
      for (const j of list) {
        const f = artifacts[JOB_ARTIFACT[j.id]];
        if (!f) continue;
        files[j.id] = f;
        fm[j.id] = gsd.frontmatter(path.join(dir, f));
      }
      result = gateOutcome({ jobs: list, fm, files });
    }
  }
  if (flags.has('--json')) out(JSON.stringify(result));
  else if (kind === 'outcome') out(`next ${result.next}; review findings ${result.reviewFindings}; open threats ${result.securityOpen}; missing ${result.missing.join(', ') || 'none'}${result.unreadable.length ? `; unreadable ${result.unreadable.join(' | ')}` : ''}`);
  else if (kind === 'regate') out(result.length ? result.map((j) => `${j.id}: ${j.since ? `${j.changed.length} input file(s) changed since ${j.since.slice(0, 12)}` : 'no committed report'}`).join('\n') : 'no regate jobs');
  else out(result.length ? result.map(describeJob).join('\n') : `no ${kind} jobs`);
  return 0;
}

const UAT_USAGE = 'uat <plan|stand|net-check|record|defer|settle|sign|owner-request> <phase> ...';
// the channels the owner answers on; standing-rule and auto are turbo's own answers, which never sign (F1)
const OWNER_CHANNELS = ['session', 'pane', 'telegram'];

function readUatFile(dir) {
  const name = phaseArtifacts(dir).uat || fail(`no UAT file in ${path.basename(dir)} (GSD writes it when verification is human_needed)`);
  return { file: path.join(dir, name), text: fs.readFileSync(path.join(dir, name), 'utf8') };
}

async function uat({ root, pos, flags, out, deps }) {
  const sub = pos[0];
  if (!['plan', 'stand', 'net-check', 'record', 'defer', 'settle', 'sign', 'owner-request'].includes(sub)) usage(UAT_USAGE);
  const phase = phaseArg(pos, 1, UAT_USAGE);
  const config = loadConfig(root);
  const stand = standCheck(config.uat);
  // a refused stand config is never used: an invalid forbidden_hosts reads as an empty list
  const standOrFail = () => stand.ok || fail(`stand refused: ${stand.reason}`);
  if (sub === 'stand') {
    const action = pos[2];
    if (action === 'prepare') {
      standOrFail();
      const s = prepareStand(root, phase);
      fs.mkdirSync(evidenceDir(root, phase), { recursive: true });
      out(JSON.stringify({ dataDir: s.dataDir, credsFile: s.credsFile, evidenceDir: evidenceDir(root, phase) }));
      return 0;
    }
    if (action === 'cleanup') {
      cleanupStand(root, phase);
      out(`uat stand for phase ${phase} removed`);
      return 0;
    }
    usage('uat stand <phase> prepare|cleanup');
  }
  if (sub === 'net-check') {
    const log = flags.get('--log') || usage('uat net-check <phase> --log <file>');
    standOrFail();
    const urls = fs.readFileSync(path.resolve(root, String(log)), 'utf8').split(/\r?\n/).filter((l) => l.trim());
    // whether a log was required is the turbo-uat procedure's call; this only says it is empty
    if (!urls.length) {
      out('no requests logged');
      return 0;
    }
    const bad = netViolations(urls, { forbiddenHosts: stand.forbiddenHosts });
    for (const b of bad) out(`${b.why}: ${b.url}`);
    out(bad.length ? `${bad.length} request(s) left the allowlist` : 'network: every request stayed on loopback');
    return bad.length ? 1 : 0;
  }
  const dir = phaseDirOrFail(root, phase);
  if (sub === 'plan') {
    const { file, text } = readUatFile(dir);
    const plan = { phase, uatFile: relTo(root, file), autonomy: config.autonomy, stand, items: uatPlan(parseUat(text).tests, { autonomy: config.autonomy }) };
    out(JSON.stringify(plan, null, 2));
    return stand.ok ? 0 : 1;
  }
  if (sub === 'record') {
    const resultsFile = flags.get('--results') || usage('uat record <phase> --results <file.json>');
    const results = readJson(path.resolve(root, String(resultsFile)), null);
    if (!Array.isArray(results)) fail('--results must name a JSON array of results');
    const head = headSha(gitRunner(root)) || fail('record needs a commit');
    const known = readStandSecrets(root, phase);
    // without the stand's one-time credentials the evidence scan cannot look for them
    if (!known.length && results.some((r) => Array.isArray(r?.evidence) && r.evidence.length)) {
      fail(`record before stand cleanup: the results carry evidence, but phase ${phase} has no prepared stand whose one-time credentials the scan could look for`);
    }
    const r = recordUat({ root, phaseDir: dir, phase, results, head, known, autonomy: config.autonomy });
    out(`recorded ${results.length} result(s) in ${r.file}: ${JSON.stringify(r.counts)}`);
    return 0;
  }
  if (sub === 'settle') {
    // before uat.complete-session: the working UAT file with the line endings of its blob at HEAD (lib/uat.mjs)
    const r = settleUat({ root, file: readUatFile(dir).file, git: gitRunner(root) });
    if (flags.has('--json')) out(JSON.stringify(r));
    else if (!r.settled) out(`nothing to settle (${r.file})`);
    else out(r.clean ? `settled: ${r.file} has the committed bytes again (git diff shows nothing; git status may still list it)` : `settled: ${r.file} has the committed line endings (LF); its own changes wait for their commit`);
    return 0;
  }
  if (sub === 'sign') {
    // F1: the owner's Accept on a sign-off card (turbo-run ask N --sign) signs exactly that card's rows
    const id = flags.get('--answer');
    if (typeof id !== 'string' || !ASK_ID.test(id)) usage('uat sign <phase> --answer <ask id>');
    const q = readQuestions(root, phase).find((x) => x.id === id) || fail(`no question ${id} in phase ${phase}: nothing signed`);
    if (!Array.isArray(q.sign)) fail(`${id} is no sign-off card (turbo-run ask ${phase} --sign): nothing signed`);
    const a = liveAnswer(readAnswers(root, phase), id) || fail(`${id} has no answer yet: nothing signed`);
    if (!OWNER_CHANNELS.includes(a.by)) fail(`${id} was answered by ${a.by}, not by the owner: a signature is the owner's own; nothing signed`);
    // the session that answered, checked again here: a lane's never signs (the lane itself runs this command)
    const from = a.session ? laneOfSession(root, deps.env || process.env, [String(a.session)]) : null;
    if (from) fail(`${id} was answered from the session of the lane of ${laneLabel(from)}, not by the owner: nothing signed`);
    // option 1 is turbo's accept (laneQuestion puts it first)
    if (a.option !== 1) fail(`the owner chose ${a.label ? `«${a.label}»` : 'their own words'}, not «${q.options?.[0]?.label ?? 'Accept'}»: nothing signed`);
    // only the rows as the card showed them (signText): a file rewritten or renumbered since signs nothing
    const seen = Object.fromEntries(q.sign.map((n, i) => [n, Array.isArray(q.signText) ? q.signText[i] : undefined]));
    const r = signUat({ root, phaseDir: dir, tests: q.sign, seen, answer: { id, by: a.by, at: a.at } });
    const already = r.already.length ? `${r.already.join(', ')} already closed` : '';
    out(r.signed.length ? `signed ${r.signed.length} row(s) in ${r.file}: ${r.signed.join(', ')} (owner answer ${id})${already ? `; ${already}` : ''}` : `nothing to sign in ${r.file}: ${already}`);
    return 0;
  }
  if (sub === 'defer') {
    const DEFER_USAGE = 'uat defer <phase> --rulings | uat defer <phase> <test>[,<test>...]';
    const rulings = flags.has('--rulings');
    const list = pos[2] === undefined ? [] : String(pos[2]).split(',').map((n) => n.trim());
    // one comma-separated list at most: a second positional would be silently dropped
    if (pos.length > 3 || rulings === Boolean(list.length) || list.some((n) => !/^\d+$/.test(n))) usage(DEFER_USAGE);
    readUatFile(dir);
    const r = deferUat({ root, phaseDir: dir, rulings, tests: list.map(Number) });
    if (flags.has('--json')) out(JSON.stringify(r));
    else out(r.deferred.length ? `deferred as follow-ups: ${r.deferred.join(', ')} (${r.file})` : `nothing to defer (${r.file})${r.already.length ? `; already deferred: ${r.already.join(', ')}` : ''}`);
    return 0;
  }
  // owner-request
  const { text } = readUatFile(dir);
  const file = path.join(runDir(root), `p${phase}-owner.md`);
  // the checklist last sent to the owner; ownerRequestFiles lists only -owner.md, so status never shows it
  const sent = path.join(runDir(root), `p${phase}-owner.notified`);
  const rel = relTo(root, file);
  const { tests } = parseUat(text);
  const req = ownerRequest({ phase, tests, lang: config.lang, file: rel });
  const pending = req.counts.checklist + req.counts.signoff;
  if (pending) {
    fs.mkdirSync(runDir(root), { recursive: true });
    fs.writeFileSync(file, `${req.text}\n`);
  } else {
    fs.rmSync(file, { force: true });
    fs.rmSync(sent, { force: true });
  }
  if (!req.needsOwner && req.counts.checklist) {
    // the lane's uat step runs owner-request more than once (repeats, context-limit resumes): one notification per
    // checklist. ownerRequest's own predicate picks the checklist items, one test at a time.
    const checklist = tests.filter((t) => ownerRequest({ phase, tests: [t] }).counts.checklist).map((t) => `${t.number}. ${t.name}`).sort();
    if (JSON.stringify(readJson(sent, null)?.checklist) !== JSON.stringify(checklist)) {
      const send = deps.notify || ((key, vars) => notify(config, msg(config.lang, key, vars)));
      await send('ownerChecklist', { phase, n: req.counts.checklist, file: rel });
      writeJsonAtomic(sent, { checklist });
    }
  }
  // sign (F1): the rows a sign-off card asks the owner to accept (turbo-run ask N --sign)
  const res = { file: pending ? rel : null, needsOwner: req.needsOwner, reason: req.reason, counts: req.counts, sign: req.sign };
  out(flags.has('--json') ? JSON.stringify(res) : `${pending ? `owner request: ${rel}` : 'nothing left for the owner'}${req.needsOwner ? ` (needs-owner: ${req.reason})` : ''}`);
  return 0;
}
