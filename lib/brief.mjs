// turbo-run brief: one page for the session that resumes work — where the milestone and turbo stand, what waits
// for an answer, the standing notes, the last lines of the log, and what to do next. Everything comes from records
// turbo and GSD already keep, so it is current at every call and nobody maintains it: a resume file that grows with
// each session's history is not needed to find the way back in.

const comparePhase = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
const NOTES_SHOWN = 3;
const one = (s, max = 240) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// ['24', '25', '26', '28'] -> '24–26, 28' (whole numbers that follow each other are one span).
export function spans(numbers) {
  const sorted = [...numbers].map(String).sort(comparePhase);
  const out = [];
  let start = null;
  let prev = null;
  const flush = () => {
    if (start !== null) out.push(start === prev ? start : `${start}–${prev}`);
  };
  for (const n of sorted) {
    const follows = prev !== null && /^\d+$/.test(n) && /^\d+$/.test(prev) && Number(n) === Number(prev) + 1;
    if (!follows) {
      flush();
      start = n;
    }
    prev = n;
  }
  flush();
  return out.join(', ');
}

// What to do next, most pressing first. -> [string]
export function nextSteps({ supervisor, phases = [], lanes = [], questions = [] }) {
  const out = [];
  if (questions.length) out.push(`${questions.length} question(s) wait for an answer: judge each from the logs, then /turbo-autonomous answer (turbo-run questions --json has the details)`);
  for (const l of lanes.filter((x) => x.status === 'needs-owner')) out.push(`phase ${l.phase} waits for the owner: ${one(l.reason || 'no reason recorded', 200)}`);
  for (const l of lanes.filter((x) => x.status === 'failed')) out.push(`phase ${l.phase} failed: ${one(l.reason || 'no reason recorded', 200)} (turbo-run resume ${l.phase} after the cause is removed)`);
  const open = phases.filter((p) => !p.complete && !p.closed);
  const isOpen = new Set(open.map((p) => String(p.number)));
  // merged into the main branch, the close (phase.complete) still owed: the lane record stays `ready` meanwhile, so
  // the merge record decides (merged, closed, mergeNote: what the merge step said last)
  for (const l of lanes.filter((x) => x.merged && !x.closed && isOpen.has(String(x.phase)))) {
    out.push(`phase ${l.phase} is merged into the main branch and not closed yet (GSD's phase.complete is still owed)${l.mergeNote ? `: ${one(l.mergeNote, 300)}` : ''}`);
  }
  // built and verified in its lane; the supervisor merges it into the main branch and closes it
  const ready = lanes.filter((x) => x.status === 'ready' && !x.merged && isOpen.has(String(x.phase)));
  for (const l of ready) out.push(`phase ${l.phase} is built and waits for its merge and close: ${supervisor.running ? 'the supervisor does both at its next check' : 'the supervisor does both once it runs (/turbo-autonomous); before that, do what the phase still owes outside its lane (a live step, an owner sign-off)'}`);
  if (!open.length && phases.length) out.push('every phase of the milestone is complete: /gsd-complete-milestone');
  else if (supervisor.damaged) out.push('the supervisor state is damaged: turbo-run start keeps the file aside and rebuilds the lanes');
  else if (!supervisor.running && !out.length && open.length) out.push(`nothing runs: /turbo-autonomous starts the next phase (${open[0].number}${open[0].name ? ` ${open[0].name}` : ''})`);
  else if (supervisor.running && !out.length) out.push('the supervisor runs: nothing to do until it asks (turbo-run status --watch shows it)');
  return out;
}

// v0.10.0: what a session start adds to the model's context (turbo-run brief --session-start): a header that frames
// the page as information, then the page, cut at a line to max bytes.
export const SESSION_START_MAX = 8192;
export const SESSION_START_HEAD = 'gsd-turbo shows this page at each session start: the state of this project\'s turbo run, information, not a request. To turn it off: "brief": { "session_start": false } in .planning/turbo/config.json.';
export function capPage(text, max = SESSION_START_MAX) {
  const s = String(text);
  if (Buffer.byteLength(s) <= max) return s;
  const tail = `… (cut at ${Math.round(max / 1024)} KB: turbo-run brief prints the whole page)\n`;
  const lines = s.split('\n');
  let out = '';
  for (const line of lines) {
    const next = `${out}${line}\n`;
    if (Buffer.byteLength(next) + Buffer.byteLength(tail) > max) break;
    out = next;
  }
  return out + tail;
}

