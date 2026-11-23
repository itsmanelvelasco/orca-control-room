// R4, R5, R9: the waits list on the fixture test set, the merge rules, click targets, untrusted
// text, and the refresh rules (one call of a kind at a time, backoff, events).
import { assert, test } from 'orca/testing'
import type { CliRequest } from '../src/cli/commands.ts'
import type { CliResult } from '../src/cli/run.ts'
import { parseWorktreePs, agentFromEvent, type AgentStatusEvent } from '../src/model/index.ts'
import { collectWaits, TRUST_LABEL } from '../src/views/waits/collect.ts'
import { createWaitsRefresher } from '../src/views/waits/refresh.ts'
import { clean, cleanOptions, MAX } from '../src/views/waits/text.ts'
import { fixture } from './helpers.ts'
import { cliKey, fixtureRun, fixtureSnapshot, WAITS_CASE } from './waits-fixture.ts'

// ---------- PRD 6: 100% recall and precision on the test set ----------

test('waits test set: 100% recall and 100% precision', async () => {
  const snap = await fixtureSnapshot()
  const got = snap.waits.map((w) => w.key)
  const want = Object.keys(WAITS_CASE.expect.waits)
  const hit = got.filter((k) => want.includes(k))
  const recall = hit.length / want.length
  const precision = got.length ? hit.length / got.length : 0
  assert.equal(new Set(got).size, got.length, 'each wait shows once')
  assert.deepEqual({ recall, precision }, { recall: 1, precision: 1 }, `got ${JSON.stringify(got)}`)
  for (const w of snap.waits) {
    const e = WAITS_CASE.expect.waits[w.key]
    assert.equal(w.kind, e.kind, w.key)
    assert.equal(w.label, e.label, w.key)
    assert.deepEqual([...w.sources].sort(), [...e.sources].sort(), `${w.key} sources`)
  }
})

test('newest first; a row says who, on what, since when', async () => {
  const { waits } = await fixtureSnapshot()
  const since = waits.map((w) => w.since ?? -1)
  assert.deepEqual(since, [...since].sort((a, b) => b - a))
  for (const w of waits) {
    assert.ok(w.who.length > 0, `${w.key} who`)
    assert.ok(w.what.length > 0, `${w.key} what`)
    assert.equal(typeof w.since, 'number', `${w.key} since`)
  }
})

test('Needs you item: question and options, first line only, never HTML', async () => {
  const { waits } = await fixtureSnapshot()
  const w = waits.find((x) => x.key === 'item:6f3df7d1-33d6-44c6-8e9d-6ac0e3e756d2')
  assert.ok(w)
  assert.equal(w.who, 'Atlas')
  assert.equal(w.what, 'Ship <b>v2</b> today, or wait for the review?')
  assert.deepEqual(w.options, ['Ship today', 'Wait for review'])
  // An item with no question shows its title.
  assert.equal(waits.find((x) => x.key === 'item:ca28fa95-0015-4c88-9af8-d8e34dbaed59')?.what, 'Pick a name for the nightly job')
})

test('pending gates show with their options; a resolved gate does not', async () => {
  const { waits } = await fixtureSnapshot()
  const a = waits.find((x) => x.key === 'task:task_a1b2c3d4e5f6')
  assert.equal(a?.who, 'Slice 1: data model')
  assert.equal(a?.what, 'Gate A: which export format first, CSV or JSON?')
  assert.deepEqual(a?.options, ['CSV', 'JSON'])
  assert.equal(waits.filter((x) => x.kind === 'gate').length, 2)
})

// ---------- PRD 5: same wait from two sources shows once ----------

test('item + gate + worker agent for one decision: one row keyed by the task', async () => {
  const { waits } = await fixtureSnapshot()
  const rows = waits.filter((w) => w.what.startsWith('Gate A: which export format'))
  assert.equal(rows.length, 1)
  assert.deepEqual([...rows[0].sources].sort(), ['agent', 'gate', 'item'])
  // Since: the earliest the decision was seen waiting (the worker agent, 1795400150000).
  assert.equal(rows[0].since, 1795400150000)
})

