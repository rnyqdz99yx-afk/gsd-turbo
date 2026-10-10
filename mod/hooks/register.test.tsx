// Harness tests of the mod shell: run locally with `claude plugin test mod` (never in CI; node --test skips .tsx).
import { expect, mock, test } from 'claude-code/testing'

const VIEW = {
  v: 1,
  at: '2026-01-01T11:00:00.000Z',
  supervisor: { running: true, pid: 4242, finished: false, halted: false, failingSince: null, updatedAt: '2026-01-01T10:59:40.000Z' },
  range: { from: '32', to: '34' },
  lanes: [{
    phase: '32', step: 'execute', done: [], notes: {}, status: 'running', reason: '', sessionId: '1a2b3c4d', mode: 'full',
    launchedAt: '2026-01-01T09:48:00.000Z', elapsedMs: 4320000, transcript: null, lastAt: '2026-01-01T10:59:58.000Z', quiet: false,
    agents: [{ agentId: 'a1', type: 'gsd-executor', description: 'Execute plan 07 of phase 32', plan: '32-07', task: '2', model: 'opus', worktreeBranch: null, state: 'running', action: { tool: 'Edit', detail: 'lib/x.mjs' }, startedAt: '2026-01-01T10:54:00.000Z', lastAt: '2026-01-01T10:59:50.000Z', elapsedMs: 360000, tokens: 166000, sessionId: 's', transcript: 't' }],
    push: { outcome: 'pushed', sha: 'a1b2c3d', at: '2026-01-01T10:50:00.000Z', ci: 'green' },
  }],
  questions: [{ id: 'q1', phase: '32', plan: '32-09', task: '3', kind: 'decision', header: 'Deploy', question: 'Deploy after green CI?', options: [{ label: 'Yes, by the gate' }, { label: 'Stop' }], allowOther: true, state: 'open', rev: 1 }],
  commits: [{ sha: 'a1b2c3d', subject: 'fix: lane record keeps the reason' }],
  ui: { lang: 'en', refreshSeconds: 3 },
}
const BIN = '/home/dev/.claude/turbo/bin/turbo-run.mjs'
const BAND = { plugin: 'turbo-view', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
const PANE = { plugin: 'turbo-view', surface: 'terminal', component: 'Pane', requestId: 'turbo-view', props: { title: 'turbo', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

type Run = { exitCode: number; stdout: string; stderr: string }

const NODE = '/usr/bin/node'

// A session in /work: .planning/turbo/ exists unless turbo is false; views[i] answers the i-th view read; surfaces
// is what $.session.surfaces() reports (none: a background session nobody is attached to). PATH holds a relative
// entry and a directory without node before /usr/bin; the project itself has a node that must never run.
function stub(on, { turbo = true, views = [VIEW] as unknown[], answer = { exitCode: 0, stdout: 'answered q1 (pane)\n', stderr: '' } as Run, answerDelayMs = 0, surfaces = ['terminal'], binExists = true, pathVar = '.:relative/bin:/opt/none:/usr/bin', openFails = false, surfacesFail = 0 } = {}) {
  const calls: string[][] = []
  const toasts: string[] = []
  const probed: string[] = []
  let reads = 0
  const clock = mock.clock(on)
  mock.env(on, { CLAUDE_CONFIG_DIR: '/home/dev/.claude', PATH: pathVar })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  // a stub answers a failing call with { deny } (the call rejects in the mod)
  let surfacesLeft = surfacesFail
  on('session.surfaces', () => (surfacesLeft-- > 0 ? { deny: 'surfaces unavailable' } : { value: surfaces }))
  // the kit hands fs paths over absolute, in the platform's form (C:\work\.planning on Windows)
  on('fs.exists', (_$, e) => {
    probed.push(e.path)
    if (/[\\/]home[\\/]dev[\\/]\.claude[\\/]turbo[\\/]bin[\\/]turbo-run\.mjs$/.test(e.path)) return { value: binExists }
    if (/[\\/]usr[\\/]bin[\\/]node$/.test(e.path) || /[\\/]work[\\/]node(\.exe)?$/.test(e.path) || /relative[\\/]bin[\\/]node$/.test(e.path)) return { value: true }
    return { value: turbo && /[\\/]work[\\/]\.planning([\\/]turbo)?$/.test(e.path) }
  })
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => (openFails ? { deny: 'no room for a pane' } : { value: { isPlaced: true } }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('process.run', async (_$, e) => {
    calls.push([...e.argv])
    if (e.argv[2] === 'answer') {
      if (answerDelayMs) await clock.sleep(answerDelayMs)
      return { value: answer }
    }
    const v = views[Math.min(reads++, views.length - 1)]
    return { value: typeof v === 'string' ? { exitCode: 1, stdout: '', stderr: v } : { exitCode: 0, stdout: JSON.stringify(v), stderr: '' } }
  })
  return { calls, toasts, clock, probed }
}

const start = ($, isInteractive = true) => $.session.start({ cwd: '/work', surface: isInteractive ? 'terminal' : null, isInteractive })

test('in a turbo project the band and the pane show the view, and an option button answers through turbo-run', async ($, on) => {
  const { calls, clock } = stub(on)
  await start($)
  await clock.settle()
  expect(calls[0]).toEqual([NODE, BIN, 'view', '--json'])
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: 'turbo p32 execute · 1 agent · ? 1 question · CI ✓' })).toBeDefined()
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: /gsd-executor +32-07 Task 2 +Edit lib\/x\.mjs +6m · 166k/ })).toBeDefined()
  // the question in full, its options numbered, one short numbered button per option
  expect((await pane.find({ type: 'Text', text: '    32-09 Task 3 · Deploy after green CI?' })).props.wrap).toBe('wrap')
  expect(await pane.find({ type: 'Text', text: '      2. Stop' })).toBeDefined()
  expect((await pane.find({ key: 'q:q1:2' })).props.label).toBe('2')
  await pane.press({ key: 'q:q1:1' })
  await clock.settle()
  expect(calls.find((c) => c[2] === 'answer')).toEqual([NODE, BIN, 'answer', '32', 'q1', '--option', '1', '--by', 'pane', '--rev', '1'])
})

