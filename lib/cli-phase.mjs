import fs from 'node:fs';
import path from 'node:path';
import { gsdCoreDir, runDir } from './paths.mjs';
import { normalizePhaseId, runGsdJson } from './gsd.mjs';
import { STEPS, completeStep, countAttempt, nextStep, readProgress, resetProgress } from './phase-progress.mjs';
import { phaseArtifacts, phaseDirMatches, phasesDir } from './phase-files.mjs';
import { artifactFiles, gitRunner, headSha, recordBases, stalenessReport } from './staleness.mjs';
import { createGsdConfig, docsCommitsOff, docsCommitsRestore, ensureChunkedParallel, gatesActive, gatesOff, gatesRel, gatesRestore, gsdText } from './gates.mjs';
import { JOB_ARTIFACT, fanoutJobs, gateOutcome, prologueJobs } from './phase-jobs.mjs';
import { loadConfig, pushSettings } from './config.mjs';
import { formatInboxMessage, markRead, unreadInbox } from './inbox.mjs';
import { UNHANDLED_MS, createGit, requestPush, waitPush } from './push.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { msg } from './messages.mjs';
import { notify } from './notify.mjs';
import { uatPlan } from './uat-classify.mjs';
import { ownerRequest, parseUat, recordUat } from './uat.mjs';
import { cleanupStand, evidenceDir, netViolations, prepareStand, readStandSecrets, standCheck } from './uat-stand.mjs';
import { stateSync } from './state-sync.mjs';
import { openQuestions } from './view.mjs';
import { AGENT_ID, QUESTION_ID, classifyQuestions, markDelivered, readQuestions, refreshQuestions, stopQuestion } from './questions.mjs';
import { agentTail, formatAgentTail } from './agent-tail.mjs';
import { AnswerRefused, QuestionChanged, answerQuestion, applyStandingRule, deliveries, describeAnswer, preAnswerText } from './answers.mjs';

// Stage-2 subcommands. bin/turbo-run.mjs routes these names here.
export const PHASE_COMMANDS = new Set(['phase-step', 'staleness', 'gates', 'jobs', 'uat', 'state-sync', 'inbox', 'push-request', 'questions', 'answer', 'agent-tail']);

// No path separators: a phase id only ever names files inside turbo's own directories.
const PHASE_ID = /^[A-Za-z0-9._-]+$/;
// Flags whose next argument is their value; bin's projectArg skips them too, so a value never reads as --project.
export const VALUE_FLAGS = new Set([
  '--project', '--done', '--note', '--results', '--log', '--attempt', '--at',
  '--class', '--preanswers', '--stop', '--agent', '--kind', '--question', '--delivered', '--path', '--option', '--text', '--by', '--rev',
]);

class UsageError extends Error {}
export const usage = (text) => { throw new UsageError(text); };
export const fail = (text) => { throw new Error(text); };

export function parseArgs(args) {
  const pos = [];
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) flags.set(a, args[++i] ?? '');
    else if (a.startsWith('--')) flags.set(a, true);
    else pos.push(a);
  }
  return { pos, flags };
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
  questions,
  answer,
  'agent-tail': agentTailCommand,
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

function syncState({ root, pos, out, err, deps }) {
  const phase = phaseArg(pos, 0, 'state-sync <phase>');
  const gsd = deps.gsd || ((args) => gsdAnswer(gsdText(coreOrFail(root), root, args)));
  let r;
  try {
    r = stateSync({ root, phase, gsd, now: deps.now });
  } catch (e) {
    // best effort: every caller is a stop or a step's end, which must not fail on it
    err(`warn: state-sync: ${String(e?.message ?? e).split(/\r?\n/)[0]}`);
    return 0;
  }
  const outside = r.outside?.length ? `; not written, their first match lies outside Current Position: ${r.outside.join(', ')}` : '';
  out(r.synced ? `STATE.md: phase ${r.phase} executing, next plan ${r.next} (${r.at} of ${r.total}); ${r.commit}${outside}` : `STATE.md: left as it is (${r.reason})`);
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

function phaseStep({ root, pos, flags, out }) {
  const text = 'phase-step <phase> [--done <step> [--note <text>] | --attempt <step> | --reset] [--json]';
  const phase = phaseArg(pos, 0, text);
  if (flags.has('--reset')) {
    resetProgress(root, phase);
    out(`phase ${phase}: progress reset`);
    return 0;
  }
  if (flags.has('--attempt')) {
    const step = String(flags.get('--attempt'));
    if (!step) usage(text);
    out(`attempt ${step} ${countAttempt(root, phase, step)}`);
    return 0;
  }
  let p = readProgress(root, phase);
  if (flags.has('--done')) p = completeStep(root, phase, String(flags.get('--done')), { note: String(flags.get('--note') || '') });
  const next = nextStep(p);
  if (flags.has('--json')) out(JSON.stringify({ phase, done: p.done, next, steps: STEPS, attempts: p.attempts }));
  else out(`phase ${phase}: next ${next ?? 'none'}${p.done.length ? ` (done: ${p.done.join(', ')})` : ''}`);
  return 0;
}

const QUESTIONS_USAGE = 'questions <phase> [--json] | questions <phase> --class <id>=<class>[,<id>=<class>…] | questions <phase> --preanswers <plan> | questions <phase> --stop <id> --agent <agent id> [--unmet] [--kind human-verify|human-action --question <text>] | questions <phase> --deliver [--json] | questions <phase> --delivered <id> --path same-agent|continuation | questions --open [--json]';
const ANSWER_USAGE = 'answer <phase> <question id> (--option <k> | --text <text>) --by <session|pane|telegram> [--rev <n>]';

// A lane works in this checkout when the supervisor runs and has one: the lane then commits the answers file at
// its step boundaries; otherwise turbo-run answer commits it (spec §5.4).
function laneRuns(root, deps) {
  const sup = readJson(path.join(runDir(root), 'supervisor.json'), null);
  return Boolean(sup?.lane) && Boolean(deps.supervisorAlive?.());
}

function questionLine(q) {
  const cls = q.classified ? `class ${q.class}${q.topic ? `:${q.topic}` : ''}` : 'unclassified';
  return `${q.id} · ${q.kind} · ${q.state}${q.stopped ? ' (stopped)' : ''} · ${cls} · ${q.question}`;
}

// The lane's side of the owner questions (spec §5.1–§5.3, §5.5): list and classify, the pre-answers for a plan, a
// stop at a checkpoint, the answers to deliver and their delivery. --open lists every phase's open questions.
function questions({ root, pos, flags, out, deps }) {
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
    else for (const d of list) out(`${d.id} · plan ${d.plan} task ${d.task} · agent ${d.agentId}\n  message: ${d.message}`);
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
      lang: config.lang,
      now,
    });
    const id = r.question.id;
    out(r.status === 'answered' || standing().includes(id)
      ? `answered: ${id}; deliver it now (turbo-run questions ${phase} --deliver)`
      : `stopped: ${id} waits for the owner; stop for the owner with the reason: owner question ${id}`);
    return 0;
  }
  if (flags.has('--class')) classifyQuestions(root, phase, String(flags.get('--class')));
  else refreshQuestions(root, phase, { lang: config.lang });
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

