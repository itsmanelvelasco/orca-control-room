// R7. The Agents view: every agent in every workspace, grouped by project, with state and time
// in it, from the plugin API only. Fixture: test/fixtures/cases/agents-host.json.
import { readdirSync, readFileSync } from 'node:fs'
import { assert, mockHost, mount, mountWorker, test } from 'orca/testing'
import * as main from '../src/worker.ts'
import { agentsListOf, manyAgentsCase, type AgentsCase } from '../src/views/agents/demo.ts'
import { buildGroups, cleanText, emptySnapshot, GROUP_CAP, GROUP_HARD_CAP, hostLabel, NO_PROJECT, type AgentsSnapshot } from '../src/views/agents/model.ts'
import { createAgentsRefresher, type AgentsHost } from '../src/views/agents/refresh.ts'
import { registerAgents } from '../src/views/agents/worker.ts'
import { AgentsView } from '../src/views/agents/view.tsx'
import { fixture } from './helpers.ts'

const CASE = fixture<AgentsCase>('cases/agents-host.json')

/** A host that answers from a case and records every call. */
function caseHost(c: AgentsCase) {
  const calls: string[] = []
  const host: AgentsHost = {
    listWorkspaces: async () => {
      calls.push('workspace.list')
      return c.workspaceList
    },
    listAgents: async (id) => {
      calls.push(`agents.list ${id}`)
      return agentsListOf(c, id)
    }
  }
  return { host, calls }
}

const hostResults = (c: AgentsCase) => ({
  'workspace.list': c.workspaceList,
  'agents.list': (p: { workspaceId?: string } | undefined) => agentsListOf(c, p?.workspaceId)
})

const rowsOf = (s: AgentsSnapshot) => s.groups.flatMap((g) => g.rows.map((r) => ({ group: g.name, ...r })))

// ---------- model ----------

test('every agent in every workspace shows once, in its project group (fixture: 100%)', async () => {
  const { host } = caseHost(CASE)
  const r = createAgentsRefresher({ host, now: () => CASE.now })
  await r.refresh()
  const s = r.snapshot()
  assert.equal(s.status, 'ok')
  // 7 agents listed by the 6 workspaces that answer; wt-broken did not answer and had none before.
  const want: Record<string, string> = {
    term_main_1: 'sample-app',
    term_main_2: 'sample-app',
    term_export_1: 'sample-app',
    term_docs_1: 'docs-site',
    term_notes_1: NO_PROJECT,
    term_api_1: 'sample-api',
    term_ml_1: 'sample-ml'
  }
  const got = Object.fromEntries(rowsOf(s).map((x) => [x.key, x.group]))
  assert.deepEqual(got, want)
  assert.equal(s.total, 7)
})

test('each row carries its state and when it entered it', async () => {
  const { host } = caseHost(CASE)
  const r = createAgentsRefresher({ host, now: () => CASE.now })
  await r.refresh()
  const byKey = new Map(rowsOf(r.snapshot()).map((x) => [x.key, x]))
  for (const [wsId, v] of Object.entries(CASE.agentsList)) {
    if (typeof v !== 'object') continue
    for (const a of v.agents) {
      const row = byKey.get(a.terminalId!)
      assert.ok(row, `${a.terminalId} of ${wsId} shows`)
      assert.equal(row.state, a.state)
      assert.equal(row.since, a.stateStartedAt)
    }
  }
})

test('groups with a wait come first; rows run blocked, waiting, working, done', async () => {
  const { host } = caseHost(CASE)
  const r = createAgentsRefresher({ host, now: () => CASE.now })
  await r.refresh()
  const s = r.snapshot()
  assert.deepEqual(s.groups.map((g) => g.name), ['docs-site', 'sample-app', 'sample-api', 'sample-ml', NO_PROJECT])
  const app = s.groups.find((g) => g.name === 'sample-app')!
  assert.deepEqual(app.rows.map((x) => x.state), ['waiting', 'working', 'done'])
  assert.equal(app.waiting, 1)
  assert.equal(app.total, 3)
})

