// R9: keeps the waits current. Every 4 s (and soon after each agent event) it reads items,
// gates and `worktree ps`; every 20 s it also reads the lists those depend on (bots, Runs, and
// the tasks and workers of each Run). Calls of one kind never overlap: each command name is a
// lane, a lane runs its calls one after another, and a cycle skips a lane that is still busy.
// A failed call keeps the last good data of that source.

import type { CliRequest } from '../../cli/commands.ts'
import type { CliFailure, CliResult } from '../../cli/run.ts'
import {
  agentFromEvent, parseBotItemList, parseBotList, parseGateList, parseRunList, parseTaskList, parseWorkerList, parseWorktreePs,
  type Agent, type AgentStatusEvent, type Bot, type BotItem, type Gate, type Run, type Task, type Worker, type Worktree
} from '../../model/index.ts'
import { collectWaits, type Wait } from './collect.ts'

export const FAST_MS = 4_000
export const SLOW_EVERY = 5 // 5 x 4 s = 20 s
/** Backoff after the CLI is missing or answers runtime_unavailable (PRD 5): 4, 8, 16 ... 60 s. */
export const BACKOFF_MS = { first: 4_000, max: 60_000 } as const
/** Agent events cap, so a long session does not grow the map without end. */
const MAX_EVENTS = 500

export type WaitsBanner = { kind: CliFailure['kind']; message: string; code?: string; tried?: string[] }

export type WaitsSnapshot = {
  waits: Wait[]
  /** When the last cycle ended, ms since epoch; null before the first. */
  updatedAt: number | null
  /** The newest failure since the last clean cycle, for one banner; null when all is well. */
  banner: WaitsBanner | null
  /** The CLI path in use, for the footer. */
  cliPath: string | null
}

export type RunCli = (request: CliRequest) => Promise<CliResult>

export type WaitsRefresher = {
  /** One cycle; `slow` also re-reads bots, Runs, tasks and workers. Resolves when every lane it started is done. */
  cycle(slow: boolean): Promise<void>
  /** An `agent.status.changed` payload: updates the list at once, no CLI call. */
  onAgentEvent(e: AgentStatusEvent): void
  snapshot(): WaitsSnapshot
}

export function createWaitsRefresher(deps: { run: RunCli; now?: () => number; onChange?: (s: WaitsSnapshot) => void; cliPath?: () => string | null }): WaitsRefresher {
  const now = deps.now ?? Date.now
  const busy = new Set<string>()
  let bots: Bot[] = []
  let runs: Run[] = []
  const items = new Map<string, BotItem[]>() // by bot id
  const gates = new Map<string, Gate[]>() // by run id
  const tasks = new Map<string, Task[]>()
  const workers = new Map<string, Worker[]>()
  let worktrees: Worktree[] = []
  const events = new Map<string, Agent>() // by pane key
  const firstSeen = new Map<string, number>()
  let banner: WaitsBanner | null = null
  let cycleFailed = false
  let backoffUntil = 0
  let backoff: number = BACKOFF_MS.first
  let updatedAt: number | null = null
  let waits: Wait[] = []
  let last = ''

  const recompute = (): void => {
    const allGates = [...gates.values()].flat()
    for (const g of allGates) if (!firstSeen.has(g.id)) firstSeen.set(g.id, now())
    waits = collectWaits({ items: [...items.values()].flat(), gates: allGates, tasks: [...tasks.values()].flat(), workers: [...workers.values()].flat(), worktrees, events: [...events.values()], firstSeen })
    const snap = snapshot()
    const sig = JSON.stringify([snap.waits, snap.banner, snap.cliPath])
    if (sig !== last) {
      last = sig
      deps.onChange?.(snap)
    }
  }

  const snapshot = (): WaitsSnapshot => ({ waits, updatedAt, banner, cliPath: deps.cliPath?.() ?? null })

  /** Runs one call; on failure records the banner and returns null. */
  const call = async (request: CliRequest): Promise<unknown | null> => {
    const r = await deps.run(request)
    if (r.ok) return r.result
    cycleFailed = true
    const e = r.error
    banner = { kind: e.kind, message: e.message, ...(e.code ? { code: e.code } : {}), ...(e.tried ? { tried: e.tried.map((t) => t.path) } : {}) }
    if (e.kind === 'not_found' || (e.kind === 'cli_error' && e.code === 'runtime_unavailable') || e.kind === 'spawn') {
      backoffUntil = now() + backoff
      backoff = Math.min(backoff * 2, BACKOFF_MS.max)
    }
    return null
  }

  /** A lane: skipped when the last one of its kind is still running, else its jobs run in turn. */
  const lane = async (kind: string, job: () => Promise<void>): Promise<void> => {
    if (busy.has(kind)) return
    busy.add(kind)
    try {
      await job()
    } finally {
      busy.delete(kind)
    }
  }

  /** Keeps only the keys still listed, so a removed bot or Run drops its rows. */
  const prune = <T>(m: Map<string, T>, keep: readonly string[]): void => {
    for (const k of [...m.keys()]) if (!keep.includes(k)) m.delete(k)
  }
  const liveRuns = (): Run[] => runs.filter((r) => !r.legacy && !r.unbound)

  const slowLanes = async (): Promise<void> => {
    await Promise.all([
      lane('bot list', async () => {
        const r = await call({ command: 'bot list' })
        if (r !== null) {
          bots = parseBotList(r)
          prune(items, bots.map((b) => b.id))
        }
      }),
      lane('orchestration run-list', async () => {
        const r = await call({ command: 'orchestration run-list' })
        if (r !== null) {
          runs = parseRunList(r)
          const ids = liveRuns().map((x) => x.id)
          prune(gates, ids)
          prune(tasks, ids)
          prune(workers, ids)
        }
      })
    ])
    await Promise.all([
      lane('orchestration task-list', async () => {
        for (const run of liveRuns()) {
          const r = await call({ command: 'orchestration task-list', run: run.id })
          if (r !== null) tasks.set(run.id, parseTaskList(r))
        }
      }),
      lane('orchestration worker-list', async () => {
        for (const run of liveRuns()) {
          const r = await call({ command: 'orchestration worker-list', run: run.id })
          if (r !== null) workers.set(run.id, parseWorkerList(r))
        }
      })
    ])
  }

  const fastLanes = async (): Promise<void> => {
    await Promise.all([
      lane('worktree ps', async () => {
        const r = await call({ command: 'worktree ps', agentWait: true })
        if (r !== null) worktrees = parseWorktreePs(r).worktrees
      }),
      lane('bot item list', async () => {
        for (const bot of bots) {
          if (bot.paused) continue
          const r = await call({ command: 'bot item list', bot: bot.id })
          if (r !== null) items.set(bot.id, parseBotItemList(r).items)
        }
      }),
      lane('orchestration gate-list', async () => {
        for (const run of liveRuns()) {
          const r = await call({ command: 'orchestration gate-list', run: run.id })
          if (r !== null) gates.set(run.id, parseGateList(r))
        }
      })
    ])
  }

  return {
    async cycle(slow) {
      if (now() < backoffUntil) return
      cycleFailed = false
      if (slow || updatedAt === null) await slowLanes()
      if (now() >= backoffUntil) await fastLanes()
      if (!cycleFailed) {
        banner = null
        backoff = BACKOFF_MS.first
      }
      updatedAt = now()
      recompute()
    },
    onAgentEvent(e) {
      const a = agentFromEvent(e)
      events.delete(a.key)
      events.set(a.key, a)
      while (events.size > MAX_EVENTS) events.delete(events.keys().next().value as string)
      recompute()
    },
    snapshot
  }
}
