import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';

// A crash (a bugcheck, a power cut) between a rename and the moment the renamed file's data reaches the disk leaves the
// new name with zero bytes in it: a supervisor.json of NUL bytes, read as no run at all. The data is flushed first.
test('writeJsonAtomic flushes the new file to the disk before it renames it into place', () => {
  const file = path.join(tmpDir('fsx'), 'run', 'supervisor.json');
  const calls = [];
  const { fsyncSync, renameSync } = fs;
  fs.fsyncSync = (fd) => {
    calls.push('fsync');
    return fsyncSync(fd);
  };
  fs.renameSync = (from, to) => {
    calls.push(`rename ${path.basename(from).replace(/\d+$/, 'N')} ${path.basename(to)}`);
    return renameSync(from, to);
  };
  try {
    writeJsonAtomic(file, { pid: 42 });
  } finally {
    fs.fsyncSync = fsyncSync;
    fs.renameSync = renameSync;
  }
  assert.deepEqual(calls, ['fsync', 'rename supervisor.json.tmp-N supervisor.json']);
  assert.deepEqual(readJson(file), { pid: 42 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['supervisor.json'], 'no temp file left');
});

test('writeJsonAtomic leaves no temp file and keeps the old content when the flush fails', () => {
  const file = path.join(tmpDir('fsx'), 'state.json');
  writeJsonAtomic(file, { v: 1 });
  const { fsyncSync } = fs;
  fs.fsyncSync = () => {
    throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
  };
  try {
    assert.throws(() => writeJsonAtomic(file, { v: 2 }), /EIO/);
  } finally {
    fs.fsyncSync = fsyncSync;
  }
  assert.deepEqual(readJson(file), { v: 1 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
});
