// The Agents view (R7): every agent in every workspace, grouped by project, with its state and
// how long it has been in it. Built only from Orca's plugin API (`workspace.list`, `agents.list`,
// `agent.status.changed`), so it works with the Orca CLI missing.
//
// This file is pure: it turns what the host answered into the snapshot the panel draws.

import { agentFromEvent, agentFromListRow, mergeAgents, type Agent, type AgentState, type AgentStatusEvent, type AgentsListRow } from '../../model/index.ts'

/** The panel shows this many rows per group, then a "Show all" button (PRD edge case: 50+ rows). */
export const GROUP_CAP = 50
/** The worker never sends more rows than this per group, so one post stays far below 256 KiB. */
export const GROUP_HARD_CAP = 500

/** A workspace row of `workspace.list`, as far as this view needs it. */
export type WorkspaceRow = {
  id: string
  kind?: 'worktree' | 'folder'
  name: string
  project?: string | null
  projectId?: string | null
  path?: string
  branch?: string | null
  hostId: string | null
  status?: { state: string; unread: boolean; terminalCount: number; lastActivityAt: number | null }
}

/** One agent as the panel draws it. All text is cut and plain: the panel never renders HTML. */
export type AgentRow = {
  key: string
  title: string
  agentKind: string | null
  state: AgentState
  /** When it entered `state`, ms since epoch. */
  since: number | null
  workspace: string | null
  task: string | null
  /** True when a click can focus its terminal or open its workspace. */
  canOpen: boolean
}

export type AgentGroup = {
  key: string
  /** The project name, or "No project". */
  name: string
  /** Where the project lives when it is not this machine: `ssh box`, `paired server`. */
  host: string | null
  remote: boolean
  /** Agents in the group, before the hard cap. */
  total: number
  /** Agents that wait on the user (blocked or waiting). */
  waiting: number
  rows: AgentRow[]
}

export type AgentsSnapshot = {
  status: 'loading' | 'ok' | 'error'
  groups: AgentGroup[]
  total: number
  updatedAt: number | null
  /** One line when the last read failed; the last good groups stay. */
  error: string | null
  /** Workspaces whose `agents.list` failed on the last read; their last known agents stay. */
  stale: string[]
  /** `workspace.list` said it left workspaces out, so some agents may be missing. */
  truncated: boolean
}

export const emptySnapshot = (): AgentsSnapshot => ({ status: 'loading', groups: [], total: 0, updatedAt: null, error: null, stale: [], truncated: false })

/**
 * Untrusted text (titles, task titles, names) for one line: control characters out, first line
 * only, at most `max` characters. The panel shows it as text, never as HTML or Markdown.
 */
