import { claudeHome } from './paths.mjs';
import { laneAgents, laneTranscript, projectDirs, tailEntries } from './transcripts.mjs';
import { laneUserPrompt } from './lane-prompt.mjs';

// The prompts that wake a lane's own conversation (spec §5.5.1 step 3, §5.5.6). They go to claude --bg --resume as
// a plain argv value: fixed text, ids and commands only, no double quotes or percent signs, never the owner's words
// (the lane reads those with turbo-run questions N --deliver, where they are labelled as data).
export function answerWakePrompt({ phase, turboRun, ids }) {
  return `The owner answered the questions phase ${phase} stopped for: ${ids.join(', ')}. Deliver them first: run ${turboRun} questions ${phase} --deliver and follow the turbo-phase skill, section Owner questions, Delivery: SendMessage each answer to the agent it names and wait for its result. Then go on with the turbo-phase skill for phase ${phase} from where you stopped; its step loop resumes by itself (arguments: ${phase} --resume).`;
}

export function stallWakePrompt({ phase, turboRun, mode = 'safe', minutes }) {
  const lead = `This session was interrupted: nothing was written for ${minutes} minutes.`;
  if (mode === 'full') {
    return `${lead} Run ${turboRun} view --json and follow the turbo-phase skill, section Owner questions, After an interruption: send each unfinished background subagent of this lane SendMessage with the current state of the disk and git, asking it to continue from where it stopped and to re-check any partial write. Then go on with the turbo-phase skill for phase ${phase} from where you stopped (arguments: ${phase} --resume).`;
  }
  return `${lead} Send each of your unfinished background subagents SendMessage with the current state of the disk and git (git status --short, git log --oneline -5), asking it to continue from where it stopped and to re-check any partial write. Then: ${laneUserPrompt({ phase, resume: true, mode: 'safe', turboRun })}`;
}

// A lane's newest write (its transcript and every subagent's) and how many of its subagents still run (S0 states).
export function activityOf(t) {
  const times = [t.lastAt, ...t.agents.map((a) => a.lastAt)].map((x) => Date.parse(x)).filter(Number.isFinite);
  return { lastMs: times.length ? Math.max(...times) : null, active: t.agents.filter((a) => a.state === 'running').length };
}

// The supervisor's read-only view of a lane's transcripts (S0): the session id to resume, the lane's activity, and
// whether the lane session itself answered since a time. The cache lives as long as the daemon, so each tick reads
// only what grew.
export function createLaneProbe(root, env = process.env) {
  const home = claudeHome(env);
  let cache = {};
  return {
    session(jobId) {
      return laneTranscript({ home, root, jobId })?.sessionId || null;
    },
    activity(jobId, now, stallMs) {
      const main = laneTranscript({ home, root, jobId });
      if (!main) return { lastMs: null, active: 0 };
      const used = {};
      const t = laneAgents({ dirs: projectDirs(home, root), main, root, now, stallMs, cache, used });
      cache = used;
      return activityOf(t);
    },
    // An assistant entry of the lane session (the model's own output, not a synthetic error) newer than sinceMs:
    // what a woken session did itself. The wake prompt it records, and the writes of claude stop, are no answer.
    replied(jobId, sinceMs) {
      const main = laneTranscript({ home, root, jobId });
      if (!main) return false;
      return tailEntries(main.file).entries.some((e) => e?.type === 'assistant' && e.message?.model !== '<synthetic>' && Date.parse(e.timestamp) > sinceMs);
    },
  };
}
