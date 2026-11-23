// The runner: failure kinds, re-resolve on failure, one call of each kind in flight.
import { assert, test } from 'orca/testing'
import { createCliRunner } from '../src/cli/run.ts'
import type { Resolution } from '../src/cli/resolve.ts'
import { fakeExec, fixture, fixtureText, foundAt } from './helpers.ts'

const PATH = '/opt/Orca/resources/bin/orca'
const runner = (answer: Parameters<typeof fakeExec>[0], resolve: () => Resolution = foundAt(PATH)) => {
  const f = fakeExec(answer)
  return { ...f, cli: createCliRunner({ exec: f.exec, resolve, env: () => ({}) }) }
}

test('ok: returns the envelope result and the path used', async () => {
  const { cli } = runner(() => ({ stdout: fixtureText('cli/bot-list.json') }))
  const r = await cli.run({ command: 'bot list' })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal((r.result as { bots: unknown[] }).bots.length, 9)
  assert.equal(r.cliPath, PATH)
  assert.deepEqual(cli.current(), { path: PATH, source: 'app' })
})

test('cli_error: runtime_unavailable is quoted as one line', async () => {
  const { cli } = runner(() => ({ error: Object.assign(new Error('Command failed'), { code: 1 }), stdout: fixtureText('cases/runtime-unavailable.json') }))
  const r = await cli.run({ command: 'bot list' })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.error.kind, 'cli_error')
    assert.equal(r.error.code, 'runtime_unavailable')
    assert.equal(r.error.message, 'APPDATA is not set, so the Orca runtime metadata path cannot be resolved.')
  }
})

test('malformed: non-JSON output, then the path is resolved again', async () => {
  let resolves = 0
  const { cli } = runner(() => ({ error: Object.assign(new Error('Command failed'), { code: 1 }), stdout: '', stderr: fixtureText('cases/malformed.txt') }), () => {
    resolves++
    return foundAt(PATH)()
  })
  const r = await cli.run({ command: 'bot list' })
  assert.equal(!r.ok && r.error.kind, 'malformed')
  if (!r.ok) assert.ok(r.error.message.includes('cjs/loader'), r.error.message)
  await cli.run({ command: 'bot list' })
  assert.equal(resolves, 2)
})

test('malformed: truncated JSON on stdout', async () => {
  const { cli } = runner(() => ({ stdout: '{"ok": tru' }))
  const r = await cli.run({ command: 'bot list' })
  assert.equal(!r.ok && r.error.kind, 'malformed')
})

test('timeout: killed after 10 s; the path is kept', async () => {
  const t = fixture<{ error: object; stdout: string; stderr: string }>('cases/timeout.json')
  let resolves = 0
  const { cli } = runner(() => ({ error: Object.assign(new Error('x'), t.error), stdout: t.stdout, stderr: t.stderr }), () => {
    resolves++
    return foundAt(PATH)()
  })
  const r = await cli.run({ command: 'worktree ps' })
  assert.equal(!r.ok && r.error.kind, 'timeout')
  await cli.run({ command: 'worktree ps' })
  assert.equal(resolves, 1)
})

test('spawn failure (path moved): re-resolves and uses the new path', async () => {
  const paths = ['/old/orca', '/new/orca']
  let n = 0
  const { cli, calls } = runner(
    (call) => (call.file === '/old/orca' ? { error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) } : { stdout: '{"ok":true,"result":{"bots":[]}}' }),
    () => foundAt(paths[Math.min(n++, 1)])()
  )
  const first = await cli.run({ command: 'bot list' })
  assert.equal(!first.ok && first.error.kind, 'spawn')
  const second = await cli.run({ command: 'bot list' })
  assert.equal(second.ok, true)
  assert.deepEqual(calls.map((c) => c.file), ['/old/orca', '/new/orca'])
})

test('not found: no exec, tried paths returned, retried next call', async () => {
  const tried = [{ path: '/opt/Orca/resources/bin/orca', source: 'os-default' as const }]
  let resolves = 0
  const { cli, calls } = runner(undefined, () => {
    resolves++
    return { ok: false, tried }
  })
  const r = await cli.run({ command: 'bot list' })
  assert.equal(!r.ok && r.error.kind, 'not_found')
  if (!r.ok) assert.deepEqual(r.error.tried, tried)
  await cli.run({ command: 'bot list' })
  assert.equal(resolves, 2)
  assert.equal(calls.length, 0)
})

test('too large: more than 16 MB', async () => {
  const { cli } = runner(() => ({ error: Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) }))
  const r = await cli.run({ command: 'worktree ps' })
  assert.equal(!r.ok && r.error.kind, 'too_large')
})

test('one call of each kind in flight', async () => {
  const { cli, calls } = runner(() => ({ stdout: '{"ok":true,"result":{}}' }))
  const a = cli.run({ command: 'bot list' })
  const b = cli.run({ command: 'bot list' })
  const c = cli.run({ command: 'automations list' })
  assert.equal(a, b)
  await Promise.all([a, b, c])
  assert.equal(calls.length, 2)
  await cli.run({ command: 'bot list' })
  assert.equal(calls.length, 3)
})

test('exec that throws synchronously is a spawn failure, not a crash', async () => {
  const cli = createCliRunner({ exec: () => { throw new Error('boom') }, resolve: foundAt(PATH), env: () => ({}) })
  const r = await cli.run({ command: 'bot list' })
  assert.equal(!r.ok && r.error.kind, 'spawn')
})
