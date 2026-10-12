// Secret patterns shared by every scan and mask: the UAT evidence and record scans (lib/uat.mjs) and the
// masking of what turbo-run view shows from transcripts (lib/transcripts.mjs).
export const SECRET_RULES = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['aws access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['api key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['bearer token', /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/i],
  ['credential assignment', credentialRule()],
];

// A key (quoted or not, alone or the end of an identifier such as DB_PASSWORD), ':' or '=', a value of 6+
// characters. A bare "pass" counts only where config puts it: a quoted key or value ("pass": x, pass: 'x'), before
// '=' (pass = x), after '_' (DB_PASS:), lowercase after indentation, '.', '{', ',' or a YAML '- ' (smtp.pass: x),
// or lowercase with no space, or at the start of a line (a root YAML key), before a value with a letter and a
// digit (pass:x1y2z3, pass: S3cret9). Prose such as
// "PASS: dry-run complete", "PASS: 14/14" or "the tests pass: ..." is no finding.
function credentialRule() {
  const ci = (w) => w.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
  const value = `[^\\s"'<>]{6,}`;
  const key = `(?:${ci('pass')}(?:${ci('word')}|${ci('wd')})|${ci('secret')}|${ci('token')}|${ci('api')}[_-]?${ci('key')})`;
  const pass = ci('pass');
  const secretish = `(?=[^\\s"'<>]*\\d)(?=[^\\s"'<>]*[A-Za-z])`;
  return new RegExp([
    `(?<![A-Za-z0-9])(?:`,
    `${key}["']?\\s*[:=]\\s*["']?${value}`,
    `|["']${pass}["']\\s*[:=]\\s*["']?${value}`,
    `|${pass}\\s*[:=]\\s*["']${value}`,
    `|${pass}\\s*=\\s*${value}`,
    `|(?<=_)${pass}["']?\\s*[:=]\\s*["']?${value}`,
    `|(?<=^\\s+|[.{,]\\s*|^\\s*-\\s+)pass\\s*:\\s*${value}`,
    `|pass:${secretish}${value}`,
    `|(?<=^)pass\\s*:\\s*${secretish}${value}`,
    ')',
  ].join(''), 'm');
}

export const MASK = '[secret]';
// replace() with a non-global pattern replaces only the first match: global copies, built once.
const GLOBAL_RULES = SECRET_RULES.map(([, re]) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`));

// The text with every match of every rule replaced by [secret]; anything but a string reads as ''.
export function maskSecrets(text) {
  let s = typeof text === 'string' ? text : '';
  for (const re of GLOBAL_RULES) s = s.replace(re, MASK);
  return s;
}
