import path from 'node:path';

// spec §11 (Stage 4 L1, D14): the modules of the sibling sub-projects, loaded when they exist: L2's merge
// (lib/merge.mjs mergeReady, then mergeFollowUp; mergeState, mergeHolds — reconcile R5), L3's jobs (lib/prep.mjs pendingJobs, jobPrompts, finishJob) and lane annotation
// (lib/lanes-file.mjs readLanesFile). Without L2 a ready lane waits; without L3 there are no jobs and no annotation
// (one phase lane at a time). Only "this very file does not exist" is null: a file it imports that is missing, any
// other load error, or a missing export this plan pins is an error.
export const PLUGIN_FILES = Object.freeze({ merge: 'merge.mjs', prep: 'prep.mjs', lanesFile: 'lanes-file.mjs' });
const EXPORTS = Object.freeze({ merge: ['mergeReady', 'mergeFollowUp', 'mergeState', 'mergeHolds'], prep: ['pendingJobs', 'jobPrompts', 'finishJob'], lanesFile: ['readLanesFile'] });
const NOT_FOUND = /Cannot find (?:module|package) '([^']+)'/;

function missingItself(err, file) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') return false;
  const m = NOT_FOUND.exec(String(err.message ?? ''));
  return Boolean(m) && path.basename(m[1].replace(/^file:\/\//, '')) === file;
}

export async function loadLanePlugins({ importer = (href) => import(href), base = import.meta.url } = {}) {
  const out = { mergeReady: null, mergeFollowUp: null, mergeState: null, mergeHolds: null, pendingJobs: null, jobPrompts: null, finishJob: null, readLanesFile: null };
  for (const [part, file] of Object.entries(PLUGIN_FILES)) {
    let mod;
    try {
      mod = await importer(new URL(`./${file}`, base).href);
    } catch (err) {
      if (missingItself(err, file)) continue;
      throw err;
    }
    for (const name of EXPORTS[part]) {
      if (typeof mod?.[name] !== 'function') throw new Error(`lib/${file} does not export the function ${name} (Stage 4 L1 interface)`);
      out[name] = mod[name];
    }
  }
  return out;
}
