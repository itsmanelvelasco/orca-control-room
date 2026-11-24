// One CLI call of each kind at a time, across every loop of the worker (Waits, Shipping line,
// Funnel). Calls of one command name wait in line, first come first served; calls of different
// names run side by side. Pure: no Node modules, so views may import its type.
import type { CliRequest } from './commands.ts'
import type { CliResult } from './run.ts'

export type RunCli = (request: CliRequest) => Promise<CliResult>

export function inTurns(run: RunCli): RunCli {
  /** The last call queued per command name; the next one starts when it settles. */
  const tails = new Map<string, Promise<unknown>>()
  return (request) => {
    const kind = request.command
    const before = tails.get(kind) ?? Promise.resolve()
    const call = before.then(() => run(request))
    const tail = call.catch(() => undefined)
    tails.set(kind, tail)
    // Forget an idle line, so the map holds only kinds with a call waiting or running.
    void tail.then(() => {
      if (tails.get(kind) === tail) tails.delete(kind)
    })
    return call
  }
}
