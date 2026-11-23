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
import { collectWaits, type AgentSpell, type Wait } from './collect.ts'
import { clean, MAX } from './text.ts'

export const FAST_MS = 4_000
export const SLOW_EVERY = 5 // 5 x 4 s = 20 s
/** Backoff after the CLI is missing or answers runtime_unavailable (PRD 5): 4, 8, 16 ... 60 s, once per failed cycle. */
export const BACKOFF_MS = { first: 4_000, max: 60_000 } as const
/** Agent events cap, so a long session does not grow the map without end. */
const MAX_EVENTS = 500
/** Longest CLI path shown in the banner. */
const MAX_PATH = 200

export type WaitsBanner = { kind: CliFailure['kind']; message: string; code?: string; tried?: string[] }

export type WaitsSnapshot = {
  waits: Wait[]
  /** When the last cycle ended, ms since epoch; null before the first. */
  updatedAt: number | null
  /** True once one cycle read every source without a failure: what waits then is the starting point. */
  primed: boolean
  /** The newest failure since the last clean cycle, for one banner; null when all is well. */
  banner: WaitsBanner | null
  /** The CLI path in use, for the footer. */
  cliPath: string | null
}

export type RunCli = (request: CliRequest) => Promise<CliResult>

/** Where the gates' first-seen times live between worker restarts (gate id -> ms since epoch). */
export type SeenStore = { load(): Promise<unknown>; save(seen: Record<string, number>): Promise<unknown> }

export type WaitsRefresher = {
  /** One cycle; `slow` also re-reads bots, Runs, tasks and workers. Resolves when every lane it started is done. */
  cycle(slow: boolean): Promise<void>
  /** An `agent.status.changed` payload: updates the list at once, no CLI call. */
  onAgentEvent(e: AgentStatusEvent): void
  snapshot(): WaitsSnapshot
}

const isBackoff = (e: CliFailure): boolean => e.kind === 'not_found' || e.kind === 'spawn' || (e.kind === 'cli_error' && e.code === 'runtime_unavailable')

