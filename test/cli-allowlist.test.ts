// R3 proof: no command outside the 12 and no free-text argument can reach execFile.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import { ALLOWED_COMMAND_NAMES, ALLOWED_COMMANDS, buildArgv, MAX_LIMIT, RUN_ID_PATTERN, TASK_ID_PATTERN, UUID_PATTERN, type CliRequest } from '../src/cli/commands.ts'
import { createCliRunner } from '../src/cli/run.ts'
import { fakeExec, foundAt } from './helpers.ts'

/** The PRD's list (R3), word for word. */
const PRD_COMMANDS = [
  'bot list', 'bot item list', 'bot work list', 'bot chats', 'worktree ps', 'automations list',
  'orchestration inbox', 'orchestration run-list', 'orchestration run-show', 'orchestration task-list',
  'orchestration worker-list', 'orchestration gate-list'
]

const BOT = 'd9ec3578-8f3a-4251-aa26-32620fccac8a'
const RUN = 'run_e9ab7779805a'
const TASK = 'task_10c86e44be27'

const VALID: CliRequest[] = [
  { command: 'bot list' },
  { command: 'bot item list', bot: BOT },
  { command: 'bot item list', bot: BOT, all: true },
  { command: 'bot work list', bot: BOT },
  { command: 'bot chats', bot: BOT },
  { command: 'worktree ps' },
  { command: 'worktree ps', limit: 50, agentWait: true },
  { command: 'automations list' },
  { command: 'orchestration inbox' },
  { command: 'orchestration inbox', run: 'run_unbound', limit: 20 },
  { command: 'orchestration run-list' },
  { command: 'orchestration run-show', run: RUN },
  { command: 'orchestration task-list', run: RUN },
  { command: 'orchestration worker-list', run: RUN },
  { command: 'orchestration gate-list', run: RUN },
  { command: 'orchestration gate-list', run: RUN, task: TASK }
]

const polluted = JSON.parse('{"command":"bot list","__proto__":{"x":1}}')
class Fancy { command = 'bot list' }

const INVALID: unknown[] = [
  null, undefined, 'bot list', ['bot', 'list'], 42, new Fancy(), polluted,
  {}, { command: '' }, { command: 'bot' }, { command: 'BOT LIST' }, { command: 'bot list ' },
  // write and send commands
  { command: 'bot item set' }, { command: 'bot item done' }, { command: 'bot item ask' }, { command: 'orchestration send' },
  { command: 'orchestration gate-resolve' }, { command: 'orchestration gate-create' }, { command: 'terminal send' },
  { command: 'orchestration worker-start' }, { command: 'automations create' }, { command: 'plugin install' },
  { command: 'toString' }, { command: 'constructor' }, { command: '__proto__' },
  // missing or bad ids
  { command: 'bot item list' }, { command: 'bot item list', bot: 'Chief' }, { command: 'bot item list', bot: `${BOT} --all` },
  { command: 'bot item list', bot: `--bot=${BOT}` }, { command: 'bot chats', bot: BOT.toUpperCase() + 'x' },
  { command: 'orchestration run-show' }, { command: 'orchestration run-show', run: 'run_x; rm -rf /' },
  { command: 'orchestration run-show', run: 'RUN_ABC' }, { command: 'orchestration run-show', run: 'run_' },
  { command: 'orchestration task-list', run: `${RUN}\n--full` }, { command: 'orchestration task-list', run: 42 },
  { command: 'orchestration gate-list', run: RUN, task: 'task_x y' }, { command: 'orchestration gate-list', run: RUN, task: RUN },
  { command: 'orchestration worker-list', run: ['run_a'] },
  // flags and numbers
  { command: 'bot item list', bot: BOT, all: 'yes' }, { command: 'worktree ps', limit: 0 }, { command: 'worktree ps', limit: MAX_LIMIT + 1 },
  { command: 'worktree ps', limit: 1.5 }, { command: 'worktree ps', limit: '10' }, { command: 'worktree ps', limit: NaN },
  { command: 'worktree ps', agentWait: 1 },
  // fields that are not on the list
  { command: 'bot list', json: false }, { command: 'bot list', args: ['--help'] }, { command: 'bot list', extra: '--pairing-code x' },
  { command: 'worktree ps', since: '7d' }, { command: 'orchestration inbox', terminal: 'term_x' }, { command: 'bot chats', bot: BOT, all: true }
]

