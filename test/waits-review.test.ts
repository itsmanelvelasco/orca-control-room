// Review of PR 4: stale rows, one notification per wait, first install, backoff, and the nits.
import { assert, test } from 'orca/testing'
import type { CliRequest } from '../src/cli/commands.ts'
import type { CliResult } from '../src/cli/run.ts'
import { agentFromEvent, parseWorktreePs, type AgentStatusEvent } from '../src/model/index.ts'
import { createNotifier, MAX_NOTIFIED } from '../src/notify.ts'
import { collectWaits, TRUST_LABEL, type AgentSpell, type Wait } from '../src/views/waits/collect.ts'
import { createWaitsRefresher } from '../src/views/waits/refresh.ts'
import { MAX } from '../src/views/waits/text.ts'
import { fixture } from './helpers.ts'
import { fixtureRun, WAITS_CASE } from './waits-fixture.ts'

const LOOSE: AgentStatusEvent = { workspaceId: null, paneKey: 'pane-gone:1', terminalId: 'term_aaaaaaaa-0000-4000-8000-0000000000aa', title: 'Closed agent', state: 'blocked', receivedAt: 1795400800000 }
const hasLoose = (s: { waits: { key: string }[] }): boolean => s.waits.some((w) => w.key === `agent:${LOOSE.terminalId}`)

const wait = (id: string): Wait => ({ key: id, notifyId: id, kind: 'agent', who: 'Agent', what: 'Waiting for your input', options: [], label: 'Waiting', since: 1, target: null, sources: ['agent'] })

function store(stored: unknown) {
  const shown: string[] = []
  let saved: unknown = stored
  const deps = { show: async (title: string) => void shown.push(title), load: async () => saved, save: async (ids: string[]) => void (saved = ids), enabled: () => true }
  return { shown, deps, saved: () => saved }
}

// ---------- 1: stale agent rows ----------

test('review 1: an agent `worktree ps` no longer lists drops its event row at the next read', async () => {
  const r = createWaitsRefresher({ run: fixtureRun() })
  await r.cycle(true)
  r.onAgentEvent(LOOSE)
  assert.ok(hasLoose(r.snapshot()), 'the event shows at once')
  await r.cycle(false)
  assert.equal(hasLoose(r.snapshot()), false, 'ps does not list its pane: the row goes')
  // An agent ps still lists keeps its event row.
  r.onAgentEvent(WAITS_CASE.events[0])
  await r.cycle(false)
  assert.ok(r.snapshot().waits.some((w) => w.key === 'agent:term_7291498c-cd05-44be-a8fc-8de963d40e56'))
})

test('review 1: an event that comes while `worktree ps` runs, or a cut ps list, keeps its row', async () => {
  const good = fixtureRun()
  let during: (() => void) | null = null
  let truncated = false
  const run = async (req: CliRequest): Promise<CliResult> => {
    const res = await good(req)
    if (req.command === 'worktree ps') {
      during?.()
      during = null
      if (truncated && res.ok) return { ...res, result: { ...(res.result as object), truncated: true } }
    }
    return res
  }
  const r = createWaitsRefresher({ run })
  await r.cycle(true)
  during = () => r.onAgentEvent(LOOSE)
  await r.cycle(false)
  assert.ok(hasLoose(r.snapshot()), 'newer than the ps read: kept')
  truncated = true
  await r.cycle(false)
  assert.ok(hasLoose(r.snapshot()), 'ps list cut: kept')
  truncated = false
  await r.cycle(false)
  assert.equal(hasLoose(r.snapshot()), false)
})

// ---------- 2: paused bot ----------

test('review 2: a paused bot drops its questions and is not read', async () => {
  let paused = false
  const calls: string[] = []
  const good = fixtureRun((k) => calls.push(k))
  const run = async (req: CliRequest): Promise<CliResult> => {
    const res = await good(req)
    if (req.command === 'bot list' && res.ok && paused) {
      const bots = (res.result as { bots: { id: string }[] }).bots.map((b) => ({ ...b, paused: b.id.startsWith('494abacd') }))
      return { ...res, result: { bots } }
    }
    return res
  }
  const r = createWaitsRefresher({ run })
  const atlas = 'item:6f3df7d1-33d6-44c6-8e9d-6ac0e3e756d2'
  await r.cycle(true)
  assert.ok(r.snapshot().waits.some((w) => w.key === atlas))
  paused = true
  calls.length = 0
  await r.cycle(true)
  assert.equal(r.snapshot().waits.some((w) => w.key === atlas), false)
  assert.equal(calls.some((c) => c.startsWith('bot item list') && c.includes('494abacd')), false, 'the paused bot is not read')
  assert.ok(r.snapshot().waits.some((w) => w.key === 'item:ca28fa95-0015-4c88-9af8-d8e34dbaed59'), 'the other bot stays')
})

