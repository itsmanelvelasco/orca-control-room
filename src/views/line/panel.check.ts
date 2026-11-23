// `orca plugin check` (and `orca plugin shot --scenario`) render the shipping line once per
// scenario. The data is the fixture set (test/fixtures), never live CLI output.
import { readFileSync } from 'node:fs'
import { defineCheck } from 'orca/testing'
import { lineFromCase } from './demo.ts'

/** An invented PR for the worker that finished slice 2 (gate B asks to merge it). */
const SAMPLE_PR = { ref: 'example-org/sample-app#42', number: 42, url: 'https://github.com/example-org/sample-app/pull/42', state: 'open', checks: 'success', review: 'APPROVED', title: 'Slice 2: export view' }

const caseJson = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../test/fixtures/cases/${name}`, import.meta.url), 'utf8'))

export default defineCheck({
  // A Run with 4 tasks in build order, a failed worker, gates A and B, one PR.
  fixture: { requests: { 'line.snapshot': lineFromCase({ ...(caseJson('run-4-tasks.json') as object), prs: { ctx_1b2c3d4e5f0a: SAMPLE_PR } }) } },
  // A user with no Runs.
  'no-runs': { requests: { 'line.snapshot': lineFromCase({ runList: { ok: true, result: { runs: [] } } }) } },
  // The CLI is missing: one banner with the paths tried.
  'cli-missing': {
    requests: {
      'line.snapshot': {
        status: 'error',
        updatedAt: null,
        error: { kind: 'not_found', message: 'No Orca CLI on any path.', tried: ['C:\Users\alex\AppData\Local\Programs\Orca\resources\bin\orca.exe', 'orca (PATH)'] },
        runs: [],
        legacy: [],
        refreshSeconds: 20
      }
    }
  }
})
