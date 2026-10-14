import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { readJson, readJsonState, writeFileDurable, writeJsonAtomic } from '../lib/fsx.mjs';

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

test('a file system that cannot flush a file (EINVAL, ENOTSUP) still gets the write, unflushed', () => {
  const file = path.join(tmpDir('fsx'), 'state.json');
  const { fsyncSync } = fs;
  for (const code of ['EINVAL', 'ENOTSUP']) {
    fs.fsyncSync = () => {
      throw Object.assign(new Error(`${code}: fsync`), { code });
    };
    try {
      writeJsonAtomic(file, { code });
    } finally {
      fs.fsyncSync = fsyncSync;
    }
    assert.deepEqual(readJson(file), { code });
  }
});

test('writeFileDurable flushes the data and keeps the mode it is given', { skip: process.platform === 'win32' && 'Windows has no POSIX modes' }, () => {
  const file = path.join(tmpDir('fsx'), 'private.json');
  writeFileDurable(file, '{}\n', { mode: 0o600 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{}\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

// A state file a crash left behind is told apart from one never written: empty, zero bytes (the 526 NUL bytes seen after a
// bugcheck), cut short, or not an object are damaged; a file that cannot be read says why.
test('readJsonState tells missing, valid and damaged apart (empty, zero bytes, truncated JSON, not an object, unreadable)', () => {
  const dir = tmpDir('fsx');
  const file = (name, data) => {
    const f = path.join(dir, name);
    if (data !== undefined) fs.writeFileSync(f, data);
    return f;
  };
  assert.deepEqual(readJsonState(file('none.json')), { state: 'missing', value: null, why: null });
  assert.deepEqual(readJsonState(path.join(file('plain.txt', 'x'), 'sub.json')), { state: 'missing', value: null, why: null }, 'a file where a directory should be');
  assert.deepEqual(readJsonState(file('ok.json', '﻿{"pid":42}\n')), { state: 'valid', value: { pid: 42 }, why: null });
  assert.deepEqual(readJsonState(file('empty.json', '')), { state: 'damaged', value: null, why: 'empty (0 bytes)', bytes: 0 });
  assert.deepEqual(readJsonState(file('nul.json', Buffer.alloc(526))), { state: 'damaged', value: null, why: '526 zero bytes', bytes: 526 });
  const full = JSON.stringify({ pid: 42, lanes: { 38: { phase: '38', slot: 1 } } }, null, 2);
  assert.deepEqual(readJsonState(file('cut.json', full.slice(0, 30))), { state: 'damaged', value: null, why: 'not JSON (30 bytes)', bytes: 30 });
  // a crash may also leave the start of the data and zero bytes after it
  assert.equal(readJsonState(file('tail.json', Buffer.concat([Buffer.from(full.slice(0, 20)), Buffer.alloc(100)]))).why, 'not JSON (120 bytes)');
  for (const text of ['null', '[]', '42', '"x"']) assert.equal(readJsonState(file('odd.json', text)).why, `not a JSON object (${text.length} bytes)`, text);
  const isDir = path.join(dir, 'isdir.json');
  fs.mkdirSync(isDir);
  const unreadable = readJsonState(isDir);
  assert.equal(unreadable.state, 'damaged');
  assert.equal(unreadable.unreadable, true);
  assert.match(unreadable.why, /^unreadable \(E[A-Z]+\)$/);
  // readJson reads every damaged file as its fallback, as before
  assert.equal(readJson(path.join(dir, 'nul.json'), 'fallback'), 'fallback');
});
