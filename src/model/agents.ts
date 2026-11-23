// Agents in terminal panes, from two sources:
// - the plugin API: `agents.list` and the `agent.status.changed` event (no CLI needed, R7);
// - `orca worktree ps --json`: every workspace with its open agents (the R5 fallback).
// Both map to one `Agent` type, so views do not care where a row came from.

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
  /** Stable key: the pane key when known, else the terminal id. */
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
  return {
    key: paneKey,
    paneKey,
    terminalId: null,
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
