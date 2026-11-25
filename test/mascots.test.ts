// Funnel slice 4, R9: bot pictures. Orca's mascots from the installed app (found from
// process.execPath), an uploaded avatar first, the initial when nothing is found, the SVG check.
// A fake file system: no real home folder or Orca install is read.
import { assert, test } from 'orca/testing'
import { assetsDir, avatarOf, botsDir, createPictureStore, isSafeSvg, mascotFiles, MAX_PICTURE, PICTURE_URL, readPictures, type FileStat, type PictureDeps } from '../src/views/graph/mascots.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50])
const enc = (s: string) => new TextEncoder().encode(s)
/** Shaped like Orca's own mascots: filters and clip paths by local id. */
const MASCOT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><filter id="A1b"><feGaussianBlur stdDeviation="5"/></filter><clipPath id="A1s"><circle cx="64" cy="64" r="60"/></clipPath></defs><g clip-path="url(#A1s)"><path d="M0,0h128v128z" fill="#e0857c" filter="url(#A1b)"/></g><use href="#A1s"/></svg>'

type Entry = { bytes: Uint8Array; link?: boolean; mtime?: number } | 'dir'

/** A fake disk on POSIX paths. */
function fakeDisk(files: Record<string, Entry>, over: Partial<PictureDeps> = {}): PictureDeps & { reads: string[] } {
  const reads: string[] = []
  return {
    platform: 'linux',
    execPath: '/opt/Orca/orca',
    homedir: '/home/alex',
    reads,
    async readdir(path) {
      const pre = `${path}/`
      const names = Object.keys(files).filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length).split('/')[0])
      if (!names.length && files[path] !== 'dir') throw new Error('ENOENT')
      return [...new Set(names)]
    },
    async stat(path): Promise<FileStat> {
      const f = files[path]
      if (!f) throw new Error('ENOENT')
      if (f === 'dir') return { isFile: false, size: 0, mtimeMs: 0 }
      return { isFile: !f.link, size: f.bytes.length, mtimeMs: f.mtime ?? 1 }
    },
    async readFile(path) {
      reads.push(path)
      const f = files[path]
      if (!f || f === 'dir') throw new Error('ENOENT')
      return f.bytes
    },
    ...over
  }
}

const ASSETS = '/opt/Orca/resources/app.asar.unpacked/out/renderer/assets'
const BOTS = '/home/alex/.orca/bots'
const bot = (id: string, name: string, avatar?: string): Entry => ({ bytes: enc(JSON.stringify({ id, name, avatar, other: 'x' })) })

test('R9: the install folder comes from process.execPath on Windows, macOS (main app or helper) and Linux', () => {
  assert.equal(assetsDir('C:\\Users\\alex\\AppData\\Local\\Programs\\orca\\Orca.exe', 'win32'), 'C:\\Users\\alex\\AppData\\Local\\Programs\\orca\\resources\\app.asar.unpacked\\out\\renderer\\assets')
  assert.equal(assetsDir('/Applications/Orca.app/Contents/MacOS/Orca', 'darwin'), '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/renderer/assets')
  assert.equal(assetsDir('/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper', 'darwin'), '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/renderer/assets')
  assert.equal(assetsDir('/opt/Orca/orca', 'linux'), ASSETS)
  assert.equal(assetsDir('orca', 'linux'), null, 'a relative path is never used')
  assert.equal(assetsDir('Orca.exe', 'win32'), null)
  assert.equal(assetsDir('/usr/bin/node', 'darwin'), null, 'not inside an app: no folder')
  assert.equal(botsDir('C:\\Users\\alex', 'win32'), 'C:\\Users\\alex\\.orca\\bots')
  assert.equal(botsDir('', 'linux'), null)
})

test('R9: the avatar field: mascot id, upload, or nothing', () => {
  assert.deepEqual(avatarOf('mascot:H1'), { kind: 'mascot', id: 'H1' })
  assert.deepEqual(avatarOf(' upload:abc-123 '), { kind: 'upload' })
  assert.equal(avatarOf('mascot:../../x'), null)
  assert.equal(avatarOf('🐙'), null)
  assert.equal(avatarOf(42), null)
})

