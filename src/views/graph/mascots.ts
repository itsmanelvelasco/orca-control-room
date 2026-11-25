// Funnel slice 4, R9: each bot's picture, read by the worker and sent to the panel as data.
//
// Order per bot, as Orca's own sidebar picks it from the bot's `bot.json` `avatar` field:
//  1. `upload:<id>`: the picture the user uploaded, `~/.orca/bots/<home>/avatar.png`.
//  2. `mascot:<id>`: Orca's own mascot, read from the installed app:
//     `<Orca install>/resources/app.asar.unpacked/out/renderer/assets/<id>-<hash>.svg` (then `.webp`).
//     The install folder comes from `process.execPath` (the same idea as the CLI finder).
//  3. Nothing found: no picture; the panel draws the bot's initial.
// Every file: a plain file, not empty, at most 1 MB, and really the image its name says. An SVG with
// script, event handlers, foreignObject, entities or any outside link is refused.
// The plugin ships no mascot files. Panel code never reads files: only this worker module does.
//
// The pure parts (paths, checks) take no Node module; `readPictures` takes its file access as deps.

/** At most this many bytes per picture file. */
export const MAX_BYTES = 1024 * 1024
/** At most this many bytes of a bot.json. */
export const MAX_BOT_JSON = 64 * 1024
/** At most this many bot homes are looked at. */
export const MAX_BOTS = 200

export type Picture = { url: string; from: 'upload' | 'mascot' }
export type Avatar = { kind: 'mascot'; id: string } | { kind: 'upload' } | null

/** What a bot.json `avatar` field says. An emoji or anything else is no picture. */
export function avatarOf(v: unknown): Avatar {
  const a = typeof v === 'string' ? v.trim() : ''
  const m = /^mascot:([A-Za-z][A-Za-z0-9]{0,7})$/.exec(a)
  if (m) return { kind: 'mascot', id: m[1] }
  if (/^upload:[A-Za-z0-9._-]{1,128}$/.test(a)) return { kind: 'upload' }
  return null
}

/** Joins path parts with the platform's separator. */
function join(win: boolean, ...parts: string[]): string {
  const sep = win ? '\\' : '/'
  return parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, ''))).join(sep)
}

function dirname(win: boolean, path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), win ? path.lastIndexOf('\\') : -1)
  return cut > 0 ? path.slice(0, cut) : path
}

/**
 * Where the installed Orca keeps its mascots, from the worker's `process.execPath`; null when the
 * path is not absolute. macOS: the `Resources` folder of the outermost `.app` (a helper inside
 * `Frameworks` resolves to the main app). Windows and Linux: `resources` next to the executable.
 */
export function assetsDir(execPath: string, platform: string): string | null {
  const win = platform === 'win32'
  if (!execPath || !(win ? /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]/.test(execPath) : execPath.startsWith('/'))) return null
  const tail = ['app.asar.unpacked', 'out', 'renderer', 'assets']
  if (platform === 'darwin') {
    const at = execPath.indexOf('.app/Contents/')
    if (at < 0) return null
    return join(false, execPath.slice(0, at + '.app/Contents'.length), 'Resources', ...tail)
  }
  return join(win, dirname(win, execPath), 'resources', ...tail)
}

/** The bot homes folder: `~/.orca/bots`. */
export function botsDir(homedir: string, platform: string): string | null {
  return homedir ? join(platform === 'win32', homedir, '.orca', 'bots') : null
}

/** Mascot files of id `id` in a folder listing, `.svg` before `.webp`; never a `-cut`/`-rim` variant. */
export function mascotFiles(names: readonly string[], id: string): string[] {
  const re = /^([A-Za-z][A-Za-z0-9]{0,7})-([A-Za-z0-9_]{6,16})\.(svg|webp)$/
  const hits = names.map((n) => ({ n, m: re.exec(n) })).filter((x) => x.m && x.m[1] === id)
  return hits.sort((a, b) => (a.m![3] === b.m![3] ? a.n.localeCompare(b.n) : a.m![3] === 'svg' ? -1 : 1)).map((x) => x.n)
}

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((x, i) => b[at + i] === x)
export const isPng = (b: Uint8Array): boolean => b.length > 8 && startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
export const isWebp = (b: Uint8Array): boolean => b.length > 12 && startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)

/**
 * True when an SVG text is safe to show as a picture: it starts as an SVG and holds no script,
 * no event handler, no foreignObject, no entity or DOCTYPE subset, and no link outside itself
 * (`href`, `xlink:href`, `url(...)` and `@import` may point only at `#local` ids).
 */
