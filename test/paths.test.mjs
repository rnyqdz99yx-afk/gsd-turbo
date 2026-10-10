import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dirKey } from '../lib/paths.mjs';
import { tmpDir } from './helpers/tmp.mjs';

// A transcript's cwd may name a folder that no longer exists (or never did here). Its key must still match
// the key of the real folder it was in: on a Windows runner the temp path has an 8.3 short name
// (C:\Users\RUNNER~1\…) that realpath expands for existing paths only; a link in the path does the same.
test('dirKey of a missing path keys it under its nearest existing parent, through links and short names', () => {
  const base = tmpDir('dirkey');
  const real = path.join(base, 'real');
  fs.mkdirSync(real);
  const link = path.join(base, 'link');
  fs.symlinkSync(real, link, 'junction');
  assert.equal(dirKey(path.join(link, 'gone', 'deeper')), `${dirKey(real)}/gone/deeper`);
  assert.equal(dirKey(path.join(base, 'missing')), `${dirKey(base)}/missing`);
  assert.equal(dirKey(link), dirKey(real));
});
