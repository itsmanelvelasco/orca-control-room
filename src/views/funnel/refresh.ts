// Funnel slice 2: keeps the funnel current in the worker.
//
// Most of the data comes from the Waits loops (open items, bots, Runs with their tasks, workers and
// gates, the waits, agent events), so the funnel adds no call for it. The funnel reads only the
// two sources Waits does not: closed items (`bot item list --all`) and each bot's workers with
// their PRs (`bot work list`). Those reads run only while a panel asks (the Funnel tab is
// visible), at most every `refreshSeconds` (20 s), one bot at a time per kind; the worker passes
// a runner that also keeps other loops' calls of the same kind from running at once
// (src/cli/turns.ts). A failed call keeps that bot's last good rows and says so in a note.
// A change of the Waits data (a new read or an agent event) rebuilds the funnel at once, with no
// call, while a panel is watching.

// The panel may import this file's types, so it takes the CLI's pure parts only.
import { isBotId, type CliRequest } from '../../cli/commands.ts'
import type { CliFailure, CliResult } from '../../cli/run.ts'
import { parseBotItemList, parseBotWorkList, type BotItem, type BotWork } from '../../model/index.ts'
import { cleanText } from '../line/model.ts'
import type { WaitsData } from '../waits/refresh.ts'
import { buildFunnel, STAGES, type Funnel } from './model.ts'

export const DEFAULT_REFRESH_SECONDS = 20
/** A panel tick (every 1 s) that lands a little early still refreshes. */
export const SLACK_MS = 1_000
/** At least this long between the end of one read and the start of the next. */
export const MIN_GAP_MS = 2_000
/** A panel that asked within this long is watching: Waits changes rebuild the funnel. */
export const WATCH_MS = 5_000
/** The same cap as the Shipping line: at most 50 bots read per turn. */
export const MAX_BOTS = 50

export type FunnelError = { kind: CliFailure['kind'] | 'internal'; message: string }

export type FunnelSnapshot = {
  /** `loading` until Waits has read once and the first funnel read ended. */
  status: 'loading' | 'ok'
  /** Rises each time the funnel changes; a panel that holds it gets `null` back. */
  version: number
  /** When the last funnel read ended, ms since epoch. */
  updatedAt: number | null
  /** When the Waits data the funnel was built from was read. */
  waitsAt: number | null
  funnel: Funnel
  /** One line per source that failed in the last read, each saying the last good data shows. */
  notes: string[]
  /** How long the last build took (R8: under 50 ms for 60 bots). */
  buildMs: number
  refreshSeconds: number
}

export type FunnelCli = (request: CliRequest) => Promise<CliResult>

export type FunnelRefresher = {
  snapshot(): FunnelSnapshot
  /** A panel asks: reads when due (or `force`) and none runs. Resolves when that read ends. Never rejects. */
  refresh(force?: boolean): Promise<FunnelSnapshot>
  /** The Waits data changed: rebuild with no call, if a panel is watching. */
  onWaitsChanged(): void
}

export const emptyFunnel = (): Funnel => ({ pieces: [], columns: Object.fromEntries(STAGES.map((s) => [s, []])) as unknown as Funnel['columns'], unlinkedWaits: [], left: [], looseWorks: [] })

/** CLI missing or Orca not answering: the rest of that lane makes no more calls this turn. */
const isStop = (e: CliFailure): boolean => e.kind === 'not_found' || e.kind === 'spawn' || (e.kind === 'cli_error' && e.code === 'runtime_unavailable')

