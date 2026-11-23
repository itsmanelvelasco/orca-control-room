// The worker on a mock host with the fixture CLI: waits.get, waits.open, notifications,
// the status bar, agent events. No real CLI runs.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { CliRunner } from '../src/cli/run.ts'
import * as main from '../src/worker.ts'
import { FIXTURE_CLI_PATH, fixtureRun } from './waits-fixture.ts'

const fakeRunner = (): CliRunner => ({
  run: fixtureRun(),
  current: () => ({ path: FIXTURE_CLI_PATH, source: 'app' }),
  lastResolution: () => ({ ok: true, path: FIXTURE_CLI_PATH, source: 'app', tried: [{ path: FIXTURE_CLI_PATH, source: 'app' }] }),
  reset: () => undefined
})

async function start(storage: Record<string, any> = { 'waits.notified': [] }, settings: Record<string, any> = { orcaCli: '', notifyNewWaits: true }) {
  const real = { ...main.runtime }
  const timers: (() => void)[] = []
  main.runtime.createRunner = fakeRunner
  main.runtime.setInterval = ((fn: () => void) => (timers.push(fn), 0)) as unknown as typeof setInterval
  main.runtime.setTimeout = ((fn: () => void) => (fn(), 0)) as unknown as typeof setTimeout
  const host = mockHost({ storage, settings })
  const worker = await mountWorker(main, { host, events: ['agent.status.changed'] })
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((d) => setTimeout(d, 0))
  }
  await settle()
  const done = async () => {
    await worker.deactivate()
    Object.assign(main.runtime, real)
  }
  return { host, worker, settle, timers, done }
}

test('worker: waits.get answers the fixture waits; status bar counts them; one notification each', async () => {
  const { host, worker, done } = await start()
  const snap = (await worker.request('waits.get')) as any
  assert.equal(snap.waits.length, 8, 'no events yet: the event-only agent is missing, and pane-perf:3 still waits (its working event has not come)')
  assert.equal(snap.cliPath, FIXTURE_CLI_PATH)
  const bar = host.callsOf('statusBar.update').at(-1) as any
  assert.equal(bar.text, '8 waiting')
  assert.equal(bar.id, 'waits')
  assert.equal(host.callsOf('notifications.show').length, 3, 'MAX_PER_UPDATE: two waits and one summary')
  assert.ok(worker.posts.some((p) => p.event === 'waits.changed'))
  assert.deepEqual(worker.refusals, [])
  await done()
})

test('worker: a later cycle with the same waits notifies nothing more', async () => {
  const { host, worker, settle, timers, done } = await start()
  const n = host.callsOf('notifications.show').length
  for (const t of timers) t()
  await settle()
  assert.equal(host.callsOf('notifications.show').length, n)
  assert.deepEqual(worker.refusals, [])
  await done()
})

test('worker: an agent event adds a wait at once and posts it', async () => {
  const { host, worker, settle, done } = await start()
  await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'pane-loose:1', terminalId: 'term_8e4f3fb7-bd76-4a6c-8e92-3f5e3a3a9d44', title: 'Loose agent', state: 'blocked', receivedAt: 1795400800000 })
  await settle()
  const snap = (await worker.request('waits.get')) as any
  assert.ok(snap.waits.some((w: any) => w.key === 'agent:term_8e4f3fb7-bd76-4a6c-8e92-3f5e3a3a9d44'))
  assert.equal((host.callsOf('statusBar.update').at(-1) as any).text, '9 waiting')
  await done()
})

test('worker: waits.open focuses a terminal or opens a workspace, by key only', async () => {
  const { host, worker, done } = await start()
  host.respond('terminal.focus', { focused: true })
  host.respond('workspace.open', { opened: true })
  assert.deepEqual(await worker.request('waits.open', { key: 'task:task_a1b2c3d4e5f6' }), { opened: true })
  assert.deepEqual(host.callsOf('terminal.focus').at(-1), { terminalId: 'term_03d70d0b-6eff-4557-a980-036162fa9748' })
  assert.deepEqual(await worker.request('waits.open', { key: 'item:6f3df7d1-33d6-44c6-8e9d-6ac0e3e756d2' }), { opened: true })
  assert.deepEqual(host.callsOf('workspace.open').at(-1), { workspaceId: '90ea16a8-81c0-4382-a6b8-7a3f0ad9f019::/home/alex/bots/atlas' })
  assert.deepEqual(await worker.request('waits.open', { key: 'nope' }), { opened: false, reason: 'unknown' })
  assert.deepEqual(await worker.request('waits.open', { key: { evil: 1 } } as any), { opened: false, reason: 'unknown' })
  assert.deepEqual(worker.refusals, [])
  await done()
})

test('worker: notifications off in settings: none shown', async () => {
  const { host, done } = await start({ 'waits.notified': [] }, { orcaCli: '', notifyNewWaits: false })
  assert.equal(host.callsOf('notifications.show').length, 0)
  await done()
})

test('worker: logs env key names only', async () => {
  const { worker, done } = await start()
  assert.ok(worker.logs.some((l) => l.startsWith('worker env: ') && !l.includes('=C:') && !l.includes('=/')), 'env key names only')
  await done()
})
