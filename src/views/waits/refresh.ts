// R9: keeps the waits current, in two loops that never wait on each other:
// - the agent loop (`agentCycle`): `worktree ps` only (agent states and trust reasons), every 4 s
//   and soon after each agent event, so a trust prompt gets its label within 10 s even when the
//   other calls are slow;
// - the item loop (`itemCycle`): bot items and gates every 4 s; every 20 s also the lists those
//   depend on (bots, Runs, and the tasks and workers of each Run).
// Calls of one kind never overlap: each command name is a lane, a lane runs its calls one after
// another, and a cycle skips a lane that is still busy. A failed call keeps the last good data of
// that source.

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

/**
 * What the Waits loops last read, for the Funnel (funnel slice 2): it builds from these and reads
 * only what Waits does not (closed items, bot work), so it adds no call for data Waits has.
 */
export type WaitsData = {
  /** When the last pass ended; null before the first. */
  updatedAt: number | null
  bots: Bot[]
  /** Open items of every bot not paused. */
  items: BotItem[]
  /** Every Run listed; legacy and unbound Runs with no lists. */
  runs: { run: Run; tasks: Task[]; workers: Worker[]; gates: Gate[] }[]
  waits: Wait[]
  /** Bot name -> its home workspace (the first `worktree ps` row under it), where its chats open. */
  homes?: Record<string, string>
}

/** Where the gates' first-seen times live between worker restarts (gate id -> ms since epoch). */
export type SeenStore = { load(): Promise<unknown>; save(seen: Record<string, number>): Promise<unknown> }

export type WaitsRefresher = {
  /** Both loops once, side by side; `slow` also re-reads bots, Runs, tasks and workers. */
  cycle(slow: boolean): Promise<void>
  /** The agent loop once: `worktree ps` only. */
  agentCycle(): Promise<void>
  /** The item loop once: bot items and gates; `slow` also re-reads bots, Runs, tasks and workers. */
  itemCycle(slow: boolean): Promise<void>
  /** An `agent.status.changed` payload: updates the list at once, no CLI call. */
  onAgentEvent(e: AgentStatusEvent): void
  snapshot(): WaitsSnapshot
  /** The last good data of every source, as plain lists. No CLI call. */
  data(): WaitsData
}

/** One pass of one loop: whether a call failed, a backoff-class failure stops it, a call answered. */
type Pass = { failed: boolean; backoff: boolean; answered: boolean }

const isBackoff = (e: CliFailure): boolean => e.kind === 'not_found' || e.kind === 'spawn' || (e.kind === 'cli_error' && e.code === 'runtime_unavailable')

