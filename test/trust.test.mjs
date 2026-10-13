import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { CHANGE_TRIES, RENAME_PAUSE_MS, RENAME_TRIES, claudeJsonPath, trustKey, trustLine, trustSlot, trustState, untrustSlot } from '../lib/trust.mjs';

const NOW = () => new Date('2026-10-13T12:00:00.000Z');
// A copy of Claude Code's global config in a temp directory: never the developer's own.
function claudeJson() {
  const home = tmpDir('cj');
  const file = path.join(home, '.claude.json');
  const other = trustKey(path.join(home, 'other-project'));
  const data = { numStartups: 7, projects: { [other]: { allowedTools: [], hasTrustDialogAccepted: true } }, userID: 'u-test' };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { home, file, other, slot: path.join(home, 'app.turbo', 'lane-1') };
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const opts = (c, more = {}) => ({ file: c.file, now: NOW, sleep: () => {}, run: {}, ...more });
const backups = (c) => fs.readdirSync(c.home).filter((n) => n.startsWith('.claude.json.turbo-bak-')).sort();
const leftovers = (c) => fs.readdirSync(c.home).filter((n) => n.includes('.turbo-tmp-'));

test('where Claude Code keeps its config, and the key it writes for a folder (S1)', () => {
  assert.equal(claudeJsonPath({ CLAUDE_CONFIG_DIR: path.join('cfg', 'claude') }, path.join(path.sep, 'home', 'dev')), path.join(path.resolve('cfg', 'claude'), '.claude.json'));
  assert.equal(claudeJsonPath({}, path.join(path.sep, 'home', 'dev')), path.join(path.sep, 'home', 'dev', '.claude.json'));
  assert.equal(trustKey('c:\\Users\\dev\\app.turbo\\lane-1', 'win32'), 'C:/Users/dev/app.turbo/lane-1');
  assert.equal(trustKey('C:/Users/dev/app.turbo/lane-2/', 'win32'), 'C:/Users/dev/app.turbo/lane-2');
  assert.equal(trustKey('/home/dev/app.turbo/lane-1/', 'linux'), '/home/dev/app.turbo/lane-1');
  assert.equal(trustLine('/home/dev/app.turbo/lane-1'), 'open claude in /home/dev/app.turbo/lane-1 once and accept the trust dialog');
  assert.equal(trustLine('/home/dev/app.turbo/lane-1', 'ru'), 'откройте claude в /home/dev/app.turbo/lane-1 один раз и примите доверие к папке');
});

test('trust writes one value with a backup, once per command run, and changes nothing else', () => {
  const c = claudeJson();
  const before = read(c.file);
  assert.equal(trustState(c.slot, { file: c.file }), 'untrusted');
  const run = {};
  const r = trustSlot(c.slot, opts(c, { run }));
  assert.deepEqual([r.status, r.key, r.backup], ['trusted', trustKey(c.slot), `${c.file}.turbo-bak-20261013T120000Z`]);
  const after = read(c.file);
  assert.deepEqual(after, { ...before, projects: { ...before.projects, [trustKey(c.slot)]: { hasTrustDialogAccepted: true } } });
  assert.deepEqual(Object.keys(after), Object.keys(before), 'top-level order kept');
  assert.equal(trustState(c.slot, { file: c.file }), 'trusted');
  assert.deepEqual(read(path.join(c.home, backups(c)[0])), before);
  assert.equal(trustSlot(path.join(c.home, 'app.turbo', 'lane-2'), opts(c, { run })).status, 'trusted');
  assert.equal(backups(c).length, 1, 'one backup per run of the command');
  assert.equal(trustSlot(c.slot, opts(c, { run })).status, 'already');
  assert.equal(trustSlot(path.join(c.home, 'app.turbo', 'lane-3'), opts(c)).backup, `${c.file}.turbo-bak-20261013T120000Z-1`, 'a new run: a backup of its own');
  assert.deepEqual(leftovers(c), []);
});

test('an entry Claude Code already keeps is found case-insensitively on Windows and keeps its fields; untrust removes it whole', () => {
  const home = tmpDir('cjw');
  const file = path.join(home, '.claude.json');
  const other = { hasTrustDialogAccepted: true };
  fs.writeFileSync(file, JSON.stringify({ projects: { 'C:/Users/dev/other': other, 'C:/Users/Dev/App.turbo/lane-1': { allowedTools: ['Bash'], lastCost: 1.5 } } }));
  const o = { file, platform: 'win32', now: NOW, sleep: () => {}, run: {} };
  const slot = 'C:\\Users\\dev\\app.turbo\\lane-1';
  assert.equal(trustSlot(slot, o).status, 'trusted');
  assert.deepEqual(read(file).projects, { 'C:/Users/dev/other': other, 'C:/Users/Dev/App.turbo/lane-1': { allowedTools: ['Bash'], lastCost: 1.5, hasTrustDialogAccepted: true } });
  assert.equal(trustState(slot, { file, platform: 'win32' }), 'trusted');
  assert.equal(untrustSlot(slot, o).status, 'removed');
  assert.deepEqual(read(file).projects, { 'C:/Users/dev/other': other });
  assert.equal(untrustSlot(slot, o).status, 'absent');
});

test('a format turbo does not know, a missing file, or writing turned off: the owner\'s line, the file untouched', () => {
  for (const text of ['not json', '[]', '{"projects":[]}', '{"numStartups":1}', '{"projects":{"relative/key":{}}}']) {
    const c = claudeJson();
    fs.writeFileSync(c.file, text);
    const r = trustSlot(c.slot, opts(c));
    assert.deepEqual([r.status, r.line], ['manual', trustLine(c.slot)], text);
    assert.match(r.why, /is not one turbo knows/, text);
    assert.equal(fs.readFileSync(c.file, 'utf8'), text);
    assert.equal(trustState(c.slot, { file: c.file }), 'unknown');
    assert.deepEqual([backups(c), leftovers(c)], [[], []]);
  }
  const gone = claudeJson();
  fs.rmSync(gone.file);
  assert.match(trustSlot(gone.slot, opts(gone)).why, /cannot read .*ENOENT/);
  assert.equal(untrustSlot(gone.slot, opts(gone)).status, 'absent');
  const off = claudeJson();
  const bytes = fs.readFileSync(off.file, 'utf8');
  const r = trustSlot(off.slot, opts(off, { write: false, lang: 'ru' }));
  assert.deepEqual([r.status, r.line, r.why], ['manual', trustLine(off.slot, 'ru'), 'writing the trust is off: lanes.trust_write is false or --no-trust-write was given']);
  assert.equal(fs.readFileSync(off.file, 'utf8'), bytes);
  trustSlot(off.slot, opts(off));
  assert.equal(trustSlot(off.slot, opts(off, { write: false })).status, 'already', 'a trusted slot needs no write');
  assert.equal(untrustSlot(off.slot, opts(off, { write: false })).status, 'manual');
  assert.equal(trustState(off.slot, { file: off.file }), 'trusted');
});

test('rename refused while Claude Code holds the file: retried 500 ms apart; held for good: the owner\'s line, nothing left behind (Review Focus 2)', () => {
  const c = claudeJson();
  const sleeps = [];
  let fails = 2;
  const rename = (a, b) => {
    if (fails-- > 0) throw Object.assign(new Error('held'), { code: 'EPERM' });
    fs.renameSync(a, b);
  };
  assert.equal(trustSlot(c.slot, opts(c, { rename, sleep: (ms) => sleeps.push(ms) })).status, 'trusted');
  assert.deepEqual(sleeps, [RENAME_PAUSE_MS, RENAME_PAUSE_MS]);

  const d = claudeJson();
  const bytes = fs.readFileSync(d.file, 'utf8');
  const slept = [];
  const r = trustSlot(d.slot, opts(d, { rename: () => { throw Object.assign(new Error('held'), { code: 'EBUSY' }); }, sleep: (ms) => slept.push(ms) }));
  assert.equal(r.status, 'manual');
  assert.match(r.why, /cannot write .*EBUSY/);
  assert.equal(slept.length, RENAME_TRIES - 1);
  assert.equal(fs.readFileSync(d.file, 'utf8'), bytes);
  assert.deepEqual(leftovers(d), []);

  const e = claudeJson();
  const once = [];
  const r2 = trustSlot(e.slot, opts(e, { rename: () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); }, sleep: (ms) => once.push(ms) }));
  assert.deepEqual([r2.status, once], ['manual', []], 'no retry for other errors');
});

