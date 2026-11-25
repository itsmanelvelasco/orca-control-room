// Worker side of the Funnel graph panel (funnel slice 4). The HTML panel draws; this decides.
// - `graph.snapshot`: the graph built from the funnel the worker holds. Asking starts a funnel read
//   when one is due, exactly as the Funnel tab's ask does, so a hidden panel costs no CLI call (R8).
// - `graph.pictures` / `graph.picture`: bot pictures (R9), read here and never in the panel. The
//   first sends each bot's picture signature, at most one scan a minute, re-reading only changed
//   files; the second sends one picture as a `data:` URL.
// Opening a node goes through the Funnel tab's own `funnel.open` and `waits.open`.
import { lstat, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { OrcaWorkerApi } from 'orca/worker'
import type { FunnelRefresher } from '../funnel/refresh.ts'
import type { WaitsData } from '../waits/refresh.ts'
import { createPictureStore, type PictureDeps, type PictureStore } from './mascots.ts'
import { buildGraph, type Graph } from './model.ts'

export const PICTURES_TTL_MS = 60_000

export type GraphSnapshot = {
  status: 'loading' | 'ok'
  version: number
  updatedAt: number | null
  notes: string[]
  graph: Graph
}

/** The real file access, for the picture store. Tests pass their own. */
export function nodePictureDeps(): PictureDeps {
  return {
    platform: process.platform,
    execPath: process.execPath,
    homedir: homedir(),
    readdir: (p) => readdir(p),
    stat: async (p) => {
      const s = await lstat(p)
      return { isFile: s.isFile(), size: s.size, mtimeMs: s.mtimeMs }
    },
    readFile: async (p) => new Uint8Array(await readFile(p))
  }
}

/** The graph snapshot for a funnel snapshot; bot names come from the Waits data. */
export function graphSnapshot(funnel: FunnelRefresher, waits: () => WaitsData): GraphSnapshot {
  const s = funnel.snapshot()
  const names: Record<string, string> = {}
  for (const b of waits().bots) names[b.id] = b.name
  return { status: s.status, version: s.version, updatedAt: s.updatedAt, notes: s.notes, graph: buildGraph(s.funnel, names) }
}

export function registerGraph(orca: OrcaWorkerApi, funnel: FunnelRefresher, waits: () => WaitsData, deps: () => PictureDeps = nodePictureDeps, now: () => number = Date.now): void {
  orca.panels.handle('graph.snapshot', (input) => {
    void funnel.refresh(input?.force === true)
    const s = graphSnapshot(funnel, waits)
    return typeof input?.version === 'number' && input.version === s.version ? null : s
  })

  // Pictures go one per answer: an answer stays far below the 256 KiB a panel message may hold.
  // `graph.pictures` sends only each key's signature; the page asks `graph.picture` for the keys
  // whose signature it does not hold yet.
  let store: PictureStore | null = null
  let scanned: { at: number; sigs: Record<string, string | null> } | null = null
  let running: Promise<Record<string, string | null>> | null = null
  const scan = (): Promise<Record<string, string | null>> => {
    if (scanned && now() - scanned.at < PICTURES_TTL_MS) return Promise.resolve(scanned.sigs)
    store ??= createPictureStore(deps(), (line) => orca.log(line))
    running ??= store
      .scan()
      .catch((e: unknown) => {
        orca.log(`graph.pictures failed: ${String((e as Error)?.message ?? e).split(/\r?\n/, 1)[0].slice(0, 200)}`)
        return {} as Record<string, string | null>
      })
      .then((sigs) => {
        scanned = { at: now(), sigs }
        return sigs
      })
      .finally(() => {
        running = null
      })
    return running
  }
  orca.panels.handle('graph.pictures', async () => ({ sigs: await scan() }))
  orca.panels.handle('graph.picture', async (input) => {
    const key = input && typeof input === 'object' && typeof input.key === 'string' ? input.key.slice(0, 200) : ''
    await scan()
    const e = key && store ? store.get(key) : null
    return e ? { key, sig: e.sig, picture: e.picture } : { key, sig: null, picture: null }
  })
}
