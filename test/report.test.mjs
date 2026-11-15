import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpDir } from './helpers/tmp.mjs';
import {
  REPORT_REPO, describeRecord, draftReport, dropReport, fingerprint, pendingReports, readRecords, recordFailure, renderReport,
  reportRepo, reportsDir, reportsLine, runReportCommand, scrub, sendReport, turboFrames,
} from '../lib/report.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'turbo-run.mjs');
const VERSIONS = { turbo: '9.9.9', gsd: '1.21.0', claude: '2.1.325', node: 'v24.0.0', os: 'linux 6.1 x64' };
const WIN = { root: 'D:\\home\\bob\\work\\acme-shop', home: 'D:\\home\\bob', user: 'bob', install: 'D:\\home\\bob\\.claude\\turbo', claudeHome: 'D:\\home\\bob\\.claude', platform: 'win32' };
const NIX = { root: '/home/bob/work/acme-shop', home: '/home/bob', user: 'bob', install: '/home/bob/.claude/turbo', claudeHome: '/home/bob/.claude', platform: 'linux' };

// a machine of its own per test: reports under a throwaway Claude home, a project that is not this checkout, fixed
// versions (no claude --version), no gh unless the test gives one
function machine(extra = {}) {
  const home = tmpDir('rep-home');
  const root = tmpDir('rep-proj');
  let clock = Date.parse('2026-11-15T10:00:00Z');
  return { env: { CLAUDE_CONFIG_DIR: home }, root, versions: VERSIONS, ghBin: null, now: () => new Date((clock += 1000)), ...extra };
}
// gh as a list of answers by its first two arguments; every call is kept
function fakeGh(answers) {
  const calls = [];
  const exec = (bin, args, opts) => {
    calls.push({ bin, args, input: opts?.input });
    const a = answers[`${args[0]} ${args[1]}`];
    if (a instanceof Error) throw a;
    return a ?? '';
  };
  return { exec, calls };
}
const boom = (message = "Cannot read properties of undefined (reading 'k')") => new TypeError(message);

test('scrub: Windows paths keep only what is turbo\'s own', () => {
  const s = (t) => scrub(t, WIN);
  assert.equal(s("ENOENT: no such file or directory, open 'D:\\home\\bob\\work\\acme-shop\\.planning\\turbo\\run\\p35.json'"), "ENOENT: no such file or directory, open '<project>/.planning/turbo/run/p35.json'");
  assert.equal(s('cannot read D:\\home\\bob\\work\\acme-shop\\src\\billing\\secret.js now'), 'cannot read <project>/<…> now');
  assert.equal(s('D:/home/bob/work/acme-shop.turbo/lane-2/.planning/phases/37-final-release/37-UAT.md'), '<project>/.planning/phases/37-…/37-UAT.md');
  assert.equal(s('at D:\\home\\bob\\.claude\\turbo\\lib\\supervisor.mjs'), 'at <turbo>/lib/supervisor.mjs');
  assert.equal(s('Command failed: node D:\\home\\bob\\.claude\\gsd-core\\bin\\gsd-tools.cjs init manager'), 'Command failed: node <gsd-core>/bin/gsd-tools.cjs init manager');
  assert.equal(s('D:\\home\\bob\\.claude\\projects\\D--home-bob-work-acme-shop\\x.jsonl'), '<claude>/<…>');
  assert.equal(s('D:\\home\\bob\\Desktop\\notes.txt'), '~/<…>');
  assert.equal(s('D:\\other\\thing.txt and /c/Users/bob/work/x'), '<path> and <path>');
  assert.equal(s('trust d:\\HOME\\BOB\\work\\ACME-shop: no'), 'trust <project>: no');
});

