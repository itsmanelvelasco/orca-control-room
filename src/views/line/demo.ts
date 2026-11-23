// Builds a LineSnapshot from a hand-made case file (test/fixtures/cases/*.json: runList,
// runShow, taskList, workerList, gateList, prs), for tests, `orca plugin check` and screenshots.
// The same code path as the worker: parse each envelope's result, then buildRunLine.
import { isRecord, parseGateList, parseRunList, parseRunShow, parseTaskList, parseWorkerList, type PullRequest } from '../../model/index.ts'
import { buildRunLine, hasLine, type LineSnapshot } from './model.ts'

const resultOf = (v: unknown): unknown => (isRecord(v) ? v.result : undefined)

/** `now` is fixed so a snapshot is the same on every run. */
export function lineFromCase(c: unknown, now = Date.UTC(2026, 10, 23, 12, 0, 0)): LineSnapshot {
  const k = isRecord(c) ? c : {}
  const runs = parseRunList(resultOf(k.runList))
  const detail = parseRunShow(resultOf(k.runShow))
  const prs = new Map<string, PullRequest>(isRecord(k.prs) ? (Object.entries(k.prs) as [string, PullRequest][]) : [])
  const tasks = parseTaskList(resultOf(k.taskList))
  const workers = parseWorkerList(resultOf(k.workerList))
  const gates = parseGateList(resultOf(k.gateList))
  const live = runs.filter(hasLine)
  return {
    status: 'ok',
    updatedAt: now,
    error: null,
    // A case holds one Run's lists; they belong to the Run run-show names, else the first.
    runs: live.map((run, i) => {
      const mine = detail ? detail.id === run.id : i === 0
      return buildRunLine({ run, detail: detail?.id === run.id ? detail : null, tasks: mine ? tasks : [], workers: mine ? workers : [], gates: mine ? gates : [] }, prs)
    }),
    legacy: runs.filter((r) => r.legacy).map((r) => ({ id: r.id, objective: r.objective })),
    hiddenRuns: 0,
    notes: [],
    refreshSeconds: 20
  }
}
