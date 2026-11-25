// Funnel slice 4: the worker answers the Funnel graph panel. `graph.snapshot` follows the funnel
// (same version, `null` when the panel holds it); `graph.pictures` reads bot pictures through its
// deps, at most once a minute. A fake CLI and a fake disk: nothing real is read.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { CliRunner } from '../src/cli/run.ts'
import type { PictureDeps } from '../src/views/graph/mascots.ts'
import * as main from '../src/worker.ts'
import { FIXTURE_CLI_PATH, fixtureRun } from './waits-fixture.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

function fakeDeps(): PictureDeps & { reads: number } {
  const files: Record<string, Uint8Array> = {
    '/home/alex/.orca/bots/atlas/bot.json': new TextEncoder().encode(JSON.stringify({ id: 'bot-a', name: 'Atlas', avatar: 'upload:1' })),
    '/home/alex/.orca/bots/atlas/avatar.png': PNG
  }
  const deps = {
    platform: 'linux',
    execPath: '/opt/Orca/orca',
    homedir: '/home/alex',
    reads: 0,
    async readdir(path: string) {
      if (path === '/home/alex/.orca/bots') return ['atlas']
      throw new Error('ENOENT')
    },
    async stat(path: string) {
      if (!files[path]) throw new Error('ENOENT')
      return { isFile: true, size: files[path].length, mtimeMs: 1 }
    },
    async readFile(path: string) {
      deps.reads++
      return files[path]
    }
  }
  return deps
}

async function start() {
  const real = { ...main.runtime }
  const deps = fakeDeps()
  main.runtime.createRunner = (): CliRunner => ({
    run: fixtureRun(),
    current: () => ({ path: FIXTURE_CLI_PATH, source: 'app' }),
    lastResolution: () => ({ ok: true, path: FIXTURE_CLI_PATH, source: 'app', tried: [{ path: FIXTURE_CLI_PATH, source: 'app' }] }),
    reset: () => undefined
  })
  main.runtime.setInterval = (() => 0) as unknown as typeof setInterval
  main.runtime.setTimeout = (() => 0) as unknown as typeof setTimeout
  main.runtime.pictureDeps = () => deps
  const worker = await mountWorker(main, { host: mockHost({ storage: { 'waits.notified': [] }, settings: { orcaCli: '', notifyNewWaits: false } }), events: ['agent.status.changed'] })
  for (let i = 0; i < 20; i++) await new Promise((d) => setTimeout(d, 0))
  const done = async () => {
    await worker.deactivate()
    Object.assign(main.runtime, real)
  }
  return { worker, deps, done }
}

test('graph.snapshot: the graph of the funnel the worker holds; null when the panel already has that version', async () => {
  const { worker, done } = await start()
  const s = (await worker.request('graph.snapshot', {})) as any
  assert.ok(s && typeof s.version === 'number')
  assert.equal(s.graph.columns.length, 4)
  assert.ok(Array.isArray(s.graph.nodes) && Array.isArray(s.graph.edges))
  const funnel = (await worker.request('funnel.snapshot', {})) as any
  assert.equal(funnel?.version ?? s.version, s.version, 'the same version as the funnel')
  const again = await worker.request('graph.snapshot', { version: s.version })
  if (again !== null) assert.ok((again as any).version > s.version, 'only a newer funnel comes back')
  assert.deepEqual(worker.refusals, [])
  await done()
})

test('graph.pictures (R9): read by the worker through its deps, cached for a minute', async () => {
  const { worker, deps, done } = await start()
  const r = (await worker.request('graph.pictures')) as any
  assert.match(r.pictures['bot-a'].url, /^data:image\/png;base64,/)
  assert.equal(r.pictures['bot-a'].from, 'upload')
  const reads = deps.reads
  await worker.request('graph.pictures')
  assert.equal(deps.reads, reads, 'the second ask within a minute reads nothing')
  assert.deepEqual(worker.refusals, [])
  await done()
})
