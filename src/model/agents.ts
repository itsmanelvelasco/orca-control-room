// Agents in terminal panes, from two sources:
// - the plugin API: `agents.list` and the `agent.status.changed` event (no CLI needed, R7);
// - `orca worktree ps --json`: every workspace with its open agents (the R5 fallback).
// Both map to one `Agent` type, so views do not care where a row came from.
// The same agent can come from all three sources; `mergeAgents` makes it one row.

import { bool, isRecord, numOrNull, oneOf, rows, str, strOrNull, type JsonRecord } from './envelope.ts'

/** The four states Orca's plugin API reports. `blocked` and `waiting` are waits on the user (R4). */
export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'
export const AGENT_STATES: readonly AgentState[] = ['working', 'blocked', 'waiting', 'done']

/** Orca's blocked reasons for a folder-trust dialog (Claude Code and Codex). Both mean "trust this folder". */
export const TRUST_REASONS: readonly string[] = ['agent-trust-workspace', 'codex-trust-workspace']

/**
 * R5, checked live on Orca 1.4.271 (Windows, 23/11/2026): at Claude Code's trust prompt the plugin's
 * `agent.status.changed` says `waiting`, with no reason. Only `worktree ps` names the prompt:
 * `programStatus: { state: 'blocked', kind: 'permission', message: 'trust this folder' }` always, and
 * `agentWait: { reason: 'agent-trust-workspace' }` with `--agent-wait`. So trust comes from `worktree ps`.
 */
export const TRUST_MESSAGE = 'trust this folder'

export type AgentSource = 'agents.list' | 'agent.status.changed' | 'worktree ps'

export type Agent = {
  /**
   * Stable key: the pane key when known, else the terminal id. One source alone may know only one
   * of them (`agents.list` has no pane key), so use `mergeAgents` before keying rows from several sources.
   */
  key: string
  paneKey: string | null
  terminalId: string | null
  /** Orca's workspace id, when Orca can tie the pane to one. */
  workspaceId: string | null
  title: string | null
  /** `claude`, `codex`, ... when known. */
  agentKind: string | null
  state: AgentState
  /** When it entered `state`, ms since epoch. */
  stateStartedAt: number | null
  /** The dispatched task title, if the agent is an orchestration worker. */
  taskTitle: string | null
  /** True when Orca says the agent waits at a folder-trust prompt. Set only from `worktree ps` (see TRUST_MESSAGE). */
  trustPrompt: boolean
  /** What the agent waits on, in Orca's words (e.g. "trust this folder"), from `worktree ps` programStatus. Untrusted. */
  waitMessage: string | null
  source: AgentSource
}

/** One row of `agents.list` from the plugin API. */
export type AgentsListRow = { terminalId: string | null; title: string | null; agent: string | null; state: AgentState; stateStartedAt: number; sessionId?: string | null; task?: { title: string } | null }

export function agentFromListRow(row: AgentsListRow, workspaceId: string | null): Agent | null {
  const key = row.terminalId
  if (!key) return null
  return { key, paneKey: null, terminalId: row.terminalId, workspaceId, title: row.title, agentKind: row.agent, state: oneOf(row.state, AGENT_STATES, 'working'), stateStartedAt: numOrNull(row.stateStartedAt), taskTitle: row.task?.title ?? null, trustPrompt: false, waitMessage: null, source: 'agents.list' }
}

/** The `agent.status.changed` payload (plugin API 1). */
export type AgentStatusEvent = {
  workspaceId: string | null
  workspaceListId?: string
  paneKey: string
  terminalId?: string
  title?: string
  state: AgentState
  receivedAt: number
  mainAgent?: { state: AgentState; outcome?: string; stateStartedAt: number }
  sessionId?: string
}

