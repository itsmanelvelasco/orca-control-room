// Reads the shipping line from the CLI in turns: one call at a time, never two of the same kind
// (R9), at most once per `refreshSeconds` (default 20 s). A failed refresh keeps the last good
// data and says why (PRD 5). Read only: every call is an allow-listed read (src/cli/commands.ts).

import type { CliFailure, CliRequest, CliResult } from '../../cli/index.ts'
import { isBotId } from '../../cli/index.ts'
import { parseBotList, parseBotWorkList, parseGateList, parseRunList, parseRunShow, parseTaskList, parseWorkerList, type BotWork } from '../../model/index.ts'
import { buildRunLine, cleanText, emptySnapshot, hasLine, indexPrs, type LineSnapshot, type RunInput } from './model.ts'

export const DEFAULT_REFRESH_SECONDS = 20
/** PRD 5: lists cap at 50 per group; the same cap keeps the CLI calls per turn bounded. */
export const MAX_RUNS = 50
export const MAX_BOTS = 50

export type LineCli = { run(request: CliRequest): Promise<CliResult> }

export type LineRefresher = {
  /** What the panel shows now. */
  snapshot(): LineSnapshot
  /**
   * Starts a refresh when the data is older than the interval (or `force`) and none is running.
   * Resolves when that refresh (or the one already running) ends.
   */
  refresh(force?: boolean): Promise<LineSnapshot>
}

function failure(e: CliFailure): NonNullable<LineSnapshot['error']> {
  return { kind: e.kind, message: cleanText(e.message, 200), tried: (e.tried ?? []).map((t) => t.path).slice(0, 8) }
}

export function createLineRefresher(opts: { cli: LineCli; refreshSeconds?: number; now?: () => number; onChange?: (s: LineSnapshot) => void }): LineRefresher {
  const now = opts.now ?? Date.now
  const refreshSeconds = opts.refreshSeconds ?? DEFAULT_REFRESH_SECONDS
  let snap = emptySnapshot(refreshSeconds)
  let lastTry = -Infinity
  let running: Promise<LineSnapshot> | null = null

  const one = async (request: CliRequest): Promise<{ ok: true; result: unknown } | { ok: false; error: CliFailure }> => {
    const r = await opts.cli.run(request)
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
    const live = all.filter(hasLine).slice(0, MAX_RUNS)
    const inputs: RunInput[] = []
    for (const run of live) {
      const errors: string[] = []
      const get = async <T>(req: CliRequest, parse: (r: unknown) => T, empty: T): Promise<T> => {
        const r = await one(req)
        if (r.ok) return parse(r.result)
        errors.push(`${req.command.replace('orchestration ', '')}: ${r.error.message}`)
        return empty
      }
      const detail = await get({ command: 'orchestration run-show', run: run.id }, parseRunShow, null)
      const tasks = await get({ command: 'orchestration task-list', run: run.id }, parseTaskList, [])
      const workers = await get({ command: 'orchestration worker-list', run: run.id }, parseWorkerList, [])
      const gates = await get({ command: 'orchestration gate-list', run: run.id }, parseGateList, [])
      inputs.push({ run, detail, tasks, workers, gates, error: errors[0] ?? null })
    }

    // PR links: `bot work list` ties a bot's workers (Dispatch ids) to their PRs. Only asked when a Run has workers.
    let works: BotWork[] = []
    if (inputs.some((i) => i.workers.length > 0)) {
      const bots = await one({ command: 'bot list' })
      if (bots.ok) {
        for (const b of parseBotList(bots.result).slice(0, MAX_BOTS)) {
          if (!isBotId(b.id)) continue
          const w = await one({ command: 'bot work list', bot: b.id })
          if (w.ok) works = works.concat(parseBotWorkList(w.result).items)
        }
      }
    }
    const prs = indexPrs(works)
    snap = {
      status: 'ok',
      updatedAt: now(),
      error: null,
      runs: inputs.map((i) => buildRunLine(i, prs)),
      legacy: all.filter((r) => r.legacy).map((r) => ({ id: r.id, objective: cleanText(r.objective) || r.id })),
      refreshSeconds
    }
    return snap
  }

  return {
    snapshot: () => snap,
    refresh(force = false) {
      if (running) return running
      if (!force && now() - lastTry < refreshSeconds * 1000) return Promise.resolve(snap)
      lastTry = now()
      running = cycle()
        .catch((e: unknown) => {
          snap = { ...snap, status: snap.updatedAt === null ? 'error' : snap.status, error: { kind: 'internal', message: cleanText(String(e), 200), tried: [] } }
          return snap
        })
        .finally(() => {
          running = null
          opts.onChange?.(snap)
        })
      return running
    }
  }
}
