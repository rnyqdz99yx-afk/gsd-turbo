export const CLASSES = Object.freeze(['A', 'B', 'C', 'D']);
const rank = (c) => CLASSES.indexOf(c);

// Spec §6.2: first match wins, strictest class first. Russian patterns avoid \b (ASCII-only without the u flag).
const D_RULES = [
  ['signature', /\b(signatures?|sign[- ]off|e-?sign(ature|ing)?|notari[sz](e|ed|ation))\b|\bsign(s|ed)?\b(?![- ](in|up|out|on)\b)|подпис|нотари/i],
  ['legal', /\blegal (review|approval|sign[- ]?off)\b|\bterms of service acceptance\b|юридическ/i],
  ['owner decision', /\b(owner|stakeholder|product owner)('s)? (decision|approval|sign[- ]?off)\b|решени[ея] владельца|на правах владельца|одобрени[ея] владельца/i],
  ['keys', /\b(private|signing|offline|master|root) keys?\b|\b(hsm|yubikey|hardware (key|wallet))\b|офлайн[- ]?ключ|приватн\S* ключ|ключ\S* подпис/i],
  ['2fa', /\b(2fa|two[- ]factor|mfa|authenticator app)\b|двухфактор|2фа/i],
  ['money', /\b(real money|real (card )?payments?|live payments?|actual payments?|charges? (a|the) (real )?card|payouts?|withdrawals?|bank transfers?|wire transfers?)\b|реальн\S* (деньг|платеж|оплат)|оплата реальн|списани\S* (денег|средств)|вывод средств|банковск\S* перевод/i],
];
const DEPLOY = /\b(deploy(s|ed|ing|ment)?|release to (prod|production)|roll(ing)? ?out to)\b|деплой|выкат/i;
const C_RULES = [
  ['third-party platform', /\bthird[- ]party\b|\bexternal (service|platform|app|account|provider)\b|\bpartner (platform|site)\b|сторонн\S* (сервис|платформ|сайт)|внешн\S* (сервис|платформ)/i],
  ['physical device', /\b(physical|real) (device|phone|hardware|printer)\b|\b(usb|bluetooth|nfc)\b|\bon (a|the|your) (phone|device|tablet)\b|физическ\S* устройств|на телефоне|реальн\S* устройств/i],
  ['desktop app', /\b(desktop|native|mobile) (app|application|client)\b|\binstaller\b|десктоп|нативн\S* приложени/i],
  ['production', /\b(?:in|on|to|against) (?:the )?prod(?:uction)?\b(?! (?:build|mode|bundle|config))|\bprod(?:uction)? (server|site|environment|env|database|db|host|url|data)\b|на проде|в проде|продакшн/i],
  ['live account', /\blive (session|stream|account|site)\b|\bowner'?s (own )?accounts?\b|живая сесси|аккаунт\S* владельца/i],
  ['delivery', /\b(sms|push notifications?)\b|\be-?mail (delivery|arrives|is received|inbox)\b|смс|пуш[- ]уведомлен/i],
];
const B_RULES = [
  ['authenticated', /\b(log(ged)?[- ]?in|sign(ed|s)?[- ]in|log(ged)?[- ]?out|authenticat\w*|sessions?|admin|roles?|permissions?|accounts?|seed(ed)?|fixtures?)\b|войти|вход|авториз|учётн|учетн|сесси|админ|роль|прав доступа/i],
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

const CLAUSE_RE = /(?<=[.;!?])\s+|\s+(?:and then|then|and|while|и затем|затем|а также|и)\s+/i;
const isLive = (c) => c === 'C' || c === 'D';

export function splitItem(text, opts = {}) {
  const whole = classifyItem(text, opts);
  if (!isLive(whole.class)) return [{ text, ...whole }];
  const clauses = String(text).split(CLAUSE_RE).map((s) => s.trim()).filter(Boolean);
  const live = [];
  const hermetic = [];
  for (const c of clauses) (isLive(classifyItem(c, opts).class) ? live : hermetic).push(c);
  if (!live.length || !hermetic.some((c) => ['A', 'B'].includes(classifyItem(c, opts).class))) return [{ text, ...whole }];
  const h = hermetic.join('; ');
  const l = live.join('; ');
  return [{ text: h, ...classifyItem(h, opts), part: 'hermetic' }, { text: l, ...classifyItem(l, opts), part: 'live' }];
}

export function uatPlan(tests, { autonomy = 'standard' } = {}) {
  const items = [];
  for (const t of tests) {
    if (t.result !== 'pending') continue;
    const text = [t.name, t.expected].filter(Boolean).join('. ');
    const parts = splitItem(text, { autonomy });
    if (parts.length === 1) {
      items.push({ test: t.number, name: t.name, expected: t.expected || '', class: parts[0].class, rule: parts[0].rule });
    } else {
      for (const p of parts) items.push({ test: t.number, name: t.name, expected: p.text, class: p.class, rule: p.rule, split: p.part });
    }
  }
  return items;
}
