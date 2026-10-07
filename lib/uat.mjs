import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { classifyItem, finalClass, rowFloor, splitItem, itemText, CLASSES, LIVE_PART_RE } from './uat-classify.mjs';
import { phaseArtifacts } from './phase-files.mjs';
import { runDir } from './paths.mjs';

const HEADING_RE = /^###\s*(\d+)\.\s*(.+)$/;
const FIELD_RE = /^([a-z_]+):[ \t]*(.*)$/;
const SEVERITIES = ['blocker', 'major', 'minor', 'cosmetic'];
const RECORD_KEYS = new Set(['result', 'reason', 'reported', 'severity', 'source', 'class', 'checks', 'harness', 'head', 'evidence', 'blocked_by']);
const RESULT_CLASS = { pass: ['A', 'B'], issue: ['A', 'B'], deferred: ['C'], owner: ['D'] };
// marks the rows and the Gaps / Deferred Follow-Ups entries turbo wrote
const OWN = 'source: turbo-uat';
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const HEX_HEAD = /^[0-9a-f]{7,64}$/;
// control characters plus U+2028/U+2029, which GSD's heading scan treats as line breaks (built, not written, so
// no tool turns the escapes into the raw separators)
const CONTROL_RE = new RegExp(`[\x00-\x1f\x7f${String.fromCharCode(0x2028, 0x2029)}]`);
export const DEFERRED_PREFIX = 'Deferred follow-up: ';
// the deferral GSD's UAT predicate accepts on a skipped row's first reason line (uat-predicate.cjs, G12)
const DEFERRED_REASON_RE = /^["']?deferred follow-up\b/i;
const EVIDENCE_DIR = '.planning/turbo/run/evidence';

const one = (s) => String(s ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
const quote = (s) => `"${one(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function fieldText(lines, t, key) {
  if (!Object.hasOwn(t.fields, key)) return '';
  const v = t.fields[key].trim();
  if (!/^[|>]-?$/.test(v)) return v;
  const out = [];
  for (let i = t.fieldLine[key] + 1; i < t.end && /^\s+\S/.test(lines[i]); i++) out.push(lines[i].trim());
  return out.join(' ');
}

export function parseUat(text) {
  const lines = String(text).split(/\r?\n/);
  const tests = [];
  let section = '';
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^## /.test(line)) {
      section = line.slice(3).trim();
      cur = null;
      continue;
    }
    if (section !== 'Tests') continue;
    const h = HEADING_RE.exec(line);
    if (h) {
      // trimmed: LIVE_PART_RE is anchored at the end of the name
      cur = { number: Number(h[1]), name: h[2].trim(), start: i, end: i + 1, fields: {}, fieldLine: {} };
      tests.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.end = i + 1;
    const f = FIELD_RE.exec(line);
    if (f && !Object.hasOwn(cur.fields, f[1])) {
      cur.fields[f[1]] = f[2];
      cur.fieldLine[f[1]] = i;
    }
  }
  for (const t of tests) {
    const m = /^\[?([\w-]+)\]?/.exec(t.fields.result || '');
    t.result = m ? m[1].toLowerCase() : 'missing';
    t.expected = fieldText(lines, t, 'expected');
  }
  return { lines, tests };
}

function recordLines(r, head) {
  const out = [];
  if (r.result === 'pass') out.push('result: pass');
  else if (r.result === 'issue') out.push('result: issue', `reported: ${quote(r.reported)}`, `severity: ${SEVERITIES.includes(r.severity) ? r.severity : 'major'}`);
  else if (r.result === 'deferred') out.push('result: skipped', `reason: ${quote(DEFERRED_PREFIX + one(r.reason))}`);
  else out.push('result: [pending]');
  out.push(OWN, `class: ${r.class}`);
  if (Array.isArray(r.checks) && r.checks.length) out.push(`checks: ${r.checks.map(one).join('; ')}`);
  if (r.harness) out.push(`harness: ${one(r.harness)}`);
  out.push(`head: ${head}`);
  if (Array.isArray(r.evidence) && r.evidence.length) {
    out.push('evidence:');
    for (const e of r.evidence) out.push(`  - ${e.file} sha256:${e.sha256}`);
  }
  return out;
}

// The block's own lines without earlier record fields (and their indented continuations).
function keptLines(block) {
  const kept = [];
  let dropping = false;
  for (const line of block) {
    const k = FIELD_RE.exec(line)?.[1];
    if (k) dropping = RECORD_KEYS.has(k);
    else if (line.trim() && !/^\s/.test(line)) dropping = false;
    if (!dropping) kept.push(line);
  }
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  return kept;
}

function insertSectionEnd(lines, title, add) {
  const start = lines.findIndex((l) => l.trim() === `## ${title}`);
  if (start < 0) {
    const out = [...lines];
    while (out.length && !out.at(-1).trim()) out.pop();
    return [...out, '', `## ${title}`, '', ...add, ''];
  }
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  let at = end;
  while (at > start + 1 && !lines[at - 1].trim()) at--;
  return [...lines.slice(0, at), '', ...add, '', ...lines.slice(end)];
}

// The entries of a `## <title>` list: a column-0 "- " line and the indented lines after it.
function listEntries(lines, title) {
  const start = lines.findIndex((l) => l.trim() === `## ${title}`);
  const entries = [];
  if (start < 0) return entries;
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    if (/^- /.test(lines[i])) entries.push({ from: i, to: i + 1 });
    else if (entries.at(-1)?.to === i && /^\s+\S/.test(lines[i])) entries.at(-1).to = i + 1;
  }
  return entries.map((e) => ({ ...e, body: lines.slice(e.from, e.to) }));
}

