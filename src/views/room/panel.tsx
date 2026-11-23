// The one Control Room panel (PRD goal: "one Orca panel"). Three tabs: Waits on you (R4),
// Shipping line (R6) and Agents (R7). Each tab is the view module of its slice, set up once here.
// A tab polls only while the panel is visible and that tab is the one shown.
import { atom, derived, read, set, Tab, Tabs, type PanelContext } from 'orca'
import * as waits from '../waits/panel.tsx'
import * as line from '../line/panel.tsx'
import * as agents from '../agents/panel.tsx'

export const TABS = ['waits', 'line', 'agents'] as const
export type TabId = (typeof TABS)[number]

/** The tab shown; kept by Orca for the plugin, so the panel opens where the user left it. */
export const tab = atom<TabId>('room.tab', 'waits', { persist: 'plugin' })

const isTab = (v: unknown): v is TabId => typeof v === 'string' && (TABS as readonly string[]).includes(v)

/** The same context, with `visible` true only while the panel is visible and `id` is the tab shown. */
function contextFor(ctx: PanelContext, id: TabId): PanelContext {
  return { ...ctx, visible: derived(() => read(ctx.visible) && read(tab) === id) }
}

export function setup(ctx: PanelContext): void {
  waits.setup(contextFor(ctx, 'waits'))
  line.setup(contextFor(ctx, 'line'))
  agents.setup(contextFor(ctx, 'agents'))
}

export default function Panel() {
  const count = read(waits.snapshot)?.waits.length ?? 0
  const current = read(tab)
  return (
    <Tabs label="Control Room" defaultValue={isTab(current) ? current : 'waits'} onChange={(v) => isTab(v) && set(tab, v)}>
      <Tab value="waits" label={count ? `Waits (${count})` : 'Waits'} icon="bell">
        <waits.default />
      </Tab>
      <Tab value="line" label="Shipping line" icon="rocket">
        <line.default />
      </Tab>
      <Tab value="agents" label="Agents" icon="agent">
        <agents.default />
      </Tab>
    </Tabs>
  )
}
