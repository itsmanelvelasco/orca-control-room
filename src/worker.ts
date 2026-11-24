// Control Room worker. Slice 1: the CLI bridge. Slice 2: waits on you. Slice 3: the shipping line.
// Slice 4: the Agents view. Funnel slice 2: the funnel, built from the Waits data.
// - `cli.status`: the CLI path and one timed `bot list` (slice 1's live check).
// - Waits on you (R4, R5, R9): refreshes every 4 s and on each agent event, answers `waits.get`,
//   posts `waits.changed`, opens a wait's place on `waits.open`, notifies new waits once, and
//   keeps the status bar count.
// - The shipping line (R6): src/views/line.
// - The Agents view (R7): src/views/agents, no CLI.
// - The funnel: src/views/funnel, built from the Waits data.
import type { OrcaWorkerApi } from 'orca/worker'
import './protocol.ts'
import { createHostCliRunner } from './cli/index.ts'
import type { CliRequest } from './cli/commands.ts'
import { parseBotList, type AgentStatusEvent } from './model/index.ts'
import { createNotifier, NOTIFIED_KEY, NOTIFY_SETTING, STATUS_ITEM, statusBarOf } from './notify.ts'
import { createWaitsRefresher, FAST_MS, SLOW_EVERY, type WaitsSnapshot } from './views/waits/refresh.ts'
import { registerLine } from './views/line/worker.ts'
import { registerAgents } from './views/agents/worker.ts'
import { registerFunnel } from './views/funnel/worker.ts'

export const ORCA_CLI_SETTING = 'orcaCli'
/** Gate id -> when this plugin first saw it, so a restart keeps "since". */
export const GATES_SEEN_KEY = 'waits.gatesSeen'

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
  // Waits, the Shipping line and the funnel share one runner: an identical call (same argv) made
  // while one runs gets that call's answer (src/cli/run.ts), so overlapping loops run it once.
  const run = (r: CliRequest) => cli.run(r)
  orca.settings.onDidChange(() => {
    void readSettings().then(() => cli.reset())
  })

  const status = async () => {
    const r = await run({ command: 'bot list' })
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
  registerAgents(orca)

  registerLine(orca, { run })

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
    void notifier.update(snap.waits, snap.primed).catch(() => undefined)
  }
  let funnel: ReturnType<typeof registerFunnel> | null = null
  const refresher = createWaitsRefresher({
    run,
    onChange,
    onData: () => funnel?.onWaitsChanged(),
    cliPath: () => cli.current()?.path ?? null,
    seen: { load: () => orca.storage.get(GATES_SEEN_KEY), save: (seen) => orca.storage.set(GATES_SEEN_KEY, seen) }
  })

  funnel = registerFunnel(orca, run, () => refresher.data())

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

  // Two loops, every 4 s each, that never wait on each other (R5: a trust label within 10 s even
  // when item and gate calls are slow). The agent loop reads `worktree ps` only; the item loop
  // reads items and gates, and every 5th tick (20 s) bots and Runs too. A loop never starts while
  // its last pass runs; a slow tick it skips is taken by its next pass.
  const log = (e: unknown): void => orca.log(`waits cycle failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
  let agentRun: Promise<void> | null = null
  const agentCycle = (): Promise<void> => {
    if (agentRun) return agentRun
    agentRun = refresher.agentCycle().catch(log).finally(() => {
      agentRun = null
    })
    return agentRun
  }
  let itemRun: Promise<void> | null = null
  let slowDue = false
  const itemCycle = (slow: boolean): Promise<void> => {
    slowDue ||= slow
    if (itemRun) return itemRun
    const full = slowDue
    slowDue = false
    itemRun = refresher.itemCycle(full).catch(log).finally(() => {
      itemRun = null
    })
    return itemRun
  }
  let tick = 0
  const timer = runtime.setInterval(() => {
    tick++
    void agentCycle()
    void itemCycle(tick % SLOW_EVERY === 0)
  }, FAST_MS)
  // After an agent event: update at once from the event, then read `worktree ps` soon after.
  let soon: ReturnType<typeof setTimeout> | null = null
  orca.events.on('agent.status.changed', (e) => {
    refresher.onAgentEvent(e as AgentStatusEvent)
    if (!soon) {
      soon = runtime.setTimeout(() => {
        soon = null
        void agentCycle()
      }, 500)
    }
  })
  stop = () => {
    clearInterval(timer)
    if (soon) clearTimeout(soon)
    // End the CLI calls still running, so a stopped worker leaves no child process behind.
    cli.stop?.()
  }
  void agentCycle()
  void itemCycle(true)
}

export function deactivate(): void {
  stop?.()
  stop = null
}
