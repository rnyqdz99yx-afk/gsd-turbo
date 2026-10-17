import fs from 'node:fs';
import path from 'node:path';
import { normalizePhaseId } from './gsd.mjs';
import { parseRoadmapPhases } from './roadmap-lanes.mjs';
import { findPhaseDir, phaseArtifacts, planFileNames } from './phase-files.mjs';
import { frontList } from './plan-drafts.mjs';

// Stage 6 §5.2: whether a phase needs GSD's researcher and turbo's security audit, read from the phase's own GSD files
// (ROADMAP section, REQUIREMENTS.md, CONTEXT.md, DISCUSSION-LOG.md, PLAN frontmatter). Read-only, no gsd-tools; every
// answer carries a why that quotes what it matched (or lists what it looked at).

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const lines = (text) => String(text).split(/\r?\n/);

// GSD's requirement ids (REQUIREMENTS.md **AUTH-01**, ROADMAP **Requirements**: [AUTH-01, PAY-02a]).
const REQ_ID_RE = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+[A-Za-z]?\b/g;
const REQ_LINE_RE = /^\s*-\s*\[[ xX]\]\s*\*\*([^*]+?):?\*\*:?\s*(.*)$/;
const ITEM_RE = /^\s*(?:\d+[.)]|[-*+])\s+(.*)$/;
const CRITERIA_RE = /^\s*\*\*Success Criteria\b/i;
const LOG_RE = /^\d+[A-Z]?(?:\.\d+)*-DISCUSSION-LOG\.md$/i;
const RESEARCH_HEAD_RE = /^(#{2,3})\s+External Research\s*$/i;
const NONE_RE = /^(?:none|n\/a)\.?$/i;

// The success criteria of a phase section: the list items after its **Success Criteria** line, up to the first line
// that is neither blank nor an item.
function criteriaOf(body) {
  const at = body.findIndex((l) => CRITERIA_RE.test(l));
  if (at < 0) return [];
  const out = [];
  for (const l of body.slice(at + 1)) {
    if (!l.trim()) continue;
    const m = ITEM_RE.exec(l);
    if (!m) break;
    out.push(m[1].trim());
  }
  return out;
}

// The bullets under an h2/h3 "External Research" of GSD's discussion log (assumptions mode records the analyzer's
// needs_research findings there), up to the next heading of the same or a higher level; none/n/a dropped.
function researchItems(text) {
  const all = lines(text);
  const at = all.findIndex((l) => RESEARCH_HEAD_RE.test(l));
  if (at < 0) return [];
  const level = RESEARCH_HEAD_RE.exec(all[at])[1].length;
  const out = [];
  for (const l of all.slice(at + 1)) {
    const h = /^(#{1,6})\s/.exec(l);
    if (h && h[1].length <= level) break;
    const m = /^\s*[-*+]\s+(.*)$/.exec(l);
    const item = m?.[1].trim();
    if (item && !NONE_RE.test(item)) out.push(item.slice(0, 300));
  }
  return out;
}

const normFile = (p) => String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '');

// -> { phase, goal, successCriteria, requirements: [{ id, text }], contextText, discussionLogText, needsResearchItems,
//      plannedFiles, hasResearch }; a missing phase or file leaves its fields empty.
export function readPhaseInfo(root, phase) {
  const id = normalizePhaseId(String(phase));
  const planning = path.join(root, '.planning');
  const roadmap = read(path.join(planning, 'ROADMAP.md'));
  const section = parseRoadmapPhases(roadmap).find((s) => s.number === id);
  const body = section ? lines(roadmap).slice(section.start + 1, section.end) : [];
  const ids = [...new Set(String(section?.requirements ?? '').match(REQ_ID_RE) ?? [])];
  const texts = new Map();
  for (const l of lines(read(path.join(planning, 'REQUIREMENTS.md')))) {
    const m = REQ_LINE_RE.exec(l);
    if (m && !texts.has(m[1].trim())) texts.set(m[1].trim(), m[2].trim());
  }
  const info = {
    phase: id,
    goal: section?.goal ?? '',
    successCriteria: criteriaOf(body),
    requirements: ids.map((r) => ({ id: r, text: texts.get(r) ?? '' })),
    contextText: '',
    discussionLogText: '',
    needsResearchItems: [],
    plannedFiles: [],
    hasResearch: false,
  };
  let dir = null;
  try {
    dir = findPhaseDir(root, id);
  } catch {
    // an unreadable phases directory reads as none
  }
  if (!dir) return info;
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return info;
  }
  const art = phaseArtifacts(dir);
  if (art.context) info.contextText = read(path.join(dir, art.context));
  info.hasResearch = Boolean(art.research);
  const log = names.find((f) => LOG_RE.test(f));
  if (log) info.discussionLogText = read(path.join(dir, log));
  info.needsResearchItems = researchItems(info.discussionLogText);
  const files = new Set();
  for (const f of planFileNames(dir)) {
    const text = read(path.join(dir, ...f.split('/')));
    for (const key of ['files_modified', 'files_deleted']) for (const p of frontList(text, key) ?? []) if (normFile(p)) files.add(normFile(p));
  }
  info.plannedFiles = [...files].sort();
  return info;
}