// The single arbiter for the owner's answers (spec §5.3): the first answer wins. --rev is the question's revision the
// channel showed; another revision records nothing (exit 4). Never from inside a lane.
function answer({ root, pos, flags, out, deps }) {
  const phase = phaseArg(pos, 0, ANSWER_USAGE);
  const id = pos[1];
  const by = String(flags.get('--by') || '');
  const hasOption = flags.has('--option');
  if (!id || !QUESTION_ID.test(id) || !['session', 'pane', 'telegram'].includes(by) || hasOption === flags.has('--text')) usage(ANSWER_USAGE);
  const option = hasOption ? Number(flags.get('--option')) : null;
  if (hasOption && !(Number.isInteger(option) && option >= 1)) usage(ANSWER_USAGE);
  const rev = flags.has('--rev') ? Number(flags.get('--rev')) : null;
  if (rev !== null && !(Number.isInteger(rev) && rev >= 1)) usage(ANSWER_USAGE);
  if ((deps.env || process.env).TURBO_LANE) {
    out("refused: a lane never answers the owner's questions; the owner answers them (/turbo-autonomous answer, the turbo-view pane or Telegram)");
    return 1;
  }
  let r;
  try {
    r = answerQuestion({
      root, phase, id, option, text: hasOption ? null : String(flags.get('--text')), by, rev,
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
  const phase = phaseArg(pos, 0, 'staleness <phase> [--json] | staleness <phase> --record <file>... | staleness <phase> --record-all');
  const dir = phaseDirOrFail(root, phase);
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

const describeJob = (j) => `${j.id}: ${j.skill ? `Skill ${j.skill} ${j.args}` : `gsd-tools ${j.gsdTools.join(' ')}`}${j.isolation === 'worktree' ? ' (own worktree)' : ''}`;

function jobs({ root, pos, flags, out, deps }) {
  const text = 'jobs <phase> <prologue|fanout|outcome> [--json]';
  const phase = phaseArg(pos, 0, text);
  const kind = pos[1];
  if (!['prologue', 'fanout', 'outcome'].includes(kind)) usage(text);
  const dir = phaseDirOrFail(root, phase);
  const artifacts = phaseArtifacts(dir);
  const gsd = deps.gsd || gsdQueries(root);
  let result;
  if (kind === 'prologue') {
    result = prologueJobs({ phase, hooks: gsd.hooks('plan:pre'), artifacts, frontend: gsd.frontend(phase), goal: gsd.goal(phase) });
  } else {
    const active = gatesActive(root, phase) || fail(`GSD gates were never switched off for phase ${phase}: run turbo-run gates off ${phase} before execute`);
    // while they are off, GSD's gate skills exit without doing anything (G16)
    if (fs.existsSync(path.join(root, gatesRel(phase)))) fail(`GSD's built-in gates are still off for phase ${phase}: run turbo-run gates restore ${phase} before the fan-out`);
    const list = fanoutJobs({ phase, active, artifacts });
    if (kind === 'fanout') result = list;
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
  else out(result.length ? result.map(describeJob).join('\n') : `no ${kind} jobs`);
  return 0;
}

const UAT_USAGE = 'uat <plan|stand|net-check|record|owner-request> <phase> ...';

function readUatFile(dir) {
  const name = phaseArtifacts(dir).uat || fail(`no UAT file in ${path.basename(dir)} (GSD writes it when verification is human_needed)`);
  return { file: path.join(dir, name), text: fs.readFileSync(path.join(dir, name), 'utf8') };
}

async function uat({ root, pos, flags, out, deps }) {
  const sub = pos[0];
  if (!['plan', 'stand', 'net-check', 'record', 'owner-request'].includes(sub)) usage(UAT_USAGE);
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
  const res = { file: pending ? rel : null, needsOwner: req.needsOwner, reason: req.reason, counts: req.counts };
  out(flags.has('--json') ? JSON.stringify(res) : `${pending ? `owner request: ${rel}` : 'nothing left for the owner'}${req.needsOwner ? ` (needs-owner: ${req.reason})` : ''}`);
  return 0;
}
