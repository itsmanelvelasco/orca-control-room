// The Waits on you panel on the fixture snapshot: rows, labels, text drawn as text, clicks by key.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from '../src/views/waits/panel.tsx'
import { fixtureSnapshot } from './waits-fixture.ts'

test('panel: one row per wait, newest first, labels and options; HTML shown as text', async () => {
  const snap = await fixtureSnapshot()
  const opened: string[] = []
  const host = mockHost({ requests: { 'waits.get': snap, 'waits.open': ({ key }: { key: string }) => (opened.push(key), { opened: true }) } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Waits on you' }))
  assert.ok(view.find({ text: String(snap.waits.length) }))
  assert.ok(view.find({ text: 'Ship <b>v2</b> today, or wait for the review?' }), 'literal text, not HTML')
  assert.equal(view.findAll({ text: 'trust this folder' }).length, 2)
  assert.ok(view.find({ text: 'CSV' }))
  await view.press({ text: 'Focus terminal' })
  assert.equal(opened.length, 1)
  assert.equal(opened[0], snap.waits.find((w) => w.target?.kind === 'terminal')?.key)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('panel: empty state, banner when the CLI is missing, live update from the worker', async () => {
  const host = mockHost({ requests: { 'waits.get': { waits: [], updatedAt: 1, primed: true, banner: { kind: 'not_found', message: 'The Orca CLI was not found.', tried: ['/opt/Orca/resources/bin/orca'] }, cliPath: null } } })
  const view = await mount(panel, { host })
  assert.ok(view.summary().includes('EmptyState "Nothing waits on you"'))
  assert.ok(view.summary().includes('Callout warning "Orca CLI not found"'))
  const snap = await fixtureSnapshot()
  await view.post('waits.changed', snap)
  assert.ok(view.find({ text: 'Ship <b>v2</b> today, or wait for the review?' }))
  assert.ok(!view.summary().some((l) => l.startsWith('EmptyState')))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('panel: a place that cannot open says so on its row', async () => {
  const snap = await fixtureSnapshot()
  const host = mockHost({ requests: { 'waits.get': snap, 'waits.open': { opened: false, reason: 'failed' } } })
  const view = await mount(panel, { host })
  await view.press({ text: 'Open workspace' })
  assert.ok(view.find({ text: 'Could not open it.' }))
  await view.unmount()
})
