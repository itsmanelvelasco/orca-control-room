// The shipping line: Runs, their tasks, the worker on each task, and decision gates.
// Sources: `orchestration run-list`, `run-show --id`, `task-list --run`, `worker-list --run`,
// `gate-list --run`, `inbox`.

import { isRunId, isTaskId } from '../cli/commands.ts'
import { bool, isRecord, numOrNull, oneOf, rows, str, strOrNull, stringList } from './envelope.ts'

// ---------- runs ----------

/** One orchestration Run. `run_unbound` (mail from no Run) and legacy Runs hold no tasks of their own. */
export type Run = {
  id: string
  /** What the Run is for. Untrusted text. */
  objective: string
  /** Old state, read only; never has a shipping line. */
  legacy: boolean
  /** The catch-all mailbox for terminals in no Run. */
  unbound: boolean
}

export function parseRunList(result: unknown): Run[] {
  const r = isRecord(result) ? result : {}
  return rows(r.runs, (x): Run | null => {
    const id = str(x.id)
    if (!isRunId(id)) return null
    return { id, objective: str(x.objective) ?? '', legacy: bool(x.legacy), unbound: id === 'run_unbound' }
  })
}

/** `run-show --id`: the Run with a count of what was removed from it. */
export type RunDetail = { id: string; objective: string; removed: { tasks: number; workers: number; lastRemovedAt: string | null } }

export function parseRunShow(result: unknown): RunDetail | null {
  const r = isRecord(result) ? result : {}
  const id = str(r.runId) ?? str(r.id)
  if (!isRunId(id)) return null
  const rem = isRecord(r.removedWork) ? r.removedWork : {}
  return { id, objective: str(r.objective) ?? '', removed: { tasks: numOrNull(rem.tasks) ?? 0, workers: numOrNull(rem.workers) ?? 0, lastRemovedAt: strOrNull(rem.lastRemovedAt) } }
}

// ---------- tasks ----------

export type TaskStatus = 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked' | 'circuit_broken' | 'unknown'
const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked', 'circuit_broken']

/** One task of a Run. In the PRD's playbook one task is one slice, one worker, one PR. */
export type Task = {
  id: string
  runId: string | null
  title: string
  status: TaskStatus
  /** Task ids this one waits for; the build order comes from these. */
  deps: string[]
  /** The current Dispatch, when one is out. */
  dispatchId: string | null
  /** The worker's terminal handle (`term_…`), when dispatched. */
  assignee: string | null
}

export function parseTaskList(result: unknown): Task[] {
  const r = isRecord(result) ? result : {}
  const runId = strOrNull(r.runId)
  return rows(r.tasks, (t): Task | null => {
    const id = str(t.id)
    if (!isTaskId(id)) return null
    return { id, runId, title: str(t.title) ?? id, status: oneOf(t.status, TASK_STATUSES, 'unknown'), deps: stringList(t.deps).filter(isTaskId), dispatchId: strOrNull(t.dispatchId), assignee: strOrNull(t.assignee) }
  })
}

/** Tasks in build order: each after the tasks it depends on, otherwise in list order. Cycles keep list order. */
export function buildOrder(tasks: readonly Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const out: Task[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (t: Task): void => {
    if (state.get(t.id)) return
    state.set(t.id, 'visiting')
    for (const d of t.deps) {
      const dep = byId.get(d)
      if (dep && !state.get(dep.id)) visit(dep)
    }
    state.set(t.id, 'done')
    out.push(t)
  }
  for (const t of tasks) visit(t)
  return out
}

// ---------- workers ----------

/** A Dispatch's lifecycle. `failed`, `succeeded`, `stopped` and `abandoned` are final. */
export type WorkerState = 'starting' | 'ready' | 'start_unknown' | 'stopping' | 'stop_unknown' | 'failed' | 'succeeded' | 'stopped' | 'abandoned' | 'unknown'
const WORKER_STATES: readonly WorkerState[] = ['starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown', 'failed', 'succeeded', 'stopped', 'abandoned']

/** One worker (a supervised Dispatch) on a task. */
export type Worker = {
  dispatchId: string
  taskId: string | null
  state: WorkerState
  /** How the work went: `in_progress`, `succeeded`, `failed`, ... Kept as Orca prints it. */
  outcome: string | null
  /** `live` while the terminal answers. */
  liveness: string | null
  /** `claude/claude-opus-5-5`, `codex/...`. */
  agent: string | null
  terminal: string | null
  /** Process accounting, separate from task status: active, reclaimable, retained, released, ... */
  terminalState: string | null
  /** `<repoId>::<path>`: the worktree the worker runs in. */
  workspace: string | null
  host: string | null
}

export const isWorkerFailed = (w: Worker): boolean => w.state === 'failed' || w.outcome === 'failed'

export function parseWorkerList(result: unknown): Worker[] {
  const r = isRecord(result) ? result : {}
  return rows(r.workers, (w): Worker | null => {
    const dispatchId = str(w.dispatchId)
    if (!dispatchId) return null
    const taskId = str(w.taskId)
    return {
      dispatchId,
      taskId: isTaskId(taskId) ? taskId : null,
      state: oneOf(w.state, WORKER_STATES, 'unknown'),
      outcome: strOrNull(w.outcome),
      liveness: strOrNull(w.liveness),
      agent: strOrNull(w.agent),
      terminal: strOrNull(w.terminal),
      terminalState: strOrNull(w.terminalState),
      workspace: strOrNull(w.workspace),
      host: strOrNull(w.host)
    }
  })
}

// ---------- gates ----------

export type GateStatus = 'pending' | 'resolved' | 'timeout' | 'unknown'

/** A decision gate blocking a task. A `pending` gate is a wait on the user (R4). */
export type Gate = {
  /** `gate_…`. */
  id: string
  taskId: string
  status: GateStatus
  /** Untrusted text. */
  question: string
  /** The answers offered, if any. */
  options: string[]
}

export function parseGateList(result: unknown): Gate[] {
  const r = isRecord(result) ? result : {}
  return rows(r.gates, (g): Gate | null => {
    const id = str(g.id)
    const taskId = str(g.taskId) ?? str(g.task_id)
    if (!id || !isTaskId(taskId)) return null
    return { id, taskId, status: oneOf(g.status, ['pending', 'resolved', 'timeout'] as const, 'unknown'), question: str(g.question) ?? '', options: stringList(g.options) }
  })
}

// ---------- inbox ----------

/** One orchestration message (concise view: the body is cut to 200 characters by the CLI). */
export type InboxMessage = { id: string; type: string; from: string | null; to: string | null; subject: string; body: string; handled: boolean }

export function parseInbox(result: unknown): InboxMessage[] {
  const r = isRecord(result) ? result : {}
  return rows(r.messages, (m): InboxMessage | null => {
    const id = str(m.id)
    if (!id) return null
    return { id, type: str(m.type) ?? 'message', from: strOrNull(m.from), to: strOrNull(m.to), subject: str(m.subject) ?? '', body: str(m.body) ?? '', handled: bool(m.handled) }
  })
}
