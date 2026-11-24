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

/** A worker's place: its live terminal, else its workspace (orchestration first, then bot work). */
function workerPlace(dispatchId: string, w: WaitsData, works: readonly BotWork[]): WaitTarget | null {
  const orch = w.runs.flatMap((r) => r.workers).filter((x) => x.dispatchId === dispatchId)
  const live = orch.find((x) => x.terminal && x.liveness !== 'gone')
  if (live?.terminal) return { kind: 'terminal', terminalId: live.terminal }
  const ws = orch.find((x) => x.workspace)?.workspace ?? works.find((x) => x.dispatchId === dispatchId && x.workspace)?.workspace
  return ws ? { kind: 'workspace', workspaceId: ws } : null
}

/**
 * Where a press goes (R6). A worker: its terminal, else its workspace. A card: the place of its
 * first wait, else the item's chat (its bot's home workspace, as a Waits question row opens), else
 * the place of its first worker that has one. Only pieces and workers in `f` are opened.
 */
export function funnelTarget(f: Funnel, input: OpenInput, w: WaitsData, works: readonly BotWork[]): { target: WaitTarget } | { reason: 'unknown' | 'no_target' } {
  const piece = f.pieces.find((p) => p.key === input.key)
  if (!piece) return { reason: 'unknown' }
  if (input.dispatchId !== undefined) {
    if (!piece.workers.some((x) => x.dispatchId === input.dispatchId)) return { reason: 'unknown' }
    const t = workerPlace(input.dispatchId, w, works)
    return t ? { target: t } : { reason: 'no_target' }
  }
  const wait = piece.waits.find((x) => x.target)
  if (wait?.target) return { target: wait.target }
  const home = piece.botName ? w.homes?.[piece.botName] : undefined
  if (piece.item && home) return { target: { kind: 'workspace', workspaceId: home } }
  for (const x of piece.workers) {
    const t = workerPlace(x.dispatchId, w, works)
    if (t) return { target: t }
  }
  return { reason: 'no_target' }
}

/** Focuses a terminal or shows a workspace. */
export async function openTarget(orca: OrcaWorkerApi, t: WaitTarget): Promise<boolean> {
  if (t.kind === 'terminal') return (await orca.host.call('terminal.focus', { terminalId: t.terminalId })).focused
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
      return (await openTarget(orca, found.target)) ? { opened: true } : { opened: false, reason: 'failed' }
    } catch (e) {
      orca.log(`funnel.open failed: ${String((e as Error)?.message ?? e).split(/\r?\n/, 1)[0].slice(0, 200)}`)
      return { opened: false, reason: 'failed' }
    }
  })
  return funnel
}
