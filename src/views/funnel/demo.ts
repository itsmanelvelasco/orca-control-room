// Builds a FunnelSnapshot from a hand-made case file (test/fixtures/cases/funnel-demo.json: item
// pages, bot work pages, run-list, each Run's task, worker and gate lists, the waits and the bots'
// home workspaces), for tests, `orca plugin check` and screenshots. The same code path as the
// worker: parse each CLI result, then buildFunnel and funnelDetails.
import { isRecord, parseBotItemList, parseBotWorkList, parseGateList, parseRunList, parseTaskList, parseWorkerList } from '../../model/index.ts'
import type { Wait } from '../waits/collect.ts'
import type { WaitsData } from '../waits/refresh.ts'
import { buildFunnel, funnelDetails, type FunnelRun } from './model.ts'
import { emptyDetails, type FunnelSnapshot } from './refresh.ts'

/** Time fields a case holds; each moves by the same amount, so a case reads "2 h ago" whenever it runs. */
const TIME_KEYS = new Set(['createdAt', 'updatedAt', 'lastActivityAt', 'closedAt', 'startedAt', 'settledAt', 'since'])

/** A copy of `v` with every time field moved by `by` ms. */
export function shiftTimes<T>(v: T, by: number): T {
  if (Array.isArray(v)) return v.map((x) => shiftTimes(x, by)) as T
  if (!isRecord(v)) return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k] = TIME_KEYS.has(k) && typeof x === 'number' ? x + by : shiftTimes(x, by)
  return out as T
}

export type FunnelCase = {
  now: number
  items: Record<string, unknown>
  works?: Record<string, unknown>
  runList: unknown
  runs?: Record<string, { tasks?: unknown; workers?: unknown; gates?: unknown }>
  waits?: Wait[]
  homes?: Record<string, string>
}

/** The case as the worker's inputs: the Waits data (open items, Runs, waits, homes), closed items and bot work. */
export function caseInputs(raw: unknown, now?: number): { waits: WaitsData; closed: ReturnType<typeof parseBotItemList>['items']; works: ReturnType<typeof parseBotWorkList>['items']; now: number } {
  const c0 = raw as FunnelCase
  const at = now ?? c0.now
  const c = shiftTimes(c0, at - c0.now)
  const items = Object.values(c.items).flatMap((page) => parseBotItemList(page).items)
  const runs: FunnelRun[] = parseRunList(c.runList).map((run) => {
    const r = c.runs?.[run.id] ?? {}
    return { run, tasks: parseTaskList(r.tasks ?? {}), workers: parseWorkerList(r.workers ?? {}), gates: parseGateList(r.gates ?? {}) }
  })
  const works = Object.values(c.works ?? {}).flatMap((page) => parseBotWorkList(page).items)
  const open = items.filter((i) => i.status !== 'done' && i.status !== 'canceled')
  return {
    waits: { updatedAt: at, bots: [], items: open, runs: runs.map((r) => ({ ...r, tasks: [...r.tasks], workers: [...r.workers], gates: [...r.gates] })), waits: c.waits ?? [], homes: c.homes ?? {} },
    closed: items.filter((i) => !open.includes(i)),
    works,
    now: at
  }
}

/** The snapshot the worker would hold for this case, read at `now`. */
export function funnelFromCase(raw: unknown, now?: number): FunnelSnapshot {
  const { waits, closed, works, now: at } = caseInputs(raw, now)
  const funnel = buildFunnel({ items: [...waits.items, ...closed], works, runs: waits.runs, waits: waits.waits, now: at })
  return { status: 'ok', version: 1, updatedAt: at, waitsAt: at, funnel, details: funnel.pieces.length ? funnelDetails(funnel, waits.runs) : emptyDetails(), notes: [], buildMs: 0, refreshSeconds: 20 }
}