test('Other… opens a field whose text reaches turbo-run answer as one argument; an empty field sends nothing', async ($, on) => {
  const { calls, clock } = stub(on)
  await start($)
  await clock.settle()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'q:q1:other' })
  await pane.input({ key: 'q:q1:text', text: '   ' })
  expect(calls.some((c) => c[2] === 'answer')).toBe(false)
  await pane.press({ key: 'q:q1:other' })
  await pane.input({ key: 'q:q1:text', text: '-x "y"; да 👍' })
  await clock.settle()
  expect(calls.find((c) => c[2] === 'answer')).toEqual([NODE, BIN, 'answer', '32', 'q1', '--text', '-x "y"; да 👍', '--by', 'pane', '--rev', '1'])
})

test('a double press sends one answer while the first is on its way', async ($, on) => {
  const { calls, clock } = stub(on, { answerDelayMs: 1000 })
  await start($)
  await clock.settle()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'q:q1:1' })
  await pane.press({ key: 'q:q1:2' })
  await clock.advance(1000)
  expect(calls.filter((c) => c[2] === 'answer')).toHaveLength(1)
})

test('node runs from an absolute PATH directory: never a node in the project, never a relative PATH entry', async ($, on) => {
  const { calls, clock, probed } = stub(on)
  await start($)
  await clock.settle()
  expect(calls[0][0]).toBe(NODE)
  expect(probed.some((p) => /[\\/]work[\\/]node(\.exe)?$/.test(p) || /relative[\\/]bin[\\/]node$/.test(p))).toBe(false)
})

