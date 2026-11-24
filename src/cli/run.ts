// The one place that runs the Orca CLI. Every call goes: allow-list (commands.ts) ->
// resolved absolute path (resolve.ts) -> clean env (env.ts) -> execFile with fixed options.

import { buildArgv, CliRequestError, type CliRequest } from './commands.ts'
import type { CliCandidate, CliSource, Resolution } from './resolve.ts'
import { parseEnvelope } from '../model/envelope.ts'

/** R2: fixed for every call. */
export const EXEC_OPTIONS = Object.freeze({ timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })

export type ExecOptions = typeof EXEC_OPTIONS & { env: Record<string, string> }
export type ExecCallback = (error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null, stdout: string, stderr: string) => void
/** The shape of node:child_process execFile that the runner needs. Tests pass a fake. */
export type ExecFileLike = (file: string, args: string[], options: ExecOptions, callback: ExecCallback) => unknown

/** Why a call gave no data. Views turn `kind` into one banner. */
export type CliFailureKind =
  | 'refused' // the request failed the allow-list; nothing ran
  | 'not_found' // no CLI on any path; `tried` lists them
  | 'spawn' // the file could not start (moved, not executable)
  | 'timeout' // no answer in 10 s; keep the last good data
  | 'too_large' // more than 16 MB of output
  | 'cli_error' // the CLI answered ok:false, e.g. runtime_unavailable
  | 'malformed' // stdout was not a JSON envelope

export type CliFailure = { kind: CliFailureKind; message: string; code?: string; tried?: CliCandidate[] }

export type CliResult =
  | { ok: true; result: unknown; ms: number; cliPath: string }
  | { ok: false; error: CliFailure; ms: number; cliPath: string | null }

export type CliRunnerDeps = {
  exec: ExecFileLike
  /** Finds the CLI; called at the first call and again after a failure that may mean it moved. */
  resolve: () => Resolution
  /** The env for each call (buildCliEnv). */
  env: () => Record<string, string>
  now?: () => number
}

export type CliRunner = {
  /** Runs one allowed request. Never throws; a refused request comes back as `kind: 'refused'`. */
  run(request: CliRequest): Promise<CliResult>
  /** The path in use and where it came from, for the panel footer; null before the first call or when not found. */
  current(): { path: string; source: CliSource } | null
  /** The last resolution, with every path tried. */
  lastResolution(): Resolution | null
  /** Forget the path so the next call resolves again (e.g. after the orcaCli setting changes). */
  reset(): void
  /** Kills the calls still running and refuses new ones: the worker is stopping, so nothing outlives it. */
  stop?(): void
}

/** Failures after which the path is looked up again on the next call (PRD 5: the path can move on update). */
const RERESOLVE_ON: ReadonlySet<CliFailureKind> = new Set(['not_found', 'spawn', 'malformed'])

export function createCliRunner(deps: CliRunnerDeps): CliRunner {
  const now = deps.now ?? Date.now
  let resolution: Resolution | null = null
  /** True when the next call must look the path up again. */
  let stale = true
  const inFlight = new Map<string, Promise<CliResult>>()
  /** Child processes still running, so `stop` can end them. */
  const children = new Set<{ kill: () => unknown }>()
  let stopped = false

  const ensure = (): Resolution => {
    if (stale || !resolution || !resolution.ok) {
      resolution = deps.resolve()
      stale = false
    }
    return resolution
  }

  const execOnce = (path: string, argv: string[]): Promise<CliResult> => {
    const started = now()
    return new Promise<CliResult>((done) => {
      const finish = (r: { ok: true; result: unknown } | { ok: false; error: CliFailure }): void => {
        const ms = now() - started
        if (!r.ok && RERESOLVE_ON.has(r.error.kind)) stale = true
        done(r.ok ? { ok: true, result: r.result, ms, cliPath: path } : { ok: false, error: r.error, ms, cliPath: path })
      }
      let killable: { kill: () => unknown } | null = null
      let ended = false
      try {
        const child = deps.exec(path, argv, { ...EXEC_OPTIONS, env: deps.env() }, (error, stdout, stderr) => {
          ended = true
          if (killable) children.delete(killable)
          const out = String(stdout ?? '')
          if (error) {
            const code = typeof error.code === 'string' ? error.code : undefined
            if (stopped) return finish({ ok: false, error: { kind: 'timeout', message: 'The plugin stopped this call.' } })
            if (error.killed || code === 'ETIMEDOUT') return finish({ ok: false, error: { kind: 'timeout', message: 'The Orca CLI did not answer in 10 s.' } })
            if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return finish({ ok: false, error: { kind: 'too_large', message: 'The Orca CLI answered more than 16 MB.' } })
            if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'UNKNOWN') {
              return finish({ ok: false, error: { kind: 'spawn', code, message: `Could not start the Orca CLI (${code}).` } })
            }
          }
          // The CLI prints a JSON envelope on success and on its own errors (exit 1).
          const envelope = parseEnvelope(out)
          if (envelope?.ok) return finish({ ok: true, result: envelope.result })
          if (envelope && !envelope.ok) return finish({ ok: false, error: { kind: 'cli_error', code: envelope.error.code, message: envelope.error.message } })
          const detail = String(stderr ?? '').split(/\r?\n/).find((l) => l.trim()) ?? out.slice(0, 120)
          finish({ ok: false, error: { kind: 'malformed', message: `The Orca CLI did not answer JSON${detail ? `: ${detail.trim().slice(0, 200)}` : '.'}` } })
        })
        // node's execFile returns the child; a test fake may return nothing.
        const k = child as { kill?: unknown } | null | undefined
        if (!ended && k && typeof k.kill === 'function') {
          killable = { kill: () => (k.kill as () => unknown).call(k) }
          children.add(killable)
        }
      } catch (e) {
        finish({ ok: false, error: { kind: 'spawn', message: `Could not start the Orca CLI: ${String((e as Error)?.message ?? e).slice(0, 200)}` } })
      }
    })
  }

  return {
    run(request) {
      let argv: string[]
      try {
        argv = buildArgv(request)
      } catch (e) {
        const message = e instanceof CliRequestError ? e.message : 'request refused'
        return Promise.resolve({ ok: false, error: { kind: 'refused', message }, ms: 0, cliPath: null })
      }
      if (stopped) return Promise.resolve({ ok: false, error: { kind: 'timeout', message: 'The plugin is stopping.' }, ms: 0, cliPath: null })
      const key = argv.join('\u0000')
      const running = inFlight.get(key)
      if (running) return running
      const r = ensure()
      if (!r.ok) {
        return Promise.resolve({ ok: false, error: { kind: 'not_found', message: 'The Orca CLI was not found.', tried: r.tried }, ms: 0, cliPath: null })
      }
      const p = execOnce(r.path, argv).finally(() => inFlight.delete(key))
      inFlight.set(key, p)
      return p
    },
    current() {
      return resolution?.ok ?{ path: resolution.path, source: resolution.source } : null
    },
    lastResolution() {
      return resolution
    },
    stop() {
      stopped = true
      for (const c of children) {
        try {
          c.kill()
        } catch {
          /* already gone */
        }
      }
      children.clear()
    },
    reset() {
      stale = true
    }
  }
}
