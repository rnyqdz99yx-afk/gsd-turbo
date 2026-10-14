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

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}
