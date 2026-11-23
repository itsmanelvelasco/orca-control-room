// The slice-1 worker starts with the manifest's capabilities and logs agent events (R5 check).
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from '../src/worker.ts'

test('activates, reads the orcaCli setting, logs agent.status.changed', async () => {
  const host = mockHost({ settings: { orcaCli: '' } })
  const worker = await mountWorker(main, { host, events: ['agent.status.changed'] })
  await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'tab:pane', state: 'waiting', receivedAt: 1 })
  assert.ok(worker.logs.some((l) => l.startsWith('agent.status.changed ') && l.includes('"waiting"')))
  assert.ok(worker.logs.some((l) => l.startsWith('worker env: ') && !l.includes('=C:') && !l.includes('=/')), 'env key names only')
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
