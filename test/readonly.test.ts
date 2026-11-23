// R8: read only. A grep over every source file fails the build on a write: a CLI command off the
// read allow-list, a terminal write or send, or a host call that is not read, open or focus.
// The manifest asks for the PRD's six capabilities and nothing else.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import { ALLOWED_COMMAND_NAMES, ALLOWED_COMMANDS } from '../src/cli/commands.ts'

const ROOT = new URL('../', import.meta.url)

/** Every .ts/.tsx file under `dir` (a path from the repo root), as [path, text]. */
function sources(dir: string): [string, string][] {
  const out: [string, string][] = []
  const walk = (rel: string): void => {
    for (const name of readdirSync(new URL(rel, ROOT))) {
      const path = `${rel}/${name}`
      if (statSync(new URL(path, ROOT)).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(name)) out.push([path, readFileSync(new URL(path, ROOT), 'utf8')])
    }
  }
  walk(dir)
  return out
}

/** Host methods the plugin may call: reads, open and focus, its own notifications and status bar. */
export const READ_ONLY_HOST_CALLS = new Set(['workspace.list', 'agents.list', 'workspace.open', 'terminal.focus', 'notifications.show', 'statusBar.update'])

/** Words that make a CLI command write. None of them may appear in an allowed command. */
const WRITE_VERBS = [
  'add', 'abandon', 'approve', 'ask', 'cancel', 'close', 'create', 'delete', 'disable', 'edit', 'enable', 'install', 'kill',
  'merge', 'move', 'open', 'remove', 'rename', 'reply', 'reset', 'resolve', 'restart', 'rm', 'send', 'set', 'start',
  'stop', 'uninstall', 'update', 'write'
]

/**
 * What in one source text breaks R8. Comments count too: a write named anywhere is worth a look.
 * Kept separate from the file walk so the last test can prove it catches each kind.
 */
export function findWrites(text: string): string[] {
  const found: string[] = []
  // Terminal writes, by any name the host or a hook gives them.
  for (const m of text.matchAll(/terminal\.(write|send|sendText|sendKeys|paste|input|create|close|kill)\b/g)) found.push(m[0])
  // Every host call names its method as a literal, and that method is on the read-only list.
  for (const m of text.matchAll(/host\.call\(\s*([^,)]*)/g)) {
    const lit = /^['"`]([\w.]+)['"`]$/.exec(m[1].trim())
    if (!lit) found.push(`host.call with a computed method: ${m[1].trim().slice(0, 40)}`)
    else if (!READ_ONLY_HOST_CALLS.has(lit[1])) found.push(`host.call('${lit[1]}')`)
  }
  // A CLI command spelled as a string: only the 12 read commands.
  for (const m of text.matchAll(/['"`]((?:bot|orchestration|worktree|automations|terminal|repo)(?: [a-z][\w-]*)+)['"`]/g)) {
    if (!(ALLOWED_COMMAND_NAMES as readonly string[]).includes(m[1])) found.push(`CLI command '${m[1]}'`)
  }
  // Settings written by code: the user owns them.
  if (/settings\.set\b/.test(text)) found.push('settings.set')
  return found
}

test('R8 AC: no source file has a write command, a terminal write or send, or a write host call', () => {
  const files = sources('src')
  assert.ok(files.length > 20, `expected the whole src tree, got ${files.length} files`)
  const bad = files.flatMap(([path, text]) => findWrites(text).map((w) => `${path}: ${w}`))
  assert.deepEqual(bad, [])
})

test('R8: every CLI command on the allow-list reads; none has a write verb', () => {
  assert.equal(ALLOWED_COMMAND_NAMES.length, 12)
  for (const name of ALLOWED_COMMAND_NAMES) {
    const words = ALLOWED_COMMANDS[name].argv.flatMap((w) => w.split('-'))
    const verbs = words.filter((w) => WRITE_VERBS.includes(w))
    assert.deepEqual(verbs, [], `${name} has a write verb`)
    for (const field of Object.values(ALLOWED_COMMANDS[name].fields)) assert.ok(!WRITE_VERBS.includes(field.flag.replace(/^--/, '')), `${name} ${field.flag}`)
  }
})

test('R8: the manifest asks for the six PRD capabilities, no hooks, and only the agent event', () => {
  const m = JSON.parse(readFileSync(new URL('orca-plugin.json', ROOT), 'utf8')) as {
    capabilities: { kind: string }[]
    contributes: Record<string, unknown> & { events?: { on: string }[] }
  }
  assert.deepEqual(m.capabilities.map((c) => c.kind).sort(), ['agent:read', 'notifications:show', 'settings:own', 'storage:own', 'workspace:read', 'workspace:write'])
  assert.equal(m.contributes.hooks, undefined)
  assert.deepEqual((m.contributes.events ?? []).map((e) => e.on), ['agent.status.changed'])
})

test('no network: no fetch, socket or http module anywhere in src', () => {
  const bad = sources('src').filter(([, t]) => /\bfetch\(|XMLHttpRequest|WebSocket|['"]node:(https?|net|tls|dgram)['"]/.test(t)).map(([p]) => p)
  assert.deepEqual(bad, [])
})

test('the grep catches each kind of write (so a pass means something)', () => {
  const planted: [string, string][] = [
    ["orca.host.call('terminal.sendText', { terminalId, text })", 'terminal.sendText'],
    ['await terminal.write(id, "y")', 'terminal.write'],
    ["orca.hooks.on('terminal.send', f)", 'terminal.send'],
    ["orca.host.call('workspace.rename', { workspaceId, name })", "host.call('workspace.rename')"],
    ["orca.host.call('automation.delete', { id })", "host.call('automation.delete')"],
    ['orca.host.call(method, params)', 'host.call with a computed method: method'],
    ["cli.run({ command: 'orchestration send' })", "CLI command 'orchestration send'"],
    ["const c = 'bot item set'", "CLI command 'bot item set'"],
    ["orca.host.call('settings.set', { key, value })", 'settings.set']
  ]
  for (const [src, expect] of planted) assert.ok(findWrites(src).includes(expect), `missed: ${src} -> ${JSON.stringify(findWrites(src))}`)
  assert.deepEqual(findWrites("orca.host.call('terminal.focus', { terminalId }); cli.run({ command: 'orchestration gate-list', run })"), [])
})
