// The panel <-> worker contract, shared by both sides.
import type { LineSnapshot } from './views/line/model.ts'
import type { WaitsSnapshot } from './views/waits/refresh.ts'
import type { AgentsSnapshot } from './views/agents/model.ts'

export type { LineSnapshot, WaitsSnapshot, AgentsSnapshot }
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
    /** Sent when the list, the banner or the CLI path changes. */
    'waits.changed': WaitsSnapshot
    /** Posted when an agent event or a read changes the Agents snapshot. */
    'agents.changed': AgentsSnapshot
  }
}
