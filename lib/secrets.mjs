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
  // A key (quoted or not, alone or the end of an identifier such as DB_PASSWORD), ':' or '=', a value of 6+
  // characters. A bare "pass" is a key only when quoted ("pass":), right before '=' (pass=) or after '_'
  // (DB_PASS:): prose such as "PASS: dry-run complete" or "the tests pass: ..." is no finding.
  ['credential assignment', /(?<![A-Za-z0-9])(?:(?:pass(?:word|wd)|secret|token|api[_-]?key)["']?\s*[:=]|["']pass["']\s*[:=]|pass=|(?<=_)pass["']?\s*[:=])\s*["']?[^\s"'<>]{6,}/i],
];

export const MASK = '[secret]';
// replace() with a non-global pattern replaces only the first match: global copies, built once.
const GLOBAL_RULES = SECRET_RULES.map(([, re]) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`));

// The text with every match of every rule replaced by [secret]; anything but a string reads as ''.
export function maskSecrets(text) {
  let s = typeof text === 'string' ? text : '';
  for (const re of GLOBAL_RULES) s = s.replace(re, MASK);
  return s;
}
