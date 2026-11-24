// The panel <-> worker contract, shared by both sides.
import type { LineSnapshot } from './views/line/model.ts'
import type { WaitsSnapshot } from './views/waits/refresh.ts'
import type { AgentsSnapshot } from './views/agents/model.ts'
import type { FunnelSnapshot } from './views/funnel/refresh.ts'

export type { LineSnapshot, WaitsSnapshot, AgentsSnapshot, FunnelSnapshot }
export type { Funnel, FunnelDetails, Piece, Stage } from './views/funnel/model.ts'
export type { Wait, WaitTarget } from './views/waits/collect.ts'

declare module 'orca' {
  interface PluginRequests {
    /** The CLI path in use (for the footer) and one `bot list` call with its timing. */
    'cli.status': {
      output: {
        cliPath: string | null
        source: string | null
        tried: { path: string; source: string }[]
        ok: boolean
        ms: number
        bots: number
        error: { kind: string; message: string; code?: string } | null
      }
    }
    /** The shipping line (R6). Starts a refresh when one is due (or at once with `force`) and answers at once with what the worker holds, or `null` when the panel already has that `version`. */
    'line.snapshot': { input?: { force?: boolean; version?: number }; output: LineSnapshot | null }
    /** Funnel (funnel slice 2). Starts a read of closed items and bot work when one is due (or at once with `force`) and answers at once with the funnel the worker holds, or `null` when the panel already has that `version`. Asking every second while visible keeps the funnel live; no ask, no CLI call. */
    'funnel.snapshot': { input?: { force?: boolean; version?: number }; output: FunnelSnapshot | null }
    /** Funnel slice 3 (R6): opens or focuses a card's place. Takes a piece key, plus a dispatch id for one of its workers; the worker looks up where it goes. Nothing is written. */
    'funnel.open': { input: { key: string; dispatchId?: string }; output: { opened: boolean; reason?: 'unknown' | 'no_target' | 'failed' } }
    /** R4: the waits as the worker last read them. */
    'waits.get': { output: WaitsSnapshot }
    /** Opens or focuses the place of one wait. Takes only the row key; the worker looks up where it goes. */
    'waits.open': { input: { key: string }; output: { opened: boolean; reason?: 'unknown' | 'no_target' | 'failed' } }
    /** R7: every agent, grouped by project. Reads again when the last read is older than 3 s, or with `force`. No CLI. */
    'agents.get': { input?: { force?: boolean }; output: AgentsSnapshot }
    /** Focuses an agent's terminal, or opens its workspace. Takes only the row key; the worker looks up where it goes. */
    'agents.open': { input: { key: string }; output: { opened: boolean; reason?: 'no_target' | 'failed' } }
  }
  interface PluginPanelEvents {
    /** Posted after each shipping-line refresh. */
    'line.changed': LineSnapshot
    /** Posted when the funnel changes: after a read, or after new Waits data while a panel watches. */
    'funnel.changed': FunnelSnapshot
    /** Sent when the list, the banner or the CLI path changes. */
    'waits.changed': WaitsSnapshot
    /** Posted when an agent event or a read changes the Agents snapshot. */
    'agents.changed': AgentsSnapshot
  }
}
