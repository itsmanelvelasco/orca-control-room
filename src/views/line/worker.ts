// Worker side of the shipping line: answers `line.snapshot` and posts `line.changed` after
// each refresh. Refresh is driven by open panels (they ask every `refreshSeconds` while
// visible), so a closed panel costs no CLI calls.
import type { OrcaWorkerApi } from 'orca/worker'
import { createLineRefresher, type LineCli } from './refresh.ts'

export function registerLine(orca: OrcaWorkerApi, cli: LineCli): void {
  const line = createLineRefresher({
    cli,
    onChange: (s) => orca.panels.post('line.changed', s)
  })
  orca.panels.handle('line.snapshot', (input) => {
    void line.refresh(input?.force === true)
    return line.snapshot()
  })
}
