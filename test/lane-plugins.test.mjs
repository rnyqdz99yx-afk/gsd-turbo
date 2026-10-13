import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PLUGIN_FILES, loadLanePlugins } from '../lib/lane-plugins.mjs';

const notFound = (file) => Object.assign(new Error(`Cannot find module '${file}' imported from ${fileURLToPath(import.meta.url)}`), { code: 'ERR_MODULE_NOT_FOUND' });
const absent = async (href) => { throw notFound(fileURLToPath(href)); };
const FNS = {
  mergeReady: async () => ({ outcome: 'wait' }),
  mergeFollowUp: async () => ({ outcome: 'wait' }),
  mergeState: () => null,
  mergeHolds: () => [],
  pendingJobs: () => [],
  jobPrompts: () => ({ prompt: 'p', systemPrompt: 's' }),
  finishJob: async () => ({ outcome: 'wait' }),
  readLanesFile: () => null,
};

test('loadLanePlugins: a module that does not exist yet is null; one that exists gives its functions (D14)', async () => {
  assert.deepEqual(PLUGIN_FILES, { merge: 'merge.mjs', prep: 'prep.mjs', lanesFile: 'lanes-file.mjs' });
  assert.deepEqual(await loadLanePlugins({ importer: absent }), { mergeReady: null, mergeFollowUp: null, mergeState: null, mergeHolds: null, pendingJobs: null, jobPrompts: null, finishJob: null, readLanesFile: null });
  const all = await loadLanePlugins({ importer: async () => FNS });
  for (const [name, fn] of Object.entries(FNS)) assert.equal(all[name], fn, name);
  const seen = [];
  await loadLanePlugins({ importer: async (href) => { seen.push(href.split('/').pop()); return FNS; } });
  assert.deepEqual(seen, ['merge.mjs', 'prep.mjs', 'lanes-file.mjs']);
  const onlyMerge = await loadLanePlugins({ importer: async (href) => (href.endsWith('/merge.mjs') ? FNS : absent(href)) });
  assert.deepEqual([onlyMerge.mergeReady === FNS.mergeReady, onlyMerge.mergeFollowUp === FNS.mergeFollowUp, onlyMerge.pendingJobs, onlyMerge.readLanesFile], [true, true, null, null]);
  // reconcile R5: the merge is two calls; a merge.mjs without mergeFollowUp is an error
});

test('loadLanePlugins: a module that fails inside, or lacks a pinned export, is an error, never silently off', async () => {
  // merge.mjs exists but imports a file that does not: the message names that file, not merge.mjs
  const inner = async (href) => {
    if (href.endsWith('/merge.mjs')) throw Object.assign(new Error(`Cannot find module '${fileURLToPath(new URL('./git-merge.mjs', href))}' imported from ${fileURLToPath(href)}`), { code: 'ERR_MODULE_NOT_FOUND' });
    return absent(href);
  };
  await assert.rejects(loadLanePlugins({ importer: inner }), /git-merge\.mjs/);
  await assert.rejects(loadLanePlugins({ importer: async (href) => (href.endsWith('/prep.mjs') ? { pendingJobs: () => [] } : absent(href)) }), /^Error: lib\/prep\.mjs does not export the function jobPrompts \(Stage 4 L1 interface\)$/);
  await assert.rejects(loadLanePlugins({ importer: async () => { throw new SyntaxError('Unexpected token'); } }), /Unexpected token/);
  const { mergeFollowUp: _f, ...noFollowUp } = FNS;
  await assert.rejects(loadLanePlugins({ importer: async (href) => (href.endsWith('/merge.mjs') ? noFollowUp : absent(href)) }), /^Error: lib\/merge\.mjs does not export the function mergeFollowUp/);
});
