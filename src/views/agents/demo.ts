// Host answers built from a hand-made case (test/fixtures/cases/agents-host.json), for tests,
// `orca plugin check` and screenshots. Never live data.
import type { AgentsListRow, AgentStatusEvent } from '../../model/index.ts'
import type { WorkspaceRow } from './model.ts'

export type AgentsCase = {
  now: number
  workspaceList: { workspaces: WorkspaceRow[]; truncated: boolean }
  /** By workspace id: the answer, or "error" when the call rejects. */
  agentsList: Record<string, { agents: AgentsListRow[] } | string>
  events: AgentStatusEvent[]
}

export class DemoHostError extends Error {
  code = 'unavailable'
  retryable = true
}

/** `agents.list` for one workspace id, as the case says; throws for "error" and unknown ids. */
export function agentsListOf(c: AgentsCase, workspaceId: string | undefined): { agents: AgentsListRow[] } {
  const a = workspaceId ? c.agentsList[workspaceId] : undefined
  if (a && typeof a === 'object') return a
  throw new DemoHostError(a === 'error' ? 'The SSH host did not answer.' : `No workspace ${workspaceId ?? '(focused)'}.`)
}

/** The case moved so its newest time is `at` (screenshots then read "5m", not "3 years"). */
export function shiftCase(c: AgentsCase, at: number): AgentsCase {
  const d = at - c.now
  const t = (n: number) => n + d
  return {
    ...c,
    now: at,
    agentsList: Object.fromEntries(Object.entries(c.agentsList).map(([k, v]) => [k, typeof v === 'object' ? { agents: v.agents.map((a) => ({ ...a, stateStartedAt: t(a.stateStartedAt) })) } : v])),
    events: c.events.map((e) => ({ ...e, receivedAt: t(e.receivedAt), ...(e.mainAgent ? { mainAgent: { ...e.mainAgent, stateStartedAt: t(e.mainAgent.stateStartedAt) } } : {}) }))
  }
}

/**
 * `count` working agents in one local project, for the 50-row cap. `agents.list` answers at most
 * 50 agents per workspace, so they spread over workspaces of 30.
 */
export function manyAgentsCase(count: number, now: number): AgentsCase {
  const per = 30
  const workspaces: WorkspaceRow[] = []
  const agentsList: AgentsCase['agentsList'] = {}
  for (let w = 0; w * per < count; w++) {
    const id = `wt-bulk-${w + 1}`
    const n = Math.min(per, count - w * per)
    workspaces.push({ id, kind: 'worktree', name: `bulk runs ${w + 1}`, project: 'sample-batch', projectId: 'proj-batch', path: `/home/alex/code/sample-batch-${w + 1}`, branch: 'main', hostId: 'local', status: { state: 'working', unread: false, terminalCount: n, lastActivityAt: now } })
    agentsList[id] = {
      agents: Array.from({ length: n }, (_, j) => {
        const i = w * per + j
        return { terminalId: `term_bulk_${i}`, title: `Batch job ${String(i + 1).padStart(2, '0')}`, agent: 'claude', state: 'working' as const, stateStartedAt: now - (count - i) * 60_000, sessionId: null, task: null }
      })
    }
  }
  return { now, workspaceList: { workspaces, truncated: false }, agentsList, events: [] }
}
