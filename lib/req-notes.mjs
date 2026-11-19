import fs from 'node:fs';
import path from 'node:path';

// GSD 1.22 (#6293) advances a traceability row by the status word its Status cell starts with and replaces the whole
// cell: a note beside the word («Pending (waits for a live check)») is gone and the requirement reads Complete, with
// nothing in the command's output (GSD 1.16–1.21 left such a row alone). Turbo closes phases unattended, so around
// its own phase.complete it puts such a row and its checkbox back as written and names them: a requirement somebody
// marked as open stays open, in sight.

// The status words GSD advances, followed by more text: the note.
const NOTED = /^(?:pending|in\s+progress|gaps\s+found)(?![A-Za-z0-9])\s*\S/i;
const ID = /^[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const cellsOf = (body) => body.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isRow = (body) => /^\s*\|/.test(body);
const isRule = (body) => /^\s*\|?\s*:?-{2,}/.test(body);
const BOX = /^\s*[-*]\s+\[[ xX]\]\s+\*{0,2}([A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9][A-Za-z0-9._-]*?)\*{0,2}(?=[\s:]|$)/;

// Lines with their own line ends, the traceability rows by requirement id (lower case) and the checkbox lines.
function parse(text) {
  const lines = String(text).split(/(?<=\n)/).map((raw) => {
    const eol = /\r?\n$/.exec(raw)?.[0] ?? '';
    return { body: raw.slice(0, raw.length - eol.length), eol };
  });
  const rows = new Map();
  const boxes = new Map();
  let status = -1; // the Status column of the table being read; -1 outside a table or in one without it
  lines.forEach((line, index) => {
    const box = BOX.exec(line.body);
    if (box) boxes.set(box[1].toLowerCase(), { index, body: line.body });
    if (!isRow(line.body)) {
      status = -1;
      return;
    }
    if (isRule(line.body)) return;
    const cells = cellsOf(line.body);
    // a header is the row right above a rule line
    if (index + 1 < lines.length && isRule(lines[index + 1].body) && isRow(lines[index + 1].body)) {
      status = cells.findIndex((c) => c.toLowerCase() === 'status');
      return;
    }
    if (status < 0 || !ID.test(cells[0] ?? '') || cells[status] === undefined) return;
    rows.set(cells[0].toLowerCase(), { index, body: line.body, id: cells[0], status: cells[status] });
  });
  return { lines, rows, boxes };
}

// before, after: REQUIREMENTS.md around a phase.complete. -> { text, kept: [{ id, status }] }: after with every row
// whose Status carried a note and was changed put back as written, its checkbox line too.
export function restoreNotes(before, after) {
  const was = parse(before);
  const now = parse(after);
  const kept = [];
  for (const [key, row] of was.rows) {
    if (!NOTED.test(row.status)) continue;
    const cur = now.rows.get(key);
    if (!cur || cur.status === row.status) continue;
    now.lines[cur.index].body = row.body;
    const box = was.boxes.get(key);
    const curBox = now.boxes.get(key);
    if (box && curBox && box.body !== curBox.body) now.lines[curBox.index].body = box.body;
    kept.push({ id: row.id, status: row.status });
  }
  return { text: kept.length ? now.lines.map((l) => l.body + l.eol).join('') : String(after), kept };
}

// Runs the close (run: () => whatever phase.complete returns) and puts the noted rows back. -> { result, kept }.
// A close that throws is not caught: the caller's own undo sees the file as GSD left it.
export function keepRequirementNotes(root, run) {
  const file = path.join(root, '.planning', 'REQUIREMENTS.md');
  const read = () => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };
  const before = read();
  const result = run();
  const after = before === null ? null : read();
  if (after === null || after === before) return { result, kept: [] };
  const r = restoreNotes(before, after);
  if (r.kept.length) fs.writeFileSync(file, r.text);
  return { result, kept: r.kept };
}

export const keptLine = (kept) => `${kept.length} requirement row(s) kept as written (GSD would mark them Complete and drop the note): ${kept.map((k) => `${k.id} «${k.status}»`).join('; ')}`;
