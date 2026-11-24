// The Funnel tab (funnel slice 3). While visible it asks the worker every second; the worker reads
// when one is due (about every 20 s) and answers `null` when nothing changed, so an ask is cheap.
// A hidden tab asks nothing, so it costs no CLI call (R8). Presses only open or focus (R6).
import { atom, plugin, read, set, type PanelContext } from 'orca'
import '../../protocol.ts'
import { emptySnapshot, type FunnelSnapshot } from './refresh.ts'
import { FunnelView } from './view.tsx'

/** How often a visible tab asks; the worker decides whether a read is due. */
export const TICK_MS = 1_000

export const snap = atom<FunnelSnapshot>(emptySnapshot())
/** One line when the worker did not answer; the last good funnel stays. */
const askError = atom<string | null>(null)
/** What the last press could not open (see FunnelActions.notOpened). */
const notOpened = atom<string | null>(null)

/**
 * Keeps a snapshot only if it is not older than the one held: a `funnel.changed` can land before an
 * older ask's reply. A restarted worker counts from 0 again, so a newer read time also wins.
 */
function take(s: FunnelSnapshot): void {
  const held = read(snap)
  if (s.version >= held.version || (s.updatedAt ?? 0) > (held.updatedAt ?? 0)) set(snap, s)
}

async function ask(force = false): Promise<void> {
  try {
    // Plain JSON only: `version` is sent once the panel holds one (an undefined field is refused).
    const version = read(snap).version
    const answer = await plugin.request('funnel.snapshot', version >= 0 ? { force, version } : { force })
    if (answer) take(answer)
    set(askError, null)
  } catch (e) {
    set(askError, e instanceof Error ? e.message.split(/\r?\n/, 1)[0].slice(0, 200) : 'The worker did not answer.')
  }
}

async function open(key: string, dispatchId?: string): Promise<void> {
  const id = dispatchId === undefined ? key : `${key}#${dispatchId}`
  set(notOpened, null)
  try {
    const r = await plugin.request('funnel.open', dispatchId === undefined ? { key } : { key, dispatchId })
    if (!r.opened) set(notOpened, id)
  } catch {
    set(notOpened, id)
  }
}

/** An unlinked wait opens through the Waits view's own request. */
async function openWait(key: string): Promise<void> {
  set(notOpened, null)
  try {
    const r = await plugin.request('waits.open', { key })
    if (!r.opened) set(notOpened, `wait:${key}`)
  } catch {
    set(notOpened, `wait:${key}`)
  }
}

/** The tab was just switched to: ask now rather than at the next tick. */
export function wake(): void {
  void ask()
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('funnel.changed', take))
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
  return <FunnelView snap={read(snap)} error={read(askError)} notOpened={read(notOpened)} onRefresh={() => void ask(true)} onOpen={(k, d) => void open(k, d)} onOpenWait={(k) => void openWait(k)} />
}