test('scrub: POSIX paths, names, links and secrets', () => {
  const s = (t) => scrub(t, NIX);
  assert.equal(s('open /home/bob/work/acme-shop/.planning/STATE.md failed'), 'open <project>/.planning/STATE.md failed');
  assert.equal(s('/home/bob/work/acme-shop/src/pay.js'), '<project>/<…>');
  assert.equal(s('/home/bob/.claude/turbo/lib/build.mjs:12'), '<turbo>/lib/build.mjs:12');
  assert.equal(s('/usr/local/bin/gh --flag=/opt/x/y'), '<path> --flag=<path>');
  assert.equal(s('branch acme-shop-feature of bob, 3/4 done, either/or'), 'branch <project>-feature of <user>, 3/4 done, either/or');
  assert.equal(s('see https://github.com/rnyqdz99yx-afk/gsd-turbo/issues/1 and /turbo-autonomous status'), 'see https://github.com/rnyqdz99yx-afk/gsd-turbo/issues/1 and /turbo-autonomous status');
  assert.equal(s('.planning/phases/04.1-customer-billing/04.1-02-PLAN.md'), '.planning/phases/04.1-…/04.1-02-PLAN.md');
  assert.ok(!s(`token=ghp_${'a'.repeat(36)} here`).includes('ghp_'));
});

test('scrub: a generic folder or user name is left alone', () => {
  assert.equal(scrub('turbo-run test of the project', { ...NIX, root: '/srv/turbo', user: 'test' }), 'turbo-run test of the project');
});

test('turboFrames: only turbo\'s own files, relative to its directory', () => {
  const install = tmpDir('rep-install');
  const url = (...p) => pathToFileURL(path.join(install, ...p)).href;
  const err = { stack: [
    "TypeError: x is not a function",
    `    at failedTick (${url('lib', 'supervisor.mjs')}:1446:3)`,
    `    at async tick (${url('lib', 'supervisor.mjs')}:1535:20)`,
    '    at ModuleJob.run (node:internal/modules/esm/module_job:268:25)',
    `    at thing (${pathToFileURL(path.join(tmpDir('rep-other'), 'secret-project', 'a.mjs')).href}:1:1)`,
    `    at ${url('bin', 'turbo-run.mjs')}:1429:1`,
  ].join('\n') };
  assert.deepEqual(turboFrames(err, { install }), ['failedTick (lib/supervisor.mjs:1446)', 'tick (lib/supervisor.mjs:1535)', '<anonymous> (bin/turbo-run.mjs:1429)']);
});

test('fingerprint: the same failure whatever the numbers and line numbers; another failure differs', () => {
  const a = fingerprint({ kind: 'tick', name: 'Error', message: 'launch phase 2 failed: exit status 1', frames: ['tick (lib/supervisor.mjs:10)'] });
  const b = fingerprint({ kind: 'stuck', name: 'Error', message: 'launch phase 37 failed: exit status 3', frames: ['tick (lib/supervisor.mjs:99)'] });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{10}$/);
  assert.notEqual(a, fingerprint({ kind: 'tick', name: 'Error', message: 'gsd-core not found', frames: [] }));
  assert.equal(fingerprint({ kind: 'agent', title: 'Status shows a dead lane 35 as running' }), fingerprint({ kind: 'agent', title: 'status shows a dead lane 7 as running' }));
});

test('draftReport: an engine failure is written under turbo\'s own directory, with nothing of the project in it', () => {
  const m = machine();
  const err = boom(`cannot read ${path.join(m.root, 'src', 'billing.js')}`);
  const r = draftReport({ kind: 'crash', err, cmd: 'daemon' }, m);
  assert.equal(r.duplicate, false);
  assert.match(r.id, /^\d{8}T\d{6}Z-[0-9a-f]{10}$/);
  assert.ok(fs.existsSync(path.join(reportsDir(m.env), `${r.id}.json`)));
  const { title, body } = renderReport(r.record);
  assert.match(title, new RegExp(`^\\[turbo-report ${r.record.fp}\\] TypeError: cannot read <project>/<…>$`));
  assert.ok(body.includes('`turbo-run daemon` ended with an unexpected error'));
  assert.ok(body.includes('| 9.9.9 | 1.21.0 | 2.1.325 | v24.0.0 | linux 6.1 x64 |'));
  assert.ok(!body.includes(m.root) && !body.includes(path.basename(m.root)) && !body.includes('billing'));
  // the same failure again: no second record
  const again = draftReport({ kind: 'crash', err: boom(`cannot read ${path.join(m.root, 'src', 'other.js')}`), cmd: 'daemon' }, m);
  assert.deepEqual([again.duplicate, again.id], [true, r.id]);
  assert.equal(readRecords(m).length, 1);
});

