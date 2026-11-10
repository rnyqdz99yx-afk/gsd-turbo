import { execFileSync } from 'node:child_process';

// Live run 2026-11-10: a lane in its slot stopped for the owner about a failing login; meanwhile a fix for it landed on
// the main branch from outside turbo, the owner answered «fix it», and the lane was about to fix it a second time on a
// stale base. When the owner answers a slot lane, the commits the main branch got since the lane asked go to its
// inbox as a note, before it acts on the answer.

// turbo's own commits on the main branch (answers, lean, markup, a lane's merge and its integrate) are no news to a lane
const TURBO_OWN = /^(?:docs|chore)\(turbo\)|^Merge phase \S+ \(turbo lane|^Merge main into turbo\//;
const GIT_TIMEOUT_MS = 10000;

const runGit = (root, args) => String(execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' }));

// The commits of the checked-out branch of root after since (ISO), newest first, without turbo's own: [{ sha, subject }],
// at most max. [] when git fails: the note is help, never a reason to hold the answer back.
export function movedSince(root, since, { git = runGit, max = 10 } = {}) {
  try {
    const out = git(root, ['log', `--since=${since}`, '--max-count=200', '--format=%h%x09%s']);
    return out.split('\n').filter((l) => l.trim()).map((l) => {
      const [sha, ...rest] = l.split('\t');
      return { sha: sha.trim(), subject: rest.join('\t').trim() };
    }).filter((c) => c.sha && !TURBO_OWN.test(c.subject)).slice(0, max);
  } catch {
    return [];
  }
}

// The note, in the project's language.
export function movedNote(commits, phase, lang = 'en') {
  const list = commits.map((c) => `${c.sha} ${c.subject}`).join('; ');
  return lang === 'ru'
    ? `С тех пор как фаза задала вопрос владельцу, в основную ветку пришли коммиты (новые первыми): ${list}. Они могут уже делать то, о чём ответ владельца. Прежде чем действовать по ответу: если какой-то из них касается темы вопроса, сначала подтяните основную ветку (turbo-run integrate ${phase}) и не делайте заново то, что уже есть.`
    : `Since this phase asked the owner, the main branch got these commits (newest first): ${list}. They may already do what the owner's answer is about. Before acting on the answer: when any of them touches the question's topic, take in the main branch first (turbo-run integrate ${phase}) and do not redo what is already there.`;
}
