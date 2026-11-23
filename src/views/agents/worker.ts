// Worker side of the Agents view (R7). Answers `agents.get` and `agents.open`, applies each
// `agent.status.changed` at once and posts `agents.changed`. It takes no CLI runner on purpose:
// the view must work with the Orca CLI missing.
import type { OrcaWorkerApi } from 'orca/worker'
import type { AgentStatusEvent } from '../../model/index.ts'
import { createAgentsRefresher, type AgentsHost } from './refresh.ts'

/** Posts after events wait this long, so a burst of events is one post. */
const POST_DEBOUNCE_MS = 250

export function registerAgents(orca: OrcaWorkerApi): void {
  // `agents.list` takes a workspace id since host API 1.10; before, it answers for the focused one.
  const perWorkspace = orca.api.major > 1 || orca.api.minor >= 10
  const host: AgentsHost = {
    listWorkspaces: () => orca.host.call('workspace.list', { includeStatus: true }),
    listAgents: (workspaceId) => orca.host.call('agents.list', { workspaceId }),
    focusedAgents: async () => {
      const ctx = await orca.host.call('workspace.readContext')
      const r = await orca.host.call('agents.list')
      return { workspaceId: ctx?.workspaceId ?? null, agents: r.agents }
    }
  }

  let pending: ReturnType<typeof setTimeout> | null = null
  const post = (): void => {
    if (pending) return
    pending = setTimeout(() => {
      pending = null
      orca.panels.post('agents.changed', agents.snapshot())
    }, POST_DEBOUNCE_MS)
    ;(pending as { unref?: () => void }).unref?.()
  }
  const agents = createAgentsRefresher({ host, perWorkspace, onChange: post })

  orca.panels.handle('agents.get', async (input) => {
    await agents.refresh(input?.force === true)
    return agents.snapshot()
  })

  // Read only: the one action is focus (a terminal) or open (a workspace). Takes only the row key.
  orca.panels.handle('agents.open', async (input) => {
    const key = input && typeof input.key === 'string' ? input.key : ''
    const t = agents.targetOf(key)
    if (!t) return { opened: false, reason: 'no_target' as const }
    try {
      if (t.kind === 'terminal') {
        const r = await orca.host.call('terminal.focus', { terminalId: t.terminalId })
        return r.focused ? { opened: true } : { opened: false, reason: 'failed' as const }
      }
      await orca.host.call('workspace.open', { workspaceId: t.workspaceId })
      return { opened: true }
    } catch (e) {
      orca.log(`agents.open failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
      return { opened: false, reason: 'failed' as const }
    }
  })

  orca.events.on('agent.status.changed', (e) => agents.onEvent(e as AgentStatusEvent))
}
