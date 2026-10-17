import fs from 'node:fs';
import path from 'node:path';

// --- Stage 6 §5.4: STATE.md within lean.state_budget_kb (lib/state-sync.mjs applies it) ---
// Sections are h2/h3 headings outside code fences, each up to the next h2 or h3 (an h2's nested h3s are sections of
// their own). Protected (never trimmed): GSD's template sections that carry the position and the decisions; history:
// GSD's log sections and any heading that says history, archive or changelog (EN/RU). Protected names win.
// A heading that starts with a protected name (`## Current Position — history`, `### Decisions (archived …)`) or speaks
// of decisions anywhere (`## Журнал решений`) is protected.
const PROTECTED_RE = /^(?:project reference|current position|decisions?(?: made)?|accumulated context|pending todos|blockers?(?:\/concerns| & concerns)?|session continuity|deferred items)(?![\p{L}\p{N}])/iu;
const DECISION_RE = /\bdecisions?\b|(?<!\p{L})решени/iu;
const HISTORY_RE = /^(?:performance metrics|recently completed|quick tasks completed|session (?:log|history)|previous sessions?)$/i;
const HISTORY_WORD_RE = /\b(?:history|archived?|changelog)\b/i;
const HISTORY_RU_RE = /(?<!\p{L})(?:истори|архив|журнал)/iu;
const POINTER_RE = /^_Older entries moved to STATE-ARCHIVE\.md by turbo state-sync \(\d{4}-\d{2}-\d{2}\)\._$/;
const pointerLine = (date) => `_Older entries moved to STATE-ARCHIVE.md by turbo state-sync (${date})._`;
// GSD's own prune file header (bin/lib/state.cjs cmdStatePrune)
const ARCHIVE_HEAD = '# STATE Archive\n\nPruned entries from STATE.md. Recoverable but no longer loaded into agent context.\n\n';
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const bytesOf = (s) => Buffer.byteLength(s, 'utf8');

function stateSections(lines) {
  const out = [];
  let fenced = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    const m = !fenced && /^(#{2,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(l);
    if (!m) return;
    const name = m[2].trim();
    const bare = name.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    const kind = PROTECTED_RE.test(bare) || DECISION_RE.test(bare) ? 'protected' : HISTORY_RE.test(bare) || HISTORY_WORD_RE.test(bare) || HISTORY_RU_RE.test(bare) ? 'history' : 'other';
    out.push({ start: i, end: lines.length, name, kind });
  });
  for (let k = 0; k + 1 < out.length; k++) out[k].end = out[k + 1].start;
  return out;
}

// A history section's trimmable lines (indices): the data rows of its markdown tables when it has one (headers stay),
// else every non-blank body line but a pointer line; with the table headers the archive keeps for each table.
function trimmable(lines, s) {
  const rows = [];
  const heads = [];
  let i = s.start + 1;
  while (i < s.end) {
    if (!lines[i].trim().startsWith('|')) {
      i++;
      continue;
    }
    const from = i;
    while (i < s.end && lines[i].trim().startsWith('|')) i++;
    const sep = lines.slice(from, i).findIndex((l) => TABLE_SEP_RE.test(l));
    if (sep < 0) continue;
    heads.push(...Array.from({ length: sep + 1 }, (_, k) => from + k));
    for (let k = from + sep + 1; k < i; k++) rows.push(k);
  }
  if (heads.length) return { idx: rows, heads };
  const idx = [];
  for (let k = s.start + 1; k < s.end; k++) if (lines[k].trim() && !POINTER_RE.test(lines[k].trim())) idx.push(k);
  return { idx, heads: [] };
}

