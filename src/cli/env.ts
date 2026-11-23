// R2. The env every Orca CLI call runs with.
//
// Orca starts plugin workers with ELECTRON_RUN_AS_NODE=1 and, on Windows, without APPDATA.
// Passed on as is, the CLI either runs as plain Node ("Cannot find module ...\orca\bot") or
// stops with "runtime_unavailable: APPDATA is not set". This builds the env the CLI needs.

/** The parts of the host the env builder reads. Tests pass fixtures; the worker passes the real ones. */
export type EnvHost = {
  platform: string
  env: Readonly<Record<string, string | undefined>>
  /** os.homedir(), used only when the env has neither USERPROFILE (Windows) nor HOME. */
  homedir: string
}

/** Reads a key the way the OS does: Windows env keys ignore case (`Path` is `PATH`). */
export function envGet(env: Readonly<Record<string, string | undefined>>, key: string, platform: string): string | undefined {
  if (platform !== 'win32') return env[key]
  const want = key.toUpperCase()
  for (const k of Object.keys(env)) if (k.toUpperCase() === want) return env[k]
  return undefined
}

function joinWin(base: string, ...parts: string[]): string {
  return [base.replace(/[\\/]+$/, ''), ...parts].join('\\')
}

/**
 * process.env minus ELECTRON_RUN_AS_NODE, plus the folders the CLI needs:
 * - Windows: APPDATA = %USERPROFILE%\AppData\Roaming and LOCALAPPDATA = %USERPROFILE%\AppData\Local, when missing.
 * - macOS and Linux: HOME, when missing.
 * Values already set are never changed. Returns a new object; the input is not touched.
 */
export function buildCliEnv(host: EnvHost): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(host.env)) {
    if (v === undefined) continue
    if (k.toUpperCase() === 'ELECTRON_RUN_AS_NODE') continue
    out[k] = v
  }
  if (host.platform === 'win32') {
    const profile = envGet(out, 'USERPROFILE', 'win32') || host.homedir
    if (profile) {
      if (!envGet(out, 'APPDATA', 'win32')) out.APPDATA = joinWin(profile, 'AppData', 'Roaming')
      if (!envGet(out, 'LOCALAPPDATA', 'win32')) out.LOCALAPPDATA = joinWin(profile, 'AppData', 'Local')
    }
  } else if (!out.HOME && host.homedir) {
    out.HOME = host.homedir
  }
  return out
}
