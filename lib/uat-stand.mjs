import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runDir } from './paths.mjs';
import { readJson } from './fsx.mjs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackHost(host) {
  const h = String(host).toLowerCase();
  return LOOPBACK.has(h) || /^127(\.\d{1,3}){3}$/.test(h) || h.endsWith('.localhost');
}

export function isLoopbackUrl(u) {
  try {
    const url = new URL(u);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

// What a message may show of a URL: scheme and host, never userinfo, path, query or fragment; nothing of an
// unparsable one.
function shownHost(u) {
  try {
    const url = new URL(u);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '(unparsable URL)';
  }
}

// Spec §6.3: the stand is loopback only; forbidden_hosts are never reached.
export function standCheck(uat = {}) {
  const baseUrl = String(uat?.base_url || '').trim();
  const forbiddenHosts = Array.isArray(uat?.forbidden_hosts) ? uat.forbidden_hosts.map(String) : [];
  if (baseUrl && !isLoopbackUrl(baseUrl)) return { ok: false, reason: `uat.base_url must be a loopback URL (localhost, 127.0.0.1 or [::1]): ${shownHost(baseUrl)}`, forbiddenHosts };
  return { ok: true, baseUrl: baseUrl || null, inferred: !baseUrl, boot: String(uat?.boot || ''), seed: String(uat?.seed || ''), forbiddenHosts };
}

const SAFE_SCHEMES = new Set(['data:', 'blob:', 'about:', 'chrome:', 'chrome-extension:']);

export function netViolations(urls, { forbiddenHosts = [] } = {}) {
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
    // origin drops userinfo; a URL without an origin (file:, or "user:pw@host" read as a scheme) carries
    // everything in its path, so only its scheme and host are shown
    const shown = url.origin === 'null' ? shownHost(u) : `${url.origin}${url.pathname}`;
    if (forbiddenHosts.some((f) => { const h = String(f).toLowerCase(); return host === h || host.endsWith(`.${h}`); })) bad.push({ url: shown, why: 'forbidden host' });
    else if (!isLoopbackHost(host)) bad.push({ url: shown, why: 'not loopback' });
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
  fs.rmSync(dir, { recursive: true, force: true });
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
  fs.rmSync(standDir(root, phase), { recursive: true, force: true });
}