// data: what turbo-run brief gathers (bin/turbo-run.mjs). allNotes: every standing note, not the newest of each
// phase. -> the page, markdown.
export function briefText(data, { allNotes = false } = {}) {
  const { project, at, turbo, gsd, milestone, phases = [], status = [], lanes = [], questions = [], notes = [], kept = [], reports = null, ownerRequests = [], log = [], phasesError = null } = data;
  const closed = phases.filter((p) => p.complete || p.closed);
  const open = phases.filter((p) => !p.complete && !p.closed);
  const lines = [
    `# turbo brief: ${project} (${String(at).slice(0, 16).replace('T', ' ')} UTC)`, '',
    `gsd-turbo ${turbo} · GSD core ${gsd}`, '',
    `## Milestone${milestone ? ` ${milestone}` : ''}`, '',
  ];
  if (phasesError) lines.push(`- GSD did not list the phases: ${one(phasesError)}`);
  else {
    lines.push(`- ${closed.length} of ${phases.length} phases closed${closed.length ? `: ${spans(closed.map((p) => p.number))}` : ''}`);
    for (const p of open.slice(0, 8)) lines.push(`- open: ${p.number}${p.name ? ` ${p.name}` : ''}${p.diskStatus ? ` · ${p.diskStatus}` : ''}${p.verification ? ` · verification ${p.verification}` : ''}${p.deps?.length ? ` · after ${p.deps.join(', ')}` : ''}`);
    if (open.length > 8) lines.push(`- and ${open.length - 8} more open phases`);
  }
  // v0.9.2: an owner request file of a closed phase is history (obs-chat 2026-11-19: p33-owner.md weeks after the
  // close), in the brief's own list and in the status lines it quotes alike
  const closedIds = new Set(closed.map((p) => String(p.number)));
  const stale = (f) => closedIds.has(/(?:^|[\\/])p(.+)-owner\.md$/.exec(String(f))?.[1] ?? '\0');
  const shownStatus = status.filter((l) => !(l.startsWith('owner request: ') && stale(l.slice('owner request: '.length))));
  lines.push('', '## Turbo now', '', ...(shownStatus.length ? shownStatus.map((l) => (l.startsWith('  ') ? `  ${l}` : `- ${one(l, 400)}`)) : ['- no status']));
  if (reports) lines.push(`- ${one(reports)}`);
  if (questions.length) {
    lines.push('', `## Waiting for an answer (${questions.length})`, '');
    for (const q of questions) lines.push(`- ${q.id} · phase ${q.phase}: ${one(q.question)}`);
  }
  const openRequests = ownerRequests.filter((f) => !stale(f));
  if (openRequests.length) lines.push('', '## Owner request files', '', ...openRequests.map((f) => `- ${f}`));
  if (notes.length) {
    // the newest NOTES_SHOWN of each phase: the page stays a page
    lines.push('', '## Standing notes of the open phases (every role of the phase reads them)', '');
    for (const phase of [...new Set(notes.map((n) => String(n.phase)))].sort(comparePhase)) {
      const own = notes.filter((n) => String(n.phase) === phase);
      const shown = allNotes ? own : own.slice(-NOTES_SHOWN);
      if (own.length > shown.length) lines.push(`- phase ${phase}: ${own.length - shown.length} earlier note(s) not shown (turbo-run brief --all-notes shows them)`);
      for (const n of shown) lines.push(`- phase ${phase}, ${n.by === 'turbo' ? 'turbo' : 'owner'}${n.at ? `, ${String(n.at).slice(0, 16).replace('T', ' ')} UTC` : ''}: ${one(n.text, 300)}`);
    }
  }
  if (kept.length) {
    lines.push('', '## Requirement rows kept open at a phase close', '');
    for (const k of kept) lines.push(`- phase ${k.phase}: ${k.rows.map((r) => `${r.id} «${one(r.status, 120)}»`).join('; ')}`);
  }
  if (log.length) lines.push('', '## Last lines of the supervisor log', '', ...log.map((l) => `    ${one(l, 220)}`));
  const next = nextSteps({ supervisor: data.supervisor ?? { running: false }, phases, lanes, questions });
  lines.push('', '## Next', '', ...(next.length ? next.map((n) => `- ${n}`) : ['- nothing waits']));
  return `${lines.join('\n')}\n`;
}