test('R9: mascot files: the id and hash shape only, SVG before WebP, never a -cut or -rim variant', () => {
  const names = ['A1-cut-CvGk81fy.webp', 'A1-DvApH1kv.webp', 'A1-C49URgBU.svg', 'A10-xxxxxxxx.svg', 'B1-DVAXFugz.svg', 'A1-rim-AAAAAAA.webp', 'A1-..%2f.svg', 'App-CTRL5owY.js']
  assert.deepEqual(mascotFiles(names, 'A1'), ['A1-C49URgBU.svg', 'A1-DvApH1kv.webp'])
  assert.deepEqual(mascotFiles(names, 'Z9'), [])
})

test('R9: SVG safety check: Orca-shaped mascots pass; script, handlers, outside links and entities fail', () => {
  assert.ok(isSafeSvg(MASCOT_SVG))
  assert.ok(isSafeSvg(`<?xml version="1.0"?>\n<!-- made by hand -->\n${MASCOT_SVG}`))
  const bad = [
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"></svg>',
    '<svg><rect onclick = "x"/></svg>',
    '<svg><foreignObject><div/></foreignObject></svg>',
    '<svg><image href="https://example.com/a.png"/></svg>',
    '<svg><use xlink:href="other.svg#a"/></svg>',
    '<svg><a href="javascript:alert(1)"><rect/></a></svg>',
    '<svg><rect fill="url(https://example.com/x)"/></svg>',
    '<svg><style>@import "https://example.com/x.css";</style></svg>',
    '<svg><image href="data:image/png;base64,AAAA"/></svg>',
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>',
    '<html><svg/></html>',
    'not an svg'
  ]
  for (const s of bad) assert.equal(isSafeSvg(s), false, s)
})

test('R9: an uploaded avatar comes first; a mascot bot gets the mascot from the install; nothing found gives null', async () => {
  const disk = fakeDisk({
    [`${BOTS}/atlas/bot.json`]: bot('bot-a', 'Atlas', 'upload:k1'),
    [`${BOTS}/atlas/avatar.png`]: { bytes: PNG },
    [`${BOTS}/beacon/bot.json`]: bot('bot-b', 'Beacon', 'mascot:A1'),
    [`${BOTS}/beacon/avatar.png`]: { bytes: PNG },
    [`${BOTS}/comet/bot.json`]: bot('bot-c', 'Comet', 'mascot:B1'),
    [`${BOTS}/dune/bot.json`]: bot('bot-d', 'Dune', 'mascot:Z9'),
    [`${BOTS}/ember/bot.json`]: bot('bot-e', 'Ember'),
    [`${ASSETS}/A1-C49URgBU.svg`]: { bytes: enc(MASCOT_SVG) },
    [`${ASSETS}/B1-DVAXFugz.svg`]: { bytes: enc('<svg onload="x"/>') },
    [`${ASSETS}/B1-yyzHHcRb.webp`]: { bytes: WEBP }
  })
  const p = await readPictures(disk)
  assert.equal(p['bot-a']?.from, 'upload')
  assert.match(p['bot-a']!.url, /^data:image\/png;base64,/)
  assert.equal(p['bot-b']?.from, 'mascot', 'set to a mascot: the mascot, as Orca shows it')
  assert.match(p['bot-b']!.url, /^data:image\/svg\+xml;base64,/)
  assert.match(p['bot-c']!.url, /^data:image\/webp;base64,/, 'an unsafe SVG is skipped; its WebP is used')
  assert.equal(p['bot-d'], null, 'no such mascot: the initial')
  assert.equal(p['bot-e'], null, 'no avatar and no upload: the initial')
  assert.equal(p['name:Atlas']?.from, 'upload', 'also by name')
  for (const v of Object.values(p)) if (v) assert.match(v.url, PICTURE_URL)
  // The mascot folder is listed once, each mascot file read once.
  assert.equal(disk.reads.filter((r) => r.startsWith(ASSETS)).length, 3)
})

