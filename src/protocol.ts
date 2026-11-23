// The panel <-> worker contract. Slice 1 has no panel; these requests serve the live checks
// (`orca plugin dev request . cli.status`) and give slices 2-4 a typed start.
import type { LineSnapshot } from './views/line/model.ts'
export {}

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
  }
  interface PluginPanelEvents {
    /** Posted after each shipping-line refresh. */
    'line.changed': LineSnapshot
  }
}
