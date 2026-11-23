// The Agents panel (R7). Asks the worker when it shows and every 4 s while visible; the worker
// also posts `agents.changed` on each agent event. No CLI anywhere on this path.
import { atom, plugin, read, set, update, type PanelContext } from 'orca'
import { emptySnapshot, type AgentsSnapshot } from './model.ts'
import { REFRESH_MS } from './refresh.ts'
import { AgentsView } from './view.tsx'

/** How often a panel checks whether it is visible and an ask is due. */
const TICK_MS = 1_000

const snap = atom<AgentsSnapshot>(emptySnapshot())
const expanded = atom<string[]>([])
const notice = atom<string | null>(null)

async function ask(force = false): Promise<void> {
  try {
    set(snap, await plugin.request('agents.get', { force }))
  } catch (e) {
    const message = (e instanceof Error ? e.message : 'The worker did not answer.').split(/\r?\n/, 1)[0].slice(0, 200)
    const s = read(snap)
    set(snap, { ...s, status: s.updatedAt === null ? 'error' : 'ok', error: message })
  }
}

/** A press that cannot open its agent says so and reads again: the row is often gone or renamed. */
async function open(key: string): Promise<void> {
  let r: { opened: boolean; reason?: string }
  try {
    r = await plugin.request('agents.open', { key })
  } catch {
    r = { opened: false, reason: 'failed' }
  }
  if (r.opened) {
    set(notice, null)
    return
  }
  set(notice, r.reason === 'no_target' ? 'That agent is gone or moved. Reading agents again.' : 'Orca did not open that agent. Reading agents again.')
  await ask(true)
}

/** When the last periodic ask went out. */
let last = -Infinity

/** The tab was just switched to: ask now rather than at the next tick. */
export function wake(): void {
  last = Date.now()
  void ask()
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('agents.changed', (s) => set(snap, s)))
  // Asks at mount and on each tick only while visible; on becoming visible it asks at the next
  // 1 s tick, then every 4 s.
  last = -Infinity
  const askIfDue = (): void => {
    if (!read(ctx.visible)) {
      last = -Infinity
      return
    }
    if (Date.now() - last < REFRESH_MS) return
    last = Date.now()
    void ask()
  }
  askIfDue()
  const timer = setInterval(askIfDue, TICK_MS)
  // Where timers are Node's (tests, `plugin check`), the timer alone must not keep the process up.
  ;(timer as { unref?: () => void }).unref?.()
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
}

export default function Panel() {
  return (
    <AgentsView
      snap={read(snap)}
      expanded={read(expanded)}
      onShowAll={(key, all) => update(expanded, (xs) => (all ? [...xs.filter((x) => x !== key), key] : xs.filter((x) => x !== key)))}
      onOpen={(key) => void open(key)}
      onRefresh={() => void ask(true)}
      notice={read(notice)}
    />
  )
}
