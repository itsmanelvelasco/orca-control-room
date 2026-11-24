// The one Control Room panel (PRD goal: "one Orca panel"). Three tabs: Waits on you (R4),
// Shipping line (R6) and Agents (R7). Each tab is the view module of its slice, set up once here.
// A tab polls only while the panel is visible and that tab is the one shown.
// Funnel slices 3-4 build a 4th tab, Funnel. Until slice 5 ships it, the tab shows only when
// `room.devFunnel` is on: nothing in the UI sets it, only the `funnel` check scenarios do.
import { atom, derived, read, set, Tab, Tabs, type PanelContext } from 'orca'
import * as waits from '../waits/panel.tsx'
import * as line from '../line/panel.tsx'
import * as agents from '../agents/panel.tsx'
import * as funnel from '../funnel/panel.tsx'
import { startClock } from '../time.ts'

export const TABS = ['waits', 'line', 'agents', 'funnel'] as const
export type TabId = (typeof TABS)[number]

/** The tab shown; kept by Orca for the plugin, so the panel opens where the user left it. */
export const tab = atom<TabId>('room.tab', 'waits', { persist: 'plugin' })
/** Dev only, until funnel slice 5: shows the Funnel tab. */
export const devFunnel = atom<boolean>('room.devFunnel', false, { persist: 'plugin' })

const isTab = (v: unknown): v is TabId => typeof v === 'string' && (TABS as readonly string[]).includes(v) && (v !== 'funnel' || read(devFunnel) === true)

/** The tab on screen. Tabs is controlled by it, so what shows and what polls never differ. */
const shown = derived<TabId>(() => {
  const t = read(tab)
  return isTab(t) ? t : 'waits'
})

/** The same context, with `visible` true only while the panel is visible and `id` is the tab shown. */
function contextFor(ctx: PanelContext, id: TabId): PanelContext {
  return { ...ctx, visible: derived(() => read(ctx.visible) && read(shown) === id) }
}

export function setup(ctx: PanelContext): void {
  waits.setup(contextFor(ctx, 'waits'))
  line.setup(contextFor(ctx, 'line'))
  agents.setup(contextFor(ctx, 'agents'))
  funnel.setup(contextFor(ctx, 'funnel'))
  startClock(ctx)
}

/** A tab press: show it, and let its view ask at once (a hidden tab asked nothing). */
function show(v: string): void {
  if (!isTab(v) || v === read(shown)) return
  set(tab, v)
  if (v === 'line') line.wake()
  if (v === 'agents') agents.wake()
  if (v === 'funnel') funnel.wake()
}

export default function Panel() {
  const count = read(waits.snapshot)?.waits.length ?? 0
  return (
    <Tabs label="Control Room" value={read(shown)} onChange={show}>
      <Tab value="waits" label={count ? `Waits (${count})` : 'Waits'} icon="bell">
        <waits.default />
      </Tab>
      <Tab value="line" label="Shipping line" icon="rocket">
        <line.default />
      </Tab>
      <Tab value="agents" label="Agents" icon="agent">
        <agents.default />
      </Tab>
      {read(devFunnel) === true ? (
        <Tab value="funnel" label="Funnel" icon="layers">
          <funnel.default />
        </Tab>
      ) : null}
    </Tabs>
  )
}
