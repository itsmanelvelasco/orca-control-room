// `orca plugin check` (and `orca plugin shot --scenario`) render the Agents panel once per
// scenario, with the plugin's real worker on a mock host. The data is the fixture set, never live.
import { readFileSync } from 'node:fs'
import { defineCheck } from 'orca/testing'
import { agentsListOf, manyAgentsCase, shiftCase, type AgentsCase } from './demo.ts'

const raw = JSON.parse(readFileSync(new URL('../../../test/fixtures/cases/agents-host.json', import.meta.url), 'utf8')) as AgentsCase

const hostOf = (c: AgentsCase) => ({
  'workspace.list': c.workspaceList,
  'agents.list': (params: { workspaceId?: string } | undefined) => agentsListOf(c, params?.workspaceId)
})

export default defineCheck({
  // Every agent in every workspace, grouped by project: waits first, a remote SSH host and a
  // paired server, a folder with no project, one workspace that did not answer.
  fixture: { results: hostOf(shiftCase(raw, Date.now())) },
  // 60 agents in one project: 50 rows and "Show all 60".
  many: { results: hostOf(manyAgentsCase(60, Date.now())) },
  // No agent anywhere.
  empty: { results: { 'workspace.list': { workspaces: [], truncated: false } } }
})
