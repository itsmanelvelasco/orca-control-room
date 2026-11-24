// Funnel slice 2 (PRD "Control Room funnel view", R8): the worker wiring. The funnel builds from the
// Waits loops' data, reads only closed items and bot work, only while a panel asks, never queues in
// front of Waits, and keeps the last good data when a call fails.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { CliRequest } from '../src/cli/commands.ts'
import type { CliResult, CliRunner } from '../src/cli/run.ts'
import { createCliRunner, type ExecCallback, type ExecFileLike } from '../src/cli/run.ts'
import { parseBotItemList, type Bot } from '../src/model/index.ts'
import { createFunnelRefresher, MIN_GAP_MS, WATCH_MS, type FunnelSnapshot } from '../src/views/funnel/refresh.ts'
import type { WaitsData } from '../src/views/waits/refresh.ts'
import * as main from '../src/worker.ts'
import { foundAt } from './helpers.ts'
import { cliKey, FIXTURE_CLI_PATH, fixtureRun, WAITS_CASE } from './waits-fixture.ts'

const NOW = 1795400900000
const DAY = 24 * 60 * 60 * 1000
const botId = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
const bots = (n: number): Bot[] => Array.from({ length: n }, (_, i) => ({ id: botId(i), name: `Bot ${i}`, agent: 'claude', paused: false, specialty: null, chatCount: 1 }))

const prOf = (n: number, state: string) => ({ shown: true, ref: `example-org/sample-app#${n}`, number: n, url: `https://github.com/example-org/sample-app/pull/${n}`, state, checks: null, review: null, title: null })
const rawItem = (uid: string, number: number, status: string, extra: Record<string, unknown> = {}) => ({ uid, number, title: `Item ${number}`, status, chat: { id: 'chat-1', kind: 'home' }, owner: { botId: botId(0), name: 'Bot 0' }, links: [], createdAt: NOW - 3 * DAY, ...extra })

/** Waits data: 9 bots, bot 0 has one open item (its newest copy, from the 4 s read). */
function waitsData(over: Partial<WaitsData> = {}): WaitsData {
  return {
    updatedAt: NOW,
    bots: bots(9),
    items: parseBotItemList({ botId: botId(0), items: [rawItem('item-open', 1, 'in_progress', { title: 'Open item, fresh title' })] }).items,
    runs: [],
    waits: [],
    ...over
  }
}

const ok = (result: unknown): CliResult => ({ ok: true, result, ms: 1, cliPath: FIXTURE_CLI_PATH })
const fail = (kind: 'cli_error' | 'not_found', message: string, code?: string): CliResult => ({ ok: false, error: { kind, message, ...(code ? { code } : {}) }, ms: 1, cliPath: FIXTURE_CLI_PATH })

/** A fake CLI for the funnel's two reads. Bot 0 has a stale open copy and a done item with a merged PR. */
function funnelCli(answer?: (r: CliRequest) => CliResult | null) {
  const calls: CliRequest[] = []
  const run = async (r: CliRequest): Promise<CliResult> => {
    calls.push(r)
    const a = answer?.(r)
    if (a) return a
    if (r.command === 'bot item list' && r.bot === botId(0)) {
      return ok({
        botId: botId(0),
        items: [
          rawItem('item-open', 1, 'in_progress', { title: 'Open item, stale title' }),
          rawItem('item-done', 2, 'done', { closedAt: NOW - DAY, links: [{ kind: 'pr', ref: 'example-org/sample-app#7', pr: prOf(7, 'merged') }] })
        ]
      })
    }
    if (r.command === 'bot work list' && r.bot === botId(1)) {
      return ok({ items: [{ id: 'work-1', dispatchId: 'ctx_aaaa00000001', title: 'Loose worker with a PR', state: 'working', pr: prOf(8, 'open'), source: 'dispatch' }] })
    }
    return ok(r.command === 'bot item list' ? { botId: (r as any).bot, items: [] } : { items: [] })
  }
  return { run, calls }
}

const pieceTitles = (s: FunnelSnapshot): string[] => s.funnel.pieces.map((p) => p.title).sort()

// ---------- review 1 and 2: the funnel never holds up Waits; identical calls run once ----------