export function isSafeSvg(text: string): boolean {
  const head = text.replace(/^﻿/, '').replace(/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*/, '')
  if (!/^<svg[\s>]/i.test(head)) return false
  if (/<!DOCTYPE|<!ENTITY|<script|<foreignObject|<iframe|<embed|<object/i.test(text)) return false
  if (/\son[a-z]+\s*=/i.test(text)) return false
  // A value that does not start with `#`, quoted or not (no backtracking past the quote).
  const outside = String.raw`\s*(?:"\s*(?!#)|'\s*(?!#)|(?!["'\s#]))`
  if (new RegExp(String.raw`href\s*=` + outside, 'i').test(text)) return false
  if (new RegExp(String.raw`url\(` + outside, 'i').test(text)) return false
  if (/@import|javascript:|data:/i.test(text)) return false
  return true
}

/** A `data:` URL for bytes already checked; base64 without a Node Buffer. */
export function dataUrl(mime: string, b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return `data:${mime};base64,${btoa(s)}`
}

/** The panel accepts only these: a check on both sides. */
export const PICTURE_URL = /^data:image\/(png|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/

export type FileStat = { isFile: boolean; size: number; mtimeMs: number }
export type PictureDeps = {
  platform: string
  execPath: string
  homedir: string
  readdir(path: string): Promise<string[]>
  /** lstat: a link is not a file. */
  stat(path: string): Promise<FileStat>
  readFile(path: string): Promise<Uint8Array>
}

/** Reads one file if it is a plain file of 1..max bytes; null otherwise. */
async function readSmall(deps: PictureDeps, path: string, max: number): Promise<Uint8Array | null> {
  try {
    const s = await deps.stat(path)
    if (!s.isFile || s.size <= 0 || s.size > max) return null
    const b = await deps.readFile(path)
    return b.length > 0 && b.length <= max ? b : null
  } catch {
    return null
  }
}

/** The uploaded picture in a bot home: `avatar.png`, a real PNG. */
export async function readUpload(deps: PictureDeps, home: string): Promise<Picture | null> {
  const b = await readSmall(deps, join(deps.platform === 'win32', home, 'avatar.png'), MAX_BYTES)
  return b && isPng(b) ? { url: dataUrl('image/png', b), from: 'upload' } : null
}

/** Orca's mascot `id` from the installed app: the first file that passes its check. */
export async function readMascot(deps: PictureDeps, dir: string, names: readonly string[], id: string): Promise<Picture | null> {
  for (const name of mascotFiles(names, id)) {
    const b = await readSmall(deps, join(deps.platform === 'win32', dir, name), MAX_BYTES)
    if (!b) continue
    if (name.endsWith('.svg')) {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(b)
      if (isSafeSvg(text)) return { url: dataUrl('image/svg+xml', b), from: 'mascot' }
    } else if (isWebp(b)) {
      return { url: dataUrl('image/webp', b), from: 'mascot' }
    }
  }
  return null
}

/**
 * Every bot's picture, by bot id (and by bot name, for pieces that know only the name). A bot with no
 * picture maps to null. A missing folder or an unreadable file is skipped with no error (R9 AC).
 */
export async function readPictures(deps: PictureDeps): Promise<Record<string, Picture | null>> {
  const out: Record<string, Picture | null> = {}
  const bots = botsDir(deps.homedir, deps.platform)
  if (!bots) return out
  const win = deps.platform === 'win32'
  let homes: string[] = []
  try {
    homes = (await deps.readdir(bots)).filter((n) => !n.startsWith('.')).sort().slice(0, MAX_BOTS)
  } catch {
    return out
  }
  const assets = assetsDir(deps.execPath, deps.platform)
  let assetNames: string[] | null = null
  const listAssets = async (): Promise<string[]> => {
    if (assetNames) return assetNames
    try {
      assetNames = assets ? await deps.readdir(assets) : []
    } catch {
      assetNames = []
    }
    return assetNames
  }
  const mascots = new Map<string, Picture | null>()
  for (const name of homes) {
    const home = join(win, bots, name)
    const raw = await readSmall(deps, join(win, home, 'bot.json'), MAX_BOT_JSON)
    if (!raw) continue
    let bot: { id?: unknown; name?: unknown; avatar?: unknown }
    try {
      bot = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      continue
    }
    if (!bot || typeof bot !== 'object') continue
    const id = typeof bot.id === 'string' ? bot.id.slice(0, 80) : ''
    const botName = typeof bot.name === 'string' ? bot.name.slice(0, 80) : ''
    if (!id && !botName) continue
    const avatar = avatarOf(bot.avatar)
    let pic: Picture | null = null
    // An uploaded picture first; a bot set to a mascot shows the mascot, as Orca's sidebar does.
    if (avatar?.kind !== 'mascot') pic = await readUpload(deps, home)
    else if (assets) {
      if (!mascots.has(avatar.id)) mascots.set(avatar.id, await readMascot(deps, assets, await listAssets(), avatar.id))
      pic = mascots.get(avatar.id) ?? null
    }
    if (id) out[id] = pic
    if (botName && !(`name:${botName}` in out)) out[`name:${botName}`] = pic
  }
  return out
}
