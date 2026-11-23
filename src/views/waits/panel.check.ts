// `orca plugin check` (and `orca plugin shot --scenario`) render the panel once per scenario.
// `waits` is the fixture test set (invented names), used for the PR screenshots.
import { defineCheck } from 'orca/testing'
import { fixtureSnapshot } from '../../../test/waits-fixture.ts'

const snap = await fixtureSnapshot(Date.now())

export default defineCheck({
  waits: { requests: { 'waits.get': snap } },
  empty: { requests: { 'waits.get': { waits: [], updatedAt: Date.now(), primed: true, banner: null, cliPath: '/opt/Orca/resources/bin/orca' } } },
  cliMissing: {
    requests: {
      'waits.get': { waits: [], updatedAt: Date.now(), primed: true, banner: { kind: 'not_found', message: 'The Orca CLI was not found.', tried: ['/opt/Orca/resources/bin/orca', 'orca on PATH'] }, cliPath: null }
    }
  }
})
