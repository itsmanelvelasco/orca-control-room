// The one Control Room panel: three tabs over the slice 2-4 views, the waits count on its tab,
// the tab kept in storage, and only the tab shown polls.
import { readFileSync } from 'node:fs'
import { assert, mockHost, mount, test } from 'orca/testing'
import * as room from '../src/views/room/panel.tsx'
import { emptySnapshot as emptyAgents } from '../src/views/agents/model.ts'
import { lineFromCase } from '../src/views/line/demo.ts'
import { fixtureSnapshot } from './waits-fixture.ts'

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function hostWithCounts() {
  const asks = { line: 0, agents: 0, waits: 0 }
  const waits = await fixtureSnapshot()
  const line = lineFromCase({ runList: { ok: true, result: { runs: [] } } })
  const agents = { ...emptyAgents(), status: 'ok' as const, updatedAt: 1 }
  const host = mockHost({
    requests: {
      'waits.get': () => (asks.waits++, waits),
      'line.snapshot': () => (asks.line++, line),
      'agents.get': () => (asks.agents++, agents)
    }
  })
  return { host, asks, waits }
}

test('PRD goal: the manifest has one panel, Control Room, and the status bar item', () => {
  const m = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')) as { contributes: { panels: { id: string; entry: string }[]; statusBarItems: { id: string }[] } }
  assert.deepEqual(m.contributes.panels.map((p) => [p.id, p.entry]), [['control-room', 'src/views/room/panel.tsx']])
  assert.deepEqual(m.contributes.statusBarItems.map((s) => s.id), ['waits'])
})

test('three tabs; Waits first with its count; a tab switch shows that view', async () => {
  const { host, waits } = await hostWithCounts()
  const view = await mount(room, { host })
  assert.ok(view.summary()[0].startsWith(`Tabs "Control Room": "Waits (${waits.waits.length})" selected`), view.summary()[0])
  assert.ok(view.find({ text: 'Waits on you' }))
  await view.select({ type: 'Tabs' }, 'line')
  assert.ok(view.find({ text: 'Shipping line' }))
  assert.ok(view.find({ text: /No runs/i }), 'R6 AC: a user with no Runs sees "No runs"')
  await view.select({ type: 'Tabs' }, 'agents')
  assert.ok(view.summary()[0].includes('"Agents" selected'), view.summary().slice(0, 3).join(' / '))
  assert.equal(view.persisted.plugin['room.tab'], 'agents')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('the panel opens on the tab it was left on', async () => {
  const { host } = await hostWithCounts()
  const view = await mount(room, { host, persisted: { plugin: { 'room.tab': 'line' } } })
  assert.ok(view.summary()[0].includes('"Shipping line" selected'))
  await view.unmount()
})

test('only the tab shown polls; a hidden panel polls nothing', async () => {
  const { host, asks } = await hostWithCounts()
  const view = await mount(room, { host })
  await sleep(50)
  const start = { ...asks }
  // Waits shown: the shipping line (1 s tick) does not ask.
  await sleep(1_300)
  assert.equal(asks.line, start.line, 'line asks while its tab is hidden')
  await view.select({ type: 'Tabs' }, 'line')
  await sleep(1_300)
  assert.ok(asks.line > start.line, 'line does not ask while its tab is shown')
  await view.setVisible(false)
  await sleep(50)
  const hidden = asks.line
  await sleep(1_300)
  assert.equal(asks.line, hidden, 'line asks while the panel is hidden')
  await view.unmount()
})