test('remote workspaces (SSH, paired server) show their agents, labelled by host', async () => {
  const { host } = caseHost(CASE)
  const r = createAgentsRefresher({ host, now: () => CASE.now })
  await r.refresh()
  const g = (name: string) => r.snapshot().groups.find((x) => x.name === name)!
  assert.equal(g('sample-api').remote, true)
  assert.equal(g('sample-api').host, 'ssh build-box')
  assert.equal(g('sample-ml').remote, true)
  assert.equal(g('sample-ml').host, 'paired server')
  assert.equal(g('sample-app').remote, false)
  assert.equal(hostLabel('local'), null)
  assert.equal(hostLabel(null), null)
})

test('a workspace with no terminal is not asked; one that fails is named and keeps its last agents', async () => {
  const { host, calls } = caseHost(CASE)
  const r = createAgentsRefresher({ host, now: () => CASE.now })
  await r.refresh()
  assert.ok(!calls.includes('agents.list wt-idle'), 'terminalCount 0 is skipped')
  assert.deepEqual(r.snapshot().stale, ['unreachable'])

  // The workspace answered once, then fails: its agent stays.
  const ok: AgentsCase = { ...CASE, agentsList: { ...CASE.agentsList, 'wt-broken': { agents: [{ terminalId: 'term_api_2', title: 'Migrate', agent: 'codex', state: 'working', stateStartedAt: CASE.now - 1000, sessionId: null, task: null }] } } }
  let c = ok
  let t = CASE.now
  const r2 = createAgentsRefresher({ host: { listWorkspaces: async () => c.workspaceList, listAgents: async (id) => agentsListOf(c, id) }, now: () => t })
  await r2.refresh()
  assert.ok(rowsOf(r2.snapshot()).some((x) => x.key === 'term_api_2'))
  c = CASE
  t += 10_000
  await r2.refresh()
  assert.ok(rowsOf(r2.snapshot()).some((x) => x.key === 'term_api_2'), 'last known agent stays')
  assert.deepEqual(r2.snapshot().stale, ['unreachable'])
})

test('workspace.list failing keeps the last good groups and says why in one line', async () => {
  let fail = false
  let t = CASE.now
  const { host } = caseHost(CASE)
  const r = createAgentsRefresher({
    host: { ...host, listWorkspaces: async () => { if (fail) throw new Error('Orca is busy\nstack line'); return CASE.workspaceList } },
    now: () => t
  })
  await r.refresh()
  fail = true
  t += 10_000
  await r.refresh()
  const s = r.snapshot()
  assert.equal(s.error, 'Orca is busy')
  assert.equal(s.total, 7)
  assert.equal(s.status, 'ok')
})

test('agent.status.changed updates a row at once and adds an agent agents.list has not shown yet', async () => {
  const { host } = caseHost(CASE)
  let t = CASE.now
  const r = createAgentsRefresher({ host, now: () => t })
  await r.refresh()
  t += 1000
  for (const e of CASE.events) r.onEvent(e)
  const rows = rowsOf(r.snapshot())
  const main1 = rows.find((x) => x.key === 'tab-main:1')!
  assert.equal(main1.state, 'waiting', 'event joined the list row by terminal id')
  assert.equal(main1.since, 1795430000500)
  assert.equal(main1.group, 'sample-app')
  assert.ok(!rows.some((x) => x.key === 'term_main_1'), 'one row per agent')
  const glossary = rows.find((x) => x.key === 'tab-docs:2')!
  assert.equal(glossary.group, 'docs-site', 'workspaceListId ties it to its project')
  assert.equal(r.snapshot().total, 8)

  // The next full read is the truth: events older than it are dropped.
  t += 5000
  await r.refresh()
  assert.equal(r.snapshot().total, 7)
})

test('a burst of panel asks is one read; a read younger than 3 s is reused', async () => {
  const { host, calls } = caseHost(CASE)
  let t = CASE.now
  const r = createAgentsRefresher({ host, now: () => t })
  await Promise.all([r.refresh(), r.refresh(), r.refresh()])
  assert.equal(calls.filter((c) => c === 'workspace.list').length, 1)
  t += 1000
  await r.refresh()
  assert.equal(calls.filter((c) => c === 'workspace.list').length, 1)
  await r.refresh(true)
  assert.equal(calls.filter((c) => c === 'workspace.list').length, 2)
})

