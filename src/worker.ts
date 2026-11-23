// Control Room worker. Slice 1: the CLI bridge. Slice 2: waits on you. Slice 3: the shipping line.
// - `cli.status`: the CLI path and one timed `bot list` (slice 1's live check).
// - Waits on you (R4, R5, R9): refreshes every 4 s and on each agent event, answers `waits.get`,
//   posts `waits.changed`, opens a wait's place on `waits.open`, notifies new waits once, and
//   keeps the status bar count.
// - The shipping line (R6): src/views/line.
import type { OrcaWorkerApi } from 'orca/worker'
import './protocol.ts'
import { createHostCliRunner } from './cli/index.ts'
import { parseBotList, type AgentStatusEvent } from './model/index.ts'
import { createNotifier, NOTIFIED_KEY, NOTIFY_SETTING, STATUS_ITEM, statusBarOf } from './notify.ts'
import { createWaitsRefresher, FAST_MS, SLOW_EVERY, type WaitsSnapshot } from './views/waits/refresh.ts'
import { registerLine } from './views/line/worker.ts'

export const ORCA_CLI_SETTING = 'orcaCli'

/** Seams for the worker test: a fake CLI runner and timers. Orca never changes them. */
export const runtime = { createRunner: createHostCliRunner, setInterval, setTimeout }

let stop: (() => void) | null = null

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  let setting: string | null = null
  let notify = true
  const readSettings = async (): Promise<void> => {
    try {
      const all = await orca.settings.get()
      const v = all[ORCA_CLI_SETTING]
      setting = typeof v === 'string' && v.trim() ? v.trim() : null
      notify = all[NOTIFY_SETTING] !== false
    } catch {
      setting = null
    }
  }
  await readSettings()
  // Key names only, never values: enough to see what Orca's worker env lacks.
  orca.log(`worker env: platform=${process.platform} node=${process.version} keys=${Object.keys(process.env).sort().join(',')}`)
  const cli = runtime.createRunner(() => setting)
  orca.settings.onDidChange(() => {
    void readSettings().then(() => cli.reset())
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

  // ---------- waits ----------

  const notifier = createNotifier({
    show: (title, body) => orca.host.call('notifications.show', { title, body }),
    load: () => orca.storage.get(NOTIFIED_KEY),
    save: (ids) => orca.storage.set(NOTIFIED_KEY, ids),
    enabled: () => notify
  })
  let lastCount = -1
  const onChange = (snap: WaitsSnapshot): void => {
    orca.panels.post('waits.changed', snap)
    if (snap.waits.length !== lastCount) {
      lastCount = snap.waits.length
      void orca.host.call('statusBar.update', { id: STATUS_ITEM, ...statusBarOf(lastCount), icon: 'bell' }).catch((e: unknown) => orca.log(`statusBar.update failed: ${String((e as Error)?.message ?? e)}`))
    }
    void notifier.update(snap.waits).catch(() => undefined)
  }
  const refresher = createWaitsRefresher({ run: (r) => cli.run(r), onChange, cliPath: () => cli.current()?.path ?? null })

  orca.panels.handle('waits.get', () => refresher.snapshot())
  orca.panels.handle('waits.open', async (input) => {
    const key = input && typeof input === 'object' && typeof input.key === 'string' ? input.key : ''
    const wait = refresher.snapshot().waits.find((w) => w.key === key)
    if (!wait) return { opened: false, reason: 'unknown' as const }
    const t = wait.target
    if (!t) return { opened: false, reason: 'no_target' as const }
    try {
      if (t.kind === 'terminal') {
        const r = await orca.host.call('terminal.focus', { terminalId: t.terminalId })
        return r.focused ? { opened: true } : { opened: false, reason: 'failed' as const }
      }
      await orca.host.call('workspace.open', { workspaceId: t.workspaceId })
      return { opened: true }
    } catch (e) {
      orca.log(`waits.open failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
      return { opened: false, reason: 'failed' as const }
    }
  })

  // Every 4 s; every 5th cycle (20 s) also re-reads bots and Runs. A cycle never starts while one runs.
  let tick = 0
  let running: Promise<void> | null = null
  const cycle = (slow: boolean): Promise<void> => {
    if (running) return running
    running = refresher.cycle(slow).catch((e: unknown) => orca.log(`waits cycle failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`)).finally(() => {
      running = null
    })
    return running
  }
  const timer = runtime.setInterval(() => {
    tick++
    void cycle(tick % SLOW_EVERY === 0)
  }, FAST_MS)
  // After an agent event: update at once from the event, then read `worktree ps` soon after.
  let soon: ReturnType<typeof setTimeout> | null = null
  orca.events.on('agent.status.changed', (e) => {
    refresher.onAgentEvent(e as AgentStatusEvent)
    if (!soon) {
      soon = runtime.setTimeout(() => {
        soon = null
        void cycle(false)
      }, 500)
    }
  })
  stop = () => {
    clearInterval(timer)
    if (soon) clearTimeout(soon)
  }
  void cycle(true)
}

export function deactivate(): void {
  stop?.()
  stop = null
}
