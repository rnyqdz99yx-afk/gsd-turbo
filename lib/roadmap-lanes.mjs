import crypto from 'node:crypto';
import { normalizePhaseId } from './gsd.mjs';

// spec §6.2, G3: turbo's markup lines in a phase's ROADMAP section, right after **Depends on**:. GSD 1.16 reads none
// of them, and each one ends the Goal field (extractPhaseFieldMultiline stops at a **Label**: line).
export const LANE_FIELDS = Object.freeze({ areas: 'Areas', gates: 'Gates', parallelWith: 'Parallel with' });

// GSD 1.16 roadmap.cjs collectAnalyzePhases: a line-anchored `## Phase N: Name` (2 to 4 #, an optional ( ) tag).
const HEADING = /^ {0,3}(#{2,4})\s*Phase\s+([A-Za-z]?\d+[A-Z]?(?:[.-]\d+)*)(?:\s*\([^)\n]{0,200}\))?\s*:\s*(.*?)\s*$/i;
const ANY_HEADING = /^ {0,3}(#{1,6})\s/;
const DETAILS = /<details\b/i;
const DETAILS_END = /<\/details>/i;
// GSD's label shapes: **X**:, **X:**, **X** :
const fieldRe = (label) => new RegExp(`^([ \\t]*\\*\\*${label}(?::\\*\\*|\\*\\*[ \\t]*:?))[ \\t]*(.*)$`, 'i');
const GOAL = fieldRe('Goal');
const DEPENDS = fieldRe('Depends on');
const REQUIREMENTS = fieldRe('Requirements');
const OURS = Object.fromEntries(Object.entries(LANE_FIELDS).map(([k, label]) => [k, fieldRe(label)]));
const isOurs = (line) => Object.values(OURS).some((re) => re.test(line));

const split = (text) => String(text).split(/\r?\n/);
const eolOf = (text) => (/\r\n/.test(text) ? '\r\n' : '\n');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);

// GSD's continuation rule (extractPhaseFieldMultiline): a field goes on until a blank line, a list item, another
// **Label**, a heading, a table row or a fence. Returns the index of the field's last line.
const STOPS = [/^\s*$/, /^\s*[-*+]\s/, /^\s*\*\*[A-Za-z][A-Za-z ]*:?(\*\*)?:?\s/, /^\s*#{1,4}\s/, /^\s*\|/, /^\s*(?:`{3,}|~{3,})/];
function fieldEnd(body, at) {
  let i = at;
  while (i + 1 < body.length && !STOPS.some((re) => re.test(body[i + 1]))) i++;
  return i;
}

// D4: every phase section outside <details> blocks (GSD keeps shipped milestones there), from its heading to the next
// phase heading, the next heading of its level or above, or a <details> line.
export function parseRoadmapPhases(text) {
  const all = split(text);
  const heads = [];
  let details = 0;
  all.forEach((l, i) => {
    if (DETAILS.test(l)) details++;
    const m = HEADING.exec(l);
    if (m && details === 0) heads.push({ i, level: m[1].length, number: normalizePhaseId(m[2]), name: m[3].replace(/\(INSERTED\)/i, '').trim() });
    if (DETAILS_END.test(l)) details = Math.max(0, details - 1);
  });
  return heads.map((h) => {
    let end = all.length;
    for (let j = h.i + 1; j < all.length; j++) {
      const a = ANY_HEADING.exec(all[j]);
      if (HEADING.test(all[j]) || DETAILS.test(all[j]) || (a && a[1].length <= h.level)) {
        end = j;
        break;
      }
    }
    const body = all.slice(h.i + 1, end);
    const value = (re) => {
      const line = body.find((x) => re.test(x));
      return line === undefined ? null : re.exec(line)[2].trim();
    };
    const ours = (k) => {
      const v = value(OURS[k]);
      return v === null ? null : list(v);
    };
    const goal = value(GOAL);
    const dependsOn = value(DEPENDS);
    const requirements = value(REQUIREMENTS);
    const parallel = ours('parallelWith');
    return {
      number: h.number, name: h.name, start: h.i, end, goal, dependsOn, requirements,
      areas: ours('areas'), gates: ours('gates'), parallelWith: parallel && parallel.map(normalizePhaseId),
      key: sha(JSON.stringify([h.number, h.name, goal, dependsOn, requirements])),
    };
  });
}

// D3: the sha256 of the ROADMAP's scheduling text, lanes.json's roadmap_sha256 (spec §6.4). GSD's own completion edits
// (checkboxes, Plans, Progress) and turbo's lines leave it unchanged; line endings never count.
export function roadmapDigest(text) {
  return sha(JSON.stringify(parseRoadmapPhases(text).map((s) => [s.number, s.key])));
}

// G4: GSD reads a dependency only with the word Phase.
export const depsText = (deps) => (deps.length ? deps.map((d) => `Phase ${d}`).join(', ') : 'Nothing');

function sectionOf(text, phase) {
  const s = parseRoadmapPhases(text).find((x) => x.number === normalizePhaseId(String(phase)));
  if (!s) throw new Error(`phase ${phase} has no section in the ROADMAP`);
  return s;
}

// D5: after Depends on; else after the Goal field's last line; else right after the heading (-1).
function anchor(body) {
  const d = body.findIndex((l) => DEPENDS.test(l));
  if (d >= 0) return d;
  const g = body.findIndex((l) => GOAL.test(l));
  return g >= 0 ? fieldEnd(body, g) : -1;
}

function rebuild(text, s, body) {
  const all = split(text);
  return [...all.slice(0, s.start + 1), ...body, ...all.slice(s.end)].join(eolOf(text));
}

export function writeLaneLines(text, phase, { areas = [], gates = [], parallelWith = [] } = {}) {
  const s = sectionOf(text, phase);
  const body = split(text).slice(s.start + 1, s.end).filter((l) => !isOurs(l));
  const add = [
    areas.length ? `**${LANE_FIELDS.areas}**: ${areas.join(', ')}` : null,
    gates.length ? `**${LANE_FIELDS.gates}**: ${gates.join(', ')}` : null,
    parallelWith.length ? `**${LANE_FIELDS.parallelWith}**: ${parallelWith.join(', ')}` : null,
  ].filter(Boolean);
  body.splice(anchor(body) + 1, 0, ...add);
  return rebuild(text, s, body);
}

// spec §6.2: a relaxed dependency rewrites the line in the Phase 3, Phase 4 form, keeping its label form.
export function setDependsOn(text, phase, deps) {
  const s = sectionOf(text, phase);
  const body = split(text).slice(s.start + 1, s.end);
  const d = body.findIndex((l) => DEPENDS.test(l));
  if (d >= 0) body[d] = body[d].replace(DEPENDS, (_, label) => `${label} ${depsText(deps)}`);
  else if (deps.length) {
    const g = body.findIndex((l) => GOAL.test(l));
    body.splice(g >= 0 ? fieldEnd(body, g) + 1 : 0, 0, `**Depends on**: ${depsText(deps)}`);
  } else return text;
  return rebuild(text, s, body);
}
