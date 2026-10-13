import fs from 'node:fs';
import path from 'node:path';
import { gsdCoreDir, runDir } from './paths.mjs';
import { normalizePhaseId, runGsdJson } from './gsd.mjs';
import { STEPS, completeStep, countAttempt, nextStep, readProgress, resetProgress } from './phase-progress.mjs';
import { findPhaseDir, phaseArtifacts, phaseDirMatches, phasesDir } from './phase-files.mjs';
import { artifactFiles, gitRunner, headSha, recordBases, stalenessReport, verificationRoute } from './staleness.mjs';
import { createGsdConfig, docsCommitsOff, docsCommitsRestore, ensureChunkedParallel, gatesActive, gatesOff, gatesRel, gatesRestore, gsdText } from './gates.mjs';
import { JOB_ARTIFACT, fanoutJobs, gateOutcome, prologueJobs } from './phase-jobs.mjs';
import { loadConfig, pushSettings } from './config.mjs';
import { formatInboxMessage, markRead, unreadInbox } from './inbox.mjs';
import { UNHANDLED_MS, allowFile, createGit, listFindings, readAllowed, recordFile, requestPush, short, waitPush } from './push.mjs';
import { SECRET_RULES } from './secrets.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { msg } from './messages.mjs';
import { notify } from './notify.mjs';
import { uatPlan } from './uat-classify.mjs';
import { deferUat, ownerRequest, parseUat, recordUat, settleUat } from './uat.mjs';
import { cleanupStand, evidenceDir, netViolations, prepareStand, readStandSecrets, standCheck } from './uat-stand.mjs';
import { stateSync } from './state-sync.mjs';
import { openQuestions } from './view.mjs';
import { AGENT_ID, QUESTION_ID, askOwner, classifyQuestions, markDelivered, readQuestions, refreshQuestions, stopQuestion } from './questions.mjs';
import { LIVE_CHECK_OPTION, loopSentence, ownerGapsText, reviewLoop, reviewVersions } from './review-loop.mjs';
import { agentTail, formatAgentTail } from './agent-tail.mjs';
import { GAP_STEPS, gapRound } from './gap-rounds.mjs';
import { attendedPhases } from './attend.mjs';
import { AnswerRefused, QuestionChanged, answerQuestion, applyStandingRule, deliveries, describeAnswer, preAnswerText } from './answers.mjs';

// Stage-2 subcommands. bin/turbo-run.mjs routes these names here.
export const PHASE_COMMANDS = new Set(['phase-step', 'staleness', 'gates', 'jobs', 'uat', 'state-sync', 'inbox', 'push-request', 'push-allow', 'questions', 'answer', 'ask', 'owner-gaps', 'agent-tail']);

// No path separators: a phase id only ever names files inside turbo's own directories.
const PHASE_ID = /^[A-Za-z0-9._-]+$/;
// Flags whose next argument is their value; bin's projectArg skips them too, so a value never reads as --project.
export const VALUE_FLAGS = new Set([
  '--project', '--done', '--note', '--results', '--log', '--attempt', '--at',
  '--class', '--preanswers', '--stop', '--agent', '--kind', '--question', '--delivered', '--path', '--option', '--text', '--by', '--rev',
  '--context', '--recommended', '--action', '--review', '--gap',
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
    r = stateSync({ root, phase, gsd });
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
    // review 1: close is the phase's last gate; a lane that marks it done past a failed verification or an open
    // threat (an owner's "go on", say) is refused here
    const why = step === 'close' ? closeBlocker(root, phase) : null;
    if (why) fail(`phase ${phase} cannot close: ${why}`);
    p = completeStep(root, phase, step, { note: String(flags.get('--note') || '') });
  }
  const next = nextStep(p);
  if (flags.has('--json')) out(JSON.stringify({ phase, done: p.done, next, steps: STEPS, attempts: p.attempts }));
  else out(`phase ${phase}: next ${next ?? 'none'}${p.done.length ? ` (done: ${p.done.join(', ')})` : ''}`);
  return 0;
}

const QUESTIONS_USAGE = 'questions <phase> [--json] | questions <phase> --class <id>=<class>[,<id>=<class>…] | questions <phase> --preanswers <plan> | questions <phase> --stop <id> --agent <agent id> [--unmet] [--kind human-verify|human-action --question <text>] | questions <phase> --deliver [--json] | questions <phase> --delivered <id> --path same-agent|continuation|lane | questions --open [--json]';
const ANSWER_USAGE = 'answer <phase> <question id> (--option <k> | --text <text>) --by <session|pane|telegram> [--rev <n>]';

// A lane works in this checkout when the supervisor runs and has one, whatever its phase: the lane then commits the
// whole answers directory at its step boundaries (an answer to another phase included), and turbo-run answer commits
// nothing, so two git commits never race in the shared checkout; otherwise turbo-run answer commits it (spec §5.4).
// spec §8 (S4): while a phase is attended no lane runs (attend stopped them, and a supervisor started meanwhile holds
// every lane), so the owner's session commits its answers itself
function laneRuns(root, deps) {
  const sup = readJson(path.join(runDir(root), 'supervisor.json'), null);
  return Boolean(sup?.lane) && Boolean(deps.supervisorAlive?.()) && !attendedPhases(root).length;
}

function questionLine(q) {
  const cls = q.classified ? `class ${q.class}${q.topic ? `:${q.topic}` : ''}` : 'unclassified';
  return `${q.id} · ${q.kind} · ${q.state}${q.stopped ? ' (stopped)' : ''} · ${cls} · ${q.question}`;
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

const ASK_USAGE = 'ask <phase> --question <text> [--context <text>] --option "<label>|<description>" (2 to 4 times) --recommended <n> [--about-review] [--json] | ask <phase> --action <text> [--context <text>] [--json]';

// v0.3.3 (D2, D7): the lane's stop for the owner, asked as an owner question in plain words (a decision with 2-4
// options, or owner-only work), and the lane's needs-owner record. --about-review: a question about review findings
// says so when the review keeps finding new edges in the same code, and offers the live check.
function ask({ root, pos, flags, values, out, deps }) {
  const phase = phaseArg(pos, 0, ASK_USAGE);
  const action = flags.has('--action') ? String(flags.get('--action')) : null;
  if ((action === null) === !flags.has('--question') || (action !== null && flags.has('--about-review'))) usage(ASK_USAGE);
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
  const input = action === null ? { question: String(flags.get('--question')), context, options, recommended } : { action, context, options, recommended };
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

const UAT_USAGE = 'uat <plan|stand|net-check|record|defer|settle|owner-request> <phase> ...';

function readUatFile(dir) {
  const name = phaseArtifacts(dir).uat || fail(`no UAT file in ${path.basename(dir)} (GSD writes it when verification is human_needed)`);
  return { file: path.join(dir, name), text: fs.readFileSync(path.join(dir, name), 'utf8') };
}

async function uat({ root, pos, flags, out, deps }) {
  const sub = pos[0];
  if (!['plan', 'stand', 'net-check', 'record', 'defer', 'settle', 'owner-request'].includes(sub)) usage(UAT_USAGE);
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
  const res = { file: pending ? rel : null, needsOwner: req.needsOwner, reason: req.reason, counts: req.counts };
  out(flags.has('--json') ? JSON.stringify(res) : `${pending ? `owner request: ${rel}` : 'nothing left for the owner'}${req.needsOwner ? ` (needs-owner: ${req.reason})` : ''}`);
  return 0;
}