test('untrusted titles: first line, no control characters, cut, never HTML', async () => {
  const { host } = caseHost(CASE)
  const r = createAgentsRefresher({ host, now: () => CASE.now })
  await r.refresh()
  const docs = rowsOf(r.snapshot()).find((x) => x.key === 'term_docs_1')!
  assert.equal(docs.title, '<img src=x onerror=alert(1)> Fix links')
  assert.equal(cleanText('a\u0007b\u202Ec\nsecond'), 'abc')
  assert.equal(cleanText('x'.repeat(300)).length, 120)
  // An agent with no title takes its kind.
  assert.equal(rowsOf(r.snapshot()).find((x) => x.key === 'term_notes_1')!.title, 'gemini')
})

test('the panel draws text as text: no Markdown or Code component anywhere', async () => {
  const { host } = caseHost(CASE)
  const r = createAgentsRefresher({ host, now: () => CASE.now })
  await r.refresh()
  const panel = await mount(() => <AgentsView snap={r.snapshot()} expanded={[]} onShowAll={() => {}} onOpen={() => {}} onRefresh={() => {}} />)
  const json = JSON.stringify(panel.tree())
  assert.ok(!json.includes('"Markdown"') && !json.includes('"CodeView"'))
  assert.ok(json.includes('<img src=x onerror=alert(1)> Fix links'), 'shown as plain text')
  assert.ok(!json.includes('second line that must not show'))
  await panel.unmount()
})

// ---------- cap: 50 rows per group, "Show all" ----------

test('a group of 60 shows 50 rows and "Show all 60"; pressing it shows all', async () => {
  const c = manyAgentsCase(60, CASE.now)
  const { host } = caseHost(c)
  const r = createAgentsRefresher({ host, now: () => c.now })
  await r.refresh()
  assert.equal(r.snapshot().groups.length, 1)
  assert.equal(r.snapshot().groups[0].rows.length, 60)

  const worker = mockHost({ requests: { 'agents.get': r.snapshot() } })
  const panel = await mount(await import('../src/views/agents/panel.tsx'), { host: worker })
  const table = { type: 'Table', label: 'Agents in sample-batch' }
  assert.equal(panel.rowsOf(table).length, GROUP_CAP)
  await panel.press({ text: 'Show all 60' })
  assert.equal(panel.rowsOf(table).length, 60)
  await panel.press({ text: `Show first ${GROUP_CAP}` })
  assert.equal(panel.rowsOf(table).length, GROUP_CAP)
  await panel.unmount()
})

test('the worker never sends more than 500 rows per group', () => {
  const listed = new Map([['w', Array.from({ length: 600 }, (_, i) => ({ terminalId: `term_${i}`, title: `t${i}`, agent: 'claude', state: 'working' as const, stateStartedAt: i }))]])
  const { groups } = buildGroups({ workspaces: [{ id: 'w', name: 'w', project: 'p', projectId: 'p', hostId: 'local' }], listed, events: [] })
  assert.equal(groups[0].total, 600)
  assert.equal(groups[0].rows.length, GROUP_HARD_CAP)
})

// ---------- worker ----------