test('a file that changes while turbo writes it: read again and the change kept; changing on every try: the owner\'s line (Review Focus 2)', () => {
  const c = claudeJson();
  let changed = false;
  // Claude Code writes the file at the moment turbo has its temporary file ready
  const readOnce = (f) => {
    if (!changed && leftovers(c).length) {
      changed = true;
      const d = read(c.file);
      d.numStartups = 8;
      fs.writeFileSync(c.file, JSON.stringify(d));
    }
    return fs.readFileSync(f, 'utf8');
  };
  assert.equal(trustSlot(c.slot, opts(c, { read: readOnce })).status, 'trusted');
  assert.deepEqual([read(c.file).numStartups, read(c.file).projects[trustKey(c.slot)]], [8, { hasTrustDialogAccepted: true }]);
  assert.deepEqual(leftovers(c), []);

  const d = claudeJson();
  let n = 0;
  const readAlways = (f) => {
    if (leftovers(d).length) fs.writeFileSync(d.file, JSON.stringify({ ...read(d.file), numStartups: (n += 1) }));
    return fs.readFileSync(f, 'utf8');
  };
  const r = trustSlot(d.slot, opts(d, { read: readAlways }));
  assert.equal(r.status, 'manual');
  assert.match(r.why, new RegExp(`kept changing while turbo wrote it \\(${CHANGE_TRIES} tries\\)`));
  assert.equal(read(d.file).projects[trustKey(d.slot)], undefined);
  assert.deepEqual(leftovers(d), []);
});