test('R9 AC: a missing bots folder or Orca install falls back with no error', async () => {
  assert.deepEqual(await readPictures(fakeDisk({})), {})
  const noInstall = fakeDisk({ [`${BOTS}/atlas/bot.json`]: bot('bot-a', 'Atlas', 'mascot:A1') }, { execPath: 'orca' })
  assert.deepEqual(await readPictures(noInstall), { 'bot-a': null, 'name:Atlas': null })
  const emptyInstall = fakeDisk({ [`${BOTS}/atlas/bot.json`]: bot('bot-a', 'Atlas', 'mascot:A1') })
  assert.deepEqual(await readPictures(emptyInstall), { 'bot-a': null, 'name:Atlas': null })
})

test('R9: only real, small, plain files: no link, nothing over 128 KB, a PNG that is a PNG, bad bot.json skipped', async () => {
  const big = new Uint8Array(MAX_PICTURE + 1)
  big.set(PNG)
  const disk = fakeDisk({
    [`${BOTS}/a/bot.json`]: bot('bot-a', 'A', 'upload:1'),
    [`${BOTS}/a/avatar.png`]: { bytes: PNG, link: true },
    [`${BOTS}/b/bot.json`]: bot('bot-b', 'B', 'upload:1'),
    [`${BOTS}/b/avatar.png`]: { bytes: big },
    [`${BOTS}/c/bot.json`]: bot('bot-c', 'C', 'upload:1'),
    [`${BOTS}/c/avatar.png`]: { bytes: enc('<svg onload="x"/>') },
    [`${BOTS}/d/bot.json`]: { bytes: enc('{not json') },
    [`${BOTS}/e/bot.json`]: { bytes: enc('null') }
  })
  const p = await readPictures(disk)
  assert.deepEqual(p, { 'bot-a': null, 'name:A': null, 'bot-b': null, 'name:B': null, 'bot-c': null, 'name:C': null })
  assert.ok(!disk.reads.includes(`${BOTS}/a/avatar.png`), 'a link is never read')
  assert.ok(!disk.reads.includes(`${BOTS}/b/avatar.png`), 'an oversized file is never read')
})

test('R9: Windows paths are joined with backslashes', async () => {
  const W = 'C:\\Users\\alex'
  const A = 'C:\\Programs\\orca\\resources\\app.asar.unpacked\\out\\renderer\\assets'
  const disk = fakeDisk({}, { platform: 'win32', homedir: W, execPath: 'C:\\Programs\\orca\\Orca.exe' })
  const files: Record<string, Entry> = {
    [`${W}\\.orca\\bots\\atlas\\bot.json`]: bot('bot-a', 'Atlas', 'mascot:A1'),
    [`${A}\\A1-C49URgBU.svg`]: { bytes: enc(MASCOT_SVG) }
  }
  const win: PictureDeps = {
    ...disk,
    async readdir(path) {
      const pre = `${path}\\`
      const names = Object.keys(files).filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length).split('\\')[0])
      if (!names.length) throw new Error('ENOENT')
      return [...new Set(names)]
    },
    async stat(path) {
      const f = files[path]
      if (!f || f === 'dir') throw new Error('ENOENT')
      return { isFile: true, size: f.bytes.length, mtimeMs: 1 }
    },
    async readFile(path) {
      const f = files[path]
      if (!f || f === 'dir') throw new Error('ENOENT')
      return f.bytes
    }
  }
  const p = await readPictures(win)
  assert.equal(p['bot-a']?.from, 'mascot')
})

// ---------- PR #12 review: answer size, cache by mtime, log lines ----------

