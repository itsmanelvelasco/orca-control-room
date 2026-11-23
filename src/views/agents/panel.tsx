// The Agents panel (R7). Asks the worker when it opens and every 4 s while visible; the worker
// also posts `agents.changed` on each agent event. No CLI anywhere on this path.
import { atom, plugin, read, set, update, type PanelContext } from 'orca'
import { emptySnapshot, type AgentsSnapshot } from './model.ts'
import { REFRESH_MS } from './refresh.ts'
import { AgentsView } from './view.tsx'

const snap = atom<AgentsSnapshot>(emptySnapshot())
const expanded = atom<string[]>([])

async function ask(force = false): Promise<void> {
  try {
    set(snap, await plugin.request('agents.get', { force }))
  } catch (e) {
    const message = (e instanceof Error ? e.message : 'The worker did not answer.').split(/\r?\n/, 1)[0].slice(0, 200)
    const s = read(snap)
    set(snap, { ...s, status: s.updatedAt === null ? 'error' : 'ok', error: message })
  }
}

function open(key: string): void {
  void plugin.request('agents.open', { key }).catch(() => undefined)
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('agents.changed', (s) => set(snap, s)))
  void ask()
  const timer = setInterval(() => {
    if (read(ctx.visible)) void ask()
  }, REFRESH_MS)
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
      onOpen={open}
      onRefresh={() => void ask(true)}
    />
  )
}
