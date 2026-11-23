// The waits test set (test/fixtures/cases/waits-mixed.json) as a fake CLI and a ready snapshot.
// Used by the tests, by `orca plugin check` scenarios and by the screenshots.
import type { CliRequest } from '../src/cli/commands.ts'
import { buildArgv } from '../src/cli/commands.ts'
import type { CliResult } from '../src/cli/run.ts'
import type { AgentStatusEvent } from '../src/model/index.ts'
import { createWaitsRefresher, type WaitsSnapshot } from '../src/views/waits/refresh.ts'
import { fixture } from './helpers.ts'

export const WAITS_CASE = fixture('cases/waits-mixed.json') as {
  cli: Record<string, { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }>
  events: AgentStatusEvent[]
  expect: { waits: Record<string, { kind: string; label: string; sources: string[] }> }
}

export const FIXTURE_CLI_PATH = '/opt/Orca/resources/bin/orca'

/** The argv of a request without `--json`: the key of WAITS_CASE.cli. */
export const cliKey = (r: CliRequest): string => buildArgv(r).slice(0, -1).join(' ')

/** A fake `cli.run` answering from the test set; an unknown call answers an empty ok result. */
export function fixtureRun(onCall?: (key: string) => void, delayMs = 0): (r: CliRequest) => Promise<CliResult> {
  return async (r) => {
    const key = cliKey(r)
    onCall?.(key)
    if (delayMs) await new Promise((done) => setTimeout(done, delayMs))
    const env = WAITS_CASE.cli[key]
    if (!env) return { ok: true, result: {}, ms: 1, cliPath: FIXTURE_CLI_PATH }
    return env.ok ? { ok: true, result: env.result, ms: 1, cliPath: FIXTURE_CLI_PATH } : { ok: false, error: { kind: 'cli_error', code: env.error.code, message: env.error.message }, ms: 1, cliPath: FIXTURE_CLI_PATH }
  }
}

/** The snapshot the worker builds from the test set: one slow cycle, then every agent event. */
export async function fixtureSnapshot(now = 1795400900000): Promise<WaitsSnapshot> {
  const r = createWaitsRefresher({ run: fixtureRun(), now: () => now, cliPath: () => FIXTURE_CLI_PATH })
  await r.cycle(true)
  for (const e of WAITS_CASE.events) r.onAgentEvent(e)
  return r.snapshot()
}
