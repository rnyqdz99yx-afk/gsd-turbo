import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { classifyItem, finalClass, splitItem, itemText, CLASSES, LIVE_PART_RE } from './uat-classify.mjs';
import { phaseArtifacts } from './phase-files.mjs';

const HEADING_RE = /^###\s*(\d+)\.\s*(.+)$/;
const FIELD_RE = /^([a-z_]+):[ \t]*(.*)$/;
const SEVERITIES = ['blocker', 'major', 'minor', 'cosmetic'];
const RECORD_KEYS = new Set(['result', 'reason', 'reported', 'severity', 'source', 'class', 'checks', 'harness', 'head', 'evidence', 'blocked_by']);
const RESULT_CLASS = { pass: ['A', 'B'], issue: ['A', 'B'], deferred: ['C'], owner: ['D'] };
export const DEFERRED_PREFIX = 'Deferred follow-up: ';

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
  out.push('source: turbo-uat', `class: ${r.class}`);
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
];

export function applyUatResults(text, results, { head, phase, now = new Date(), autonomy = 'standard' }) {
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
  const gaps = [];
  const deferred = [];
  const seen = new Set();
  for (const r of results) {
    const src = byNum.get(Number(r.test));
    if (!src) throw new Error(`no test ${r.test} in the UAT file`);
    if (!CLASSES.includes(r.class)) throw new Error(`test ${r.test}: class must be one of ${CLASSES.join(', ')}`);
    if (!Object.hasOwn(RESULT_CLASS, r.result)) throw new Error(`test ${r.test}: result must be pass, issue, deferred or owner`);
    let det;
    let part = null;
    if (r.split) {
      // a live part the recorder appended is classified whole and never split again (as uatPlan does)
      const live = LIVE_PART_RE.exec(src.name);
      if (live) throw new Error(`test ${src.number} is the live part of test ${live[1]} and is never split again`);
      // the floor of a split part comes from turbo's own split of the test, never from the agent's text
      part = splitItem(itemText(src), { autonomy }).find((p) => p.part === r.split && one(p.text) === one(r.expected));
      if (!part) throw new Error(`test ${r.test}: the ${r.split} part does not match the deterministic split of the test`);
      det = part.class;
    } else {
      det = classifyItem(itemText(src), { autonomy }).class;
    }
    if (finalClass(det, r.class) !== r.class) throw new Error(`test ${r.test}: class ${r.class} is below the deterministic class ${det}`);
    if (!RESULT_CLASS[r.result].includes(r.class)) throw new Error(`test ${r.test}: a ${r.result} result cannot have class ${r.class}`);
    // the recorded text of a split part is turbo's own part, never the agent's copy of it
    const expected = part ? one(part.text) : src.expected;
    const target = r.split === 'live' ? liveOf.get(src.number) : src;
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
    // one Gaps / Deferred Follow-Ups entry per test, also when a result is recorded again
    const has = (entry) => lines.some((l) => l.trim() === entry);
    if (r.result === 'issue' && !has(`- gap_id: G-${phase}-${number}`)) gaps.push(...gapLines(phase, number, expected, r));
    if (r.result === 'deferred' && !has(`- test: ${number}`)) deferred.push(`- test: ${number}`, `  idea: ${quote(r.reason)}`, `  deferred_at: ${now.toISOString().slice(0, 10)}`);
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
  if (gaps.length) out = insertSectionEnd(out, 'Gaps', gaps);
  if (deferred.length) out = insertSectionEnd(out, 'Deferred Follow-Ups', deferred);
  return touchUpdated(recount(out), now).join(eol);
}

export function evidenceManifest(root, files) {
  return files.map((f) => {
    const abs = path.resolve(root, f);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`evidence outside the project: ${f}`);
    const buf = fs.readFileSync(abs);
    return { file: rel, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
  });
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

export function scanSecrets(text, { known = [] } = {}) {
  const values = known.map(String).filter((v) => v.length >= 6);
  const findings = [];
  String(text ?? '').split(/\r?\n/).forEach((line, i) => {
    for (const [rule, re] of SECRET_RULES) if (re.test(line)) findings.push({ rule, line: i + 1 });
    if (values.some((v) => line.includes(v))) findings.push({ rule: 'one-time credential', line: i + 1 });
  });
  return findings;
}

const TEXT_EVIDENCE = /\.(txt|log|json|html?|md|har|csv|xml|ya?ml)$/i;

export function scanEvidence(root, files, opts = {}) {
  const out = [];
  for (const f of files) {
    if (!TEXT_EVIDENCE.test(f)) continue;
    for (const x of scanSecrets(fs.readFileSync(path.resolve(root, f), 'utf8'), opts)) out.push({ file: f, ...x });
  }
  return out;
}

export function recordUat({ root, phaseDir, phase, results, head, known = [], autonomy = 'standard', now = new Date() }) {
  const name = phaseArtifacts(phaseDir).uat;
  if (!name) throw new Error(`no UAT file in ${phaseDir}`);
  const file = path.join(phaseDir, name);
  const rel = path.relative(root, file).split(path.sep).join('/');
  const before = fs.readFileSync(file, 'utf8');
  const withManifest = results.map((r) => ({ ...r, evidence: evidenceManifest(root, Array.isArray(r.evidence) ? r.evidence : []) }));
  const text = applyUatResults(before, withManifest, { head, phase, now, autonomy });
  // findings that were already in the file are the owner's business, not this record's
  const oldLines = before.split(/\r?\n/);
  const preexisting = new Set(scanSecrets(before, { known }).map((f) => oldLines[f.line - 1]));
  const newLines = text.split(/\r?\n/);
  const findings = [
    ...scanEvidence(root, withManifest.flatMap((r) => r.evidence.map((e) => e.file)), { known }),
    ...scanSecrets(text, { known }).filter((f) => !preexisting.has(newLines[f.line - 1])).map((f) => ({ file: rel, ...f })),
  ];
  if (findings.length) throw new Error(`secret-scan refused the record: ${findings.map((f) => `${f.file}:${f.line} ${f.rule}`).join(', ')}`);
  fs.writeFileSync(file, text);
  return { file: rel, counts: countsOf(text) };
}