test('without node in PATH the band says so and nothing runs', async ($, on) => {
  const { calls, clock } = stub(on, { pathVar: '.:/opt/none' })
  await start($)
  await clock.settle()
  expect(calls).toEqual([])
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: 'turbo · ⚠ node not found in PATH' })).toBeDefined()
})

test('a missing turbo-run shows where it was looked for, and nothing is spawned', async ($, on) => {
  const { calls, clock } = stub(on, { binExists: false })
  await start($)
  await clock.settle()
  expect(calls).toEqual([])
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: `turbo · ⚠ turbo-run not found at ${BIN}` })).toBeDefined()
})

test('a failing turbo-run view shows one line in the band, keeps reading, and recovers', async ($, on) => {
  const { calls, clock } = stub(on, { views: ['invalid turbo config /work/.planning/turbo/config.json: Unexpected end of JSON input\n    at loadConfig (x.mjs:1:1)\n', VIEW] })
  await start($)
  await clock.settle()
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: 'turbo · ⚠ invalid turbo config /work/.planning/turbo/config.json: Unexpected end of JSON input' })).toBeDefined()
  await band.unmount()
  await clock.advance(15000)
  expect(calls.filter((c) => c[2] === 'view').length).toBeGreaterThan(1)
  const again = await $.ui.mount(BAND)
  expect(await again.find({ type: 'Text', text: /^turbo p32 execute/ })).toBeDefined()
})

test('a new question between two reads raises a toast', async ($, on) => {
  const q2 = { id: 'q2', phase: '32', plan: '32-10', task: '1', kind: 'verify', header: 'Check', question: 'Looks right?', options: [], allowOther: true, state: 'open' }
  const { toasts, clock } = stub(on, { views: [VIEW, { ...VIEW, questions: [...VIEW.questions, q2] }] })
  await start($)
  await clock.settle()
  expect(toasts).toEqual([])
  await clock.advance(3000)
  expect(toasts).toEqual(['new question: 32-10 Task 1 — Looks right?'])
})

test('a lane the supervisor cleared between two reads toasts phase done once, and the next phase that arrives stopped toasts too', async ($, on) => {
  const next = { ...VIEW, lanes: [{ ...VIEW.lanes[0], phase: '33', status: 'needs-owner', reason: 'checkpoint 33-01', push: null }] }
  const { toasts, clock } = stub(on, { views: [VIEW, next] })
  await start($)
  await clock.settle()
  await clock.advance(3000)
  expect(toasts).toEqual(['phase 32 done', 'phase 33 stopped: needs-owner — checkpoint 33-01'])
  await clock.advance(3000)
  expect(toasts).toHaveLength(2)
})

test('toasts remember lanes across reads: a red CI run toasted before its lane left is not toasted again when it comes back', async ($, on) => {
  const lane = { ...VIEW.lanes[0], push: { outcome: 'pushed', sha: 'b2c3d4e', at: '2026-01-01T10:50:00.000Z', ci: 'red' } }
  const sup = { ...VIEW.supervisor, pid: 5151 }
  const views = [{ ...VIEW, lanes: [lane] }, { ...VIEW, supervisor: sup, lanes: [{ ...lane, phase: '40', push: null }] }, { ...VIEW, supervisor: sup, lanes: [lane] }]
  const { toasts, clock } = stub(on, { views })
  await start($)
  await clock.settle()
  await clock.advance(6000)
  expect(toasts).toEqual(['phase 40 done'])
})

test('/turbo-view whose pane cannot open says why in a toast instead of failing', async ($, on) => {
  const { toasts, clock } = stub(on, { openFails: true })
  await start($)
  await clock.settle()
  const answer = await $.command.run({ command: 'turbo-view', args: '' })
  await clock.settle()
  expect(answer).toEqual({})
  expect(toasts).toEqual(['turbo-view: pane not opened: $.ui.open: no room for a pane'])
})

const viewReads = (calls: string[][]) => calls.filter((c) => c[2] === 'view').length

