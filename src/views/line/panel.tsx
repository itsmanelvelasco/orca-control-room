// The shipping line panel (R6). While visible it asks the worker every second; the worker
// refreshes when one is due (about every `refreshSeconds`) and answers `null` when nothing
// changed, so an ask is cheap. It also posts `line.changed` after each refresh.
import { atom, plugin, read, set, type PanelContext } from 'orca'
import { emptySnapshot, type LineSnapshot } from './model.ts'
import { DEFAULT_REFRESH_SECONDS } from './refresh.ts'
import { LineView } from './view.tsx'

/** How often a visible panel asks; the worker decides whether a refresh is due. */
export const TICK_MS = 1_000

const snap = atom<LineSnapshot>(emptySnapshot(DEFAULT_REFRESH_SECONDS))

async function ask(force = false): Promise<void> {
  try {
    // Plain JSON only: `version` is sent once the panel holds one (an undefined field is refused).
    const version = read(snap).version
    const answer = await plugin.request('line.snapshot', typeof version === 'number' ? { force, version } : { force })
    if (answer) set(snap, answer)
  } catch (e) {
    const message = e instanceof Error ? e.message.split(/\r?\n/, 1)[0].slice(0, 200) : 'The worker did not answer.'
    set(snap, { ...read(snap), status: read(snap).updatedAt === null ? 'error' : 'ok', error: { kind: 'worker', message, tried: [] } })
  }
}

/** The tab was just switched to: ask now rather than at the next tick. */
export function wake(): void {
  void ask()
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('line.changed', (s) => set(snap, s)))
  // A hidden tab makes no CLI call, not even at mount: the first ask is the first visible tick.
  if (read(ctx.visible)) void ask()
  let inFlight = false
  const timer = setInterval(() => {
    if (!read(ctx.visible) || inFlight) return
    inFlight = true
    void ask().finally(() => {
      inFlight = false
    })
  }, TICK_MS)
  // Where timers are Node's (tests, `plugin check`), the timer alone must not keep the process up.
  ;(timer as { unref?: () => void }).unref?.()
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
}

export default function Panel() {
  return <LineView snap={read(snap)} onRefresh={() => void ask(true)} />
}
