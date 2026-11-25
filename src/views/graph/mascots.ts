// Funnel slice 4, R9: each bot's picture, read by the worker and sent to the panel as data.
//
// Order per bot, as Orca's own sidebar picks it from the bot's `bot.json` `avatar` field:
//  1. `upload:<id>`: the picture the user uploaded, `~/.orca/bots/<home>/avatar.png`.
//  2. `mascot:<id>`: Orca's own mascot, read from the installed app:
//     `<Orca install>/resources/app.asar.unpacked/out/renderer/assets/<id>-<hash>.svg` (then `.webp`).
//     The install folder comes from `process.execPath` (the same idea as the CLI finder).
//  3. Nothing found: no picture; the panel draws the bot's initial.
// Every file: a plain file, not empty, at most 128 KB, and really the image its name says. An SVG with
// script, event handlers, foreignObject, entities or any outside link is refused.
// The plugin ships no mascot files. Panel code never reads files: only this worker module does.
//
// The pure parts (paths, checks) take no Node module. The store takes its file access as deps and
// reads a file again only when its size or mtime changed; the panel gets one picture per answer.

/**
 * At most this many bytes per picture file. Its base64 (about 175 KB) goes in one answer of its own,
 * far below the 256 KiB a panel message may hold.
 */
export const MAX_PICTURE = 128 * 1024
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

const statOf = async (deps: PictureDeps, path: string): Promise<FileStat | null> => {
  try {
    return await deps.stat(path)
  } catch {
    return null
  }
}

/** A picture with the signature the panel keeps: it changes when the file changes. */
export type PictureEntry = { sig: string; picture: Picture }

export type PictureStore = {
  /**
   * Looks at every bot home and returns each key's picture signature (null: no picture, draw the
   * initial). Keys are bot ids and `name:<bot name>`. Only a file whose size or mtime changed since
   * the last scan is read again.
   */
  scan(): Promise<Record<string, string | null>>
  /** The picture of one key as of the last scan; null when it has none. */
  get(key: string): PictureEntry | null
}

type Checked = { sig: string; picture: Picture | null }
type BotJson = { id: string; name: string; avatar: Avatar }

/**
 * Bot pictures with a cache by file size and mtime. A file over MAX_PICTURE, or one that fails its
 * check, gives no picture and one log line per file version. A missing folder or file gives no
 * picture and no line (R9 AC).
 */