test('the allow-list is exactly the 12 PRD commands', () => {
  assert.deepEqual([...ALLOWED_COMMAND_NAMES].sort(), [...PRD_COMMANDS].sort())
  for (const name of PRD_COMMANDS) assert.equal(ALLOWED_COMMANDS[name as keyof typeof ALLOWED_COMMANDS].argv.join(' '), name)
})

test('nothing invalid reaches execFile', async () => {
  const { exec, calls } = fakeExec()
  const cli = createCliRunner({ exec, resolve: foundAt('/opt/Orca/resources/bin/orca'), env: () => ({}) })
  for (const bad of INVALID) {
    assert.throws(() => buildArgv(bad), (e: Error) => e.name === 'CliRequestError', `buildArgv must refuse ${JSON.stringify(bad)}`)
    const r = await cli.run(bad as CliRequest)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.error.kind, 'refused', JSON.stringify(bad))
  }
  assert.equal(calls.length, 0)
})

test('every valid request reaches execFile as allow-list argv + checked ids + --json, with fixed options', async () => {
  const { exec, calls } = fakeExec()
  const cli = createCliRunner({ exec, resolve: foundAt('/opt/Orca/resources/bin/orca'), env: () => ({ HOME: '/home/alex' }) })
  for (const req of VALID) await cli.run(req)
  assert.equal(calls.length, VALID.length)
  const FIXED_FLAGS = new Set(['--bot', '--all', '--limit', '--agent-wait', '--run', '--id', '--task', '--json'])
  calls.forEach((call, i) => {
    const spec = ALLOWED_COMMANDS[VALID[i].command]
    assert.equal(call.file, '/opt/Orca/resources/bin/orca')
    assert.deepEqual(call.args.slice(0, spec.argv.length), [...spec.argv])
    assert.equal(call.args.at(-1), '--json')
    for (const a of call.args.slice(spec.argv.length)) {
      const ok = FIXED_FLAGS.has(a) || UUID_PATTERN.test(a) || RUN_ID_PATTERN.test(a) || TASK_ID_PATTERN.test(a) || /^[1-9][0-9]{0,2}$/.test(a)
      assert.ok(ok, `argument ${JSON.stringify(a)} is not a fixed flag or a checked id`)
    }
    assert.equal(call.options.timeout, 10_000)
    assert.equal(call.options.maxBuffer, 16 * 1024 * 1024)
    assert.equal(call.options.windowsHide, true)
    assert.deepEqual(call.options.env, { HOME: '/home/alex' })
  })
})

test('only src/cli/index.ts touches child_process', () => {
  const root = new URL('../src/', import.meta.url)
  const files: string[] = []
  const walk = (dir: URL): void => {
    for (const name of readdirSync(dir)) {
      const u = new URL(name, dir)
      if (statSync(u).isDirectory()) walk(new URL(name + '/', dir))
      else if (/\.(m?[jt]sx?)$/.test(name)) files.push(u.pathname)
    }
  }
  walk(root)
  const users = files.filter((f) => /['"](node:)?child_process['"]|\bexecFile\s*\(|\bspawn(Sync)?\s*\(|\bexecSync\s*\(|\bfork\s*\(/.test(readFileSync(new URL('file://' + f), 'utf8')))
  assert.deepEqual(users.map((f) => f.slice(f.indexOf('/src/'))), ['/src/cli/index.ts'])
})
