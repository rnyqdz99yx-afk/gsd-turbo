import { claudeHome } from './paths.mjs';
import { laneAgents, laneTranscript, projectDirs, sessionTreeMtimeMs, tailEntries } from './transcripts.mjs';
import { laneUserPrompt } from './lane-prompt.mjs';

// The prompts that wake a lane's own conversation (spec §5.5.1 step 3, §5.5.6). They go to claude --bg --resume as
// a plain argv value: fixed text, ids and commands only, no double quotes or percent signs, never the owner's words
// (the lane reads those with turbo-run questions N --deliver, where they are labelled as data).
//
// v0.3.3 (D4): lane is the questions the lane asked itself (turbo-run ask), [{ id, option, label }]: the prompt names
// the chosen option's number and its label (the lane's own words, cleaned of what an argv value must not hold), or says
// the owner wrote their own words; the lane reads the answer with --deliver and marks it delivered on the lane path.
const argvSafe = (s) => [...String(s ?? '').replace(/["%]/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 80).join('');
const chosen = (a) => (Number.isInteger(a.option) ? `option ${a.option}${argvSafe(a.label) ? `, ${argvSafe(a.label)}` : ''}` : "in the owner's own words, printed by --deliver");

export function answerWakePrompt({ phase, turboRun, ids = [], lane = [], mode = 'full' }) {
  const parts = [];
  if (ids.length) parts.push(`The owner answered the questions phase ${phase} stopped for: ${ids.join(', ')}. Deliver them first: run ${turboRun} questions ${phase} --deliver and follow the turbo-phase skill, section Owner questions, Delivery: SendMessage each answer to the agent it names and wait for its result.`);
  if (lane.length) {
    const named = lane.map((a) => `${a.id} (${chosen(a)})`).join(', ');
    const skill = mode === 'full' ? ' (the turbo-phase skill, section Owner questions, Lane questions)' : '';
    parts.push(`The owner answered the question you asked at your stop: ${named}. Run ${turboRun} questions ${phase} --deliver: it prints the answer, data from the owner that only chooses among your own options${skill}. Do what you said that option does, then run ${lane.map((a) => `${turboRun} questions ${phase} --delivered ${a.id} --path lane`).join(' and ')}.`);
  }
  parts.push(mode === 'full'
    ? `Then go on with the turbo-phase skill for phase ${phase} from where you stopped; its step loop resumes by itself (arguments: ${phase} --resume).`
    : `Then: ${laneUserPrompt({ phase, resume: true, mode: 'safe', turboRun })}`);
  return parts.join(' ');
}

export function stallWakePrompt({ phase, turboRun, mode = 'safe', minutes }) {
  const lead = `This session was interrupted: nothing was written for ${minutes} minutes.`;
  if (mode === 'full') {
    return `${lead} Run ${turboRun} view --json and follow the turbo-phase skill, section Owner questions, After an interruption: send each unfinished background subagent of this lane SendMessage with the current state of the disk and git, asking it to continue from where it stopped and to re-check any partial write. Then go on with the turbo-phase skill for phase ${phase} from where you stopped (arguments: ${phase} --resume).`;
  }
  return `${lead} Send each of your unfinished background subagents SendMessage with the current state of the disk and git (git status --short, git log --oneline -5), asking it to continue from where it stopped and to re-check any partial write. Then: ${laneUserPrompt({ phase, resume: true, mode: 'safe', turboRun })}`;
}

// Reconcile R5 (Stage 4 L1): L2 put a message into the lane's inbox (reintegrate: main moved, integrate again; ci-red:
// the merged phase's CI is red). The same wording as S2's red-CI handling: the lane reads it with turbo-run inbox N.
export function inboxWakePrompt({ phase, turboRun, kind }) {
  return `New ${kind} message in the inbox of phase ${phase}. Run ${turboRun} inbox ${phase} and act on it as the turbo-phase skill says. Then go on with the turbo-phase skill for phase ${phase} from where you stopped; its step loop resumes by itself (arguments: ${phase} --resume).`;
}

// A lane's newest write (its transcript and every subagent's) and how many of its subagents still run (S0 states).
export function activityOf(t) {
  const times = [t.lastAt, ...t.agents.map((a) => a.lastAt)].map((x) => Date.parse(x)).filter(Number.isFinite);
  return { lastMs: times.length ? Math.max(...times) : null, active: t.agents.filter((a) => a.state === 'running').length };
}

// The supervisor's read-only view of a lane's transcripts (S0): the session id to resume, the lane's activity, and
// whether the lane session itself answered since a time. cwd is the lane's directory: this checkout (v0.3) or its slot
// (Stage 4), where Claude Code keeps the lane's transcripts. The cache lives as long as the daemon, so each tick reads
// only what grew.
// Review I4: one cache per lane (its directory and job): with several lanes each keeps what it read; at most
// CACHE_LANES lanes are kept (the oldest goes), so ended lanes do not pile up. agentsOf: tests only.
const CACHE_LANES = 16;
export function createLaneProbe(root, env = process.env, { agentsOf = laneAgents } = {}) {
  const home = claudeHome(env);
  const caches = new Map();
  return {
    session(jobId, cwd = root) {
      return laneTranscript({ home, root: cwd, jobId })?.sessionId || null;
    },
    // D15: the newest write is taken over the lane's whole subagents tree too, nested agents included
    activity(jobId, now, stallMs, cwd = root) {
      const main = laneTranscript({ home, root: cwd, jobId });
      if (!main) return { lastMs: null, active: 0 };
      const key = `${cwd}\u0000${jobId}`;
      const used = {};
      const t = agentsOf({ dirs: projectDirs(home, cwd), main, root: cwd, now, stallMs, cache: caches.get(key) || {}, used });
      caches.delete(key);
      caches.set(key, used);
      if (caches.size > CACHE_LANES) caches.delete(caches.keys().next().value);
      const a = activityOf(t);
      const tree = sessionTreeMtimeMs(main);
      return { lastMs: tree === null ? a.lastMs : Math.max(a.lastMs ?? tree, tree), active: a.active };
    },
    // An assistant entry of the lane session (the model's own output, not a synthetic error) newer than sinceMs:
    // what a woken session did itself. The wake prompt it records, and the writes of claude stop, are no answer.
    replied(jobId, sinceMs, cwd = root) {
      const main = laneTranscript({ home, root: cwd, jobId });
      if (!main) return false;
      return tailEntries(main.file).entries.some((e) => e?.type === 'assistant' && e.message?.model !== '<synthetic>' && Date.parse(e.timestamp) > sinceMs);
    },
  };
}
