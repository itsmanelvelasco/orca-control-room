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
    /** The shipping line (R6). Answers at once with what the worker holds and starts a refresh when it is older than the interval, or at once with `force`. */
    'line.snapshot': { input?: { force?: boolean }; output: LineSnapshot }
  }
  interface PluginPanelEvents {
    /** Posted after each shipping-line refresh. */
    'line.changed': LineSnapshot
  }
}
