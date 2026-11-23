// Worker side of the shipping line: answers `line.snapshot` and posts `line.changed` after
// each refresh. Refresh is driven by open panels (they ask every `refreshSeconds` while
// visible), so a closed panel costs no CLI calls.
import type { OrcaWorkerApi } from 'orca/worker'
import { createLineRefresher, type LineCli } from './refresh.ts'

export function registerLine(orca: OrcaWorkerApi, cli: LineCli): void {
  const line = createLineRefresher({
    cli,
    onChange: (s) => {
      try {
        orca.panels.post('line.changed', s)
      } catch (e) {
        orca.log(`line.changed post failed: ${String(e).split(/\r?\n/, 1)[0].slice(0, 200)}`)
      }
    }
  })
  orca.panels.handle('line.snapshot', (input) => {
    void line.refresh(input?.force === true)
    return line.snapshot()
  })
}