test('one agent from worktree ps and agent.status.changed: one row', async () => {
  const { waits } = await fixtureSnapshot()
  assert.equal(waits.filter((w) => w.key.includes('7291498c')).length, 1)
})

// ---------- R5: folder trust ----------

test('R5 live record: Claude Code at the trust prompt shows as "trust this folder"', () => {
  const rec = fixture('cases/trust-blocked-agent.json')
  for (const ps of [rec.worktreePsAgentWait, rec.worktreePsPlain]) {
    const waits = collectWaits({ items: [], gates: [], tasks: [], workers: [], worktrees: parseWorktreePs(ps.result).worktrees, events: rec.agentStatusChanged.map((e: AgentStatusEvent) => agentFromEvent(e)) })
    assert.equal(waits.length, 1)
    assert.equal(waits[0].label, TRUST_LABEL)
    assert.equal(waits[0].what, 'Asks you to trust this folder')
    assert.deepEqual(waits[0].target, { kind: 'terminal', terminalId: 'term_7291498c-cd05-44be-a8fc-8de963d40e56' })
  }
})

test('Codex trust reason (codex-trust-workspace) also reads "trust this folder"', async () => {
  const { waits } = await fixtureSnapshot()
  assert.equal(waits.find((w) => w.key === 'agent:term_1f3594f4-849e-4742-a5be-8f473fa19f5b')?.label, TRUST_LABEL)
})

test('trust prompt answered: a newer working event drops the row', () => {
  const rec = fixture('cases/trust-blocked-agent.json')
  const worktrees = parseWorktreePs(rec.worktreePsAgentWait.result).worktrees
  const later = agentFromEvent({ ...rec.agentStatusChanged[1], state: 'working', receivedAt: 1795442860000, mainAgent: { state: 'working', stateStartedAt: 1795442860000 } })
  assert.deepEqual(collectWaits({ items: [], gates: [], tasks: [], workers: [], worktrees, events: [later] }), [])
})

// ---------- click targets ----------

test('each wait opens the right place', async () => {
  const { waits } = await fixtureSnapshot()
  const target = (k: string) => waits.find((w) => w.key === k)?.target
  // Bot question: the bot's home workspace (Orca has no API to open a bot chat).
  assert.deepEqual(target('item:6f3df7d1-33d6-44c6-8e9d-6ac0e3e756d2'), { kind: 'workspace', workspaceId: '90ea16a8-81c0-4382-a6b8-7a3f0ad9f019::/home/alex/bots/atlas' })
  // Gate with a live worker: its terminal.
  assert.deepEqual(target('task:task_a1b2c3d4e5f6'), { kind: 'terminal', terminalId: 'term_03d70d0b-6eff-4557-a980-036162fa9748' })
  // Gate whose worker is gone: the worker's workspace.
  assert.deepEqual(target('task:task_b2c3d4e5f6a1'), { kind: 'workspace', workspaceId: 'd8221cfc-f6be-402c-af08-b57a48bc7844::/home/alex/work/sample-app/slice-2' })
  // Agents: their terminal.
  assert.deepEqual(target('agent:term_5b1c0c84-8a43-4d39-9b6f-0c2b0f0d6a11'), { kind: 'terminal', terminalId: 'term_5b1c0c84-8a43-4d39-9b6f-0c2b0f0d6a11' })
})

// ---------- untrusted text ----------

test('clean: first line, no control or bidi characters, cut with an ellipsis', () => {
  assert.equal(clean('\n\n  hello\tworld \nsecond', 40), 'hello world')
  assert.equal(clean('a\u202eb\u0007c', 40), 'abc')
  assert.equal(clean('<script>alert(1)</script>', 100), '<script>alert(1)</script>')
  const long = clean('x'.repeat(500), MAX.what)
  assert.equal(Array.from(long).length, MAX.what)
  assert.ok(long.endsWith('…'))
  assert.equal(clean(null, 10), '')
  assert.deepEqual(cleanOptions(['', 'a\nb', ...Array(10).fill('o')]), ['a', 'o', 'o', 'o', 'o', 'o'])
})