export function createWaitsRefresher(deps: { run: RunCli; now?: () => number; onChange?: (s: WaitsSnapshot) => void; cliPath?: () => string | null; seen?: SeenStore }): WaitsRefresher {
  const now = deps.now ?? Date.now
  const busy = new Set<string>()
  let bots: Bot[] = []
  let runs: Run[] = []
  const items = new Map<string, BotItem[]>() // by bot id
  const gates = new Map<string, Gate[]>() // by run id
  const tasks = new Map<string, Task[]>()
  const workers = new Map<string, Worker[]>()
  let worktrees: Worktree[] = []
  /** The newest event per pane key, with the order it came in. */
  const events = new Map<string, { agent: Agent; seq: number }>()
  let seq = 0
  const firstSeen = new Map<string, number>()
  let seenLoaded = false
  let seenSaved = ''
  const spells = new Map<string, AgentSpell>()
  let banner: WaitsBanner | null = null
  let cycleFailed = false
  let cycleBackoff = false
  let backoffUntil = 0
  let backoff: number = BACKOFF_MS.first
  let updatedAt: number | null = null
  let primed = false
  let waits: Wait[] = []
  let last = ''

  const recompute = (): void => {
    const allGates = [...gates.values()].flat()
    for (const g of allGates) if (!firstSeen.has(g.id)) firstSeen.set(g.id, now())
    const evs = [...events.values()].map((e) => e.agent)
    waits = collectWaits({ items: [...items.values()].flat(), gates: allGates, tasks: [...tasks.values()].flat(), workers: [...workers.values()].flat(), worktrees, events: evs, firstSeen, spells })
    const snap = snapshot()
    const sig = JSON.stringify(snap)
    if (sig !== last) {
      last = sig
      deps.onChange?.(snap)
    }
  }

  const snapshot = (): WaitsSnapshot => ({ waits, updatedAt, primed, banner, cliPath: deps.cliPath?.() ?? null })

  /**
   * Runs one call; on failure records the banner and returns null. After a backoff-class failure
   * (CLI missing or Orca not answering) the rest of the cycle makes no more calls.
   */
  const call = async (request: CliRequest): Promise<unknown | null> => {
    if (cycleBackoff) return null
    const r = await deps.run(request)
    if (r.ok) return r.result
    cycleFailed = true
    const e = r.error
    banner = {
      kind: e.kind,
      message: clean(e.message, MAX.what),
      ...(e.code ? { code: clean(e.code, MAX.who) } : {}),
      ...(e.tried ? { tried: e.tried.map((t) => clean(t.path, MAX_PATH)) } : {})
    }
    if (isBackoff(e)) cycleBackoff = true
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

  const readTasks = async (run: string): Promise<void> => {
    const r = await call({ command: 'orchestration task-list', run })
    if (r !== null) tasks.set(run, parseTaskList(r))
  }
  const readWorkers = async (run: string): Promise<void> => {
    const r = await call({ command: 'orchestration worker-list', run })
    if (r !== null) workers.set(run, parseWorkerList(r))
  }

  const slowLanes = async (): Promise<void> => {
    await Promise.all([
      lane('bot list', async () => {
        const r = await call({ command: 'bot list' })
        if (r !== null) {
          bots = parseBotList(r)
          // A paused bot is not read, so its old questions would stay: drop them with the bot.
          prune(items, bots.filter((b) => !b.paused).map((b) => b.id))
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
    if (cycleBackoff) return
    await Promise.all([
      lane('orchestration task-list', async () => {
        for (const run of liveRuns()) await readTasks(run.id)
      }),
      lane('orchestration worker-list', async () => {
        for (const run of liveRuns()) await readWorkers(run.id)
      })
    ])
  }

  /** Drops events of agents `worktree ps` no longer lists (their terminal closed), unless newer than the read. */
  const dropClosed = (readFrom: number): void => {
    const panes = new Set<string>()
    const terminals = new Set<string>()
    for (const a of worktrees.flatMap((w) => w.agents)) {
      if (a.paneKey) panes.add(a.paneKey)
      if (a.terminalId) terminals.add(a.terminalId)
    }
    for (const [k, e] of [...events]) {
      if (e.seq > readFrom) continue
      if ((e.agent.paneKey && panes.has(e.agent.paneKey)) || (e.agent.terminalId && terminals.has(e.agent.terminalId))) continue
      events.delete(k)
    }
  }

  const fastLanes = async (): Promise<void> => {
    await Promise.all([
      lane('worktree ps', async () => {
        const readFrom = seq
        const r = await call({ command: 'worktree ps', agentWait: true })
        if (r === null) return
        const ps = parseWorktreePs(r)
        worktrees = ps.worktrees
        // A cut list does not say an agent is gone.
        if (!ps.truncated) dropClosed(readFrom)
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
          if (r === null) continue
          const list = parseGateList(r)
          // A gate on a task not read yet would show apart from its item and worker agent until
          // the next slow read: read that Run's tasks and workers first, then show the gates.
          const known = new Set((tasks.get(run.id) ?? []).map((t) => t.id))
          if (list.some((g) => g.status === 'pending' && !known.has(g.taskId))) {
            await Promise.all([lane('orchestration task-list', () => readTasks(run.id)), lane('orchestration worker-list', () => readWorkers(run.id))])
          }
          gates.set(run.id, list)
        }
      })
    ])
  }

  const loadSeen = async (): Promise<void> => {
    if (seenLoaded || !deps.seen) return
    seenLoaded = true
    try {
      const v = await deps.seen.load()
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [id, t] of Object.entries(v as Record<string, unknown>)) if (typeof t === 'number' && Number.isFinite(t) && !firstSeen.has(id)) firstSeen.set(id, t)
      }
    } catch {
      // No stored times: gates are dated from now.
    }
    seenSaved = JSON.stringify(Object.fromEntries(firstSeen))
  }

  /** After a clean cycle: keeps the first-seen times of listed gates only, and stores them when they changed. */
  const saveSeen = (): void => {
    prune(firstSeen, [...gates.values()].flat().map((g) => g.id))
    const out = Object.fromEntries(firstSeen)
    const s = JSON.stringify(out)
    if (!deps.seen || s === seenSaved) return
    seenSaved = s
    void deps.seen.save(out).catch(() => undefined)
  }

  return {
    async cycle(slow) {
      if (now() < backoffUntil) return
      await loadSeen()
      cycleFailed = false
      cycleBackoff = false
      const full = slow || updatedAt === null
      if (full) await slowLanes()
      if (!cycleBackoff) await fastLanes()
      if (cycleBackoff) {
        // Once per cycle, however many calls failed: 4, 8, 16 ... 60 s.
        backoffUntil = now() + backoff
        backoff = Math.min(backoff * 2, BACKOFF_MS.max)
      } else {
        backoff = BACKOFF_MS.first
      }
      if (!cycleFailed) {
        banner = null
        if (full) primed = true
      }
      updatedAt = now()
      recompute()
      if (!cycleFailed) saveSeen()
    },
    onAgentEvent(e) {
      const a = agentFromEvent(e)
      events.delete(a.key)
      events.set(a.key, { agent: a, seq: ++seq })
      while (events.size > MAX_EVENTS) events.delete(events.keys().next().value as string)
      recompute()
    },
    snapshot
  }
}