const entryField = (body, key) => {
  const re = new RegExp(`^(?:- | {2})${key}:[ \\t]*(.*)$`);
  for (const l of body) {
    const m = re.exec(l);
    if (m) return m[1].trim().replace(/^["'[]+|["'\]]+$/g, '');
  }
  return null;
};

// ops: key -> {write: lines} (turbo's entry for that key) or {resolve: (body) => lines} (what becomes of turbo's
// own entry when the test no longer needs one). Entries turbo did not write are never changed; writing next to one
// with the same key is refused.
function rewriteEntries(lines, title, keyOf, ops) {
  const out = [...lines];
  const done = new Set();
  for (const e of listEntries(lines, title).reverse()) {
    const key = keyOf(e.body);
    const op = ops.get(key);
    if (!op) continue;
    if (!e.body.some((l) => l.trim() === OWN)) {
      if (op.write) throw new Error(`## ${title} already has an entry ${key} that turbo-uat did not write; left alone`);
      continue;
    }
    // from the end: a later duplicate of turbo's entry is dropped, the first one is rewritten
    const repl = done.has(key) ? [] : (op.write || op.resolve(e.body));
    done.add(key);
    out.splice(e.from, e.to - e.from, ...repl);
    if (!repl.length && !out[e.from]?.trim() && !out[e.from - 1]?.trim()) out.splice(e.from, 1);
  }
  const add = [...ops].filter(([k, op]) => op.write && !done.has(k)).flatMap(([, op]) => op.write);
  return add.length ? insertSectionEnd(out, title, add) : out;
}

const countsOf = (text) => {
  const { tests } = parseUat(text);
  const n = (rs) => tests.filter((t) => rs.includes(t.result)).length;
  return { total: tests.length, passed: n(['pass', 'passed']), issues: n(['issue']), pending: n(['pending']), skipped: n(['skipped']), blocked: n(['blocked']) };
};

function recount(lines) {
  const counts = countsOf(lines.join('\n'));
  const start = lines.findIndex((l) => l.trim() === '## Summary');
  if (start < 0) return insertSectionEnd(lines, 'Summary', Object.entries(counts).map(([k, v]) => `${k}: ${v}`));
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return lines.map((l, i) => {
    const m = i > start && i < end ? /^(total|passed|issues|pending|skipped|blocked):/.exec(l) : null;
    return m ? `${m[1]}: ${counts[m[1]]}` : l;
  });
}

function touchUpdated(lines, now) {
  if (lines[0] !== '---') return lines;
  const end = lines.indexOf('---', 1);
  return lines.map((l, i) => (i > 0 && i < end && /^updated:/.test(l) ? `updated: ${now.toISOString()}` : l));
}

const gapLines = (phase, number, expected, r) => [
  `- gap_id: G-${phase}-${number}`,
  `  truth: ${quote(expected)}`,
  '  status: failed',
  `  reason: ${quote(`turbo-uat reported: ${one(r.reported)}`)}`,
  `  severity: ${SEVERITIES.includes(r.severity) ? r.severity : 'major'}`,
  `  test: ${number}`,
  '  artifacts: []',
  '  missing: []',
  `  ${OWN}`,
];

// turbo's own gap after the test is no longer an issue (GSD lists every entry that is not resolved as open)
const resolvedGap = (body, head) => [
  ...body.filter((l) => !/^ {2}(resolved_by|resolved_at):/.test(l)).map((l) => (/^ {2}status:/.test(l) ? '  status: resolved' : l)),
  '  resolved_by: turbo-uat',
  `  resolved_at: ${head}`,
];

function checkEvidence(r) {
  for (const e of Array.isArray(r.evidence) ? r.evidence : []) {
    if (typeof e?.file !== 'string' || !e.file.trim() || CONTROL_RE.test(e.file)) {
      throw new Error(`test ${r.test}: an evidence file name must be non-empty and free of control characters`);
    }
    if (!HEX_SHA256.test(String(e.sha256))) throw new Error(`test ${r.test}: evidence sha256 must be 64 lower-case hex characters`);
  }
}

export function applyUatResults(text, results, { head, phase, now = new Date(), autonomy = 'standard' }) {
  if (!HEX_HEAD.test(String(head ?? ''))) throw new Error('head must be a hex commit id');
  const eol = String(text).includes('\r\n') ? '\r\n' : '\n';
  const { lines, tests } = parseUat(text);
  const byNum = new Map(tests.map((t) => [t.number, t]));
  const liveOf = new Map();
  for (const t of tests) {
    const m = LIVE_PART_RE.exec(t.name);
    if (m) liveOf.set(Number(m[1]), t);
  }
  let next = tests.reduce((m, t) => Math.max(m, t.number), 0) + 1;
  const replaced = new Map();
  const added = [];
  const gapOps = new Map();
  const deferOps = new Map();
  const seen = new Set();
  const liveHalves = new Map();
  for (const r of results) {
    const src = byNum.get(Number(r.test));
    if (!src) throw new Error(`no test ${r.test} in the UAT file`);
    if (!CLASSES.includes(r.class)) throw new Error(`test ${r.test}: class must be one of ${CLASSES.join(', ')}`);
    if (!Object.hasOwn(RESULT_CLASS, r.result)) throw new Error(`test ${r.test}: result must be pass, issue, deferred or owner`);
    // GSD's predicate passes any "Deferred follow-up" reason, an empty one too
    if (r.result === 'deferred' && !one(r.reason)) throw new Error(`test ${r.test}: a deferred result needs a reason`);
    if (r.result === 'issue' && !one(r.reported)) throw new Error(`test ${r.test}: an issue result needs what was reported`);
    checkEvidence(r);
    let det;
    let parts = null;
    let part = null;
    if (r.split) {
      // a live part the recorder appended is classified whole and never split again (as uatPlan does)
      const live = LIVE_PART_RE.exec(src.name);
      if (live) throw new Error(`test ${src.number} is the live part of test ${live[1]} and is never split again`);
      // the floor of a split part comes from turbo's own split of the test, never from the agent's text
      parts = splitItem(itemText(src), { autonomy });
      part = parts.find((p) => p.part === r.split && one(p.text) === one(r.expected));
      if (!part) throw new Error(`test ${r.test}: the ${r.split} part does not match the deterministic split of the test`);
      det = part.class;
    } else {
      det = classifyItem(itemText(src), { autonomy }).class;
    }
    const target = r.split === 'live' ? liveOf.get(src.number) : src;
    // a class turbo-uat recorded on the row raises its floor: a later run never lowers what an agent raised (C1)
    const floor = target ? rowFloor(det, target) : det;
    if (finalClass(floor, r.class) !== r.class) {
      throw new Error(`test ${r.test}: class ${r.class} is below ${floor === det ? `the deterministic class ${det}` : `the class ${floor} turbo-uat recorded for this test`}`);
    }
    if (!RESULT_CLASS[r.result].includes(r.class)) throw new Error(`test ${r.test}: a ${r.result} result cannot have class ${r.class}`);
    // the recorded text of a split part is turbo's own part, never the agent's copy of it
    const expected = part ? one(part.text) : src.expected;
    if (r.split === 'hermetic' && !liveHalves.has(src.number)) liveHalves.set(src.number, { src, live: parts.find((p) => p.part === 'live') });
    if (r.split === 'live') liveHalves.set(src.number, null);
    if (target && target.result !== 'pending' && target.fields.source !== 'turbo-uat') {
      throw new Error(`test ${target.number} already has a result that turbo-uat did not write (${target.result}); left alone`);
    }
    let number;
    if (r.split === 'live' && !target) {
      if (seen.has(`live:${src.number}`)) throw new Error(`test ${src.number} has two results for its live part`);
      seen.add(`live:${src.number}`);
      number = next++;
      added.push(`### ${number}. ${one(src.name)} (live part, split from test ${src.number})`, `expected: ${expected}`, ...recordLines(r, head), '');
    } else {
      number = target.number;
      if (seen.has(number)) throw new Error(`test ${number} has two results`);
      seen.add(number);
      const body = [lines[target.start], ...keptLines(lines.slice(target.start + 1, target.end)), ...recordLines(r, head), ''];
      replaced.set(target.start, { end: target.end, body });
    }
    // one Gaps / Deferred Follow-Ups entry per test; a re-record rewrites turbo's own entry
    gapOps.set(`G-${phase}-${number}`, r.result === 'issue' ? { write: gapLines(phase, number, expected, r) } : { resolve: (b) => resolvedGap(b, head) });
    deferOps.set(String(number), r.result === 'deferred'
      ? { write: [`- test: ${number}`, `  idea: ${quote(r.reason)}`, `  deferred_at: ${now.toISOString().slice(0, 10)}`, `  ${OWN}`] }
      : { resolve: () => [] });
  }
  // a hermetic result never closes a split test alone: without a live result or an earlier live row, the live half
  // is appended as a pending row with turbo's own text and class
  for (const [n, half] of liveHalves) {
    if (!half || liveOf.has(n)) continue;
    const number = next++;
    added.push(`### ${number}. ${one(half.src.name)} (live part, split from test ${n})`, `expected: ${one(half.live.text)}`,
      ...recordLines({ result: 'pending', class: half.live.class }, head), '');
  }
  let out = [];
  for (let i = 0; i < lines.length; i++) {
    const rep = replaced.get(i);
    if (rep) {
      out.push(...rep.body);
      i = rep.end - 1;
    } else {
      out.push(lines[i]);
    }
  }
  if (added.length) out = insertSectionEnd(out, 'Tests', added.slice(0, -1));
  out = rewriteEntries(out, 'Gaps', (b) => entryField(b, 'gap_id'), gapOps);
  out = rewriteEntries(out, 'Deferred Follow-Ups', (b) => entryField(b, 'test'), deferOps);
  return touchUpdated(recount(out), now).join(eol);
}

const isUp = (rel) => rel === '..' || rel.startsWith('../') || rel.startsWith('..\\');

// Each evidence file is read once; the manifest hashes and the scan reads the same bytes.
function readEvidence(root, files) {
  if (!files.length) return [];
  const realRoot = fs.realpathSync(root);
  let dir = null;
  try {
    dir = fs.realpathSync(path.join(realRoot, ...EVIDENCE_DIR.split('/')));
  } catch {
    // no evidence directory: nothing is inside it
  }
  return files.map((f) => {
    const refuse = () => new Error(`evidence must be an existing file inside ${EVIDENCE_DIR}/: ${typeof f === 'string' && !CONTROL_RE.test(f) ? f : '(invalid name)'}`);
    if (typeof f !== 'string' || !f.trim() || CONTROL_RE.test(f) || !dir) throw refuse();
    let real;
    try {
      real = fs.realpathSync(path.resolve(realRoot, f));
    } catch {
      throw refuse();
    }
    const inDir = path.relative(dir, real);
    if (!inDir || isUp(inDir) || path.isAbsolute(inDir) || !fs.statSync(real).isFile()) throw refuse();
    const buf = fs.readFileSync(real);
    return { file: path.relative(realRoot, real).split(path.sep).join('/'), sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length, buf };
  });
}

export function evidenceManifest(root, files) {
  return readEvidence(root, files).map(({ buf, ...m }) => m);
}

const SECRET_RULES = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['aws access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['api key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['bearer token', /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/i],
  ['credential assignment', /\b(pass(word|wd)?|secret|token|api[_-]?key)\b\s*[:=]\s*["']?[^\s"'<>]{6,}/i],
];

// a known value as written raw, URL-encoded, JSON-escaped and base64-encoded
function knownForms(known) {
  const forms = new Set();
  for (const v of known.map(String)) {
    if (v.length < 6) throw new Error('a known credential is shorter than 6 characters; the scan cannot match it safely');
    forms.add(v);
    forms.add(encodeURIComponent(v));
    forms.add(JSON.stringify(v).slice(1, -1));
    forms.add(Buffer.from(v, 'utf8').toString('base64').replace(/=+$/, ''));
  }
  return [...forms];
}

export function scanSecrets(text, { known = [] } = {}) {
  const values = knownForms(known);
  const findings = [];
  String(text ?? '').split(/\r?\n/).forEach((line, i) => {
    for (const [rule, re] of SECRET_RULES) if (re.test(line)) findings.push({ rule, line: i + 1 });
    if (values.some((v) => line.includes(v))) findings.push({ rule: 'one-time credential', line: i + 1 });
  });
  return findings;
}

// binary evidence is hashed, never scanned; everything else is read as text
const BINARY_EVIDENCE = /\.(png|jpe?g|gif|webp|webm|mp4|zip)$/i;

const scanRead = (items, opts) => items.filter((e) => !BINARY_EVIDENCE.test(e.file))
  .flatMap((e) => scanSecrets(e.buf.toString('utf8'), opts).map((x) => ({ file: e.file, ...x })));

export function scanEvidence(root, files, opts = {}) {
  return scanRead(readEvidence(root, files), opts);
}

function writeTextAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function recordUat({ root, phaseDir, phase, results, head, known = [], autonomy = 'standard', now = new Date() }) {
  const name = phaseArtifacts(phaseDir).uat;
  if (!name) throw new Error(`no UAT file in ${phaseDir}`);
  const file = path.join(phaseDir, name);
  const rel = path.relative(root, file).split(path.sep).join('/');
  const before = fs.readFileSync(file, 'utf8');
  const read = results.map((r) => readEvidence(root, Array.isArray(r.evidence) ? r.evidence : []));
  const withManifest = results.map((r, i) => ({ ...r, evidence: read[i].map(({ buf, ...m }) => m) }));
  const text = applyUatResults(before, withManifest, { head, phase, now, autonomy });
  // findings that were already in the file are the owner's business, not this record's
  const oldLines = before.split(/\r?\n/);
  const preexisting = new Set(scanSecrets(before, { known }).map((f) => oldLines[f.line - 1]));
  const newLines = text.split(/\r?\n/);
  const findings = [
    ...scanRead(read.flat(), { known }).map((f) => `${f.file}:${f.line} ${f.rule}`),
    // the new text is not on disk, so its line numbers are labelled as such
    ...scanSecrets(text, { known }).filter((f) => !preexisting.has(newLines[f.line - 1])).map((f) => `${rel} new record line ${f.line} ${f.rule}`),
  ];
  if (findings.length) throw new Error(`secret-scan refused the record: ${findings.join(', ')}`);
  writeTextAtomic(file, text);
  return { file: rel, counts: countsOf(text) };
}

const OWNER_TEXT = {
  en: {
    title: 'Phase {phase}: turbo-uat results',
    passed: 'Passed',
    failed: 'Failed (the lane closes these through GSD gap closure)',
    checklist: 'Your checklist (live checks; they do not block the phase):',
    signoff: 'Needs your signature or decision (the phase waits):',
    how: 'Close these items with /gsd-verify-work {phase}, then run /turbo-autonomous resume {phase}.',
    none: 'Nothing is left for you.',
    reason: '{n} item(s) need your sign-off; see {file}',
  },
  ru: {
    title: 'Фаза {phase}: итоги turbo-uat',
    passed: 'Прошло',
    failed: 'Упало (полоса закроет это через gap closure GSD)',
    checklist: 'Твой чек-лист (живые проверки, фазу не блокируют):',
    signoff: 'Нужна твоя подпись или решение (фаза ждёт):',
    how: 'Закрой эти пункты через /gsd-verify-work {phase}, затем запусти /turbo-autonomous resume {phase}.',
    none: 'Для тебя ничего не осталось.',
    reason: 'Пунктов на подпись: {n}; подробности в {file}',
  },
};

export function ownerRequest({ phase, tests, lang = 'en', file = '' }) {
  const t = Object.hasOwn(OWNER_TEXT, lang) ? OWNER_TEXT[lang] : OWNER_TEXT.en;
  const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));
  const mine = tests.filter((x) => x.fields.source === 'turbo-uat');
  const deferred = (x) => x.result === 'skipped' && DEFERRED_REASON_RE.test(String(x.fields.reason ?? '').trim());
  const passed = mine.filter((x) => x.result === 'pass');
  const failed = mine.filter((x) => x.result === 'issue');
  const checklist = mine.filter((x) => deferred(x) && x.fields.class === 'C');
  // GSD's UAT predicate closes a row only with pass or a deferred skip (G12), so the phase waits on every other row
  // that is not an issue (issues go through gap closure), whoever wrote it: turbo's D items, a live half the
  // recorder appended as pending, and rows turbo never recorded (the stand failed, the agent stopped or skipped one)
  const signoff = tests.filter((x) => !['pass', 'passed', 'issue'].includes(x.result) && !deferred(x));
  const line = (x) => `${x.number}. ${x.name}${x.expected ? ` — ${x.expected}` : ''}`;
  const out = [`# ${fill(t.title, { phase })}`, '', `${t.passed}: ${passed.length}`, ...passed.map((x) => `- ${line(x)}`), ''];
  if (failed.length) out.push(`${t.failed}: ${failed.length}`, ...failed.map((x) => `- ${line(x)}`), '');
  if (checklist.length) out.push(t.checklist, ...checklist.map((x) => `- [ ] ${line(x)}`), '');
  if (signoff.length) out.push(t.signoff, ...signoff.map((x) => `- ${line(x)}`), '', fill(t.how, { phase }), '');
  if (!checklist.length && !signoff.length) out.push(t.none, '');
  return {
    text: out.join('\n'),
    needsOwner: signoff.length > 0,
    reason: signoff.length ? fill(t.reason, { n: signoff.length, file }) : '',
    counts: { passed: passed.length, failed: failed.length, checklist: checklist.length, signoff: signoff.length },
  };
}

export function ownerRequestFiles(root) {
  let names = [];
  try {
    names = fs.readdirSync(runDir(root));
  } catch {
    return [];
  }
  return names.filter((n) => /^p.+-owner\.md$/.test(n)).sort().map((n) => `.planning/turbo/run/${n}`);
}