// ---------- R9: refresh ----------

test('R9: with 8 bots, never two CLI calls of the same kind at once', async () => {
  const botIds = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`)
  const inFlight = new Map<string, number>()
  const peak = new Map<string, number>()
  const calls: string[] = []
  const run = async (r: CliRequest): Promise<CliResult> => {
    const kind = r.command
    calls.push(cliKey(r))
    inFlight.set(kind, (inFlight.get(kind) ?? 0) + 1)
    peak.set(kind, Math.max(peak.get(kind) ?? 0, inFlight.get(kind) as number))
    await new Promise((done) => setTimeout(done, 3))
    inFlight.set(kind, (inFlight.get(kind) as number) - 1)
    if (r.command === 'bot list') return { ok: true, result: { bots: botIds.map((id, i) => ({ id, name: `Bot ${i}` })) }, ms: 3, cliPath: '/x' }
    if (r.command === 'orchestration run-list') return { ok: true, result: { runs: [{ id: 'run_aaa' }, { id: 'run_bbb' }] }, ms: 3, cliPath: '/x' }
    return { ok: true, result: {}, ms: 3, cliPath: '/x' }
  }
  const r = createWaitsRefresher({ run })
  // Overlapping cycles, as a slow CLI and quick agent events would cause.
  await Promise.all([r.cycle(true), r.cycle(false), r.cycle(true), r.cycle(false)])
  await r.cycle(false)
  for (const [kind, n] of peak) assert.equal(n, 1, `${kind} ran ${n} at once`)
  assert.equal(calls.filter((c) => c.startsWith('bot item list')).length >= 8, true, 'every bot read')
})

test('R9: an agent event updates the list at once, with no CLI call', async () => {
  const calls: string[] = []
  const r = createWaitsRefresher({ run: fixtureRun((k) => calls.push(k)) })
  await r.cycle(true)
  const before = calls.length
  let changed = 0
  const r2 = createWaitsRefresher({ run: fixtureRun(), onChange: () => changed++ })
  await r2.cycle(true)
  const n = changed
  r2.onAgentEvent({ workspaceId: null, paneKey: 'pane-new:1', terminalId: 'term_aaaaaaaa-0000-4000-8000-000000000001', title: 'New', state: 'blocked', receivedAt: 1795401000000 })
  assert.equal(changed, n + 1)
  assert.ok(r2.snapshot().waits.some((w) => w.key === 'agent:term_aaaaaaaa-0000-4000-8000-000000000001'))
  r.onAgentEvent({ workspaceId: null, paneKey: 'p', state: 'waiting', receivedAt: 1 })
  assert.equal(calls.length, before)
})

test('PRD 5: a failed call keeps the last good data and shows one banner; runtime_unavailable backs off', async () => {
  let now = 1_000_000
  let fail = false
  const calls: string[] = []
  const good = fixtureRun()
  const run = async (req: CliRequest): Promise<CliResult> => {
    calls.push(req.command)
    if (fail) return { ok: false, error: { kind: 'cli_error', code: 'runtime_unavailable', message: 'runtime_unavailable: Orca is not running' }, ms: 1, cliPath: '/x' }
    return good(req)
  }
  const r = createWaitsRefresher({ run, now: () => now })
  await r.cycle(true)
  const n = r.snapshot().waits.length
  assert.ok(n > 0)
  fail = true
  await r.cycle(false)
  assert.equal(r.snapshot().waits.length, n, 'last good data stays')
  assert.equal(r.snapshot().banner?.code, 'runtime_unavailable')
  const c = calls.length
  now += 1_000
  await r.cycle(false)
  assert.equal(calls.length, c, 'within the backoff no call runs')
  fail = false
  now += 60_000
  await r.cycle(false)
  assert.equal(r.snapshot().banner, null, 'a clean cycle clears the banner')
})