test('draftReport: a command name that is not a plain word never reaches the report', () => {
  const m = machine();
  const { body } = renderReport(draftReport({ kind: 'crash', err: boom(), cmd: '--project=/x/secret' }, m).record);
  assert.ok(body.includes('`turbo-run` ended with an unexpected error') && !body.includes('secret'));
});

test('draftReport: a failed child process keeps its program and subcommand, never the rest of its command line', () => {
  const m = machine({ claudeHome: path.join(tmpDir('rep-ch'), '.claude') });
  const line = (message) => draftReport({ kind: 'crash', err: new Error(message) }, m).record.error;
  assert.equal(line('Command failed: git commit -m feat(billing): invoices for Acme src/pay.js\nfatal: x'), 'Error: Command failed: git commit …');
  assert.equal(line('Command failed: git rev-parse --show-toplevel'), 'Error: Command failed: git rev-parse …');
  assert.equal(line(`Command failed: node ${path.join(m.claudeHome, 'gsd-core', 'bin', 'gsd-tools.cjs')} commit docs(37): customer portal plan --files .planning/phases/37-portal/37-01-PLAN.md`), 'Error: Command failed: node <gsd-core>/bin/gsd-tools.cjs commit …');
  assert.equal(line(`Command failed: ${path.join(m.root, 'tools', 'acme-deploy.sh')} Production Secret`), 'Error: Command failed: <project>/<…> …');
  assert.equal(line('Command failed: git status'), 'Error: Command failed: git status');
  assert.equal(line('launch phase 2 failed: claude --bg failed: exit status 1'), 'Error: launch phase 2 failed: claude --bg failed: exit status 1');
});

