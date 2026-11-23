// The shipping line panel (R6). Asks the worker for the line when it opens and then every
// `refreshSeconds` while it is visible, and at once when it becomes visible again; the worker posts `line.changed` after each refresh.
import { atom, plugin, read, set, type PanelContext } from 'orca'
import { emptySnapshot, type LineSnapshot } from './model.ts'
import { DEFAULT_REFRESH_SECONDS } from './refresh.ts'
import { LineView } from './view.tsx'

const snap = atom<LineSnapshot>(emptySnapshot(DEFAULT_REFRESH_SECONDS))

async function ask(force = false): Promise<void> {
  try {
    set(snap, await plugin.request('line.snapshot', { force }))
  } catch (e) {
    const message = e instanceof Error ? e.message.split(/\r?\n/, 1)[0].slice(0, 200) : 'The worker did not answer.'
    set(snap, { ...read(snap), status: read(snap).updatedAt === null ? 'error' : 'ok', error: { kind: 'worker', message, tried: [] } })
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('line.changed', (s) => set(snap, s)))
  let lastAsk = Date.now()
  let wasVisible = read(ctx.visible)
  void ask()
  // A light 1 s check: asks at once when the panel becomes visible, then every `refreshSeconds`
  // while it stays visible. The worker decides whether a refresh is due, so an early ask is cheap.
  const timer = setInterval(() => {
    const visible = read(ctx.visible)
    const due = Date.now() - lastAsk >= (read(snap).refreshSeconds || DEFAULT_REFRESH_SECONDS) * 1000
    if (visible && (!wasVisible || due)) {
      lastAsk = Date.now()
      void ask()
    }
    wasVisible = visible
  }, 1000)
  // Where timers are Node's (tests, `plugin check`), the timer alone must not keep the process up.
  ;(timer as { unref?: () => void }).unref?.()
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
}

export default function Panel() {
  return <LineView snap={read(snap)} onRefresh={() => void ask(true)} />
}
