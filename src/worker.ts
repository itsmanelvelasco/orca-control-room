// Control Room worker. Slice 1: the CLI bridge. Slice 3: the shipping line (src/views/line).
// - Answers `cli.status` (CLI path + one timed `bot list`), used by the live checks.
// - Logs each `agent.status.changed` payload, for the R5 folder-trust check.
import type { OrcaWorkerApi } from 'orca/worker'
import './protocol.ts'
import { createHostCliRunner } from './cli/index.ts'
import { parseBotList } from './model/index.ts'
import { registerLine } from './views/line/worker.ts'

export const ORCA_CLI_SETTING = 'orcaCli'

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  let setting: string | null = null
  const readSetting = async (): Promise<void> => {
    try {
      const v = await orca.settings.get(ORCA_CLI_SETTING)
      setting = typeof v === 'string' && v.trim() ? v.trim() : null
    } catch {
      setting = null
    }
  }
  await readSetting()
  // Key names only, never values: enough to see what Orca's worker env lacks.
  orca.log(`worker env: platform=${process.platform} node=${process.version} keys=${Object.keys(process.env).sort().join(',')}`)
  const cli = createHostCliRunner(() => setting)
  orca.settings.onDidChange(() => {
    void readSetting().then(() => cli.reset())
  })

  const status = async () => {
    const r = await cli.run({ command: 'bot list' })
    const res = cli.lastResolution()
    const cur = cli.current()
    const out = {
      cliPath: cur?.path ?? null,
      source: cur?.source ?? null,
      tried: res?.tried ?? [],
      ok: r.ok,
      ms: r.ms,
      bots: r.ok ? parseBotList(r.result).length : 0,
      error: r.ok ? null : { kind: r.error.kind, message: r.error.message, ...(r.error.code ? { code: r.error.code } : {}) }
    }
    orca.log(`cli.status ${JSON.stringify(out)}`)
    return out
  }
  orca.panels.handle('cli.status', status)

  registerLine(orca, cli)

  // One timed `bot list` at start: finds the path for the footer early and leaves a line in
  // `orca plugin logs` that shows the CLI answers from this worker (installed plugins take no dev request).
  void status()

  orca.events.on('agent.status.changed', (e) => {
    orca.log(`agent.status.changed ${JSON.stringify(e)}`)
  })
}
