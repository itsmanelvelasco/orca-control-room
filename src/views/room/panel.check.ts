// `orca plugin check` (and `orca plugin shot --scenario`) render the Control Room panel once per
// scenario. All data is the fixture set (test/fixtures, invented names), never live CLI output.
// `persisted` picks the tab a scenario opens on; it is the README and PR screenshot source.
import { readFileSync } from 'node:fs'
import { defineCheck } from 'orca/testing'
import { fixtureSnapshot } from '../../../test/waits-fixture.ts'
import { lineFromCase } from '../line/demo.ts'
import { agentsListOf, shiftCase, type AgentsCase } from '../agents/demo.ts'
import { createAgentsRefresher } from '../agents/refresh.ts'
import { emptySnapshot as emptyAgents, type AgentsSnapshot } from '../agents/model.ts'
import type { LineSnapshot } from '../line/model.ts'
import type { WaitsSnapshot } from '../waits/refresh.ts'

const caseJson = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../test/fixtures/cases/${name}`, import.meta.url), 'utf8'))
const now = Date.now()

/** An invented PR for the worker that finished slice 2 (gate B asks to merge it). */
const SAMPLE_PR = { ref: 'example-org/sample-app#42', number: 42, url: 'https://github.com/example-org/sample-app/pull/42', state: 'open', checks: 'success', review: 'APPROVED', title: 'Slice 2: export view' }

const waits = await fixtureSnapshot(now)
const line = lineFromCase({ ...(caseJson('run-4-tasks.json') as object), prs: { ctx_1b2c3d4e5f0a: SAMPLE_PR } }, now)

/** The Agents snapshot the worker builds from the agents test case, through the same refresher. */
async function agentsOf(c: AgentsCase): Promise<AgentsSnapshot> {
  const r = createAgentsRefresher({ host: { listWorkspaces: async () => c.workspaceList, listAgents: async (id) => agentsListOf(c, id) }, now: () => now })
  await r.refresh(true)
  for (const e of c.events) r.onEvent(e)
  return r.snapshot()
}
const agents = await agentsOf(shiftCase(caseJson('agents-host.json') as AgentsCase, now))

const TRIED = ['/opt/Orca/resources/bin/orca', 'orca (PATH)']
const waitsNoCli: WaitsSnapshot = { waits: [], updatedAt: now, primed: true, banner: { kind: 'not_found', message: 'The Orca CLI was not found.', tried: TRIED }, cliPath: null }
const lineNoCli: LineSnapshot = { status: 'error', updatedAt: null, error: { kind: 'not_found', message: 'No Orca CLI on any path.', tried: TRIED }, runs: [], legacy: [], hiddenRuns: 0, notes: [], refreshSeconds: 20 }

const all = (w: WaitsSnapshot, l: LineSnapshot, a: AgentsSnapshot) => ({ 'waits.get': w, 'line.snapshot': l, 'agents.get': a })
const on = (tab: string) => ({ plugin: { 'room.tab': tab } })

export default defineCheck({
  // Waits on you: bot questions, gates and agents (two at the folder-trust prompt).
  waits: { requests: all(waits, line, agents) },
  // The shipping line: a Run with 4 tasks in build order, a failed worker, gates A and B, one PR.
  line: { requests: all(waits, line, agents), persisted: on('line') },
  // Every agent in every workspace, by project; a remote host and a paired server.
  agents: { requests: all(waits, line, agents), persisted: on('agents') },
  // The CLI is missing: one banner with the paths tried; the Agents tab still works.
  'cli-missing': { requests: all(waitsNoCli, lineNoCli, agents) },
  'cli-missing-agents': { requests: all(waitsNoCli, lineNoCli, agents), persisted: on('agents') },
  // A new user: no waits, no Runs, no agents.
  empty: {
    requests: all(
      { waits: [], updatedAt: now, primed: true, banner: null, cliPath: '/opt/Orca/resources/bin/orca' },
      lineFromCase({ runList: { ok: true, result: { runs: [] } } }, now),
      { ...emptyAgents(), status: 'ok', updatedAt: now }
    )
  }
})