test('surfaces that cannot be read still start the clock (as the foreground)', async ($, on) => {
  const { calls, clock } = stub(on, { surfacesFail: 1 })
  await start($)
  await clock.settle()
  await clock.advance(3000)
  expect(viewReads(calls)).toBe(2)
})

test('outside a turbo project nothing runs, and /turbo-view says why', async ($, on) => {
  const { calls, clock } = stub(on, { turbo: false })
  await start($)
  await clock.advance(30000)
  expect(calls).toEqual([])
  const answer = await $.command.run({ command: 'turbo-view', args: '' })
  expect(answer.text).toBe('turbo-view: no .planning/turbo/ in this directory or above it')
})

test('a -p run starts nothing', async ($, on) => {
  const { calls, clock } = stub(on)
  await start($, false)
  await clock.advance(30000)
  expect(calls).toEqual([])
})

test('a session no surface is attached to reads every 15 s, not every 3 s', async ($, on) => {
  const { calls, clock } = stub(on, { surfaces: [] })
  await start($)
  await clock.settle()
  await clock.advance(14000)
  expect(calls.filter((c) => c[2] === 'view')).toHaveLength(1)
  await clock.advance(1000)
  expect(calls.filter((c) => c[2] === 'view')).toHaveLength(2)
})

test('what is typed into the Other… field survives the next read, which redraws the pane', async ($, on) => {
  const { clock } = stub(on)
  await start($)
  await clock.settle()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'q:q1:other' })
  await pane.input({ key: 'q:q1:text', text: 'полу', kind: 'change' })
  await clock.advance(3000)
  expect((await pane.find({ key: 'q:q1:text' })).props.value).toBe('полу')
})

test('an answer already given elsewhere: the arbiter line from stdout (exit 3) is the toast, and the field closes', async ($, on) => {
  const { toasts, clock } = stub(on, { answer: { exitCode: 3, stdout: 'already answered: Stop, telegram, 2026-01-01T10:58:00.000Z\n', stderr: '' } })
  await start($)
  await clock.settle()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'q:q1:other' })
  await pane.input({ key: 'q:q1:text', text: 'go on' })
  await clock.settle()
  expect(toasts).toEqual(['already answered: Stop, telegram, 2026-01-01T10:58:00.000Z'])
  expect(await pane.find({ key: 'q:q1:text' })).toBeUndefined()
})

test('a question that changed since it was drawn (exit 4): the line is the toast, the pane reads again at once, the field closes and keeps the text', async ($, on) => {
  const line = 'changed: question q1 changed since it was shown (now rev 2, shown rev 1); read it again and answer the new version'
  const { calls, toasts, clock } = stub(on, { answer: { exitCode: 4, stdout: `${line}\n`, stderr: '' } })
  await start($)
  await clock.settle()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'q:q1:other' })
  await pane.input({ key: 'q:q1:text', text: 'go on' })
  await clock.settle()
  expect(toasts).toEqual([line])
  expect(calls.filter((c) => c[2] === 'view')).toHaveLength(2)
  expect(await pane.find({ key: 'q:q1:text' })).toBeUndefined()
  await pane.press({ key: 'q:q1:other' })
  expect((await pane.find({ key: 'q:q1:text' })).props.value).toBe('go on')
})

test('a refused answer (exit 1): the line is the toast, and the field stays open with the text to rephrase', async ($, on) => {
  const line = 'refused: the answer matches a secret pattern (GitHub token); say it without the value'
  const { toasts, clock } = stub(on, { answer: { exitCode: 1, stdout: `${line}\n`, stderr: '' } })
  await start($)
  await clock.settle()
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'q:q1:other' })
  await pane.input({ key: 'q:q1:text', text: 'token is abc' })
  await clock.settle()
  expect(toasts).toEqual([line])
  expect((await pane.find({ key: 'q:q1:text' })).props.value).toBe('token is abc')
})