// Trims history sections, largest first, until STATE.md is within budgetKb; each trimmed heading gets one pointer line
// (dated). Pure: archiveText is STATE-ARCHIVE.md now ('' when new) and archive what it becomes. Byte counts.
// -> { text, archive, moved: [heading], before, after, over }
export function trimStateHistory(text, { budgetKb, date, archiveText = '' }) {
  const budget = budgetKb * 1024;
  const before = bytesOf(text);
  if (before <= budget) return { text, archive: archiveText, moved: [], before, after: before, over: false };
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const sections = stateSections(lines);
  const candidates = sections
    .filter((s) => s.kind === 'history')
    .map((s) => ({ ...s, ...trimmable(lines, s) }))
    .filter((s) => s.idx.length)
    .map((s) => ({ ...s, bytes: s.idx.reduce((n, k) => n + bytesOf(lines[k]) + eol.length, 0) }))
    .sort((a, b) => b.bytes - a.bytes || a.start - b.start);
  const render = (chosen) => {
    const by = new Map(chosen.map((s) => [s.start, s]));
    const out = [];
    for (let i = 0; i < lines.length;) {
      const s = by.get(i);
      if (!s) {
        out.push(lines[i]);
        i++;
        continue;
      }
      const drop = new Set(s.idx);
      const keep = lines.slice(s.start + 1, s.end).filter((l, k) => !drop.has(s.start + 1 + k) && !POINTER_RE.test(l.trim()));
      while (keep.length && !keep[0].trim()) keep.shift();
      out.push(lines[s.start], '', pointerLine(date), ...(keep.length ? ['', ...keep] : ['']));
      i = s.end;
    }
    return out.join(eol);
  };
  const chosen = [];
  let next = text;
  for (const s of candidates) {
    chosen.push(s);
    next = render(chosen);
    if (bytesOf(next) <= budget) break;
  }
  if (!chosen.length) return { text, archive: archiveText, moved: [], before, after: before, over: true };
  const block = chosen.map((s) => `### ${s.name}\n\n${[...s.heads, ...s.idx].sort((a, b) => a - b).map((k) => lines[k]).join('\n')}\n\n`).join('');
  const archive = `${archiveText || ARCHIVE_HEAD}## Trimmed ${date} by turbo state-sync (STATE.md budget ${budgetKb} KB)\n\n${block}`;
  const after = bytesOf(next);
  return { text: next, archive, moved: chosen.map((s) => s.name), before, after, over: after > budget };
}

const STATE_REL = '.planning/STATE.md';
const ARCHIVE_REL = '.planning/STATE-ARCHIVE.md';
const pad2 = (n) => String(n).padStart(2, '0');

// The budget's steps for one state-sync: trim() writes STATE.md and its archive in place and names the archive for the
// commit; putBack() returns the archive's bytes (the caller puts STATE.md back); alone(gsd) trims and commits by itself.
export function stateBudget(root, budgetKb, now) {
  const stateFile = path.join(root, '.planning', 'STATE.md');
  const archiveFile = path.join(root, '.planning', 'STATE-ARCHIVE.md');
  // the local date, as GSD's own prune dates its blocks
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f) : null);
  let saved = null;
  const b = {
    result: null,
    trim() {
      saved = { state: read(stateFile), archive: read(archiveFile), wrote: false };
      if (!saved.state) return [];
      const t = trimStateHistory(saved.state.toString('utf8'), { budgetKb, date, archiveText: saved.archive ? saved.archive.toString('utf8') : '' });
      b.result = { moved: t.moved, before: t.before, after: t.after, over: t.over };
      if (!t.moved.length) return [];
      saved.wrote = true;
      fs.writeFileSync(stateFile, t.text);
      fs.writeFileSync(archiveFile, t.archive);
      return [ARCHIVE_REL];
    },
    putBack({ state = false } = {}) {
      if (!saved?.wrote) return;
      if (state) fs.writeFileSync(stateFile, saved.state);
      if (saved.archive) fs.writeFileSync(archiveFile, saved.archive);
      else fs.rmSync(archiveFile, { force: true });
    },
    alone(gsd) {
      if (!b.trim().length) return b.result;
      try {
        const c = gsd(['commit', `docs(state): keep STATE.md within its ${budgetKb} KB budget`, '--files', STATE_REL, ARCHIVE_REL]);
        if (!c || typeof c !== 'object' || c.error || (!c.committed && !c.skipped && c.reason !== 'nothing_to_commit')) throw new Error(`gsd-tools commit: ${c?.error || c?.reason || 'not committed'}`);
      } catch (err) {
        b.putBack({ state: true });
        throw new Error(`${String(err?.message ?? err).split(/\r?\n/)[0]}; STATE.md was put back as it was`);
      }
      return b.result;
    },
  };
  return b;
}