// Cyrillic stems start a word ((?<!\p{L}); \b is ASCII-only) and run to its end (\p{L}*), so a why quotes whole words.
const ru = (src) => new RegExp(`(?<!\\p{L})${src}`, 'iu');
const en = (src) => new RegExp(src, 'iu');
const AUTH = [
  en(String.raw`\b(?:auth|authentication|authori[sz]ation|login|log\s+in|logout|sign[- ]?in|sign[- ]?up|passwords?|2fa|mfa|otp|jwt|sso|(?:session|access|refresh|bearer)\s+tokens?|api\s+keys?|credentials?|permissions?|rbac|acl)\b`),
  ru(String.raw`(?:авториз|аутентиф|парол|логин|токен|учётн\p{L}*\s+запис|учетн\p{L}*\s+запис|прав\p{L}*\s+доступ|двухфактор)\p{L}*`),
];
export const SIGNALS = Object.freeze({
  externalApi: Object.freeze([
    en(String.raw`\bthird[- ]party\b`),
    en(String.raw`\b3rd[- ]party\b`),
    en(String.raw`\bexternal\s+(?:api|service|provider|system|platform)s?\b`),
    en(String.raw`\b(?:sdk|webhooks?|oauth2?|openid)\b`),
    en(String.raw`\bintegrat(?:e|es|ed|ing|ion|ions)\s+(?:with|into)\b`),
    // a named API (Stripe API, Telegram Bot API): case-sensitive, generic words excluded
    new RegExp(String.raw`\b(?!(?:REST|HTTP|JSON|GraphQL|Internal|Public|Admin|Our|The|An?)\b)[A-Z][\w.-]*\s+(?:Bot\s+)?API\b`, 'u'),
    ru(String.raw`внешн\p{L}*\s+(?:api|сервис|систем|провайдер|платформ)\p{L}*`),
    ru(String.raw`сторонн\p{L}*`),
    ru(String.raw`вебхук\p{L}*`),
    ru(String.raw`интеграци\p{L}*\s+с(?!\p{L})`),
    ru(String.raw`интегрир\p{L}*`),
  ]),
  dependencyUpgrade: Object.freeze([
    en(String.raw`\b(?:upgrade|upgrading|bump)\b`),
    en(String.raw`\bmigrat(?:e|ion|ing)\s+to\b`),
    en(String.raw`\b(?:new|next|latest)\s+major\s+version\b`),
    en(String.raw`\bdependenc(?:y|ies)\s+(?:update|upgrade)s?\b`),
    ru(String.raw`обнов\p{L}*\s+(?:зависимост|библиотек|пакет|верси|фреймворк|sdk)\p{L}*`),
    ru(String.raw`(?:миграци|переход)\p{L}*\s+на(?!\p{L})`),
    ru(String.raw`апгрейд\p{L}*`),
  ]),
  securityResearch: Object.freeze([
    ...AUTH,
    en(String.raw`\b(?:security|vulnerabilit\w*|cve)\b`),
    ru(String.raw`(?:безопасн|уязвим)\p{L}*`),
  ]),
  auth: Object.freeze(AUTH),
  privateData: Object.freeze([
    en(String.raw`\b(?:personal|private|sensitive)\s+data\b`),
    en(String.raw`\b(?:pii|gdpr|payments?|billing|credit\s+cards?|encrypt\w*|secrets?)\b`),
    ru(String.raw`(?:персональн\p{L}*\s+данн|личн\p{L}*\s+данн|приватн|конфиденц|платеж|платёж|оплат|шифров|секрет)\p{L}*`),
  ]),
  crossUser: Object.freeze([
    en(String.raw`\b(?:multi[- ]?tenant|tenants?|per[- ]user|other\s+users?|between\s+users|cross[- ]user|(?:user|data)\s+isolation|access\s+control)\b`),
    en(String.raw`\bshar(?:e|ed|ing)\s+(?:with|between)\b`),
    ru(String.raw`(?:между\s+пользовател|друг\p{L}*\s+пользовател|чуж\p{L}*\s+(?:данн|аккаунт|сообщени|чат)|изоляци\p{L}*\s+(?:данн|пользовател)|арендатор|тенант)\p{L}*`),
  ]),
  // tested on the lower-cased path
  securityPath: /(?:^|[/._-])(?:auth|authn|authz|login|logout|session|sessions|security|crypto|permissions?|acl|rbac|oauth|tokens?|secrets?|passwords?|credentials?|accounts?|billing|payments?)(?:[/._-]|$)/,
});