export function createPictureStore(deps: PictureDeps, log: (line: string) => void = () => undefined): PictureStore {
  const win = deps.platform === 'win32'
  const jsons = new Map<string, { sig: string; bot: BotJson | null }>()
  const files = new Map<string, Checked>()
  const logged = new Set<string>()
  let current = new Map<string, PictureEntry | null>()
  const once = (key: string, line: string): void => {
    if (logged.has(key)) return
    logged.add(key)
    log(line)
  }

  /** One picture file: from the cache when its size and mtime match, else read and checked. */
  async function checked(path: string, label: string, check: (b: Uint8Array) => Picture | null): Promise<Checked | null> {
    const s = await statOf(deps, path)
    if (!s || !s.isFile || s.size <= 0) return null
    const sig = `${s.size}:${s.mtimeMs}`
    const hit = files.get(path)
    if (hit && hit.sig === sig) return hit
    let picture: Picture | null = null
    if (s.size > MAX_PICTURE) {
      once(`big ${path} ${sig}`, `bot picture skipped: ${label} is ${Math.ceil(s.size / 1024)} KB, over ${MAX_PICTURE / 1024} KB; the initial shows`)
    } else {
      try {
        const b = await deps.readFile(path)
        picture = b.length > 0 && b.length <= MAX_PICTURE ? check(b) : null
      } catch {
        picture = null
      }
      if (!picture) once(`bad ${path} ${sig}`, `bot picture refused: ${label} is not a safe image of its type; the initial shows`)
    }
    const c = { sig, picture }
    files.set(path, c)
    return c
  }

  async function botJson(path: string): Promise<BotJson | null> {
    const s = await statOf(deps, path)
    if (!s || !s.isFile || s.size <= 0 || s.size > MAX_BOT_JSON) return null
    const sig = `${s.size}:${s.mtimeMs}`
    const hit = jsons.get(path)
    if (hit && hit.sig === sig) return hit.bot
    let bot: BotJson | null = null
    try {
      const v = JSON.parse(new TextDecoder().decode(await deps.readFile(path))) as { id?: unknown; name?: unknown; avatar?: unknown } | null
      if (v && typeof v === 'object') {
        const id = typeof v.id === 'string' ? v.id.slice(0, 80) : ''
        const name = typeof v.name === 'string' ? v.name.slice(0, 80) : ''
        if (id || name) bot = { id, name, avatar: avatarOf(v.avatar) }
      }
    } catch {
      bot = null
    }
    jsons.set(path, { sig, bot })
    return bot
  }

  const svgOrWebp = (name: string) => (b: Uint8Array): Picture | null => {
    if (name.endsWith('.svg')) return isSafeSvg(new TextDecoder('utf-8', { fatal: false }).decode(b)) ? { url: dataUrl('image/svg+xml', b), from: 'mascot' } : null
    return isWebp(b) ? { url: dataUrl('image/webp', b), from: 'mascot' } : null
  }
  const png = (b: Uint8Array): Picture | null => (isPng(b) ? { url: dataUrl('image/png', b), from: 'upload' } : null)

  return {
    async scan() {
      const next = new Map<string, PictureEntry | null>()
      const out: Record<string, string | null> = {}
      const bots = botsDir(deps.homedir, deps.platform)
      let homes: string[] = []
      try {
        homes = bots ? (await deps.readdir(bots)).filter((n) => !n.startsWith('.')).sort().slice(0, MAX_BOTS) : []
      } catch {
        homes = []
      }
      const assets = assetsDir(deps.execPath, deps.platform)
      let assetNames: string[] | null = null
      const mascots = new Map<string, PictureEntry | null>()
      const mascot = async (id: string): Promise<PictureEntry | null> => {
        if (mascots.has(id)) return mascots.get(id) ?? null
        let found: PictureEntry | null = null
        if (assets) {
          if (!assetNames) {
            try {
              assetNames = await deps.readdir(assets)
            } catch {
              assetNames = []
            }
          }
          for (const name of mascotFiles(assetNames, id)) {
            const c = await checked(join(win, assets, name), `Orca mascot ${name}`, svgOrWebp(name))
            if (c?.picture) {
              found = { sig: `mascot:${name}:${c.sig}`, picture: c.picture }
              break
            }
          }
        }
        mascots.set(id, found)
        return found
      }
      for (const home of homes) {
        const dir = join(win, bots as string, home)
        const bot = await botJson(join(win, dir, 'bot.json'))
        if (!bot) continue
        let entry: PictureEntry | null = null
        // An uploaded picture first; a bot set to a mascot shows the mascot, as Orca's sidebar does.
        if (bot.avatar?.kind === 'mascot') entry = await mascot(bot.avatar.id)
        else {
          const c = await checked(join(win, dir, 'avatar.png'), `avatar.png of bot "${bot.name || home}"`, png)
          entry = c?.picture ? { sig: `upload:${home}:${c.sig}`, picture: c.picture } : null
        }
        for (const key of [bot.id, bot.name ? `name:${bot.name}` : '']) {
          if (!key || key in out) continue
          next.set(key, entry)
          out[key] = entry?.sig ?? null
        }
      }
      current = next
      return out
    },
    get(key) {
      return current.get(key) ?? null
    }
  }
}

/** Every key's picture after one scan (tests and one-off use). */
export async function readPictures(deps: PictureDeps, log?: (line: string) => void): Promise<Record<string, Picture | null>> {
  const store = createPictureStore(deps, log)
  const sigs = await store.scan()
  return Object.fromEntries(Object.keys(sigs).map((k) => [k, store.get(k)?.picture ?? null]))
}
