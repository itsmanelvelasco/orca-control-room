// Reads the agents from Orca's plugin API and keeps the Agents snapshot. No CLI here (R7).
// Needs plugin API 1.10 (Orca 1.4.260, the manifest's `engines.orca`): `agents.list` by workspace id.
//
// A full read: `workspace.list` (with status, to skip workspaces with no terminal), then
// `agents.list` per workspace, 4 at a time. Between reads, each `agent.status.changed` updates the
// snapshot at once. A full read is the truth for the workspaces it read: their events older than
// its start are dropped. Events of a workspace whose read failed stay, so a wait does not flip back.

import type { Agent, AgentsListRow, AgentStatusEvent } from '../../model/index.ts'
import { firstLine } from '../../model/index.ts'
import { buildGroups, cleanText, emptySnapshot, eventWorkspaceId, targetOf, type AgentsSnapshot, type AgentTarget, type WorkspaceRow } from './model.ts'

/** R9: agent states every 4 s. A panel asks that often; a read younger than this is reused. */
export const REFRESH_MS = 4_000
const REUSE_MS = 3_000
const POOL = 4

/** What the refresher needs from Orca. The worker wires it to `orca.host.call`. */
export type AgentsHost = {
  listWorkspaces(): Promise<{ workspaces: WorkspaceRow[]; truncated?: boolean }>
  /** `agents.list` for one workspace (plugin API 1.10). */
  listAgents(workspaceId: string): Promise<{ agents: AgentsListRow[] }>
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

export function createAgentsRefresher(opts: { host: AgentsHost; onChange?: (s: AgentsSnapshot) => void; now?: () => number }): AgentsRefresher {
  const now = opts.now ?? Date.now
  let snap = emptySnapshot()
  let workspaces: WorkspaceRow[] = []
  let listed = new Map<string, AgentsListRow[]>()
  /** Latest event per pane, with when this worker got it. */
  const events = new Map<string, { e: AgentStatusEvent; at: number }>()
  /** Terminal id per pane, learned from events that carry both, for later events that carry only the pane. */
  const paneTerminal = new Map<string, string>()
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
    let truncated: boolean
    try {
      const r = await opts.host.listWorkspaces()
      ws = r.workspaces ?? []
      truncated = r.truncated === true
    } catch (e) {
      // Keep the last good groups; say why they may be old.
      snap = { ...snap, status: snap.updatedAt === null ? 'error' : 'ok', error: message(e) }
      opts.onChange?.(snap)
      return
    }
    const next = new Map<string, AgentsListRow[]>()
    const failed = new Set<string>()
    // A workspace Orca says has no terminal has no agent.
    const todo = ws.filter((w) => !w.status || w.status.terminalCount > 0)
    let i = 0
    const worker = async (): Promise<void> => {
      while (i < todo.length) {
        const w = todo[i++]
        try {
          next.set(w.id, (await opts.host.listAgents(w.id)).agents ?? [])
        } catch {
          failed.add(w.id)
          const old = listed.get(w.id)
          if (old) next.set(w.id, old)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(POOL, todo.length) }, worker))
    workspaces = ws
    listed = next
    for (const [k, x] of events) {
      const wsId = eventWorkspaceId(x.e)
      if (x.at < started && !(wsId !== null && failed.has(wsId))) events.delete(k)
    }
    lastRead = now()
    const stale = ws.filter((w) => failed.has(w.id)).map((w) => cleanText(w.name, 80) || w.id)
    rebuild({ status: 'ok', updatedAt: lastRead, error: null, stale: stale.sort(), truncated })
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
      if (e.terminalId) paneTerminal.set(e.paneKey, e.terminalId)
      const known = e.terminalId ? e : paneTerminal.has(e.paneKey) ? { ...e, terminalId: paneTerminal.get(e.paneKey) } : e
      events.set(e.paneKey, { e: known, at: now() })
      rebuild({})
    },
    targetOf(key) {
      const a = agents.find((x) => x.key === key)
      return a ? targetOf(a, workspaces) : null
    }
  }
}
