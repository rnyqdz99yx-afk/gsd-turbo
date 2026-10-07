export const CLASSES = Object.freeze(['A', 'B', 'C', 'D']);
const rank = (c) => CLASSES.indexOf(c);

// The recorder appends the live half of a split test as `### N. <name> (live part, split from test M)`.
export const LIVE_PART_RE = /\(live part, split from test (\d+)\)$/;

// Spec §6.2: first match wins, strictest class first. Russian patterns avoid \b (ASCII-only without the u flag),
// use (?<![а-яё]) / (?![а-яё]) where a short stem needs a word edge, and write a stem that can carry ё as [её].
// The floor is a best-effort pattern list with known word-form gaps; the turbo-uat agent proposes C/D for anything
// live or owner-only, and finalClass keeps the higher class.
const D_RULES = [
  // "подписка" and "подписчик" are subscriptions, not signatures
  ['signature', /\b(signatures?|sign[- ]?off|e-?sign(ature|ing)?|notari[sz](e|ed|ation))\b|\bsign(s|ed|ing)?\b(?![- ](in|into|up|out|on)\b)|подпи[сш](?!к|чик)|нотари/i],
  ['legal', /\blegal (review|approval|sign[- ]?off)\b|\bterms of service acceptance\b|юридическ/i],
  ['owner decision', /\b(owner|stakeholder)s?('s?)? (?:\w+ ){0,2}(decid|decis|approv)\w*|\b(approv|decid|decis)\w* by (?:\w+ ){0,2}(owner|stakeholder)s?\b|владел\S* (?:\S+ )?(реш|одобр|утвержд)|(реш|одобр|утвержд)\S* владел|на правах владельца/i],
  ['keys', /\b(private|signing|offline|master|root) keys?\b|\b(hsm|yubikey|hardware (key|wallet))\b|офлайн[- ]?ключ|приватн\S* ключ|ключ\S* подпис/i],
  ['2fa', /\b(2fa|two[- ]factor|mfa|authenticator app)\b|двухфактор|2фа/i],
  ['money', /\b(real money|real (card )?payments?|live payments?|actual payments?|charges? (a|the) (real )?card|payouts?|withdraw\w*|bank transfers?|wire transfers?)\b|реальн\S* (деньг|плат[её]ж|оплат)|оплата реальн|списани\S* (денег|средств)|выв(од\S*|ести) средств|банковск\S* перевод/i],
];
const DEPLOY = /\b(?:re-?)?deploy(s|ed|ing|ments?)?\b|\brelease to (prod|production)\b|\broll(ing)? ?out to\b|депло|выкат/i;
const C_RULES = [
  ['third-party platform', /\bthird[- ]party\b|\bexternal (service|platform|app|account|provider)\b|\bpartner (platform|site)\b|сторонн\S* (сервис|платформ|сайт)|внешн\S* (сервис|платформ)/i],
  ['physical device', /\b(physical|real) (device|phone|hardware|printer)\b|\b(usb|bluetooth|nfc)\b|\bon (a|the|your) (phone|device|tablet)\b|физическ\S* устройств|на телефоне|реальн\S* устройств/i],
  ['desktop app', /\b(desktop|native|mobile) (app|application|client)\b|\binstaller\b|десктоп|нативн\S* приложени/i],
  ['production', /\b(?:in|on|to|against) (?:the )?prod(?:uction)?\b(?! (?:build|mode|bundle|config))|\bprod(?:uction)? (server|site|environment|env|database|db|host|url|data)\b|(?<![а-яё])(?:на|в|с|из) прод(?:е|а|у|ом)?(?![а-яё])|(?<![а-яё])продов(?!ольств)|(?<![а-яё])прод-|продакш[еэ]?н/i],
  ['live account', /\blive (session|stream|account|site)\b|\bowner'?s (own )?accounts?\b|живая сесси|аккаунт\S* владельца/i],
  // "на почт" needs an ending so that "она почти" stays out
  ['delivery', /\b(sms|push notifications?)\b|\be-?mail (delivery|arrives|is received|inbox)\b|\b(sent|sends?|delivered|pushed) to (a|the|your|my) (phone|device|tablet|mobile)\b|смс|пуш[- ]уведомлен|(?<![а-яё])на телефон|(?<![а-яё])на (?:электронн\S* )?почт(?:у|е|ов)|(?<![а-яё])на e-?mail\b|письм\S* приход/i],
];
const B_RULES = [
  ['authenticated', /\b(log(s|ged|ging)?[- ]?in(s|to)?|sign(s|ed|ing)?[- ]?in(to)?|log(s|ged|ging)?[- ]?out|authenticat\w*|sessions?|admin|roles?|permissions?|accounts?|seed(ed)?|fixtures?)\b|войти|вход|авториз|уч[её]т[нк]|сесси|админ|роль|прав доступа/i],
];
const A_RULES = [
  ['observable', /\b(page|screen|browser|ui|button|clicks?|renders?|display(s|ed)?|shows?|visible|modal|form|http|api|endpoints?|status code|responses?|requests?|sockets?|websockets?|events?|redirects?|url|downloads?)\b|страниц|экран|кнопк|отображ|показ|запрос|ответ|сокет|событи/i],
];

export function classifyItem(text, { autonomy = 'standard' } = {}) {
  const t = String(text ?? '');
  const hit = (rules) => rules.find(([, re]) => re.test(t));
  let r = hit(D_RULES);
  if (r) return { class: 'D', rule: r[0] };
  if (DEPLOY.test(t)) return autonomy === 'max' ? { class: 'C', rule: 'deploy (production write)' } : { class: 'D', rule: 'deploy (owner under standard autonomy)' };
  r = hit(C_RULES);
  if (r) return { class: 'C', rule: r[0] };
  r = hit(B_RULES);
  if (r) return { class: 'B', rule: r[0] };
  r = hit(A_RULES);
  if (r) return { class: 'A', rule: r[0] };
  return { class: null, rule: 'unclassified' };
}

export function finalClass(det, proposed) {
  const p = CLASSES.includes(proposed) ? proposed : null;
  if (det === 'C' || det === 'D') return det;
  if (!det) return p || 'C';
  return p && rank(p) > rank(det) ? p : det;
}

// The text a test is classified by; the recorder joins it the same way.
export function itemText(t) {
  return [t.name, t.expected].filter(Boolean).join('. ');
}

const CLAUSE_RE = /(?<=[.;!?])\s+|\s+(?:and then|then|and|while|и затем|затем|а также|и)\s+/i;
const isLive = (c) => c === 'C' || c === 'D';
const isHermetic = (c) => c === 'A' || c === 'B';

export function splitItem(text, opts = {}) {
  const whole = classifyItem(text, opts);
  if (!isLive(whole.class)) return [{ text, ...whole }];
  const clauses = String(text).split(CLAUSE_RE).map((s) => s.trim()).filter(Boolean);
  const live = [];
  const hermetic = [];
  // a clause that matches no rule goes live, as an unclassified item defaults to C (finalClass)
  for (const c of clauses) (isHermetic(classifyItem(c, opts).class) ? hermetic : live).push(c);
  const h = hermetic.join('; ');
  const l = live.join('; ');
  const hc = classifyItem(h, opts);
  const lc = classifyItem(l, opts);
  // a match that spans a clause separator lives in no single clause: never split below the whole item's class
  if (!isHermetic(hc.class) || !isLive(lc.class) || rank(lc.class) < rank(whole.class)) return [{ text, ...whole }];
  return [{ text: h, ...hc, part: 'hermetic' }, { text: l, ...lc, part: 'live' }];
}

export function uatPlan(tests, { autonomy = 'standard' } = {}) {
  const items = [];
  for (const t of tests) {
    if (t.result !== 'pending') continue;
    const text = itemText(t);
    // a live part the recorder appended is classified whole and never split again
    const parts = LIVE_PART_RE.test(t.name) ? [classifyItem(text, { autonomy })] : splitItem(text, { autonomy });
    if (parts.length === 1) {
      items.push({ test: t.number, name: t.name, expected: t.expected || '', class: parts[0].class, rule: parts[0].rule });
    } else {
      for (const p of parts) items.push({ test: t.number, name: t.name, expected: p.text, class: p.class, rule: p.rule, split: p.part });
    }
  }
  return items;
}
