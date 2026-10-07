import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson } from './fsx.mjs';

export const HOOK_URL = pathToFileURL(fileURLToPath(new URL('./import-graph-hook.mjs', import.meta.url))).href;

export function graphEnv(env, dir) {
  return { ...env, TURBO_GRAPH_DIR: dir, NODE_OPTIONS: `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--import=${HOOK_URL}` };
}

const relIn = (root, f) => {
  const r = path.relative(root, f).split(path.sep).join('/');
  return !r || r.startsWith('..') || path.isAbsolute(r) || r.includes('node_modules/') ? null : r;
};

export function collectGraph({ root, dir, fullSha, isTest }) {
  if (!fs.existsSync(dir) || fs.existsSync(path.join(dir, 'unsupported'))) return null;
  const tests = {};
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const rec = readJson(path.join(dir, name), null);
    const entry = rec?.entry ? relIn(root, rec.entry) : null;
    if (!entry || !isTest(entry) || !Array.isArray(rec.files)) continue;
    tests[entry] = [...new Set([...(tests[entry] || []), ...rec.files.map((f) => relIn(root, f)).filter((f) => f && f !== entry)])].sort();
  }
  return Object.keys(tests).length ? { fullSha, node: process.version, tests } : null;
}

// Tests whose recorded graph loads `file`; a test always covers itself.
export function testsLoading(graph, file) {
  return Object.entries(graph.tests).filter(([t, deps]) => t === file || deps.includes(file)).map(([t]) => t);
}
