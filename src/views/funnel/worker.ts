// Worker side of the funnel (funnel slice 2): answers `funnel.snapshot` and posts `funnel.changed`.
// Reads are driven by an open panel (it asks every second while visible; the refresher decides
// whether a read is due), so a hidden Funnel tab costs no CLI call.
// Funnel slice 3: `funnel.open` opens or focuses a card's place (R6). The panel sends only a piece
// key and, for a worker, its dispatch id; the worker looks up where it goes. Nothing is written.
import type { OrcaWorkerApi } from 'orca/worker'
import type { BotWork } from '../../model/index.ts'
import type { WaitsData } from '../waits/refresh.ts'
import type { WaitTarget } from '../waits/collect.ts'
import type { Funnel } from './model.ts'
import { createFunnelRefresher, type FunnelCli, type FunnelRefresher } from './refresh.ts'

export type OpenInput = { key: string; dispatchId?: string }
export type OpenResult = { opened: boolean; reason?: 'unknown' | 'no_target' | 'failed' }
/** Where a press goes, and where to go instead when a terminal will not take focus. */
export type OpenPlan = { target: WaitTarget; fallback?: WaitTarget }

/** A worker's live terminal and its workspace (orchestration first, then bot work); either may be missing. */
function workerPlaces(dispatchId: string, w: WaitsData, works: readonly BotWork[]): { terminal: WaitTarget | null; workspace: WaitTarget | null } {
  const orch = w.runs.flatMap((r) => r.workers).filter((x) => x.dispatchId === dispatchId)
  const live = orch.find((x) => x.terminal && x.liveness !== 'gone')
  const ws = orch.find((x) => x.workspace)?.workspace ?? works.find((x) => x.dispatchId === dispatchId && x.workspace)?.workspace
  return { terminal: live?.terminal ? { kind: 'terminal', terminalId: live.terminal } : null, workspace: ws ? { kind: 'workspace', workspaceId: ws } : null }
}

/** A worker's plan: its live terminal (its workspace as the fallback), else its workspace. */
function workerPlan(dispatchId: string, w: WaitsData, works: readonly BotWork[]): OpenPlan | null {
  const { terminal, workspace } = workerPlaces(dispatchId, w, works)
  if (terminal) return workspace ? { target: terminal, fallback: workspace } : { target: terminal }
  return workspace ? { target: workspace } : null
}

/**
 * Where a press goes (R6). A worker: its live terminal, else its workspace. A card: the place of
 * its first wait; else the item's bot home (the plugin API cannot open a bot chat, so the bot's
 * home workspace, as a Waits question row opens); else a worker: first the live terminals, newest
 * first (working ones before others; Orca lists Dispatches oldest first), then the workspaces in
 * the same order, so a finished worker's workspace never beats a live terminal. Only pieces and
 * workers in `f` are opened.
 */
export function funnelTarget(f: Funnel, input: OpenInput, w: WaitsData, works: readonly BotWork[]): OpenPlan | { reason: 'unknown' | 'no_target' } {
  const piece = f.pieces.find((p) => p.key === input.key)
  if (!piece) return { reason: 'unknown' }
  if (input.dispatchId !== undefined) {
    if (!piece.workers.some((x) => x.dispatchId === input.dispatchId)) return { reason: 'unknown' }
    return workerPlan(input.dispatchId, w, works) ?? { reason: 'no_target' }
  }
  const wait = piece.waits.find((x) => x.target)
  if (wait?.target) return { target: wait.target }
  const home = piece.botName ? w.homes?.[piece.botName] : undefined
  if (piece.item && home) return { target: { kind: 'workspace', workspaceId: home } }
  const newest = [...piece.workers].reverse()
  const order = [...newest.filter((x) => x.state === 'working'), ...newest.filter((x) => x.state !== 'working')]
  for (const x of order) {
    const plan = workerPlan(x.dispatchId, w, works)
    if (plan?.target.kind === 'terminal') return plan
  }
  for (const x of order) {
    const plan = workerPlan(x.dispatchId, w, works)
    if (plan) return plan
  }
  return { reason: 'no_target' }
}

/** Focuses a terminal or shows a workspace. A terminal that will not take focus opens `fallback` if given. */
export async function openTarget(orca: OrcaWorkerApi, t: WaitTarget, fallback?: WaitTarget): Promise<boolean> {
  if (t.kind === 'terminal') {
    if ((await orca.host.call('terminal.focus', { terminalId: t.terminalId })).focused) return true
    return fallback ? openTarget(orca, fallback) : false
  }
  await orca.host.call('workspace.open', { workspaceId: t.workspaceId })
  return true
}

export function registerFunnel(orca: OrcaWorkerApi, run: FunnelCli, waits: () => WaitsData): FunnelRefresher {
  const funnel = createFunnelRefresher({
    run,
    waits,
    onChange: (s) => {
      try {
        orca.panels.post('funnel.changed', s)
      } catch (e) {
        orca.log(`funnel.changed post failed: ${String(e).split(/\r?\n/, 1)[0].slice(0, 200)}`)
      }
    }
  })
  orca.panels.handle('funnel.snapshot', (input) => {
    // Answer at once with what the worker holds (one read is 2 calls per bot, too slow to wait
    // for); a read that ends posts `funnel.changed`. A Waits change not built yet is built now.
    void funnel.refresh(input?.force === true)
    const s = funnel.snapshot()
    return typeof input?.version === 'number' && input.version === s.version ? null : s
  })
  orca.panels.handle('funnel.open', async (input): Promise<OpenResult> => {
    const key = input && typeof input === 'object' && typeof input.key === 'string' ? input.key : ''
    const dispatchId = input && typeof input === 'object' && typeof input.dispatchId === 'string' ? input.dispatchId : undefined
    const found = funnelTarget(funnel.snapshot().funnel, dispatchId === undefined ? { key } : { key, dispatchId }, waits(), funnel.works())
    if ('reason' in found) return { opened: false, reason: found.reason }
    try {
      return (await openTarget(orca, found.target, found.fallback)) ? { opened: true } : { opened: false, reason: 'failed' }
    } catch (e) {
      orca.log(`funnel.open failed: ${String((e as Error)?.message ?? e).split(/\r?\n/, 1)[0].slice(0, 200)}`)
      return { opened: false, reason: 'failed' }
    }
  })
  return funnel
}