/** Mounts the worker on a mock host with `runner`; timers are kept for the test to fire. */
async function mount(runner: CliRunner) {
  const real = { ...main.runtime }
  const timers: (() => void)[] = []
  main.runtime.createRunner = () => runner
  main.runtime.setInterval = ((fn: () => void) => (timers.push(fn), 0)) as unknown as typeof setInterval
  main.runtime.setTimeout = (() => 0) as unknown as typeof setTimeout
  const worker = await mountWorker(main, { host: mockHost({ storage: { 'waits.notified': [] }, settings: { orcaCli: '', notifyNewWaits: false } }), events: ['agent.status.changed'] })
  const settle = async (ms = 0) => {
    for (let i = 0; i < 40; i++) await new Promise((d) => setTimeout(d, ms))
  }
  await settle()
  const done = async () => {
    await worker.deactivate()
    Object.assign(main.runtime, real)
  }
  return { worker, timers, settle, done }
}

const fixtureRunner = (run: (r: CliRequest) => Promise<CliResult>): CliRunner => ({
  run,
  current: () => ({ path: FIXTURE_CLI_PATH, source: 'app' }),
  lastResolution: () => ({ ok: true, path: FIXTURE_CLI_PATH, source: 'app', tried: [{ path: FIXTURE_CLI_PATH, source: 'app' }] }),
  reset: () => undefined
})

test('review 1: with every funnel --all call hung, Waits still reads open items and posts at once', async () => {
  const fixture = fixtureRun()
  const keys: string[] = []
  const hung: (() => void)[] = []
  const run = async (r: CliRequest): Promise<CliResult> => {
    const key = cliKey(r)
    keys.push(key)
    // Orca hangs on the funnel's reads: they answer only when the test lets them.
    if (key.endsWith('--all') || key.startsWith('bot work list')) await new Promise<void>((d) => hung.push(d))
    return fixture(r)
  }
  const { worker, timers, settle, done } = await mount(fixtureRunner(run))
  await worker.request('funnel.snapshot')
  await settle()
  assert.ok(hung.length > 0, 'the funnel read is under way and hung')
  const openReads = () => keys.filter((k) => k.startsWith('bot item list') && !k.endsWith('--all')).length
  const before = openReads()
  for (const t of timers) t()
  await settle()
  assert.ok(openReads() > before, "Waits' open-items read ran while the funnel's --all calls hung")
  for (const d of hung.splice(0)) d()
  await settle()
  for (const d of hung.splice(0)) d()
  await settle()
  await done()
})

test('review 1: a timeout stops the funnel lane for the turn (no 9 x 10 s of calls)', async () => {
  const cli = funnelCli(() => ({ ok: false, error: { kind: 'timeout', message: 'No answer in 10 s' }, ms: 10_000, cliPath: FIXTURE_CLI_PATH }))
  const f = createFunnelRefresher({ run: cli.run, waits: () => waitsData(), now: () => NOW })
  const s = await f.refresh(true)
  assert.equal(cli.calls.length, 2, 'one call per source, then stop')
  assert.deepEqual(s.notes, [
    'closed items: bot item list --all failed for 9 bots: No answer in 10 s (showing the last good data)',
    'bot work: bot work list failed for 9 bots: No answer in 10 s (showing the last good data)'
  ])
})

test('review 2: identical calls from two loops at once run the CLI once (cli.status + Waits: bot list; Waits + Shipping line: run-list)', async () => {
  // A real runner (it merges identical in-flight calls by argv) over a slow fake exec, so the loops overlap.
  const execs: string[] = []
  const slowExec: ExecFileLike = (_file, args, _options, callback: ExecCallback) => {
    const key = args.slice(0, -1).join(' ')
    execs.push(key)
    const env = WAITS_CASE.cli[key] ?? { ok: true, result: {} }
    setTimeout(() => callback(null, JSON.stringify(env), ''), 1500)
    return undefined
  }
  const { worker, settle, done } = await mount(createCliRunner({ exec: slowExec, resolve: foundAt(FIXTURE_CLI_PATH), env: () => ({}) }))
  void worker.request('line.snapshot', { force: true })
  // Each call takes 1.5 s. At 2.5 s a queued copy would have run (at 1.5 s); a merged one never runs,
  // and the line's own later bot list starts only after its run-list and per-Run reads (past 3 s).
  await new Promise((d) => setTimeout(d, 2500))
  const early = [...execs]
  const count = (k: string) => early.filter((e) => e === k).length
  assert.ok(early.includes('bot list') && early.includes('orchestration run-list'))
  assert.equal(count('bot list'), 1, 'cli.status and the Waits slow pass asked bot list at once: one CLI run')
  assert.equal(count('orchestration run-list'), 1, 'Waits and the Shipping line asked run-list at once: one CLI run')
  await new Promise((d) => setTimeout(d, 4000))
  await done()
})

