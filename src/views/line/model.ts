// R6. The shipping line: for each Run, its tasks in build order, the worker on each task, the
// PR link if any, and the gates (A: open questions, B: merge per PR). Done tasks fold.
//
// Pure: takes what the CLI printed (already parsed by src/model) and returns a plain JSON
// snapshot the panel draws. Every Run, task, worker and gate in the input lands in exactly one
// place in the output; the fixture test checks that.

import { buildOrder, firstLine, type Gate, type PullRequest, type Run, type RunDetail, type Task, type TaskStatus, type Worker } from '../../model/index.ts'

/** Untrusted text (titles, questions) is cut to its first line and this many characters. */
export const MAX_TEXT = 140

/** Cuts untrusted text to one line of plain characters. The panel draws it as text, never HTML. */
export function cleanText(text: string, max = MAX_TEXT): string {
  // Control characters out (bidi overrides included), whitespace folded.
  const one = firstLine(text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one
}

/** Gate A: an open question. Gate B: merge one PR. */
export type GateKind = 'A' | 'B'

/**
 * Which gate a question is. The playbook writes "Gate A: …" or "Gate B: …"; without that
 * prefix a question about merging is B, anything else A.
 */
export function gateKind(question: string): GateKind {
  const prefix = /^\s*gate\s*([ab])\b/i.exec(question)
  if (prefix) return prefix[1].toUpperCase() as GateKind
  return /\bmerge\b/i.test(question) ? 'B' : 'A'
}

export type GateLine = { id: string; kind: GateKind; status: Gate['status']; question: string; options: string[] }

export type WorkerLine = {
  dispatchId: string
  /** `claude/claude-opus-5-5`; null when the CLI did not say. */
  agent: string | null
  state: Worker['state']
  outcome: string | null
  liveness: string | null
  failed: boolean
  /** The task's current Dispatch (a task can have older, settled ones). */
  current: boolean
}

export type PrLine = { ref: string; number: number; url: string | null; state: PullRequest['state']; checks: string | null; review: string | null }

export type TaskLine = {
  id: string
  title: string
  status: TaskStatus
  /** Titles are untrusted, so deps are ids; the panel names them by build-order position. */
  deps: string[]
  /** 1-based place in the build order. */
  step: number
  /** Current Dispatch first, then older ones newest last as the CLI listed them. */
  workers: WorkerLine[]
  pr: PrLine | null
  gates: { a: GateLine[]; b: GateLine[] }
  /** Folded under "Done": completed with no pending gate. */
  folded: boolean
}

export type RunLine = {
  id: string
  objective: string
  /** Tasks and workers removed from the Run (run-show), so a short line is not a mystery. */
  removed: { tasks: number; workers: number }
  /** Open tasks in build order. */
  tasks: TaskLine[]
  /** Done tasks in build order; the panel folds them. */
  done: TaskLine[]
  /** Workers and gates whose task is not in task-list (removed, or a newer Orca). Shown, never dropped. */
  loose: { workers: WorkerLine[]; gates: GateLine[] }
  counts: { tasks: number; done: number; workers: number; failed: number; pendingGates: number }
  /** A per-Run call failed: one line, the rest of the Run shows what came back. */
  error: string | null
}

/** What the CLI gave for one Run. Lists are empty when a call failed; `error` says which. */
export type RunInput = { run: Run; detail: RunDetail | null; tasks: Task[]; workers: Worker[]; gates: Gate[]; error?: string | null }

/** PRs by Dispatch id, from `bot work list`. */
export type PrIndex = ReadonlyMap<string, PullRequest>

const isHttps = (url: string): boolean => /^https:\/\/[^\s"'<>]+$/i.test(url)

function prLine(pr: PullRequest): PrLine {
  return { ref: cleanText(pr.ref, 80), number: pr.number, url: isHttps(pr.url) ? pr.url : null, state: pr.state, checks: pr.checks, review: pr.review }
}

function gateLine(g: Gate): GateLine {
  return { id: g.id, kind: gateKind(g.question), status: g.status, question: cleanText(g.question), options: g.options.slice(0, 8).map((o) => cleanText(o, 40)) }
}

function workerLine(w: Worker, current: boolean): WorkerLine {
  return { dispatchId: w.dispatchId, agent: w.agent ? cleanText(w.agent, 60) : null, state: w.state, outcome: w.outcome, liveness: w.liveness, failed: w.state === 'failed' || w.outcome === 'failed', current }
}

/** One Run's line. */
export function buildRunLine(input: RunInput, prs: PrIndex = new Map()): RunLine {
  const { run, detail, tasks, workers, gates } = input
  const ordered = buildOrder(tasks)
  const taskIds = new Set(ordered.map((t) => t.id))

  const lines: TaskLine[] = ordered.map((t, i) => {
    const mine = workers.filter((w) => w.taskId === t.id)
    const current = t.dispatchId ?? mine.at(-1)?.dispatchId ?? null
    const ws = [...mine.filter((w) => w.dispatchId === current), ...mine.filter((w) => w.dispatchId !== current)].map((w) => workerLine(w, w.dispatchId === current))
    const gl = gates.filter((g) => g.taskId === t.id).map(gateLine)
    // The PR of the current worker, else of any earlier one.
    const pr = ws.map((w) => prs.get(w.dispatchId)).find((p) => p) ?? null
    const pendingGate = gl.some((g) => g.status === 'pending')
    return {
      id: t.id,
      title: cleanText(t.title),
      status: t.status,
      deps: t.deps.filter((d) => taskIds.has(d)),
      step: i + 1,
      workers: ws,
      pr: pr ? prLine(pr) : null,
      gates: { a: gl.filter((g) => g.kind === 'A'), b: gl.filter((g) => g.kind === 'B') },
      folded: t.status === 'completed' && !pendingGate
    }
  })

  const looseWorkers = workers.filter((w) => !w.taskId || !taskIds.has(w.taskId)).map((w) => workerLine(w, false))
  const looseGates = gates.filter((g) => !taskIds.has(g.taskId)).map(gateLine)

  return {
    id: run.id,
    objective: cleanText(detail?.objective || run.objective) || run.id,
    removed: { tasks: detail?.removed.tasks ?? 0, workers: detail?.removed.workers ?? 0 },
    tasks: lines.filter((l) => !l.folded),
    done: lines.filter((l) => l.folded),
    loose: { workers: looseWorkers, gates: looseGates },
    counts: {
      tasks: lines.length,
      done: lines.filter((l) => l.status === 'completed').length,
      workers: workers.length,
      failed: workers.filter((w) => w.state === 'failed' || w.outcome === 'failed').length,
      pendingGates: gates.filter((g) => g.status === 'pending').length
    },
    error: input.error ? cleanText(input.error) : null
  }
}

/** Runs that get a line: not `run_unbound` (mail only) and not legacy (read only, no tasks). */
export const hasLine = (run: Run): boolean => !run.unbound && !run.legacy

/** The panel's whole view: plain JSON, sent from the worker on `line.snapshot`. */
export type LineSnapshot = {
  /** `loading` before the first answer; `error` when run-list itself failed. */
  status: 'loading' | 'ok' | 'error'
  /** When the shown data was read (ms since epoch); kept across a failed refresh. */
  updatedAt: number | null
  /** The last refresh failed; the data shown is from `updatedAt`. One line. */
  error: { kind: string; message: string; tried: string[] } | null
  runs: RunLine[]
  /** Legacy Runs: listed by name, never a line. */
  legacy: { id: string; objective: string }[]
  refreshSeconds: number
}

export function emptySnapshot(refreshSeconds: number): LineSnapshot {
  return { status: 'loading', updatedAt: null, error: null, runs: [], legacy: [], refreshSeconds }
}

/** Every PR any bot's worker opened, keyed by Dispatch id. */
export function indexPrs(works: readonly { dispatchId: string | null; pr: PullRequest | null }[]): Map<string, PullRequest> {
  const out = new Map<string, PullRequest>()
  for (const w of works) if (w.dispatchId && w.pr && !out.has(w.dispatchId)) out.set(w.dispatchId, w.pr)
  return out
}