export function createWaitsRefresher(deps: { run: RunCli; now?: () => number; onChange?: (s: WaitsSnapshot) => void; onData?: () => void; cliPath?: () => string | null; seen?: SeenStore }): WaitsRefresher {
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
  /** Whether the last pass of each loop read without a failure; null before its first. */
  let agentsClean: boolean | null = null
  let itemsClean: boolean | null = null
  /** A full item pass (bots and Runs too) has read without a failure. */
  let fullClean = false
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
    // Every pass and agent event, changed or not: the funnel builds from more than the waits.
    try {
      deps.onData?.()
    } catch {
      // A funnel failure never stops the waits.
    }
  }

  const snapshot = (): WaitsSnapshot => ({ waits, updatedAt, primed, banner, cliPath: deps.cliPath?.() ?? null })

  /**
   * Runs one call; on failure records the banner and returns null. After a backoff-class failure
   * (CLI missing or Orca not answering) the rest of the pass makes no more calls.
   */
  const call = async (request: CliRequest, pass: Pass): Promise<unknown | null> => {
    if (pass.backoff) return null
    const r = await deps.run(request)
    if (r.ok) {
      pass.answered = true
      return r.result
    }
    // The worker is stopping: end the pass quietly, no banner and no backoff state.
    if (r.error.kind === 'stopped') {
      pass.backoff = true
      return null
    }
    pass.failed = true
    const e = r.error
    banner = {
      kind: e.kind,
      message: clean(e.message, MAX.what),
      ...(e.code ? { code: clean(e.code, MAX.who) } : {}),
      ...(e.tried ? { tried: e.tried.map((t) => clean(t.path, MAX_PATH)) } : {})
    }
    if (isBackoff(e)) pass.backoff = true
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

  const readTasks = async (run: string, pass: Pass): Promise<void> => {
    const r = await call({ command: 'orchestration task-list', run }, pass)
    if (r !== null) tasks.set(run, parseTaskList(r))
  }
  const readWorkers = async (run: string, pass: Pass): Promise<void> => {
    const r = await call({ command: 'orchestration worker-list', run }, pass)
    if (r !== null) workers.set(run, parseWorkerList(r))
  }

  const slowLanes = async (pass: Pass): Promise<void> => {
    await Promise.all([
      lane('bot list', async () => {
        const r = await call({ command: 'bot list' }, pass)
        if (r !== null) {
          bots = parseBotList(r)
          // A paused bot is not read, so its old questions would stay: drop them with the bot.
          prune(items, bots.filter((b) => !b.paused).map((b) => b.id))
        }
      }),
      lane('orchestration run-list', async () => {
        const r = await call({ command: 'orchestration run-list' }, pass)
        if (r !== null) {
          runs = parseRunList(r)
          const ids = liveRuns().map((x) => x.id)
          prune(gates, ids)
          prune(tasks, ids)
          prune(workers, ids)
        }
      })
    ])
    if (pass.backoff) return
    await Promise.all([
      lane('orchestration task-list', async () => {
        for (const run of liveRuns()) await readTasks(run.id, pass)
      }),
      lane('orchestration worker-list', async () => {
        for (const run of liveRuns()) await readWorkers(run.id, pass)
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

  const agentLane = (pass: Pass): Promise<void> =>
    lane('worktree ps', async () => {
      const readFrom = seq
      const r = await call({ command: 'worktree ps', agentWait: true }, pass)
      if (r === null) return
      const ps = parseWorktreePs(r)
      worktrees = ps.worktrees
      // A cut list does not say an agent is gone.
      if (!ps.truncated) dropClosed(readFrom)
    })

  const itemLanes = async (pass: Pass): Promise<void> => {
    await Promise.all([
      lane('bot item list', async () => {
        for (const bot of bots) {
          if (bot.paused) continue
          const r = await call({ command: 'bot item list', bot: bot.id }, pass)
          if (r !== null) items.set(bot.id, parseBotItemList(r).items)
        }
      }),
      lane('orchestration gate-list', async () => {
        for (const run of liveRuns()) {
          const r = await call({ command: 'orchestration gate-list', run: run.id }, pass)
          if (r === null) continue
          const list = parseGateList(r)
          // A gate on a task not read yet would show apart from its item and worker agent until
          // the next slow read: read that Run's tasks and workers first, then show the gates.
          const known = new Set((tasks.get(run.id) ?? []).map((t) => t.id))
          if (list.some((g) => g.status === 'pending' && !known.has(g.taskId))) {
            await Promise.all([lane('orchestration task-list', () => readTasks(run.id, pass)), lane('orchestration worker-list', () => readWorkers(run.id, pass))])
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

  /** Ends a pass of either loop: backoff, banner, primed, then the new list. */
  const finish = (pass: Pass): void => {
    if (pass.backoff) {
      // Once per window, however many calls or loops failed: 4, 8, 16 ... 60 s.
      if (now() >= backoffUntil) {
        backoffUntil = now() + backoff
        backoff = Math.min(backoff * 2, BACKOFF_MS.max)
      }
    } else if (!pass.failed && pass.answered) {
      // Only a pass that reached the CLI ends the backoff; one with nothing to read does not.
      backoff = BACKOFF_MS.first
    }
    // The banner goes once both loops last read clean.
    if (agentsClean !== false && itemsClean !== false) banner = null
    if (fullClean && agentsClean === true) primed = true
    updatedAt = now()
    recompute()
  }

  const agentCycle = async (): Promise<void> => {
    if (now() < backoffUntil) return
    const pass: Pass = { failed: false, backoff: false, answered: false }
    await agentLane(pass)
    agentsClean = !pass.failed
    // Before the first item pass the gates are unknown, so a gated task's worker agent would show
    // as a row of its own for a moment: keep the read and let the item pass post it.
    if (itemsClean === null && !pass.backoff) return
    finish(pass)
  }

  /** Has any item pass started: the first one reads bots and Runs too. */
  let itemsStarted = false
  const itemCycle = async (slow: boolean): Promise<void> => {
    if (now() < backoffUntil) return
    await loadSeen()
    const pass: Pass = { failed: false, backoff: false, answered: false }
    const full = slow || !itemsStarted
    itemsStarted = true
    if (full) await slowLanes(pass)
    if (!pass.backoff) await itemLanes(pass)
    itemsClean = !pass.failed
    if (full && !pass.failed) fullClean = true
    finish(pass)
    if (!pass.failed) saveSeen()
  }

  return {
    async cycle(slow) {
      await Promise.all([agentCycle(), itemCycle(slow)])
    },
    agentCycle,
    itemCycle,
    onAgentEvent(e) {
      const a = agentFromEvent(e)
      events.delete(a.key)
      events.set(a.key, { agent: a, seq: ++seq })
      while (events.size > MAX_EVENTS) events.delete(events.keys().next().value as string)
      recompute()
    },
    snapshot,
    data: () => ({
      updatedAt,
      bots: [...bots],
      items: [...items.values()].flat(),
      runs: runs.map((run) => ({ run, tasks: tasks.get(run.id) ?? [], workers: workers.get(run.id) ?? [], gates: gates.get(run.id) ?? [] })),
      waits,
      homes: homesOf(worktrees)
    })
  }
}

/** Bot name -> the first workspace `worktree ps` lists under it (the same pick as a Waits question row). */
export function homesOf(worktrees: readonly Worktree[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const w of worktrees) if (w.bot && !(w.bot in out)) out[w.bot] = w.worktreeId
  return out
}