export function agentFromEvent(e: AgentStatusEvent): Agent {
  const raw = e as unknown as JsonRecord
  // The API has no reason field today; if a newer Orca adds one, a trust reason is read here.
  const reason = str(raw.reason) ?? str(raw.blockedReason)
  return {
    key: e.paneKey,
    paneKey: e.paneKey,
    terminalId: e.terminalId ?? null,
    workspaceId: e.workspaceId,
    title: e.title ?? null,
    agentKind: null,
    state: oneOf(e.state, AGENT_STATES, 'working'),
    stateStartedAt: e.mainAgent?.stateStartedAt ?? e.receivedAt,
    taskTitle: null,
    trustPrompt: reason !== undefined && TRUST_REASONS.includes(reason),
    waitMessage: null,
    source: 'agent.status.changed'
  }
}

// ---------- worktree ps ----------

/** A workspace from `worktree ps`, with its open agents. */
export type Worktree = {
  worktreeId: string
  repo: string | null
  path: string | null
  branch: string | null
  displayName: string | null
  archived: boolean
  /** The bot the workspace is under, if any. */
  bot: string | null
  lastActivityAt: number | null
  agents: Agent[]
}

function agentFromPs(a: JsonRecord, worktreeId: string): Agent | null {
  const paneKey = str(a.paneKey)
  if (!paneKey) return null
  const main = isRecord(a.mainAgent) ? a.mainAgent : {}
  const wait = isRecord(a.agentWait) ? a.agentWait : {}
  const program = isRecord(a.programStatus) ? a.programStatus : {}
  const reason = str(wait.reason) ?? str(a.blockedReason)
  const waitMessage = program.state === 'blocked' ? strOrNull(program.message) : null
  const trust = (reason !== undefined && TRUST_REASONS.includes(reason)) || waitMessage === TRUST_MESSAGE
  // `address` is the terminal handle (`term_…`) that agents.list and the event call terminalId.
  // An agent "open, no handle yet" has none.
  const address = str(a.address)
  return {
    key: paneKey,
    paneKey,
    terminalId: address && address.startsWith('term_') ? address : null,
    workspaceId: worktreeId,
    title: strOrNull(a.conversationName) ?? strOrNull(a.displayName),
    agentKind: strOrNull(a.agentType),
    state: oneOf(main.state ?? a.state, AGENT_STATES, 'working'),
    stateStartedAt: numOrNull(main.stateStartedAt) ?? numOrNull(a.stateStartedAt),
    taskTitle: strOrNull(a.taskTitle),
    trustPrompt: trust,
    waitMessage,
    source: 'worktree ps'
  }
}

export type WorktreePs = { worktrees: Worktree[]; totalCount: number; truncated: boolean }

export function parseWorktreePs(result: unknown): WorktreePs {
  const r = isRecord(result) ? result : {}
  const worktrees = rows(r.worktrees, (w): Worktree | null => {
    const worktreeId = str(w.worktreeId)
    if (!worktreeId) return null
    return {
      worktreeId,
      repo: strOrNull(w.repo),
      path: strOrNull(w.path),
      branch: strOrNull(w.branch),
      displayName: strOrNull(w.displayName),
      archived: bool(w.isArchived),
      bot: strOrNull(w.bot),
      lastActivityAt: numOrNull(w.lastActivityAt),
      agents: rows(w.agents, (a) => agentFromPs(a, worktreeId))
    }
  })
  return { worktrees, totalCount: numOrNull(r.totalCount) ?? worktrees.length, truncated: bool(r.truncated) }
}

/** Every agent across workspaces, flattened. */
export const allAgents = (ps: WorktreePs): Agent[] => ps.worktrees.flatMap((w) => w.agents)

/** True for an agent that waits on the user. */
export const agentWaits = (a: Agent): boolean => a.state === 'blocked' || a.state === 'waiting' || a.trustPrompt

// ---------- one row per agent ----------

/** True when two rows are the same agent: same pane key, or same terminal id. */
export function sameAgent(a: Agent, b: Agent): boolean {
  return (a.paneKey !== null && a.paneKey === b.paneKey) || (a.terminalId !== null && a.terminalId === b.terminalId)
}