test('review #1: 9 bots and one 1 MB upload: that bot shows its initial with one log line; the others keep their pictures', async () => {
  const huge = new Uint8Array(1024 * 1024)
  huge.set(PNG)
  const files: Record<string, Entry> = { [`${ASSETS}/A1-C49URgBU.svg`]: { bytes: enc(MASCOT_SVG) } }
  for (let i = 0; i < 9; i++) {
    files[`${BOTS}/b${i}/bot.json`] = bot(`bot-${i}`, `Bot ${i}`, i === 4 ? 'upload:big' : i % 2 ? 'upload:k' : 'mascot:A1')
    if (i % 2 || i === 4) files[`${BOTS}/b${i}/avatar.png`] = { bytes: i === 4 ? huge : PNG }
  }
  const lines: string[] = []
  const disk = fakeDisk(files)
  const store = createPictureStore(disk, (l) => lines.push(l))
  const sigs = await store.scan()
  assert.equal(sigs['bot-4'], null, 'over 128 KB: no picture')
  assert.ok(!disk.reads.includes(`${BOTS}/b4/avatar.png`), 'an oversized file is never read')
  assert.deepEqual(lines, ['bot picture skipped: avatar.png of bot "Bot 4" is 1024 KB, over 128 KB; the initial shows'])
  for (const i of [0, 1, 2, 3, 5, 6, 7, 8]) {
    const e = store.get(`bot-${i}`)
    assert.ok(e, `bot-${i} keeps its picture`)
    assert.equal(sigs[`bot-${i}`], e.sig)
  }
  await store.scan()
  assert.equal(lines.length, 1, 'the same file is logged once')
})

test('review #1: the largest picture allowed fits one answer far below 256 KiB', async () => {
  const max = new Uint8Array(MAX_PICTURE)
  max.set(PNG)
  const store = createPictureStore(fakeDisk({ [`${BOTS}/a/bot.json`]: bot('bot-a', 'A', 'upload:1'), [`${BOTS}/a/avatar.png`]: { bytes: max } }))
  await store.scan()
  const e = store.get('bot-a')!
  const answer = JSON.stringify({ key: 'bot-a', sig: e.sig, picture: e.picture })
  assert.ok(answer.length < 200 * 1024, `${answer.length} bytes`)
})

test('review #5: a second scan reads no file whose size and mtime did not change; a changed one is read again with a new signature', async () => {
  const files: Record<string, Entry> = {
    [`${BOTS}/a/bot.json`]: bot('bot-a', 'A', 'upload:1'),
    [`${BOTS}/a/avatar.png`]: { bytes: PNG },
    [`${BOTS}/b/bot.json`]: bot('bot-b', 'B', 'mascot:A1'),
    [`${ASSETS}/A1-C49URgBU.svg`]: { bytes: enc(MASCOT_SVG) }
  }
  const disk = fakeDisk(files)
  const store = createPictureStore(disk)
  const first = await store.scan()
  const reads = disk.reads.length
  assert.deepEqual(await store.scan(), first)
  assert.equal(disk.reads.length, reads, 'nothing read again')
  files[`${BOTS}/a/avatar.png`] = { bytes: PNG, mtime: 2 }
  const third = await store.scan()
  assert.deepEqual(disk.reads.slice(reads), [`${BOTS}/a/avatar.png`], 'only the changed file')
  assert.notEqual(third['bot-a'], first['bot-a'])
  assert.equal(third['bot-b'], first['bot-b'])
})

test('review #4: a refused mascot is logged once, by file name; the bot shows its initial', async () => {
  const lines: string[] = []
  const store = createPictureStore(fakeDisk({ [`${BOTS}/a/bot.json`]: bot('bot-a', 'A', 'mascot:A1'), [`${ASSETS}/A1-C49URgBU.svg`]: { bytes: enc('<svg><image href="data:image/png;base64,AAAA"/></svg>') } }), (l) => lines.push(l))
  assert.equal((await store.scan())['bot-a'], null)
  await store.scan()
  assert.deepEqual(lines, ['bot picture refused: Orca mascot A1-C49URgBU.svg is not a safe image of its type; the initial shows'])
})