// ---------- R8: what the funnel reads, and how often ----------

test('R8: no ask, no call: a hidden Funnel tab costs 0 CLI calls, even when the Waits data changes', async () => {
  const cli = funnelCli()
  const posts: FunnelSnapshot[] = []
  let t = NOW
  const f = createFunnelRefresher({ run: cli.run, waits: () => waitsData(), now: () => t, onChange: (s) => posts.push(s) })
  for (let i = 0; i < 600; i++) {
    t += 1000
    f.onWaitsChanged()
  }
  assert.equal(cli.calls.length, 0)
  assert.equal(posts.length, 0, 'not even a build')
  assert.equal(f.snapshot().status, 'loading')
})

test('R8: one read is 2 calls per bot (closed items, bot work) and nothing Waits already reads; 9 bots asked every second for 10 min', async () => {
  const cli = funnelCli()
  let t = NOW
  const f = createFunnelRefresher({ run: cli.run, waits: () => waitsData(), now: () => t })
  const reads: number[] = []
  let before = 0
  for (let s = 0; s < 600; s++) {
    t = NOW + s * 1000
    await f.refresh()
    if (cli.calls.length !== before) {
      reads.push(s)
      assert.equal(cli.calls.length - before, 18, 'each read: 9 bots x 2 kinds')
      before = cli.calls.length
    }
  }
  const kinds = new Set(cli.calls.map((c) => `${c.command}${(c as any).all ? ' --all' : ''}`))
  assert.deepEqual([...kinds].sort(), ['bot item list --all', 'bot work list'], 'no bot list, run-list, task, worker or gate call: those come from Waits')
  // Due 20 s after the last read started, less 1 s of slack for an early panel tick.
  assert.deepEqual(reads.slice(0, 4), [0, 19, 38, 57])
  assert.equal(reads.length, 32)
  assert.equal(cli.calls.length, 576, '576 calls in 10 min = 57.6 a minute, about 1 a second, only while the tab is visible')
})

test('the funnel: open items from Waits win; closed items and bot work come from the funnel read', async () => {
  const cli = funnelCli()
  const f = createFunnelRefresher({ run: cli.run, waits: () => waitsData(), now: () => NOW })
  const s = await f.refresh(true)
  assert.equal(s.status, 'ok')
  assert.deepEqual(s.notes, [])
  assert.deepEqual(pieceTitles(s), ['Item 2', 'Loose worker with a PR', 'Open item, fresh title'])
  const byTitle = (title: string) => s.funnel.pieces.find((p) => p.title === title)
  assert.equal(byTitle('Item 2')?.stage, 'shipping', 'done, PR merged, closed a day ago')
  assert.equal(byTitle('Open item, fresh title')?.stage, 'ideation')
  assert.equal(byTitle('Loose worker with a PR')?.stage, 'execution')
  assert.ok(s.buildMs >= 0 && s.buildMs < 50, 'R8: build time in the snapshot')
})

test('last good data: a failed call keeps that bot\'s rows and says so; a later good read clears the note', async () => {
  let broken = false
  const cli = funnelCli((r) => (broken && r.command === 'bot work list' && r.bot === botId(1) ? fail('cli_error', 'Orca timed out\nsecond line') : null))
  let t = NOW
  const f = createFunnelRefresher({ run: cli.run, waits: () => waitsData(), now: () => t })
  const first = await f.refresh(true)
  broken = true
  t += 20_000
  const second = await f.refresh()
  assert.deepEqual(pieceTitles(second), pieceTitles(first), 'bot 1 keeps its worker')
  assert.deepEqual(second.notes, ['bot work: bot work list failed for 1 bot: Orca timed out (showing the last good data)'])
  assert.ok(second.version > first.version)
  broken = false
  t += 20_000
  const third = await f.refresh()
  assert.deepEqual(third.notes, [])
})

