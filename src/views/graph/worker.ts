// Worker side of the Funnel graph panel (funnel slice 4). The HTML panel draws; this decides.
// - `graph.snapshot`: the graph built from the funnel the worker holds. Asking starts a funnel read
//   when one is due, exactly as the Funnel tab's ask does, so a hidden panel costs no CLI call (R8).
// - `graph.pictures`: each bot's picture as a `data:` URL (R9), read here and never in the panel.
//   Read again at most once a minute.
// Opening a node goes through the Funnel tab's own `funnel.open` and `waits.open`.
import { lstat, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { OrcaWorkerApi } from 'orca/worker'
import type { FunnelRefresher } from '../funnel/refresh.ts'
import type { WaitsData } from '../waits/refresh.ts'
import { readPictures, type Picture, type PictureDeps } from './mascots.ts'
import { buildGraph, type Graph } from './model.ts'

export const PICTURES_TTL_MS = 60_000

export type GraphSnapshot = {
  status: 'loading' | 'ok'
  version: number
  updatedAt: number | null
  notes: string[]
  graph: Graph
}

/** The real file access, for `readPictures`. Tests pass their own. */
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

  let cache: { at: number; pictures: Record<string, Picture | null> } | null = null
  let running: Promise<Record<string, Picture | null>> | null = null
  orca.panels.handle('graph.pictures', async () => {
    if (cache && now() - cache.at < PICTURES_TTL_MS) return { pictures: cache.pictures }
    running ??= readPictures(deps())
      .catch((e: unknown) => {
        orca.log(`graph.pictures failed: ${String((e as Error)?.message ?? e).split(/\r?\n/, 1)[0].slice(0, 200)}`)
        return {} as Record<string, Picture | null>
      })
      .then((pictures) => {
        cache = { at: now(), pictures }
        return pictures
      })
      .finally(() => {
        running = null
      })
    return { pictures: await running }
  })
}
