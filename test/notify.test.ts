// R9: one desktop notification per new wait, never repeated; a setting turns it off; status bar text.
import { assert, test } from 'orca/testing'
import { createNotifier, MAX_PER_UPDATE, notificationOf, statusBarOf } from '../src/notify.ts'
import type { Wait } from '../src/views/waits/collect.ts'
import { fixtureSnapshot } from './waits-fixture.ts'

const wait = (id: string, extra: Partial<Wait> = {}): Wait => ({ key: id, notifyId: id, kind: 'agent', who: 'Agent', what: 'Waiting for your input', options: [], label: 'Waiting', since: 1, target: null, sources: ['agent'], ...extra })

function setup(stored: unknown = [], enabled = true) {
  const shown: { title: string; body: string }[] = []
  let saved: unknown = stored
  const deps = { show: async (title: string, body: string) => void shown.push({ title, body }), load: async () => saved, save: async (ids: string[]) => void (saved = ids), enabled: () => enabled }
  return { shown, deps, saved: () => saved }
}

test('a new wait notifies once; the same wait never again, also after a restart', async () => {
  const s = setup([])
  const n = createNotifier(s.deps)
  assert.equal(await n.update([wait('a')]), 1)
  assert.equal(await n.update([wait('a')]), 0)
  assert.equal(await n.update([]), 0)
  assert.equal(await n.update([wait('a')]), 0, 'gone and back with the same id: not repeated')
  const restarted = createNotifier(s.deps)
  assert.equal(await restarted.update([wait('a'), wait('b')]), 1)
  assert.deepEqual(s.shown.length, 2)
})

test('first run ever: what already waits is recorded, not notified', async () => {
  const s = setup(null)
  const n = createNotifier(s.deps)
  assert.equal(await n.update([wait('a'), wait('b')]), 0)
  assert.deepEqual(s.saved(), ['a', 'b'])
  assert.equal(await n.update([wait('a'), wait('b'), wait('c')]), 1)
})

test('setting off: nothing shows, ids are still recorded so turning it on does not flood', async () => {
  let on = false
  const s = setup([])
  const n = createNotifier({ ...s.deps, enabled: () => on })
  assert.equal(await n.update([wait('a')]), 0)
  on = true
  assert.equal(await n.update([wait('a')]), 0)
  assert.equal(await n.update([wait('a'), wait('b')]), 1)
})

test('two quick updates never notify the same wait twice', async () => {
  const s = setup([])
  const n = createNotifier(s.deps)
  const [x, y] = await Promise.all([n.update([wait('a')]), n.update([wait('a')])])
  assert.equal(x + y, 1)
})

test('many new waits at once: a few, then one summary', async () => {
  const s = setup([])
  const n = createNotifier(s.deps)
  await n.update(Array.from({ length: 6 }, (_, i) => wait(`w${i}`)))
  assert.equal(s.shown.length, MAX_PER_UPDATE)
  assert.match(s.shown[MAX_PER_UPDATE - 1].body, /^4 more new waits/)
})

test('notification text: cleaned, one line, trust prompt named', async () => {
  const { waits } = await fixtureSnapshot()
  const item = notificationOf(waits.find((w) => w.key.startsWith('item:6f3df7d1')) as Wait)
  assert.equal(item.title, 'Waits on you: Atlas')
  assert.equal(item.body, 'Ship <b>v2</b> today, or wait for the review? (Ship today / Wait for review)')
  const trust = notificationOf(waits.find((w) => w.key === 'agent:term_7291498c-cd05-44be-a8fc-8de963d40e56') as Wait)
  assert.match(trust.body, /^trust this folder: /)
  for (const w of waits) assert.ok(!/\n/.test(notificationOf(w).body))
})

test('status bar text', () => {
  assert.deepEqual(statusBarOf(0), { text: 'No waits', tooltip: 'Control Room: nothing waits on you', tone: 'neutral' })
  assert.equal(statusBarOf(1).text, '1 waiting')
  assert.equal(statusBarOf(1).tooltip, 'Control Room: 1 thing waits on you')
  assert.equal(statusBarOf(8).tone, 'warning')
})