test('worker: agents.get answers from workspace.list + agents.list; a row press focuses its terminal', async () => {
  const host = mockHost({ results: { ...hostResults(CASE), 'terminal.focus': { focused: true }, 'workspace.open': { opened: true } } })
  const worker = await mountWorker({ default: (orca: Parameters<typeof registerAgents>[0]) => registerAgents(orca) }, { host, events: ['agent.status.changed'] })
  const s = await worker.request('agents.get', { force: true })
  assert.equal(s.total, 7)
  assert.ok(host.callsOf('agents.list').length >= 6)

  assert.deepEqual(await worker.request('agents.open', { key: 'term_export_1' }), { opened: true })
  assert.deepEqual(host.callsOf('terminal.focus').at(-1), { terminalId: 'term_export_1' })
  // An event-only agent with no terminal id opens its workspace.
  await worker.emit('agent.status.changed', CASE.events[1])
  assert.deepEqual(await worker.request('agents.open', { key: 'tab-docs:2' }), { opened: true })
  assert.deepEqual(host.callsOf('workspace.open').at(-1), { workspaceId: 'wt-docs' })
  assert.deepEqual(await worker.request('agents.open', { key: 'nope' }), { opened: false, reason: 'no_target' })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

// ---------- R7 AC: works with the CLI missing ----------

test('R7 AC: with the Orca CLI missing, cli.status names the paths tried and the Agents view still lists every agent', async () => {
  // No CLI anywhere: no setting, nothing next to node, no default install, empty PATH.
  const saved = { ...process.env }
  const nowhere = process.platform === 'win32' ? 'C:\\nonexistent-control-room-test' : '/nonexistent-control-room-test'
  for (const k of Object.keys(process.env)) if (/^(path|localappdata|userprofile|home|appdir)$/i.test(k)) delete process.env[k]
  process.env.PATH = ''
  process.env.LOCALAPPDATA = nowhere
  process.env.USERPROFILE = nowhere
  process.env.HOME = nowhere
  try {
    const host = mockHost({ settings: { orcaCli: '' }, results: hostResults(CASE) })
    const worker = await mountWorker(main, { host, events: ['agent.status.changed'] })
    const cli = await worker.request('cli.status')
    assert.equal(cli.ok, false)
    assert.equal(cli.error?.kind, 'not_found')
    assert.ok(cli.tried.length > 0, 'the paths tried, for the other views\' banner')

    const s = await worker.request('agents.get', { force: true })
    assert.equal(s.status, 'ok')
    assert.equal(s.error, null)
    assert.equal(s.total, 7)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
})

test('R7 AC: the Agents view code never reaches the CLI (no import of src/cli or child_process)', () => {
  const dir = new URL('../src/views/agents/', import.meta.url)
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.check.ts')) continue
    const src = readFileSync(new URL(f, dir), 'utf8')
    assert.ok(!/from ['"][./]*\/cli\//.test(src) && !src.includes('child_process') && !src.includes('cli.run'), `${f} must not use the CLI`)
  }
})

test('panel: empty, loading and error states', async () => {
  const empty = await mount(() => <AgentsView snap={{ ...emptySnapshot(), status: 'ok', updatedAt: CASE.now }} expanded={[]} onShowAll={() => {}} onOpen={() => {}} onRefresh={() => {}} />)
  assert.ok(empty.find({ type: 'EmptyState', label: 'No agents' }))
  await empty.unmount()
  const loading = await mount(() => <AgentsView snap={emptySnapshot()} expanded={[]} onShowAll={() => {}} onOpen={() => {}} onRefresh={() => {}} />)
  assert.ok(loading.find({ type: 'Skeleton' }))
  await loading.unmount()
  const err = await mount(() => <AgentsView snap={{ ...emptySnapshot(), status: 'error', error: 'Orca is busy' }} expanded={[]} onShowAll={() => {}} onOpen={() => {}} onRefresh={() => {}} />)
  assert.ok(err.summary().some((l) => l.includes('Orca did not list the agents')))
  await err.unmount()
})

test('panel: a table row action asks the worker to open that row', async () => {
  const { host: h } = caseHost(CASE)
  const r = createAgentsRefresher({ host: h, now: () => CASE.now })
  await r.refresh()
  const opened: string[] = []
  const host = mockHost({ requests: { 'agents.get': r.snapshot(), 'agents.open': (i: { key: string }) => (opened.push(i.key), { opened: true }) } })
  const panel = await mount(await import('../src/views/agents/panel.tsx'), { host })
  await panel.activateRow({ type: 'Table', label: 'Agents in docs-site' }, 'term_docs_1')
  assert.deepEqual(opened, ['term_docs_1'])
  await panel.unmount()
})
