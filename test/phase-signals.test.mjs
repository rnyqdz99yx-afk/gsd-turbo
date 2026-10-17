import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { readPhaseInfo, needsResearch, needsSecurity, SIGNALS } from '../lib/phase-signals.mjs';

// A project with a ROADMAP of GSD's shape (templates/roadmap.md), REQUIREMENTS.md and the given .planning files.
function project({ phases, requirements = '', files = {} }) {
  const root = tmpDir('signals');
  const sections = phases.map((p) => [
    `### Phase ${p.n}: ${p.name ?? 'Work'}`,
    `**Goal**: ${p.goal}`,
    '**Depends on**: Nothing',
    `**Requirements**: ${p.reqs ?? 'None'}`,
    '**Success Criteria** (what must be TRUE):',
    ...(p.criteria ?? []).map((c, i) => `  ${i + 1}. ${c}`),
    '**Plans**: TBD',
    '',
  ].join('\n'));
  const all = { 'ROADMAP.md': `# Roadmap\n\n## Phase Details\n\n${sections.join('\n')}`, 'REQUIREMENTS.md': requirements, ...files };
  for (const [rel, text] of Object.entries(all)) {
    const file = path.join(root, '.planning', ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

const REQS = '# Requirements\n\n## v1\n\n- [ ] **PAY-01**: Buyer pays by card\n- [x] **PAY-02**: Seller sees the payout\n- [ ] **UI-01**: Page has a header\n';
const STRIPE = { n: 7, name: 'Payments', goal: 'Accept card payments through the Stripe API', reqs: 'PAY-01, PAY-02', criteria: ['A buyer pays by card and sees a receipt', 'A failed charge shows a retry button'] };
const LOG = [
  '# Phase 7: Payments - Discussion Log',
  '',
  '## Assumptions Presented',
  '',
  '- something',
  '',
  '## External Research',
  '',
  '- Stripe idempotency keys: retries reuse the key (Source: https://docs.stripe.com/api/idempotent_requests)',
  '- Webhook retries: Stripe retries for three days (Source: https://docs.stripe.com/webhooks)',
  '',
  '## Other',
  '',
  '- not a topic',
  '',
].join('\n');
const DIR = 'phases/07-payments';

test('readPhaseInfo reads goal, success criteria, requirement texts, CONTEXT, the discussion log\'s research topics and the planned files', () => {
  const root = project({
    phases: [{ n: 6, goal: 'Earlier work' }, STRIPE],
    requirements: REQS,
    files: {
      [`${DIR}/07-CONTEXT.md`]: '# Phase 7 context\n\nD-01 use Stripe Checkout\n',
      [`${DIR}/07-DISCUSSION-LOG.md`]: LOG,
      [`${DIR}/07-01-PLAN.md`]: '---\nphase: 07\nplan: 01\nfiles_modified: [src/billing/charge.js, "src/ui/pay.js"]\n---\n# Plan\n',
      [`${DIR}/07-02-PLAN.md`]: '---\nphase: 07\nfiles_modified:\n  - src/api/pay.js\nfiles_deleted: [src/old.js]\n---\n# Plan\n',
    },
  });
  const info = readPhaseInfo(root, '07');
  assert.equal(info.phase, '7');
  assert.equal(info.goal, 'Accept card payments through the Stripe API');
  assert.deepEqual(info.successCriteria, ['A buyer pays by card and sees a receipt', 'A failed charge shows a retry button']);
  assert.deepEqual(info.requirements, [{ id: 'PAY-01', text: 'Buyer pays by card' }, { id: 'PAY-02', text: 'Seller sees the payout' }]);
  assert.match(info.contextText, /D-01 use Stripe Checkout/);
  assert.equal(info.discussionLogText, LOG);
  assert.deepEqual(info.needsResearchItems, [
    'Stripe idempotency keys: retries reuse the key (Source: https://docs.stripe.com/api/idempotent_requests)',
    'Webhook retries: Stripe retries for three days (Source: https://docs.stripe.com/webhooks)',
  ]);
  assert.deepEqual(info.plannedFiles, ['src/api/pay.js', 'src/billing/charge.js', 'src/old.js', 'src/ui/pay.js']);
  assert.equal(info.hasResearch, false);
});

test('readPhaseInfo of a missing phase or missing files returns empty fields and never throws', () => {
  const empty = { goal: '', successCriteria: [], requirements: [], contextText: '', discussionLogText: '', needsResearchItems: [], plannedFiles: [], hasResearch: false };
  const bare = tmpDir('signals-bare');
  assert.deepEqual(readPhaseInfo(bare, 3), { phase: '3', ...empty });
  const root = project({ phases: [{ n: 2, goal: 'Something', reqs: 'X-01' }] });
  assert.deepEqual(readPhaseInfo(root, 9), { phase: '9', ...empty });
  // a requirement id without a REQUIREMENTS.md line keeps an empty text; no phase directory: no files
  assert.deepEqual(readPhaseInfo(root, 2), { phase: '2', ...empty, goal: 'Something', requirements: [{ id: 'X-01', text: '' }] });
  // a log without External Research and an n/a bullet list: no topics
  const na = project({ phases: [STRIPE], files: { [`${DIR}/07-DISCUSSION-LOG.md`]: '## External Research\n\n- none\n- n/a\n' } });
  assert.deepEqual(readPhaseInfo(na, 7).needsResearchItems, []);
});

test('needsResearch: research topics in the discussion log first', () => {
  const root = project({ phases: [STRIPE], requirements: REQS, files: { [`${DIR}/07-DISCUSSION-LOG.md`]: LOG } });
  const r = needsResearch(readPhaseInfo(root, 7));
  assert.equal(r.yes, true);
  assert.match(r.why, /^the discussion log lists 2 research topics: Stripe idempotency keys/);
});

test('needsResearch: external API, dependency upgrade and security words in the goal, requirements or success criteria; RESEARCH.md', () => {
  const at = (phase, files = {}) => needsResearch(readPhaseInfo(project({ phases: [phase], requirements: REQS, files }), phase.n));
  assert.deepEqual(at(STRIPE), { yes: true, why: 'external API: "Stripe API" in the goal' });
  assert.deepEqual(at({ n: 3, goal: 'Upgrade aiogram to 3.31' }), { yes: true, why: 'dependency upgrade: "Upgrade" in the goal' });
  assert.deepEqual(at({ n: 3, goal: 'Обновить зависимости бота до новой версии' }), { yes: true, why: 'dependency upgrade: "Обновить зависимости" in the goal' });
  assert.deepEqual(at({ n: 3, goal: 'Tidy the page', criteria: ['Пользователь входит по паролю'] }), { yes: true, why: 'security: "паролю" in the success criteria' });
  assert.deepEqual(at({ n: 3, goal: 'Tidy the page', reqs: 'PAY-01' }), { yes: false, why: 'no research topics in the discussion log, no external API, dependency upgrade or security words in the goal, requirements or success criteria, no RESEARCH.md' });
  assert.deepEqual(at({ n: 3, goal: 'Tidy the page', reqs: 'UI-01' }, { 'phases/03-tidy/03-RESEARCH.md': '# Research\n' }), { yes: true, why: 'RESEARCH.md already exists' });
  // a requirement's text counts, with its id named
  const reqs = '- [ ] **INT-02**: Orders sync with an external service\n';
  assert.deepEqual(needsResearch(readPhaseInfo(project({ phases: [{ n: 4, goal: 'Tidy', reqs: 'INT-02' }], requirements: reqs }), 4)), { yes: true, why: 'external API: "external service" in requirement INT-02' });
});

test('needsResearch no: the why lists what was looked at', () => {
  const root = project({ phases: [{ n: 5, goal: 'Rename the settings page and tidy its layout', criteria: ['The page reads Settings'] }] });
  assert.deepEqual(needsResearch(readPhaseInfo(root, 5)), { yes: false, why: 'no research topics in the discussion log, no external API, dependency upgrade or security words in the goal, requirements or success criteria, no RESEARCH.md' });
});

test('needsSecurity: auth, private data and cross-user routing words, then planned file paths', () => {
  const at = (goal, files = {}) => needsSecurity(readPhaseInfo(project({ phases: [{ n: 4, goal }], files }), 4));
  assert.deepEqual(at('Вход по паролю и сброс пароля'), { yes: true, why: 'auth: "паролю" in the goal' });
  assert.deepEqual(at('Store personal data of buyers'), { yes: true, why: 'private data: "personal data" in the goal' });
  assert.deepEqual(at('Messages go to the right chat between users'), { yes: true, why: 'cross-user data: "between users" in the goal' });
  assert.deepEqual(at('Tidy the page', { 'phases/04-tidy/04-01-PLAN.md': '---\nfiles_modified: [src/auth/session.js]\n---\n' }), { yes: true, why: 'planned file "src/auth/session.js" (auth path)' });
  assert.deepEqual(at('Tidy the page', { 'phases/04-tidy/04-01-PLAN.md': '---\nfiles_modified: [src/ui/page.js, src/author.js]\n---\n' }), { yes: false, why: 'no auth, private data or cross-user words in the goal, requirements or success criteria, no planned file on an auth path' });
});

test('SIGNALS: frozen sets of regular expressions; a Cyrillic stem never matches inside a word', () => {
  assert.ok(Object.isFrozen(SIGNALS));
  for (const k of ['externalApi', 'dependencyUpgrade', 'securityResearch', 'auth', 'privateData', 'crossUser']) assert.ok(SIGNALS[k].every((re) => re instanceof RegExp), k);
  assert.ok(SIGNALS.securityPath instanceof RegExp);
  // "непароль"-like words: the stem must start a word
  assert.equal(SIGNALS.auth.some((re) => re.test('запаролированный')), false);
  assert.equal(SIGNALS.externalApi.some((re) => re.test('the REST API stays')), false);
  assert.equal(SIGNALS.externalApi.some((re) => re.test('call the Telegram Bot API')), true);
});