test('last good data: CLI missing stops the lane after one call; nothing read yet shows the Waits data alone', async () => {
  const cli = funnelCli(() => fail('not_found', 'Orca CLI not found'))
  const f = createFunnelRefresher({ run: cli.run, waits: () => waitsData(), now: () => NOW })
  const s = await f.refresh(true)
  assert.equal(cli.calls.length, 2, 'one call per lane, then stop')
  assert.deepEqual(pieceTitles(s), ['Open item, fresh title'])
  assert.equal(s.notes.length, 2)
  assert.ok(s.notes.every((n) => n.includes('failed for 9 bots')))
})

test('plugin events: a Waits change rebuilds the funnel with no call while a panel watches, and waits for the next ask when none does', async () => {
  const cli = funnelCli()
  let data = waitsData()
  let t = NOW
  const posts: FunnelSnapshot[] = []
  const f = createFunnelRefresher({ run: cli.run, waits: () => data, now: () => t, onChange: (s) => posts.push(s) })
  await f.refresh(true)
  const calls = cli.calls.length
  const wait = { key: 'item:item-open', notifyId: 'n1', kind: 'question' as const, who: 'Bot 0', what: 'Ship it?', options: ['yes', 'no'], label: 'Needs you', since: t, target: null, sources: ['item' as const] }
  data = waitsData({ waits: [wait] })
  f.onWaitsChanged()
  assert.equal(cli.calls.length, calls)
  assert.equal(posts.at(-1)?.funnel.pieces.find((p) => p.key === 'item:item-open')?.amber, true, 'amber at once')
  const n = posts.length
  f.onWaitsChanged()
  assert.equal(posts.length, n, 'nothing changed: no post')
  // No ask for longer than WATCH_MS: a change waits for the next ask.
  t += WATCH_MS + 1
  data = waitsData()
  f.onWaitsChanged()
  assert.equal(posts.length, n)
  await f.refresh()
  assert.equal(posts.length, n + 1)
  assert.equal(posts.at(-1)?.funnel.pieces.find((p) => p.key === 'item:item-open')?.amber, false)
  assert.equal(cli.calls.length, calls, 'not due yet: built from what the worker holds')
})

test('review nit 6: reads never overlap; a forced read keeps the 2 s gap; a bot no longer listed drops its rows', async () => {
  const cli = funnelCli()
  let data = waitsData()
  let t = NOW
  const f = createFunnelRefresher({ run: cli.run, waits: () => data, now: () => t })
  const a = f.refresh(true)
  const b = f.refresh(true)
  assert.equal(a, b, 'a second ask joins the read in progress')
  await a
  data = waitsData({ bots: bots(9).slice(1), items: [] })
  const n = cli.calls.length
  t += MIN_GAP_MS - 1
  await f.refresh(true)
  assert.equal(cli.calls.length, n, 'clicked again within 2 s: no new read')
  t += 1
  await f.refresh(true)
  assert.equal(cli.calls.length, n + 16, 'after the gap, force reads: 8 bots x 2')
  assert.deepEqual(pieceTitles(f.snapshot()), ['Loose worker with a PR'], "bot 0's closed items left with it")
})

test('review nit 5: --all gives closed items only; an item Waits no longer lists as open never shows its stale open copy', async () => {
  const cli = funnelCli()
  const f = createFunnelRefresher({ run: cli.run, waits: () => waitsData({ items: [] }), now: () => NOW })
  const s = await f.refresh(true)
  assert.deepEqual(pieceTitles(s), ['Item 2', 'Loose worker with a PR'], 'no "Open item, stale title"')
})