// ---------- 3: one notification per wait ----------

test('review 3: an agent wait keeps one notify id when the trust reason and the terminal id come later', () => {
  const rec = fixture('cases/trust-blocked-agent.json')
  const spells = new Map<string, AgentSpell>()
  const base = { items: [], gates: [], tasks: [], workers: [], spells }
  // The event first: no reason, no terminal id, dated when it arrived.
  const { terminalId: _t, ...noTerminal } = rec.agentStatusChanged[0]
  const first = collectWaits({ ...base, worktrees: [], events: [agentFromEvent(noTerminal)] })
  assert.equal(first.length, 1)
  assert.equal(first[0].label, 'Waiting')
  // Then `worktree ps` adds the trust reason, the terminal id and an earlier start; then the exact event.
  const ps = parseWorktreePs(rec.worktreePsAgentWait.result).worktrees
  const second = collectWaits({ ...base, worktrees: ps, events: rec.agentStatusChanged.map((e: AgentStatusEvent) => agentFromEvent(e)) })
  assert.equal(second[0].label, TRUST_LABEL)
  assert.notEqual(second[0].key, first[0].key, 'the row key moved to the terminal id')
  assert.equal(second[0].notifyId, first[0].notifyId, 'same wait: same notify id')
  // Answered (no longer listed), then a new wait: a new id.
  const later = 1795442900000
  assert.deepEqual(collectWaits({ ...base, worktrees: [], events: [agentFromEvent({ ...rec.agentStatusChanged[1], state: 'working', receivedAt: later, mainAgent: { state: 'working', stateStartedAt: later } })] }), [])
  const again = collectWaits({ ...base, worktrees: [], events: [agentFromEvent({ ...rec.agentStatusChanged[1], receivedAt: later + 5000, mainAgent: { state: 'waiting', stateStartedAt: later + 5000 } })] })
  assert.notEqual(again[0].notifyId, first[0].notifyId)
})

test('review 3: trimming to MAX_NOTIFIED keeps the ids of waits still listed', async () => {
  const s = store(Array.from({ length: MAX_NOTIFIED }, (_, i) => `old${i}`))
  const n = createNotifier(s.deps)
  // old0 is the oldest id and its wait is still listed.
  assert.equal(await n.update([wait('old0'), wait('new')]), 1)
  const saved = s.saved() as string[]
  assert.equal(saved.length, MAX_NOTIFIED)
  assert.ok(saved.includes('old0'))
  assert.ok(!saved.includes('old1'), 'the oldest unlisted id drops instead')
  assert.equal(await n.update([wait('old0'), wait('new')]), 0, 'never repeated')
})

test('review 3: a gate seen before its task shows as one row, at every update', async () => {
  let taskReads = 0
  const good = fixtureRun()
  const run = async (req: CliRequest): Promise<CliResult> => {
    // The first task-list and worker-list reads predate the task; the next ones have it.
    if (req.command === 'orchestration task-list' && taskReads++ === 0) return { ok: true, result: { tasks: [] }, ms: 1, cliPath: '/x' }
    if (req.command === 'orchestration worker-list' && taskReads <= 1) return { ok: true, result: { workers: [] }, ms: 1, cliPath: '/x' }
    return good(req)
  }
  const posted: string[][] = []
  const r = createWaitsRefresher({ run, onChange: (s) => posted.push(s.waits.map((w) => w.key)) })
  await r.cycle(true)
  assert.ok(posted.length > 0)
  for (const keys of posted) {
    assert.equal(keys.filter((k) => k.startsWith('item:a329a828')).length, 0, 'the item merges into the gate')
    assert.equal(keys.filter((k) => k === 'agent:term_03d70d0b-6eff-4557-a980-036162fa9748').length, 0, 'the worker agent merges into the gate')
  }
  const gate = r.snapshot().waits.find((w) => w.key === 'task:task_a1b2c3d4e5f6')
  assert.deepEqual([...(gate?.sources ?? [])].sort(), ['agent', 'gate', 'item'])
})

// ---------- 4: first install ----------

