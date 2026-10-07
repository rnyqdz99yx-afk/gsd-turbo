import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runDir } from './paths.mjs';
import { readJson } from './fsx.mjs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const HTTP_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);
// schemes whose name is a real scheme; any other may be a "user:" that a scheme-less "user:pw@host" was read as
const KNOWN_SCHEMES = new Set([...HTTP_SCHEMES, 'ftp:', 'file:']);
// a dev server can still hold files in the stand for a moment after it stops (EBUSY/EPERM on Windows)
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };

export function isLoopbackHost(host) {
  const h = String(host).toLowerCase();
  return LOOPBACK.has(h) || /^127(\.\d{1,3}){3}$/.test(h) || h.endsWith('.localhost');
}

export function isLoopbackUrl(u) {
  try {
    const url = new URL(u);
    return HTTP_SCHEMES.has(url.protocol) && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

// What a message may show of a URL: a known scheme and the host, never userinfo, path, query or fragment; nothing
// of an unparsable URL or of one with an unknown scheme.
function shownHost(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return '(unparsable URL)';
  }
  return KNOWN_SCHEMES.has(url.protocol) ? `${url.protocol}//${url.host}` : '(opaque URL)';
}

// A forbidden_hosts entry as the host name URLs report: a scheme, port, path or userinfo around it is dropped.
function hostOf(entry) {
  const s = String(entry ?? '').trim().toLowerCase();
  if (!s) return null;
  try {
    return new URL(s.includes('://') ? s : `http://${s}`).hostname || null;
  } catch {
    return null;
  }
}

function forbiddenList(list) {
  if (!Array.isArray(list)) throw new Error('forbidden_hosts must be a list of host names');
  return list.map((e, i) => {
    const h = hostOf(e);
    if (!h) throw new Error(`forbidden_hosts entry ${i + 1} is not a host name`);
    return h;
  });
}

const isForbidden = (host, forbidden) => forbidden.some((h) => host === h || host.endsWith(`.${h}`));

// Spec §6.3: the stand is loopback only; forbidden_hosts are never reached. Refusals show a URL's scheme and host
// only, and a forbidden_hosts entry only by its position.
export function standCheck(uat = {}) {
  const baseUrl = String(uat?.base_url || '').trim();
  let forbiddenHosts;
  try {
    forbiddenHosts = forbiddenList(uat?.forbidden_hosts ?? []);
  } catch (err) {
    return { ok: false, reason: `uat.${err.message}`, forbiddenHosts: [] };
  }
  const refuse = (reason) => ({ ok: false, reason: `${reason}: ${shownHost(baseUrl)}`, forbiddenHosts });
  if (baseUrl) {
    if (!isLoopbackUrl(baseUrl)) return refuse('uat.base_url must be a loopback URL (localhost, 127.0.0.1 or [::1])');
    const url = new URL(baseUrl);
    // the stand's one-time credentials come from prepareStand, never from the config
    if (url.username || url.password) return refuse('uat.base_url must not carry credentials (user:password@)');
    if (isForbidden(url.hostname.toLowerCase(), forbiddenHosts)) return refuse('uat.base_url is one of uat.forbidden_hosts');
  }
  return { ok: true, baseUrl: baseUrl || null, inferred: !baseUrl, boot: String(uat?.boot || ''), seed: String(uat?.seed || ''), forbiddenHosts };
}

const SAFE_SCHEMES = new Set(['data:', 'blob:', 'about:', 'chrome:', 'chrome-extension:']);

// Each violation shows the URL's scheme and host only: paths and queries can carry tokens.
export function netViolations(urls, { forbiddenHosts = [] } = {}) {
  const forbidden = forbiddenList(forbiddenHosts);
  const bad = [];
  for (const raw of urls) {
    const u = String(raw ?? '').trim();
    if (!u) continue;
    let url;
    try {
      url = new URL(u);
    } catch {
      bad.push({ url: shownHost(u), why: 'unparsable' });
      continue;
    }
    if (SAFE_SCHEMES.has(url.protocol)) continue;
    const host = url.hostname.toLowerCase();
    if (isForbidden(host, forbidden)) bad.push({ url: shownHost(u), why: 'forbidden host' });
    else if (!HTTP_SCHEMES.has(url.protocol)) bad.push({ url: shownHost(u), why: 'scheme not allowed' });
    else if (!isLoopbackHost(host)) bad.push({ url: shownHost(u), why: 'not loopback' });
  }
  return bad;
}

// The phase id names one directory under run/ that prepareStand and cleanupStand delete recursively, so it never
// carries a path separator (the same rule as the CLI's phase argument).
const phaseSeg = (phase) => {
  const p = String(phase ?? '');
  if (!/^[A-Za-z0-9._-]+$/.test(p)) throw new Error(`invalid phase id for the UAT stand: ${JSON.stringify(p)}`);
  return p;
};

export const standDir = (root, phase) => path.join(runDir(root), `uat-p${phaseSeg(phase)}`);
export const evidenceDir = (root, phase) => path.join(runDir(root), 'evidence', `p${phaseSeg(phase)}`);

export function prepareStand(root, phase, { random = randomBytes } = {}) {
  const dir = standDir(root, phase);
  fs.rmSync(dir, RM);
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const credsFile = path.join(dir, 'creds.json');
  const creds = { username: `turbo-uat-${random(3).toString('hex')}`, password: random(18).toString('base64url') };
  fs.writeFileSync(credsFile, `${JSON.stringify(creds)}\n`, { mode: 0o600 });
  return { dataDir, credsFile };
}

export function readStandSecrets(root, phase) {
  const c = readJson(path.join(standDir(root, phase), 'creds.json'), null);
  return c?.password ? [String(c.password)] : [];
}

export function cleanupStand(root, phase) {
  fs.rmSync(standDir(root, phase), RM);
}
