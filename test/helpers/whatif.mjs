import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpGitRepo } from './tmp.mjs';
import { jsonl, projectDirFor } from './transcripts.mjs';

// A GSD 1.16 plan's frontmatter (agents/gsd-planner.md plan_format), enough for the execution graph.
export function planText({ id, wave = 1, deps = [], files = [], deleted = [], links = [], autonomous = true, gap = false }) {
  const [phase, plan] = [id.slice(0, id.lastIndexOf('-')), id.slice(id.lastIndexOf('-') + 1)];
  const list = (xs) => `[${xs.map((x) => `"${x}"`).join(', ')}]`;
  const linkLines = links.length ? `\n${links.map(([from, to]) => `    - from: "${from}"\n      to: "${to}"\n      via: "call"`).join('\n')}` : ' []';
  return `---
phase: ${phase}-demo
plan: ${plan}
type: execute
wave: ${wave}
depends_on: ${list(deps)}
files_modified: ${list(files)}
${deleted.length ? `files_deleted: ${list(deleted)}\n` : ''}autonomous: ${autonomous}
${gap ? 'gap_closure: true\n' : ''}requirements: [DEMO-01]
must_haves:
  truths: []
  key_links:${linkLines}
---

<objective>
Plan ${id}.
</objective>
`;
}

// A git checkout with phase <phase>'s plans committed at `planned` (ISO). Returns { root, dir, rel, at(iso, subject,
// files) } — at() writes each file (a line with the subject) and commits with both dates set to iso.
export function phaseRepo({ phase = '32', plans, planned = '2026-10-01T08:00:00Z' }) {
  const root = tmpGitRepo();
  const rel = `.planning/phases/${phase}-demo`;
  const dir = path.join(root, ...rel.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  for (const p of plans) fs.writeFileSync(path.join(dir, `${p.id}-PLAN.md`), planText(p));
  const env = (iso) => ({ ...process.env, GIT_CONFIG_GLOBAL: path.join(root, '.git', 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
  const git = (iso, ...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe', env: env(iso) });
  const at = (iso, subject, files = []) => {
    for (const f of files) {
      const abs = path.join(root, ...f.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, `${subject}\n`);
    }
    git(iso, 'add', '-A');
    git(iso, 'commit', '-q', '--allow-empty', '-m', subject);
  };
  at(planned, `docs(${phase}): create phase plan`);
  return { root, dir, rel, at };
}

// One executor run of a plan: a work commit, then its summary. start/end: ISO.
export function executed(repo, id, start, end, file = `src/${id}.ts`) {
  repo.at(start, `feat(${id}): work`, [file]);
  repo.at(end, `docs(${id}): complete demo plan`, [`${repo.rel}/${id}-SUMMARY.md`]);
}

// A synthetic executor subagent transcript of the session `session` in the project's transcript directory:
// entries at each ISO time of `times`, cwd `cwd`, meta { agentType, description }.
export function executorTranscript(home, root, { session = '11111111-2222-4333-8444-555555555555', agent, type = 'gsd-executor', description, times, cwd = root }) {
  const dir = path.join(projectDirFor(home, root), session, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const entries = times.map((ts, i) => ({ type: i % 2 ? 'assistant' : 'user', isSidechain: true, agentId: agent, timestamp: ts, cwd, sessionId: session, message: { role: i % 2 ? 'assistant' : 'user', content: 'x' } }));
  fs.writeFileSync(path.join(dir, `agent-${agent}.jsonl`), jsonl(entries));
  fs.writeFileSync(path.join(dir, `agent-${agent}.meta.json`), JSON.stringify({ agentType: type, description }));
}