test('review 4: first install stays silent until the first clean full cycle', async () => {
  const s = store(null)
  const n = createNotifier(s.deps)
  // An agent event before the first CLI cycle ends: not primed.
  assert.equal(await n.update([wait('a')], false), 0)
  // The first full cycle: what already waits is recorded, not notified.
  assert.equal(await n.update([wait('a'), wait('b'), wait('c')], true), 0)
  assert.equal(await n.update([wait('a'), wait('b'), wait('c'), wait('d')], true), 1)
})

test('review 4: refresher + notifier: an event before the first cycle does not end the silence', async () => {
  const s = store(null)
  const n = createNotifier(s.deps)
  const pending: Promise<number>[] = []
  const r = createWaitsRefresher({ run: fixtureRun(), onChange: (snap) => void pending.push(n.update(snap.waits, snap.primed)) })
  r.onAgentEvent({ ...LOOSE, paneKey: 'pane-early:1' })
  await r.cycle(true)
  await Promise.all(pending)
  assert.ok(pending.length >= 2)
  assert.equal(r.snapshot().primed, true)
  assert.equal(s.shown.length, 0, 'the existing items, gates and agents do not notify')
})

test('review 4: a failed first cycle does not prime', async () => {
  const r = createWaitsRefresher({ run: async () => ({ ok: false, error: { kind: 'cli_error', code: 'boom', message: 'boom' }, ms: 1, cliPath: '/x' }) })
  await r.cycle(true)
  assert.equal(r.snapshot().primed, false)
})

// ---------- 5: backoff ----------

test('review 5: backoff doubles per failed cycle, not per call; the first pause is 4 s', async () => {
  let now = 1_000_000
  const calls: string[] = []
  const run = async (req: CliRequest): Promise<CliResult> => {
    calls.push(req.command)
    return { ok: false, error: { kind: 'cli_error', code: 'runtime_unavailable', message: 'runtime_unavailable: Orca is not running' }, ms: 1, cliPath: '/x' }
  }
  const r = createWaitsRefresher({ run, now: () => now })
  await r.cycle(true)
  assert.ok(calls.length <= 2, `the cycle stops after the first failure (${calls.length} calls)`)
  const runsAfter = async (ms: number): Promise<boolean> => {
    now += ms
    const n = calls.length
    await r.cycle(false)
    return calls.length > n
  }
  assert.equal(await runsAfter(3_999), false)
  assert.equal(await runsAfter(1), true, 'first pause: 4 s')
  assert.equal(await runsAfter(7_999), false)
  assert.equal(await runsAfter(1), true, 'second pause: 8 s')
  assert.equal(await runsAfter(15_999), false)
  assert.equal(await runsAfter(1), true, 'third pause: 16 s')
})

// ---------- nits ----------

test('nit: each cycle posts a fresh updatedAt, so "Updated X ago" stays live', async () => {
  let now = 1795400900000
  const posted: (number | null)[] = []
  const r = createWaitsRefresher({ run: fixtureRun(), now: () => now, onChange: (s) => posted.push(s.updatedAt) })
  await r.cycle(true)
  now += 4_000
  await r.cycle(false)
  assert.deepEqual(posted.slice(-2), [now - 4_000, now])
})

test('nit: a gate keeps its "since" across a restart; gates no longer listed drop out of storage', async () => {
  let stored: unknown = undefined
  const save = async (v: Record<string, number>) => void (stored = v)
  const one = createWaitsRefresher({ run: fixtureRun(), now: () => 1000, seen: { load: async () => stored, save } })
  await one.cycle(true)
  assert.equal((stored as Record<string, number>).gate_6f7a8b9c0d1e, 1000)
  const two = createWaitsRefresher({ run: fixtureRun(), now: () => 9000, seen: { load: async () => ({ ...(stored as object), gate_gone: 5 }), save } })
  await two.cycle(true)
  assert.equal(two.snapshot().waits.find((w) => w.key === 'task:task_b2c3d4e5f6a1')?.since, 1000)
  assert.equal((stored as Record<string, number>).gate_gone, undefined)
})

test('nit: the banner text is cleaned and cut', async () => {
  const run = async (): Promise<CliResult> => ({ ok: false, error: { kind: 'cli_error', code: 'boom', message: `‮bad\u0007 ${'x'.repeat(400)}\nsecond line` }, ms: 1, cliPath: '/x' })
  const r = createWaitsRefresher({ run })
  await r.cycle(true)
  const m = r.snapshot().banner?.message ?? ''
  assert.ok(m.startsWith('bad x'), m.slice(0, 20))
  assert.equal(Array.from(m).length, MAX.what)
})
