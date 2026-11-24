// Worker side of the funnel (funnel slice 2): answers `funnel.snapshot` and posts `funnel.changed`.
// Reads are driven by an open panel (it asks every second while visible; the refresher decides
// whether a read is due), so a hidden Funnel tab costs no CLI call.
import type { OrcaWorkerApi } from 'orca/worker'
import type { WaitsData } from '../waits/refresh.ts'
import { createFunnelRefresher, type FunnelCli, type FunnelRefresher } from './refresh.ts'

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
  return funnel
}
