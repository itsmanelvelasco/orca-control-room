// Funnel slice 4: the worker answers the Funnel graph panel. `graph.snapshot` follows the funnel
// (same version, `null` when the panel holds it); `graph.pictures` sends picture signatures and
// `graph.picture` one picture, each answer far below 256 KiB. A fake CLI and a fake disk: nothing
// real is read. The tests wait on the requests themselves, never on a count of timer ticks.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { CliRunner } from '../src/cli/run.ts'
import { MAX_PICTURE, type PictureDeps } from '../src/views/graph/mascots.ts'
import * as main from '../src/worker.ts'
import { FIXTURE_CLI_PATH, fixtureRun } from './waits-fixture.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
/** The size a panel message may hold. */
const POST_LIMIT = 256 * 1024

/** 9 bots with uploads: bot 4's is 1 MB, bot 7's is the largest allowed. */
function fakeDeps(): PictureDeps & { reads: string[] } {
  const files: Record<string, Uint8Array> = {}
  const homes: string[] = []
  for (let i = 0; i < 9; i++) {
    homes.push(`b${i}`)
    files[`/home/alex/.orca/bots/b${i}/bot.json`] = new TextEncoder().encode(JSON.stringify({ id: `bot-${i}`, name: `Bot ${i}`, avatar: 'upload:1' }))
    const png = new Uint8Array(i === 4 ? 1024 * 1024 : i === 7 ? MAX_PICTURE : PNG.length)
    png.set(PNG)
    files[`/home/alex/.orca/bots/b${i}/avatar.png`] = png
  }
  const reads: string[] = []
  return {
    platform: 'linux',
    execPath: '/opt/Orca/orca',
    homedir: '/home/alex',
    reads,
    async readdir(path: string) {
      if (path === '/home/alex/.orca/bots') return homes
      throw new Error('ENOENT')
    },
    async stat(path: string) {
      if (!files[path]) throw new Error('ENOENT')
      return { isFile: true, size: files[path].length, mtimeMs: 1 }
    },
    async readFile(path: string) {
      reads.push(path)
      return files[path]
    }
  }
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
  // Whatever the first cycles did meanwhile: the panel's version comes back as null, or a newer one.
  const again = await worker.request('graph.snapshot', { version: s.version })
  if (again !== null) assert.ok((again as any).version > s.version, 'only a newer funnel comes back')
  assert.deepEqual(worker.refusals, [])
  await done()
})

test('review #1: 9 bots and a 1 MB upload: signatures for all, one picture per answer, every answer far below 256 KiB', async () => {
  const { worker, deps, done } = await start()
  const r = (await worker.request('graph.pictures')) as any
  assert.ok(JSON.stringify(r).length < 4 * 1024, 'signatures only')
  assert.equal(r.sigs['bot-4'], null, 'the 1 MB upload: the initial')
  assert.ok(!deps.reads.some((p) => p.includes('/b4/avatar.png')), 'never read')
  assert.ok(worker.logs.some((l) => l.includes('avatar.png of bot "Bot 4" is 1024 KB, over 128 KB')), 'one log line says why')
  for (let i = 0; i < 9; i++) {
    const p = (await worker.request('graph.picture', { key: `bot-${i}` })) as any
    assert.ok(JSON.stringify(p).length < POST_LIMIT, `bot-${i}: ${JSON.stringify(p).length} bytes`)
    if (i === 4) assert.deepEqual(p, { key: 'bot-4', sig: null, picture: null })
    else {
      assert.equal(p.sig, r.sigs[`bot-${i}`])
      assert.match(p.picture.url, /^data:image\/png;base64,/)
    }
  }
  assert.deepEqual(await worker.request('graph.picture', { key: 'nope' }), { key: 'nope', sig: null, picture: null })
  assert.deepEqual(await worker.request('graph.picture', { key: { evil: 1 } } as any), { key: '', sig: null, picture: null })
  // Within a minute nothing is scanned or read again.
  const reads = deps.reads.length
  await worker.request('graph.pictures')
  await worker.request('graph.picture', { key: 'bot-0' })
  assert.equal(deps.reads.length, reads)
  assert.deepEqual(worker.refusals, [])
  await done()
})