/**
 * How much earlier than the merged state a `worktree ps` trust row may start and still count. The
 * event without `mainAgent` dates the state by when it arrived, a few hundred ms after Orca saw it.
 */
export const TRUST_SLACK_MS = 2_000

/** When two rows disagree on state and start at the same time, the live source wins. */
const SOURCE_RANK: Readonly<Record<AgentSource, number>> = { 'agent.status.changed': 3, 'agents.list': 2, 'worktree ps': 1 }

function fold(rowsOfOne: Agent[]): Agent {
  // State: the row that entered its state last (ties: event, then agents.list, then worktree ps).
  const latest = [...rowsOfOne].sort((x, y) => (y.stateStartedAt ?? -1) - (x.stateStartedAt ?? -1) || SOURCE_RANK[y.source] - SOURCE_RANK[x.source])[0]
  const first = <K extends keyof Agent>(k: K): Agent[K] => {
    for (const r of [latest, ...rowsOfOne]) if (r[k] !== null) return r[k]
    return latest[k]
  }
  const paneKey = first('paneKey')
  const terminalId = first('terminalId')
  const waiting = latest.state === 'waiting' || latest.state === 'blocked'
  // A trust prompt counts while the agent still waits in the same spell: a newer state (the prompt
  // was answered, then a later wait) drops it until the next `worktree ps` says so again.
  const current = (r: Agent): boolean => waiting && (r.stateStartedAt ?? 0) >= (latest.stateStartedAt ?? 0) - TRUST_SLACK_MS
  const trustPrompt = rowsOfOne.some((r) => r.trustPrompt && current(r))
  const waitMessage = rowsOfOne.find((r) => r.waitMessage !== null && current(r))?.waitMessage ?? null
  return {
    key: paneKey ?? terminalId ?? latest.key,
    paneKey,
    terminalId,
    workspaceId: first('workspaceId'),
    title: first('title'),
    agentKind: first('agentKind'),
    state: latest.state,
    stateStartedAt: latest.stateStartedAt,
    taskTitle: first('taskTitle'),
    trustPrompt,
    waitMessage,
    source: latest.source
  }
}

/**
 * One row per agent from any mix of `agents.list`, `agent.status.changed` and `worktree ps` rows.
 * Rows are the same agent when they share a pane key or a terminal id (transitively: a list row
 * that matches a ps row by terminal id joins the event row that matches that ps row by pane key).
 * The merged row takes its state from the row that entered its state last, ids and labels from any
 * row that has them, and `trustPrompt` from `worktree ps` while the agent still waits or is blocked.
 * Its `key` is the pane key when any row knows it, else the terminal id. Order: first seen.
 */
export function mergeAgents(...sources: readonly (readonly Agent[])[]): Agent[] {
  const groups: Agent[][] = []
  for (const row of sources.flat()) {
    const hits = groups.filter((g) => g.some((r) => sameAgent(r, row)))
    if (hits.length === 0) {
      groups.push([row])
      continue
    }
    const [into, ...rest] = hits
    into.push(row)
    for (const g of rest) {
      into.push(...g)
      groups.splice(groups.indexOf(g), 1)
    }
  }
  return groups.map(fold)
}

// ---------- automations list ----------

/** A scheduled automation (context for bots; not a wait). */
export type Automation = { id: string; name: string; botId: string | null; enabled: boolean; rrule: string | null; nextRunAt: number | null; lastRunAt: number | null }

export function parseAutomations(result: unknown): Automation[] {
  const r = isRecord(result) ? result : {}
  return rows(r.automations, (a): Automation | null => {
    const id = str(a.id)
    if (!id) return null
    const bot = isRecord(a.bot) ? a.bot : {}
    return { id, name: str(a.name) ?? id, botId: strOrNull(bot.botId), enabled: bool(a.enabled), rrule: strOrNull(a.rrule), nextRunAt: numOrNull(a.nextRunAt), lastRunAt: numOrNull(a.lastRunAt) }
  })
}
