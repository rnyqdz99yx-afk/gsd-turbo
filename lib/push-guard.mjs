import { MASK, maskSecrets } from './secrets.mjs';

// What S2 adds to the shared secret rules (spec §6, S2): masking for git and gh output, and the file names never pushed.

// user:password@ inside a URL (git prints remote URLs in its errors)
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

// git or gh output as it may reach a log, a record, the inbox or a notification: every match of the shared rules and
// every URL credential replaced by [secret]; anything else unchanged.
export function maskOutput(text) {
  return maskSecrets(String(text ?? '')).replace(URL_USERINFO, `$1${MASK}@`);
}

// File names that are never pushed (spec §6, S2), matched on the base name in any case.
const FORBIDDEN_NAMES = Object.freeze([
  ['.env*', /^\.env/i],
  ['*.session', /\.session$/i],
  ['*.db', /\.db$/i],
  ['*.sqlite', /\.sqlite$/i],
  ['*.log', /\.log$/i],
  ['accounts.json', /^accounts\.json$/i],
  ['*.pem', /\.pem$/i],
  ['*.key', /\.key$/i],
]);

// "forbidden name <glob>" for a repository path (forward slashes) whose base name is on the list, else null.
export function forbiddenName(file) {
  const base = String(file ?? '').split('/').pop();
  const hit = FORBIDDEN_NAMES.find(([, re]) => re.test(base));
  return hit ? `forbidden name ${hit[0]}` : null;
}
