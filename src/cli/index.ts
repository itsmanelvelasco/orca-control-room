// The CLI bridge for the plugin worker: one runner wired to the real host.
// Views never call execFile; they call `bridge.run({ command: ... })`.

import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { buildCliEnv } from './env.ts'
import { resolveCli } from './resolve.ts'
import { createCliRunner, type CliRunner, type ExecFileLike } from './run.ts'

export * from './commands.ts'
export * from './env.ts'
export * from './resolve.ts'
export * from './run.ts'

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The runner for this worker. `setting` reads the `orcaCli` setting each time the path is
 * resolved, so a changed setting applies after `runner.reset()`.
 */
export function createHostCliRunner(setting: () => string | null | undefined): CliRunner {
  return createCliRunner({
    exec: execFile as unknown as ExecFileLike,
    resolve: () => resolveCli({ platform: process.platform, execPath: process.execPath, env: process.env, homedir: homedir(), setting: setting(), isFile }),
    env: () => buildCliEnv({ platform: process.platform, env: process.env, homedir: homedir() })
  })
}
