// R1 + R2 on the env fixtures: the resolver picks a working path on each OS (target 3 of 3),
// and the env the CLI gets is fixed the way the PRD says.
import { assert, test } from 'orca/testing'
import { buildCliEnv } from '../src/cli/env.ts'
import { cliCandidates, resolveCli } from '../src/cli/resolve.ts'
import { fixture } from './helpers.ts'

type EnvFixture = {
  platform: string
  execPath: string
  cwd: string
  homedir: string
  env: Record<string, string>
  files: string[]
  expect: { cliPath: string; source: string; envAdded: Record<string, string>; envRemoved: string[] }
}

const OS = ['windows', 'macos', 'linux'] as const

for (const os of OS) {
  test(`${os}: resolver finds the CLI with no setting`, () => {
    const f = fixture<EnvFixture>(`env/${os}.json`)
    const files = new Set(f.files)
    const r = resolveCli({ platform: f.platform, execPath: f.execPath, env: f.env, homedir: f.homedir, setting: null, isFile: (p) => files.has(p) })
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.path, f.expect.cliPath)
      assert.equal(r.source, f.expect.source)
    }
  })

  test(`${os}: every candidate is absolute, none is in Orca's cwd, none is bare`, () => {
    const f = fixture<EnvFixture>(`env/${os}.json`)
    const list = cliCandidates({ platform: f.platform, execPath: f.execPath, env: f.env, homedir: f.homedir, setting: 'orca', isFile: () => false })
    assert.ok(list.length > 0)
    for (const c of list) {
      assert.ok(f.platform === 'win32' ? /^[A-Za-z]:\\/.test(c.path) : c.path.startsWith('/'), c.path)
      assert.notEqual(c.path.toLowerCase(), (f.cwd + (f.platform === 'win32' ? '\\orca.exe' : '/orca')).toLowerCase())
      assert.notEqual(c.source, 'setting', 'a bare setting value is ignored')
    }
  })

  test(`${os}: clean env`, () => {
    const f = fixture<EnvFixture>(`env/${os}.json`)
    const before = JSON.stringify(f.env)
    const env = buildCliEnv({ platform: f.platform, env: f.env, homedir: f.homedir })
    assert.equal(JSON.stringify(f.env), before, 'input not changed')
    for (const k of f.expect.envRemoved) assert.equal(k in env, false, `${k} removed`)
    for (const [k, v] of Object.entries(f.expect.envAdded)) assert.equal(env[k], v)
    for (const [k, v] of Object.entries(f.env)) if (!f.expect.envRemoved.includes(k)) assert.equal(env[k], v, `${k} kept`)
  })
}

test('windows: existing APPDATA (any case) is kept', () => {
  const env = buildCliEnv({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\alex', AppData: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local' }, homedir: 'C:\\Users\\alex' })
  assert.equal(env.AppData, 'D:\\Roaming')
  assert.equal(env.APPDATA, undefined)
  assert.equal(env.LOCALAPPDATA, 'D:\\Local')
})

test('windows: no USERPROFILE falls back to homedir', () => {
  const env = buildCliEnv({ platform: 'win32', env: {}, homedir: 'C:\\Users\\sam' })
  assert.equal(env.APPDATA, 'C:\\Users\\sam\\AppData\\Roaming')
  assert.equal(env.LOCALAPPDATA, 'C:\\Users\\sam\\AppData\\Local')
})

test('linux: HOME added when missing', () => {
  assert.equal(buildCliEnv({ platform: 'linux', env: { PATH: '/usr/bin' }, homedir: '/home/sam' }).HOME, '/home/sam')
})

test('order: setting, app, OS default, PATH', () => {
  const f = fixture<EnvFixture>('env/windows.json')
  const host = { platform: 'win32', execPath: 'D:\\Apps\\Orca\\Orca.exe', env: { ...f.env, PATH: 'C:\\tools;.\\bin' }, homedir: f.homedir, setting: 'E:\\custom\\orca.exe', isFile: () => true }
  const list = cliCandidates(host)
  assert.deepEqual(list.map((c) => c.source), ['setting', 'app', 'os-default', 'path'])
  assert.equal(list[0].path, 'E:\\custom\\orca.exe')
  assert.equal(list[1].path, 'D:\\Apps\\Orca\\resources\\bin\\orca.exe')
  assert.equal(list[2].path, 'C:\\Users\\alex\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe')
  assert.equal(list[3].path, 'C:\\tools\\orca.exe', 'relative PATH entry .\\bin skipped')
  assert.equal(resolveCli(host).ok && resolveCli(host).source, 'setting')
})

test('not found: lists every path tried', () => {
  const f = fixture<EnvFixture>('env/linux.json')
  const r = resolveCli({ platform: f.platform, execPath: f.execPath, env: f.env, homedir: f.homedir, isFile: () => false })
  assert.equal(r.ok, false)
  assert.ok(r.tried.some((c) => c.path === '/opt/Orca/resources/bin/orca'))
  assert.ok(r.tried.some((c) => c.path === '/usr/bin/orca' && c.source === 'path'))
})

test('macOS: falls back to ~/Applications when Orca is not in /Applications', () => {
  const f = fixture<EnvFixture>('env/macos.json')
  const home = '/Users/alex/Applications/Orca.app/Contents/Resources/bin/orca'
  const r = resolveCli({ platform: 'darwin', execPath: '/somewhere/else/Orca', env: f.env, homedir: f.homedir, isFile: (p) => p === home })
  assert.equal(r.ok && r.path, home)
  assert.equal(r.ok && r.source, 'os-default')
})
