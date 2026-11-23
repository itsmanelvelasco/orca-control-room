// Reads the agents from Orca's plugin API and keeps the Agents snapshot. No CLI here (R7).
//
// A full read: `workspace.list` (with status, to skip workspaces with no terminal), then
// `agents.list` per workspace, 4 at a time. Between reads, each `agent.status.changed` updates the
// snapshot at once. A full read is the truth: events older than its start are dropped after it.

import type { Agent, AgentsListRow, AgentStatusEvent } from '../../model/index.ts'
import { firstLine } from '../../model/index.ts'
import { buildGroups, cleanText, emptySnapshot, targetOf, type AgentsSnapshot, type AgentTarget, type WorkspaceRow } from './model.ts'

/** R9: agent states every 4 s. A panel asks that often; a read younger than this is reused. */
export const REFRESH_MS = 4_000
const REUSE_MS = 3_000
const POOL = 4

/** What the refresher needs from Orca. The worker wires it to `orca.host.call`. */
export type AgentsHost = {
  listWorkspaces(): Promise<{ workspaces: WorkspaceRow[]; truncated?: boolean }>
  /** `agents.list` for one workspace (host API 1.10). */
  listAgents(workspaceId: string): Promise<{ agents: AgentsListRow[] }>
  /** Older Orca: `agents.list` with no id answers for the focused workspace only. */
  focusedAgents?(): Promise<{ workspaceId: string | null; agents: AgentsListRow[] }>
}

export type AgentsRefresher = {
  snapshot(): AgentsSnapshot
  /** Starts a full read unless one runs or the last is younger than 3 s (`force` skips that). */
  refresh(force?: boolean): Promise<void>
  /** Applies one `agent.status.changed` at once. */
  onEvent(e: AgentStatusEvent): void
  /** Where a click on the row `key` goes. */
  targetOf(key: string): AgentTarget | null
}

const message = (e: unknown): string => cleanText(firstLine(e instanceof Error ? e.message : String(e)), 200) || 'Orca did not answer.'

export function createAgentsRefresher(opts: { host: AgentsHost; onChange?: (s: AgentsSnapshot) => void; now?: () => number; perWorkspace?: boolean }): AgentsRefresher {
  const now = opts.now ?? Date.now
  const perWorkspace = opts.perWorkspace ?? true
  let snap = emptySnapshot()
  let workspaces: WorkspaceRow[] = []
  let listed = new Map<string, AgentsListRow[]>()
  /** Latest event per pane, with when this worker got it. */
  const events = new Map<string, { e: AgentStatusEvent; at: number }>()
  let agents: Agent[] = []
  let running: Promise<void> | null = null
  let lastRead = -Infinity

  const rebuild = (patch: Partial<AgentsSnapshot>): void => {
    const built = buildGroups({ workspaces, listed, events: [...events.values()].map((x) => x.e) })
    agents = built.agents
    snap = { ...snap, ...patch, groups: built.groups, total: built.total }
    opts.onChange?.(snap)
  }

  const read = async (): Promise<void> => {
    const started = now()
    let ws: WorkspaceRow[]
    try {
      ws = (await opts.host.listWorkspaces()).workspaces ?? []
    } catch (e) {
      // Keep the last good groups; say why they may be old.
      snap = { ...snap, status: snap.updatedAt === null ? 'error' : 'ok', error: message(e) }
      opts.onChange?.(snap)
      return
    }
    const next = new Map<string, AgentsListRow[]>()
    const stale: string[] = []
    if (perWorkspace) {
      // A workspace Orca says has no terminal has no agent.
      const todo = ws.filter((w) => !w.status || w.status.terminalCount > 0)
      let i = 0
      const worker = async (): Promise<void> => {
        while (i < todo.length) {
          const w = todo[i++]
          try {
            next.set(w.id, (await opts.host.listAgents(w.id)).agents ?? [])
          } catch {
            stale.push(cleanText(w.name, 80) || w.id)
            const old = listed.get(w.id)
            if (old) next.set(w.id, old)
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(POOL, todo.length) }, worker))
    } else if (opts.host.focusedAgents) {
      try {
        const f = await opts.host.focusedAgents()
        if (f.workspaceId) next.set(f.workspaceId, f.agents)
      } catch {
        // Events still fill the view.
      }
    }
    workspaces = ws
    listed = next
    for (const [k, x] of events) if (x.at < started) events.delete(k)
    lastRead = now()
    rebuild({ status: 'ok', updatedAt: lastRead, error: null, stale: stale.sort() })
  }

  return {
    snapshot: () => snap,
    refresh(force = false) {
      if (running) return running
      if (!force && now() - lastRead < REUSE_MS) return Promise.resolve()
      running = read().finally(() => {
        running = null
      })
      return running
    },
    onEvent(e) {
      if (!e || typeof e.paneKey !== 'string') return
      events.set(e.paneKey, { e, at: now() })
      rebuild({})
    },
    targetOf(key) {
      const a = agents.find((x) => x.key === key)
      return a ? targetOf(a, workspaces) : null
    }
  }
}