test('in a lane or a role session a report can be written up and read, never sent, dropped or changed', () => {
  const gh = fakeGh({ 'issue list': '[]', 'issue create': `https://github.com/${REPORT_REPO}/issues/3\n` });
  const m = machine({ ghBin: '/bin/gh', exec: gh.exec });
  const lane = { ...m, env: { ...m.env, TURBO_LANE: '1' } };
  const lines = [];
  const run = (deps, ...args) => { lines.length = 0; return runReportCommand(args, { out: (l) => lines.push(l), deps }); };
  assert.equal(run(lane, '--summary', 'the lane saw turbo print a wrong step'), 0);
  const id = /^recorded: (\S+)/.exec(lines[0])[1];
  assert.match(lines.at(-1), /^next: nothing here: the owner's session offers it/);
  for (const verb of ['send', 'drop', 'describe']) {
    assert.equal(run(lane, verb, id, '--summary', 'x'), 1);
    assert.deepEqual(lines, [`refused: report ${verb} is the owner's: a lane never runs it`]);
  }
  assert.equal(gh.calls.length, 0);
  assert.equal(pendingReports(m).length, 1);
  assert.match(recordFailure({ kind: 'crash', err: boom() }, lane), /recorded, not sent: the owner's session offers it to the owner/);
  // the same report from the owner's session
  assert.equal(run(m, 'send', id), 0);
  assert.equal(gh.calls.length, 2);
});

test('reportsLine: the waiting reports in the owner\'s session; nothing in a lane or under node --test', () => {
  const m = machine();
  assert.equal(reportsLine('en', m), null);
  draftReport({ kind: 'tick', err: boom() }, m);
  assert.match(reportsLine('en', m), /^turbo failure reports: 1 not sent/);
  assert.match(reportsLine('ru', m), /^отчёты об ошибках turbo: не отправлено 1/);
  assert.equal(reportsLine('en', { ...m, env: { ...m.env, TURBO_LANE: '1' } }), null);
  assert.equal(reportsLine('en', { ...m, env: { ...m.env, NODE_TEST_CONTEXT: 'child-v8' } }), null);
});

test('draftReport: the agent\'s words are scrubbed and cut; a summary is required', () => {
  const m = machine();
  const r = draftReport({ kind: 'agent', title: `status shows lane 35 as running in ${m.root}`, summary: `${'x'.repeat(2000)} ${m.root}` }, m);
  assert.equal(r.record.title, 'status shows lane 35 as running in <project>');
  assert.equal(r.record.summary.length, 1500);
  assert.ok(renderReport(r.record).body.includes('checked it and wrote it up'));
  assert.throws(() => draftReport({ kind: 'agent', title: 't', summary: '  ' }, m), /summary/);
});

test('sendReport: without gh nothing is sent and a link to file it by hand comes back', () => {
  const m = machine();
  const { id } = draftReport({ kind: 'tick', err: boom() }, m);
  const r = sendReport(id, m);
  assert.equal(r.url, null);
  assert.match(r.why, /gh/);
  assert.ok(r.link.startsWith(`https://github.com/${REPORT_REPO}/issues/new?title=%5Bturbo-report`));
  assert.equal(readRecords(m)[0].sent, null);
});

test('sendReport: a new failure becomes an issue; a second send does nothing', () => {
  const gh = fakeGh({ 'issue list': '[]', 'issue create': `Creating issue…\nhttps://github.com/${REPORT_REPO}/issues/7\n` });
  const m = machine({ ghBin: '/bin/gh', exec: gh.exec });
  const { id, record } = draftReport({ kind: 'tick', err: boom() }, m);
  const r = sendReport(id, m);
  assert.equal(r.url, `https://github.com/${REPORT_REPO}/issues/7`);
  const [list, create] = gh.calls;
  assert.deepEqual(list.args.slice(0, 4), ['issue', 'list', '-R', `github.com/${REPORT_REPO}`]);
  assert.ok(list.args.includes(`${record.fp} in:title`));
  assert.deepEqual(create.args, ['issue', 'create', '-R', `github.com/${REPORT_REPO}`, '--title', renderReport(record).title, '--body-file', '-']);
  assert.equal(create.input, renderReport(record).body);
  assert.equal(readRecords(m)[0].sent.url, r.url);
  assert.deepEqual(sendReport(id, m), { url: r.url, already: true });
  assert.equal(gh.calls.length, 2);
});

test('sendReport: a failure that already has an open issue is added to it as a comment', () => {
  const gh = fakeGh({ 'issue list': JSON.stringify([{ number: 4, url: `https://github.com/${REPORT_REPO}/issues/4` }]), 'issue comment': 'ok' });
  const m = machine({ ghBin: '/bin/gh', exec: gh.exec });
  const { id } = draftReport({ kind: 'tick', err: boom() }, m);
  assert.deepEqual(sendReport(id, m), { url: `https://github.com/${REPORT_REPO}/issues/4`, comment: true });
  assert.deepEqual(gh.calls[1].args.slice(0, 3), ['issue', 'comment', '4']);
  assert.equal(readRecords(m)[0].sent.comment, true);
});

test('sendReport: a gh failure leaves the report unsent, with the reason and the link', () => {
  const failure = Object.assign(new Error('Command failed'), { status: 1, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' });
  const gh = fakeGh({ 'issue list': failure });
  const m = machine({ ghBin: '/bin/gh', exec: gh.exec });
  const { id } = draftReport({ kind: 'tick', err: boom() }, m);
  const r = sendReport(id, m);
  assert.equal(r.url, null);
  assert.match(r.why, /gh auth login/);
  assert.ok(r.link);
  assert.equal(pendingReports(m).length, 1);
  assert.equal(sendReport('20260101T000000Z-0000000000', m).missing, true);
});

test('the target repository: TURBO_REPORT_REPO when it names one, else turbo\'s own', () => {
  assert.equal(reportRepo({}), REPORT_REPO);
  assert.equal(reportRepo({ TURBO_REPORT_REPO: 'me/fork' }), 'me/fork');
  assert.equal(reportRepo({ TURBO_REPORT_REPO: 'https://evil.example/x' }), REPORT_REPO);
});

test('describe adds the agent\'s check to a recorded failure; drop takes it off the waiting list', () => {
  const m = machine();
  const { id } = draftReport({ kind: 'stuck', err: new Error('launch phase 2 failed: claude --bg failed: exit status 1'), minutes: 10 }, m);
  assert.ok(renderReport(readRecords(m)[0]).body.includes('could not go on for 10 min'));
  describeRecord(id, `checked: the log repeats it since the update; project at ${m.root}`, m);
  assert.ok(renderReport(readRecords(m)[0]).body.includes('> checked: the log repeats it since the update; project at <project>'));
  assert.equal(pendingReports(m).length, 1);
  dropReport(id, m);
  assert.equal(pendingReports(m).length, 0);
});

test('recordFailure: one line for the log; nothing under node --test, when switched off, or for a closed pipe; never throws', () => {
  const m = machine();
  assert.match(recordFailure({ kind: 'tick', err: boom() }, m), /^turbo failure report \S+ recorded, not sent: .*turbo-run report show /);
  assert.equal(recordFailure({ kind: 'tick', err: boom() }, m), null); // the same failure: told once
  assert.match(recordFailure({ kind: 'tick', err: boom() }, { ...m, again: true }), /recorded, not sent/);
  const count = readRecords(m).length;
  assert.equal(recordFailure({ kind: 'tick', err: boom('other') }, { ...m, env: { ...m.env, NODE_TEST_CONTEXT: 'child-v8' } }), null);
  assert.equal(recordFailure({ kind: 'tick', err: boom('other') }, { ...m, env: { ...m.env, TURBO_REPORT: 'off' } }), null);
  assert.equal(recordFailure({ kind: 'crash', err: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) }, m), null);
  assert.equal(recordFailure({ kind: 'crash', err: boom('third') }, { ...m, now: () => { throw new Error('clock'); } }), null);
  assert.equal(readRecords(m).length, count);
});

test('turbo-run report: write up, list, show, send, drop', () => {
  const gh = fakeGh({ 'issue list': '[]', 'issue create': `https://github.com/${REPORT_REPO}/issues/9\n` });
  const m = machine({ ghBin: '/bin/gh', exec: gh.exec });
  const lines = [];
  const run = (...args) => { lines.length = 0; return runReportCommand(args, { root: m.root, out: (l) => lines.push(l), deps: m }); };
  assert.equal(run(), 0);
  assert.deepEqual(lines, ['turbo failure reports: none']);
  assert.equal(run('--title', 'status shows a dead lane as running', '--summary', 'lane 35 reads as closing the phase; its build pid is dead'), 0);
  const id = /^recorded: (\S+)/.exec(lines[0])[1];
  assert.ok(lines.some((l) => l.startsWith('title: [turbo-report ')) && lines.at(-1).includes(`turbo-run report send ${id}`));
  assert.equal(run('list'), 0);
  assert.match(lines[0], /^turbo failure reports: 1 waiting for the owner's yes/);
  assert.equal(run('show', id), 0);
  assert.ok(lines.join('\n').includes('> lane 35 reads as closing the phase'));
  assert.equal(run('send', id), 0);
  assert.deepEqual(lines, [`sent: https://github.com/${REPORT_REPO}/issues/9`]);
  assert.equal(run('drop', id), 1); // sent already: nothing to drop
  assert.equal(run('send', 'nope'), 1);
  assert.equal(run('show'), 2);
  assert.equal(run('--title', 'no summary'), 2);
  assert.equal(run('frobnicate'), 2);
});

test('turbo-run report through the CLI: recorded under the Claude home, listed by status', () => {
  const home = tmpDir('rep-cli-home');
  const root = tmpDir('rep-cli-proj');
  fs.mkdirSync(path.join(root, '.planning'));
  // status names the waiting reports only outside the test runner: this test stands in for the owner's session
  // (TURBO_UPDATE_CHECK off: outside the test runner a status would also look for a newer turbo on the network)
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home, TURBO_CONTROL_ROOT: '', TURBO_UPDATE_CHECK: 'off' };
  delete env.NODE_TEST_CONTEXT;
  delete env.TURBO_LANE;
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, env });
  const made = cli('report', '--summary', 'the pane shows a finished phase as running');
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /^recorded: \d{8}T\d{6}Z-[0-9a-f]{10} /);
  assert.equal(fs.readdirSync(path.join(home, 'turbo', 'reports')).length, 1);
  assert.match(cli('status').stdout, /turbo failure reports: 1 not sent/);
});