export function createFunnelRefresher(opts: {
  run: FunnelCli
  waits: () => WaitsData
  refreshSeconds?: number
  now?: () => number
  onChange?: (s: FunnelSnapshot) => void
}): FunnelRefresher {
  const now = opts.now ?? Date.now
  const refreshSeconds = opts.refreshSeconds ?? DEFAULT_REFRESH_SECONDS
  /** Last good rows per bot id. */
  const allItems = new Map<string, BotItem[]>()
  const works = new Map<string, BotWork[]>()
  let notes: string[] = []
  let readAt: number | null = null
  let lastStart = -Infinity
  let lastEnd = -Infinity
  let lastAsk = -Infinity
  /** The Waits data changed since the last build. */
  let dirty = true
  let running: Promise<FunnelSnapshot> | null = null
  let version = 0
  let sig = ''
  let snap: FunnelSnapshot = { status: 'loading', version, updatedAt: null, waitsAt: null, funnel: emptyFunnel(), notes: [], buildMs: 0, refreshSeconds }

  const due = (): boolean => now() - lastStart >= refreshSeconds * 1000 - SLACK_MS && now() - lastEnd >= MIN_GAP_MS

  /** Builds from the Waits data and the last good funnel reads; posts when the result changed. */
  const build = (): FunnelSnapshot => {
    dirty = false
    const w = opts.waits()
    // Open items: Waits reads them every 4 s, so its copy wins. Closed items: the `--all` read.
    const open = new Set(w.items.map((i) => i.uid))
    const items = [...w.items]
    for (const list of allItems.values()) for (const i of list) if (!open.has(i.uid)) items.push(i)
    const t0 = performance.now()
    let funnel: Funnel
    try {
      funnel = buildFunnel({ items, works: [...works.values()].flat(), runs: w.runs, waits: w.waits, now: now() })
    } catch (e) {
      notes = [...notes, `funnel build failed: ${cleanText(String((e as Error)?.message ?? e), 160)}`]
      funnel = snap.funnel
    }
    const buildMs = Math.round((performance.now() - t0) * 10) / 10
    const status = w.updatedAt !== null && readAt !== null ? 'ok' : 'loading'
    const body = { status, updatedAt: readAt, waitsAt: w.updatedAt, funnel, notes, refreshSeconds } as const
    const next = JSON.stringify(body)
    if (next !== sig) {
      sig = next
      snap = { ...body, notes: [...notes], version: ++version, buildMs }
      try {
        opts.onChange?.(snap)
      } catch {
        /* the next change posts again */
      }
    } else {
      snap = { ...snap, buildMs }
    }
    return snap
  }

  /** One lane: one call per bot, in turn; a failure keeps that bot's last good rows. */
  const lane = async <T>(bots: string[], request: (bot: string) => CliRequest, parse: (r: unknown) => T[], into: Map<string, T[]>, label: string): Promise<string | null> => {
    let failed = 0
    let first = ''
    for (const bot of bots) {
      const r = await opts.run(request(bot))
      if (r.ok) {
        into.set(bot, parse(r.result))
        continue
      }
      failed++
      first ||= cleanText(r.error.message, 120)
      if (isStop(r.error)) {
        failed += bots.length - bots.indexOf(bot) - 1
        break
      }
    }
    return failed ? `${label} failed for ${failed} bot${failed === 1 ? '' : 's'}: ${first} (showing the last good data)` : null
  }

  async function read(): Promise<void> {
    const w = opts.waits()
    const bots = w.bots.filter((b) => !b.paused && isBotId(b.id)).slice(0, MAX_BOTS).map((b) => b.id)
    // A bot no longer listed (or paused) drops its rows; before Waits lists bots, keep all.
    if (w.updatedAt !== null) {
      for (const m of [allItems, works] as Map<string, unknown>[]) for (const k of [...m.keys()]) if (!bots.includes(k)) m.delete(k)
    }
    const [a, b] = await Promise.all([
      lane(bots, (bot) => ({ command: 'bot item list', bot, all: true }), (r) => parseBotItemList(r).items, allItems, 'closed items: bot item list --all'),
      lane(bots, (bot) => ({ command: 'bot work list', bot }), (r) => parseBotWorkList(r).items, works, 'bot work: bot work list')
    ])
    notes = [a, b].filter((n): n is string => n !== null)
    readAt = now()
  }

  return {
    snapshot: () => snap,
    refresh(force = false) {
      lastAsk = now()
      if (running) return running
      if (!force && !due()) return Promise.resolve(dirty ? build() : snap)
      lastStart = now()
      running = read()
        .catch((e: unknown) => {
          notes = [`funnel read failed: ${cleanText(String((e as Error)?.message ?? e), 160)}`]
          readAt ??= now()
        })
        .then(() => {
          lastEnd = now()
          running = null
          return build()
        })
      return running
    },
    onWaitsChanged() {
      dirty = true
      // No panel watching: the next ask builds, so a hidden tab costs no build either.
      if (now() - lastAsk > WATCH_MS) return
      build()
    }
  }
}