// The texts the words are looked for in, each with the name a why gives it, in this order.
const corpus = (info) => [
  { name: 'the goal', text: info.goal ?? '' },
  { name: 'the success criteria', text: (info.successCriteria ?? []).join('\n') },
  ...(info.requirements ?? []).map((r) => ({ name: `requirement ${r.id}`, text: `${r.id} ${r.text ?? ''}` })),
];

// The first match of a signal set: field by field in corpus order, each field against every expression.
function firstMatch(set, fields) {
  for (const f of fields) {
    for (const re of set) {
      const m = re.exec(f.text);
      if (m) return `"${m[0].replace(/\s+/g, ' ').trim()}" in ${f.name}`;
    }
  }
  return null;
}

// §5.2 (a) the discussion log's research topics, (b) external API, dependency upgrade or security words, (c) an
// existing RESEARCH.md.
export function needsResearch(info) {
  const items = info?.needsResearchItems ?? [];
  if (items.length) return { yes: true, why: `the discussion log lists ${items.length} research topic${items.length === 1 ? '' : 's'}: ${items.join('; ')}` };
  const fields = corpus(info ?? {});
  for (const [label, set] of [['external API', SIGNALS.externalApi], ['dependency upgrade', SIGNALS.dependencyUpgrade], ['security', SIGNALS.securityResearch]]) {
    const hit = firstMatch(set, fields);
    if (hit) return { yes: true, why: `${label}: ${hit}` };
  }
  if (info?.hasResearch) return { yes: true, why: 'RESEARCH.md already exists' };
  return { yes: false, why: 'no research topics in the discussion log, no external API, dependency upgrade or security words in the goal, requirements or success criteria, no RESEARCH.md' };
}

// §5.2: the phase touches authorization, private data or the routing of data between users (words), or plans a file
// on such a path.
export function needsSecurity(info) {
  const fields = corpus(info ?? {});
  for (const [label, set] of [['auth', SIGNALS.auth], ['private data', SIGNALS.privateData], ['cross-user data', SIGNALS.crossUser]]) {
    const hit = firstMatch(set, fields);
    if (hit) return { yes: true, why: `${label}: ${hit}` };
  }
  const file = (info?.plannedFiles ?? []).find((p) => SIGNALS.securityPath.test(String(p).toLowerCase()));
  if (file) return { yes: true, why: `planned file "${file}" (auth path)` };
  return { yes: false, why: 'no auth, private data or cross-user words in the goal, requirements or success criteria, no planned file on an auth path' };
}