test('review 3: loading, never ok, until closed items and bot work were read once after Waits read; that read starts as soon as Waits has read', async () => {
  const cli = funnelCli()
  let data = waitsData({ updatedAt: null, bots: [], items: [] })
  const posts: FunnelSnapshot[] = []
  const f = createFunnelRefresher({ run: cli.run, waits: () => data, now: () => NOW, onChange: (s) => posts.push(s) })
  const s = await f.refresh(true)
  assert.equal(s.status, 'loading')
  assert.equal(cli.calls.length, 0, 'no bots known yet: nothing to read')
  // Waits' first pass lands while the panel watches: the funnel reads now, not 20 s later.
  data = waitsData()
  f.onWaitsChanged()
  assert.equal(cli.calls.length, 2, 'the read started at once (first call of each source)')
  assert.equal(f.snapshot().status, 'loading', 'still loading while the read runs')
  await f.refresh()
  assert.equal(cli.calls.length, 18)
  assert.equal(f.snapshot().status, 'ok')
  assert.deepEqual(pieceTitles(f.snapshot()), ['Item 2', 'Loose worker with a PR', 'Open item, fresh title'], 'Shipping has the closed item from the first ok post')
  assert.ok(posts.every((p, i) => p.status === 'loading' || i === posts.length - 1), 'no ok post before the read')
})

test('review 4: a failing build keeps one note and the last good funnel; repeated Waits passes neither add notes nor bump the version', async () => {
  const cli = funnelCli()
  let broken = false
  const posts: FunnelSnapshot[] = []
  const f = createFunnelRefresher({ run: cli.run, waits: () => (broken ? waitsData({ runs: [null as any] }) : waitsData()), now: () => NOW, onChange: (s) => posts.push(s) })
  const good = await f.refresh(true)
  broken = true
  f.onWaitsChanged()
  const failed = f.snapshot()
  assert.equal(failed.notes.length, 1)
  assert.ok(failed.notes[0].startsWith('funnel build failed: '))
  assert.deepEqual(pieceTitles(failed), pieceTitles(good), 'the last good funnel stays')
  const n = posts.length
  for (let i = 0; i < 5; i++) f.onWaitsChanged()
  assert.equal(posts.length, n, 'no new post')
  assert.equal(f.snapshot().version, failed.version)
  assert.equal(f.snapshot().notes.length, 1)
  broken = false
  f.onWaitsChanged()
  assert.deepEqual(f.snapshot().notes, [], 'a good build clears the note')
})

// ---------- the protocol request, in the worker ----------

test('worker: funnel.snapshot answers at once, posts funnel.changed after the read, and answers null for a version the panel holds', async () => {
  const real = { ...main.runtime }
  const keys: string[] = []
  const runner: CliRunner = {
    run: fixtureRun((k) => keys.push(k)),
    current: () => ({ path: FIXTURE_CLI_PATH, source: 'app' }),
    lastResolution: () => ({ ok: true, path: FIXTURE_CLI_PATH, source: 'app', tried: [{ path: FIXTURE_CLI_PATH, source: 'app' }] }),
    reset: () => undefined
  }
  main.runtime.createRunner = () => runner
  main.runtime.setInterval = (() => 0) as unknown as typeof setInterval
  main.runtime.setTimeout = (() => 0) as unknown as typeof setTimeout
  const settle = async () => {
    for (let i = 0; i < 40; i++) await new Promise((d) => setTimeout(d, 0))
  }
  try {
    const worker = await mountWorker(main, { host: mockHost({ storage: { 'waits.notified': [] }, settings: { orcaCli: '', notifyNewWaits: false } }), events: ['agent.status.changed'] })
    await settle()
    assert.ok(!keys.some((k) => k.includes('--all') || k.startsWith('bot work list')), 'no funnel read before a panel asks')
    const first = (await worker.request('funnel.snapshot')) as FunnelSnapshot
    assert.equal(first.status, 'loading', 'answers at once, before the read ends')
    await settle()
    assert.ok(keys.some((k) => k.endsWith('--all')) && keys.some((k) => k.startsWith('bot work list')))
    const posted = worker.posts.filter((p) => p.event === 'funnel.changed').at(-1)?.payload as FunnelSnapshot
    assert.equal(posted.status, 'ok')
    assert.ok(posted.funnel.pieces.length > 0)
    assert.equal(await worker.request('funnel.snapshot', { version: posted.version }), null)
    assert.equal(((await worker.request('funnel.snapshot', { version: -1 })) as FunnelSnapshot).version, posted.version)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    Object.assign(main.runtime, real)
  }
})
