// Reads the shipping line from the CLI in turns: one call at a time, never two of the same kind
// (R9), about every `refreshSeconds` (default 20 s). A failed call keeps the last good data for
// what it would have read and says why (PRD 5). Read only: every call is an allow-listed read
// (src/cli/commands.ts).

// The panel imports this file, so it takes the CLI's pure parts only: src/cli/index.ts pulls in
// node:child_process, which a panel cannot load (test/panel-imports.test.ts).
import { isBotId, type CliRequest } from '../../cli/commands.ts'
import type { CliFailure, CliResult } from '../../cli/run.ts'
import { parseBotList, parseBotWorkList, parseGateList, parseRunList, parseRunShow, parseTaskList, parseWorkerList, type PullRequest } from '../../model/index.ts'
import { buildRunLine, cleanText, emptySnapshot, hasLine, indexPrs, type LineSnapshot, type RunInput } from './model.ts'

/** Thrown inside a refresh when the worker stops; the refresh ends with no error shown. */
const STOPPED = new Error('stopped')

export const DEFAULT_REFRESH_SECONDS = 20
/**
 * A refresh counts as due this much before `refreshSeconds` has passed since the last one
 * started, so a panel tick (every 1 s) that lands a little early still refreshes.
 */
export const SLACK_MS = 1_000
/** At least this long between the end of one refresh and the start of the next. */
export const MIN_GAP_MS = 2_000
/** PRD 5: lists cap at 50 per group; the same cap keeps the CLI calls per turn bounded. */
export const MAX_RUNS = 50
export const MAX_BOTS = 50

export type LineCli = { run(request: CliRequest): Promise<CliResult> }

export type LineRefresher = {
  /** What the panel shows now; `version` rises after each refresh. */
  snapshot(): LineSnapshot
  /**
   * Starts a refresh when one is due (or `force`) and none is running. Resolves when that
   * refresh (or the one already running) ends. Never rejects.
   */
  refresh(force?: boolean): Promise<LineSnapshot>
}

function failure(e: CliFailure): NonNullable<LineSnapshot['error']> {
  return { kind: e.kind, message: cleanText(e.message, 200), tried: (e.tried ?? []).map((t) => t.path).slice(0, 8) }
}

const short = (command: string): string => command.replace('orchestration ', '')

