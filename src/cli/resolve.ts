// R1. Find the Orca CLI with no setting, on Windows, macOS and Linux.
//
// Order: the `orcaCli` setting, Orca's own bin folder next to the running app
// (process.execPath), the OS default install path, then `orca` on PATH.
// Every candidate is an absolute path. A bare `orca` is never run: from a plugin worker
// on Windows it resolves to Orca.exe in Orca's cwd, which runs as Node and fails.

import { posix, win32 } from 'node:path'
import { envGet } from './env.ts'

/** Where a CLI path came from. The panel footer shows it next to the path. */
export type CliSource = 'setting' | 'app' | 'os-default' | 'path'

export type CliCandidate = { path: string; source: CliSource }

export type ResolveHost = {
  platform: string
  /** process.execPath of the plugin worker: Orca's own executable. */
  execPath: string
  env: Readonly<Record<string, string | undefined>>
  homedir: string
  /** The `orcaCli` setting; empty or missing means "find it". */
  setting?: string | null
  /** True when the path is an existing file. */
  isFile: (path: string) => boolean
}

export type Resolution =
  | { ok: true; path: string; source: CliSource; tried: CliCandidate[] }
  | { ok: false; tried: CliCandidate[] }

/** Every path the resolver would try, in order, without touching the disk. Duplicates removed. */
export function cliCandidates(host: ResolveHost): CliCandidate[] {
  const win = host.platform === 'win32'
  const p = win ? win32 : posix
  const exe = win ? 'orca.exe' : 'orca'
  const out: CliCandidate[] = []
  const add = (path: string | undefined | null, source: CliSource): void => {
    if (!path || !p.isAbsolute(path)) return
    const norm = p.normalize(path)
    const key = win ? norm.toLowerCase() : norm
    if (out.some((c) => (win ? c.path.toLowerCase() : c.path) === key)) return
    out.push({ path: norm, source })
  }

  // 1. The setting. Only an absolute path counts: a bare name would be looked up from Orca's cwd.
  const setting = (host.setting ?? '').trim()
  if (setting) add(setting, 'setting')

  // 2. Orca's own bin folder, next to the running app. Covers custom install folders and the
  //    Linux AppImage mount, whose path changes on every run.
  if (host.execPath && p.isAbsolute(host.execPath)) {
    const appDir = p.dirname(host.execPath)
    add(p.join(appDir, 'resources', 'bin', exe), 'app')
    if (host.platform === 'darwin') add(p.join(appDir, '..', 'Resources', 'bin', exe), 'app')
  }

  // 3. The OS default install path.
  if (win) {
    const local = envGet(host.env, 'LOCALAPPDATA', 'win32') || (envGet(host.env, 'USERPROFILE', 'win32') || host.homedir) + '\\AppData\\Local'
    add(win32.join(local, 'Programs', 'Orca', 'resources', 'bin', exe), 'os-default')
  } else if (host.platform === 'darwin') {
    add('/Applications/Orca.app/Contents/Resources/bin/orca', 'os-default')
    if (host.homedir) add(posix.join(host.homedir, 'Applications', 'Orca.app', 'Contents', 'Resources', 'bin', 'orca'), 'os-default')
  } else {
    const appDir = host.env.APPDIR
    if (appDir) add(posix.join(appDir, 'resources', 'bin', 'orca'), 'os-default')
    add('/opt/Orca/resources/bin/orca', 'os-default')
  }

  // 4. `orca` on PATH, searched here so the result is an absolute path. Relative PATH
  //    entries are skipped: they would resolve against Orca's cwd.
  const pathVar = envGet(host.env, 'PATH', host.platform) ?? ''
  for (const dir of pathVar.split(win ? ';' : ':')) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1')
    if (d) add(p.join(d, exe), 'path')
  }
  return out
}

/** The first candidate that exists, with the full list tried (for the "CLI not found" banner). */
export function resolveCli(host: ResolveHost): Resolution {
  const tried = cliCandidates(host)
  for (const c of tried) {
    let found = false
    try {
      found = host.isFile(c.path)
    } catch {
      found = false
    }
    if (found) return { ok: true, path: c.path, source: c.source, tried }
  }
  return { ok: false, tried }
}
