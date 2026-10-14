import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Windows: rename fails transiently while another process holds the target open.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 10;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// fs.renameSync, tried again while Windows refuses it for a moment (up to RENAME_ATTEMPTS, a growing pause).
export function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_ATTEMPTS || !RENAME_RETRY_CODES.has(err.code)) throw err;
      sleepSync(20 * attempt);
    }
  }
}

// A file system that cannot flush a file (some network and FUSE mounts) answers these: the write goes on unflushed.
const NO_FSYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS']);

// The temp file of an atomic write (write it, then rename it over the target), flushed to the disk before the rename:
// a machine that crashes right after a rename whose data was still only in the cache comes back with the new name full
// of zero bytes (seen on Windows after a bugcheck: a supervisor.json of NUL bytes, read as no run at all). Flushed
// first, a crash leaves the old file or the new one, never a hole. options: fs.openSync's mode, as writeFileSync's.
export function writeFileDurable(file, data, { mode } = {}) {
  const fd = mode === undefined ? fs.openSync(file, 'w') : fs.openSync(file, 'w', mode);
  try {
    fs.writeFileSync(fd, data);
    try {
      fs.fsyncSync(fd);
    } catch (err) {
      if (!NO_FSYNC_CODES.has(err.code)) throw err;
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileDurable(tmp, JSON.stringify(obj, null, 2) + '\n');
    renameWithRetry(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // keep the original error
    }
    throw err;
  }
}

// What a JSON state file holds, told apart: missing (never written), valid (a JSON object: value) or damaged (why): it
// exists but is empty, all zero bytes (a crash right after a rename whose data never reached the disk), not JSON (cut
// short) or not an object, or it cannot be read at all (unreadable: an error code that stays after a few tries).
// readJson reads all three as its fallback; a reader that must not take a damaged file for a missing one uses this.
// A read Windows refuses for a moment (another process replaces or holds the file) is tried again READ_ATTEMPTS times
// with a growing pause before the file counts as unreadable.
const READ_ATTEMPTS = 4;
export function readJsonState(file, { sleep = sleepSync } = {}) {
  let buf;
  for (let attempt = 1; buf === undefined; attempt++) {
    try {
      buf = fs.readFileSync(file);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { state: 'missing', value: null, why: null };
      if (attempt < READ_ATTEMPTS && RENAME_RETRY_CODES.has(err.code)) {
        sleep(20 * attempt);
        continue;
      }
      return { state: 'damaged', value: null, why: `unreadable (${err.code || String(err.message).split(/\r?\n/)[0]})`, unreadable: true };
    }
  }
  const damaged = (why) => ({ state: 'damaged', value: null, why, bytes: buf.length });
  if (!buf.length) return damaged('empty (0 bytes)');
  if (buf.every((b) => b === 0)) return damaged(`${buf.length} zero bytes`);
  let value;
  try {
    value = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    return damaged(`not JSON (${buf.length} bytes)`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return damaged(`not a JSON object (${buf.length} bytes)`);
  return { state: 'valid', value, why: null };
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}