export function createLineRefresher(opts: { cli: LineCli; refreshSeconds?: number; now?: () => number; onChange?: (s: LineSnapshot) => void }): LineRefresher {
  const now = opts.now ?? Date.now
  const refreshSeconds = opts.refreshSeconds ?? DEFAULT_REFRESH_SECONDS
  let snap = emptySnapshot(refreshSeconds)
  /** When the last refresh started and ended. */
  let lastStart = -Infinity
  let lastEnd = -Infinity
  let version = 0
  let running: Promise<LineSnapshot> | null = null
  /**
   * Due `refreshSeconds` (less the slack) after the last refresh STARTED, so a slow refresh does
   * not stretch the interval; `running` prevents overlap, and MIN_GAP_MS keeps a refresh longer
   * than the interval from being followed at once by the next.
   */
  const due = (): boolean => now() - lastStart >= refreshSeconds * 1000 - SLACK_MS && now() - lastEnd >= MIN_GAP_MS
  /** The last good lists per Run and the last good PR index: what a failed call falls back to. */
  let lastInputs = new Map<string, RunInput>()
  let lastPrs = new Map<string, PullRequest>()

  const one = async (request: CliRequest): Promise<{ ok: true; result: unknown } | { ok: false; error: CliFailure }> => {
    const r = await opts.cli.run(request)
    // The worker is stopping: abandon the refresh, keep the last snapshot as it is.
    if (!r.ok && r.error.kind === 'stopped') throw STOPPED
    return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error }
  }

  async function cycle(): Promise<LineSnapshot> {
    const list = await one({ command: 'orchestration run-list' })
    if (!list.ok) {
      // Keep the last good runs; mark them with the error and their age.
      snap = { ...snap, status: snap.updatedAt === null ? 'error' : snap.status, error: failure(list.error) }
      return snap
    }
    const all = parseRunList(list.result)
    const withLine = all.filter(hasLine)
    const live = withLine.slice(0, MAX_RUNS)
    const inputs: RunInput[] = []
    for (const run of live) {
      const before = lastInputs.get(run.id)
      const errors: string[] = []
      // A failed call keeps that list as the last good refresh read it (empty for a new Run).
      const get = async <T>(req: CliRequest, parse: (r: unknown) => T, last: T): Promise<T> => {
        const r = await one(req)
        if (r.ok) return parse(r.result)
        errors.push(`${short(req.command)}: ${cleanText(r.error.message, 120)}`)
        return last
      }
      const detail = await get({ command: 'orchestration run-show', run: run.id }, parseRunShow, before?.detail ?? null)
      const tasks = await get({ command: 'orchestration task-list', run: run.id }, parseTaskList, before?.tasks ?? [])
      const workers = await get({ command: 'orchestration worker-list', run: run.id }, parseWorkerList, before?.workers ?? [])
      const gates = await get({ command: 'orchestration gate-list', run: run.id }, parseGateList, before?.gates ?? [])
      const error = errors.length ? `${errors.join('; ')}${before ? ' (showing the last good data)' : ''}` : null
      inputs.push({ run, detail, tasks, workers, gates, error })
    }

    // PR links: `bot work list` ties a bot's workers (Dispatch ids) to their PRs. Only asked when a
    // Run has workers. A failed call keeps the PRs the last good refresh found.
    const notes: string[] = []
    let prs = lastPrs
    if (inputs.some((i) => i.workers.length > 0)) {
      const bots = await one({ command: 'bot list' })
      if (!bots.ok) {
        notes.push(`PR links: bot list: ${cleanText(bots.error.message, 120)} (showing the last good links)`)
      } else {
        const found = new Map<string, PullRequest>()
        let failed = 0
        let firstError = ''
        for (const b of parseBotList(bots.result).slice(0, MAX_BOTS)) {
          if (!isBotId(b.id)) continue
          const w = await one({ command: 'bot work list', bot: b.id })
          if (w.ok) {
            for (const [k, v] of indexPrs(parseBotWorkList(w.result).items)) if (!found.has(k)) found.set(k, v)
          } else {
            failed++
            firstError ||= cleanText(w.error.message, 120)
          }
        }
        if (failed > 0) {
          // Some bots did not answer: their workers keep the PR links from last time.
          for (const [k, v] of lastPrs) if (!found.has(k)) found.set(k, v)
          notes.push(`PR links: bot work list failed for ${failed} bot${failed === 1 ? '' : 's'}: ${firstError} (showing the last good links)`)
        }
        prs = found
      }
    }

    lastInputs = new Map(inputs.map((i) => [i.run.id, i]))
    lastPrs = prs
    snap = {
      status: 'ok',
      updatedAt: now(),
      error: null,
      runs: inputs.map((i) => buildRunLine(i, prs)),
      legacy: all.filter((r) => r.legacy).map((r) => ({ id: r.id, objective: cleanText(r.objective) || r.id })),
      hiddenRuns: withLine.length - live.length,
      notes,
      refreshSeconds
    }
    return snap
  }

  return {
    snapshot: () => snap,
    refresh(force = false) {
      if (running) return running
      if (!force && !due()) return Promise.resolve(snap)
      lastStart = now()
      running = cycle()
        .catch((e: unknown) => {
          if (e === STOPPED) return snap
          snap = { ...snap, status: snap.updatedAt === null ? 'error' : snap.status, error: { kind: 'internal', message: cleanText(String(e), 200), tried: [] } }
          return snap
        })
        .then((done) => {
          lastEnd = now()
          snap = { ...done, version: ++version }
          const s = snap
          running = null
          // A throw here (e.g. a panel closed mid-refresh) must never become an unhandled rejection.
          try {
            opts.onChange?.(s)
          } catch {
            /* the next refresh posts again */
          }
          return s
        })
      return running
    }
  }
}