export function cleanText(text: string | null | undefined, max = 120): string {
  if (typeof text !== 'string') return ''
  // Control and invisible format characters (zero-width, bidi overrides) out; tabs become a space.
  // eslint-disable-next-line no-control-regex
  const line = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '').split(/\r?\n|\r/, 1)[0].replace(/\t+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** `local` and null are this machine; `ssh:box` and `runtime:…` (a paired Orca server) are not. */
export function hostLabel(hostId: string | null): string | null {
  if (!hostId || hostId === 'local') return null
  if (hostId.startsWith('ssh:')) return cleanText(`ssh ${hostId.slice(4)}`, 40)
  if (hostId.startsWith('runtime:')) return 'paired server'
  return cleanText(hostId, 40)
}

/** The id `workspace.list` gives an event's workspace: `workspaceListId`, always sent from API 1.7. */
export const eventWorkspaceId = (e: AgentStatusEvent): string | null => e.workspaceListId ?? e.workspaceId ?? null

/** An event row, tied to its workspace's `workspace.list` id. */
export function agentFromStatusEvent(e: AgentStatusEvent): Agent {
  return { ...agentFromEvent(e), workspaceId: eventWorkspaceId(e) }
}

/**
 * `terminalId` is optional on an event and `agents.list` rows have no pane key, so an event without
 * it could not merge and the agent would show twice. Such an event takes the terminal id of the one
 * list row in its workspace with the same title that no other event claims; with none or several,
 * it stays its own row (an agent the list has not shown yet).
 */
export function joinEvents(events: readonly AgentStatusEvent[], listed: ReadonlyMap<string, readonly AgentsListRow[]>): AgentStatusEvent[] {
  const claimed = new Set(events.map((e) => e.terminalId).filter((t): t is string => !!t))
  return events.map((e) => {
    if (e.terminalId || !e.title) return e
    const wsId = eventWorkspaceId(e)
    const hits = (wsId ? (listed.get(wsId) ?? []) : []).filter((r) => r.terminalId && r.title === e.title && !claimed.has(r.terminalId))
    if (hits.length !== 1) return e
    claimed.add(hits[0].terminalId!)
    return { ...e, terminalId: hits[0].terminalId! }
  })
}

/** Waits first, then work, then done. */
const STATE_ORDER: Readonly<Record<AgentState, number>> = { blocked: 0, waiting: 1, working: 2, done: 3 }

export const NO_PROJECT = 'No project'

export type BuildInput = {
  workspaces: readonly WorkspaceRow[]
  /** `agents.list` rows by workspace id. */
  listed: ReadonlyMap<string, readonly AgentsListRow[]>
  /** `agent.status.changed` payloads seen since the last full read. */
  events: readonly AgentStatusEvent[]
}

/**
 * One row per agent (list rows and events merged, see `mergeAgents`), grouped by project.
 * Groups: those with a wait first, then by name. Rows: blocked, waiting, working, done; in each
 * state the one in it longest first.
 */
export function buildGroups(input: BuildInput): { groups: AgentGroup[]; total: number; agents: Agent[] } {
  const byId = new Map(input.workspaces.map((w) => [w.id, w]))
  const listRows: Agent[] = []
  for (const [wsId, rows] of input.listed) {
    for (const r of rows) {
      const a = agentFromListRow(r, wsId)
      if (a) listRows.push(a)
    }
  }
  const agents = mergeAgents(listRows, joinEvents(input.events, input.listed).map(agentFromStatusEvent))

  const groups = new Map<string, AgentGroup & { all: AgentRow[] }>()
  for (const a of agents) {
    const ws = a.workspaceId ? byId.get(a.workspaceId) : undefined
    const projectName = cleanText(ws?.project) || NO_PROJECT
    const hostId = ws?.hostId ?? null
    const key = `${hostId ?? 'local'}|${ws?.projectId ?? (ws?.project ? `name:${ws.project}` : '-')}`
    let g = groups.get(key)
    if (!g) {
      g = { key, name: projectName, host: hostLabel(hostId), remote: hostLabel(hostId) !== null, total: 0, waiting: 0, rows: [], all: [] }
      groups.set(key, g)
    }
    g.total++
    if (a.state === 'blocked' || a.state === 'waiting') g.waiting++
    g.all.push({
      key: a.key,
      title: cleanText(a.title) || cleanText(a.agentKind) || 'Agent',
      agentKind: a.agentKind ? cleanText(a.agentKind, 24) : null,
      state: a.state,
      since: a.stateStartedAt,
      workspace: ws ? cleanText(ws.name, 80) || null : null,
      task: a.taskTitle ? cleanText(a.taskTitle) || null : null,
      canOpen: a.terminalId !== null || ws !== undefined
    })
  }

  const out: AgentGroup[] = [...groups.values()].map(({ all, ...g }) => ({
    ...g,
    rows: all.sort((x, y) => STATE_ORDER[x.state] - STATE_ORDER[y.state] || (x.since ?? Infinity) - (y.since ?? Infinity) || x.title.localeCompare(y.title)).slice(0, GROUP_HARD_CAP)
  }))
  out.sort((x, y) => Number(y.waiting > 0) - Number(x.waiting > 0) || Number(x.name === NO_PROJECT) - Number(y.name === NO_PROJECT) || x.name.localeCompare(y.name) || (x.host ?? '').localeCompare(y.host ?? ''))
  return { groups: out, total: agents.length, agents }
}

/** Where a click on a row goes: its terminal when known, else its workspace. */
export type AgentTarget = { kind: 'terminal'; terminalId: string } | { kind: 'workspace'; workspaceId: string }

export function targetOf(a: Agent, workspaces: readonly WorkspaceRow[]): AgentTarget | null {
  if (a.terminalId) return { kind: 'terminal', terminalId: a.terminalId }
  if (a.workspaceId && workspaces.some((w) => w.id === a.workspaceId)) return { kind: 'workspace', workspaceId: a.workspaceId }
  return null
}
