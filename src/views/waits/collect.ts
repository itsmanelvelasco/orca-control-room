// R4: the "Waits on you" list. A pure function of what the sources last said, so the fixture
// test can measure recall and precision on it directly.
//
// A wait is one of:
// - a bot item with status Needs you (its question and options);
// - a pending gate;
// - an agent that is blocked or waiting, or at a folder-trust prompt (R5: named by `worktree ps`).
// The same wait seen through two sources is shown once (PRD 5):
// - an item linked to the dispatch of a task with a pending gate merges into that gate's row;
// - the worker agent of a gated task merges into that gate's row;
// - one agent seen by `worktree ps` and by `agent.status.changed` is one row (model's mergeAgents).

import { agentWaits, itemNeedsYou, mergeAgents, type Agent, type BotItem, type Gate, type Task, type Worker, type Worktree } from '../../model/index.ts'
import { clean, cleanOptions, MAX } from './text.ts'

export type WaitKind = 'question' | 'gate' | 'agent'

/** Where a click goes. The worker resolves it; the panel only sends the wait's key. */
export type WaitTarget = { kind: 'terminal'; terminalId: string } | { kind: 'workspace'; workspaceId: string }

export type Wait = {
  /** Stable row key: `item:<uid>`, `task:<taskId>` or `agent:<id>`. */
  key: string
  /** Changes when the wait is new again (a new question, a new block); notifications key on it. */
  notifyId: string
  kind: WaitKind
  /** Who waits: a bot, a task, an agent. Cleaned. */
  who: string
  /** On what: the question, or what the agent waits on. Cleaned. */
  what: string
  /** Answers offered, cleaned. */
  options: string[]
  /** Short label: "Needs you", "Gate", "trust this folder", "Blocked", "Waiting". */
  label: string
  /** Since when, ms since epoch. */
  since: number | null
  target: WaitTarget | null
  /** Which sources saw it, for the merge tests. */
  sources: ('item' | 'gate' | 'agent')[]
}

export type WaitSources = {
  /** Open items of every bot. */
  items: readonly BotItem[]
  /** Gates, tasks and workers of every Run. */
  gates: readonly Gate[]
  tasks: readonly Task[]
  workers: readonly Worker[]
  /** `worktree ps --agent-wait`. */
  worktrees: readonly Worktree[]
  /** The newest `agent.status.changed` per pane, as Agents. */
  events: readonly Agent[]
  /** When this worker first saw each gate (gates carry no time). */
  firstSeen?: ReadonlyMap<string, number>
}

export const TRUST_LABEL = 'trust this folder'

// ---------- the list ----------

const itemSince = (i: BotItem): number | null => i.lastActivityAt ?? i.updatedAt ?? i.createdAt
const minTime = (...ts: (number | null | undefined)[]): number | null => {
  const xs = ts.filter((t): t is number => typeof t === 'number')
  return xs.length ? Math.min(...xs) : null
}

/** Every wait on the user, newest first. */
export function collectWaits(src: WaitSources): Wait[] {
  const out = new Map<string, Wait>()
  const tasks = new Map(src.tasks.map((t) => [t.id, t]))
  const workerOf = (taskId: string): Worker | undefined => {
    const t = tasks.get(taskId)
    const ws = src.workers.filter((w) => w.taskId === taskId || (t?.dispatchId && w.dispatchId === t.dispatchId))
    return ws.find((w) => w.dispatchId === t?.dispatchId) ?? ws[ws.length - 1]
  }
  const worktreeName = new Map(src.worktrees.map((w) => [w.worktreeId, w.displayName ?? w.branch ?? w.repo]))
  const botHome = (botName: string | null): string | null => (botName ? (src.worktrees.find((w) => w.bot === botName)?.worktreeId ?? null) : null)

  // Gates first: items and agents may merge into them.
  /** dispatch id or terminal id -> the gate row key that owns it. */
  const gatedBy = new Map<string, string>()
  for (const g of src.gates) {
    if (g.status !== 'pending') continue
    const task = tasks.get(g.taskId)
    const worker = workerOf(g.taskId)
    let key = `task:${g.taskId}`
    if (out.has(key)) key = `task:${g.taskId}:${g.id}`
    const terminal = task?.assignee ?? worker?.terminal ?? null
    const live = worker ? worker.liveness !== 'gone' : !!task?.assignee
    const target: WaitTarget | null = terminal && live ? { kind: 'terminal', terminalId: terminal } : worker?.workspace ? { kind: 'workspace', workspaceId: worker.workspace } : null
    out.set(key, {
      key,
      notifyId: `gate:${g.id}`,
      kind: 'gate',
      who: clean(task?.title ?? g.taskId, MAX.who),
      what: clean(g.question, MAX.what) || 'A decision is needed',
      options: cleanOptions(g.options),
      label: 'Gate',
      since: src.firstSeen?.get(g.id) ?? null,
      target,
      sources: ['gate']
    })
    for (const id of [task?.dispatchId, worker?.dispatchId, task?.assignee, worker?.terminal]) if (id) gatedBy.set(id, key)
  }

  for (const item of src.items) {
    if (!itemNeedsYou(item)) continue
    const linked = item.links.map((l) => (l.kind === 'dispatch' ? gatedBy.get(l.dispatchId) : undefined)).find((k) => k !== undefined)
    if (linked) {
      const row = out.get(linked)
      if (row) {
        row.sources.push('item')
        row.since = minTime(row.since, itemSince(item))
        if (row.options.length === 0 && item.question) row.options = cleanOptions(item.question.options)
      }
      continue
    }
    const home = botHome(item.botName)
    out.set(`item:${item.uid}`, {
      key: `item:${item.uid}`,
      notifyId: `item:${item.uid}:${item.question?.eventId ?? ''}`,
      kind: 'question',
      who: clean(item.botName ?? 'A bot', MAX.who),
      what: clean(item.question?.text ?? item.title, MAX.what) || clean(item.title, MAX.what),
      options: cleanOptions(item.question?.options ?? []),
      label: 'Needs you',
      since: itemSince(item),
      target: home ? { kind: 'workspace', workspaceId: home } : null,
      sources: ['item']
    })
  }

  const agents = mergeAgents(src.worktrees.flatMap((w) => w.agents), src.events)
  for (const a of agents) {
    if (!agentWaits(a)) continue
    const merged = (a.terminalId && gatedBy.get(a.terminalId)) || undefined
    if (merged) {
      const row = out.get(merged)
      if (row) {
        row.sources.push('agent')
        row.since = minTime(row.since, a.stateStartedAt)
        if (a.terminalId) row.target = { kind: 'terminal', terminalId: a.terminalId }
      }
      continue
    }
    const id = a.terminalId ?? a.paneKey ?? a.key
    const place = a.workspaceId ? worktreeName.get(a.workspaceId) : null
    const name = a.title ?? a.agentKind ?? 'Agent'
    const label = a.trustPrompt ? TRUST_LABEL : a.state === 'blocked' ? 'Blocked' : 'Waiting'
    const what = a.trustPrompt ? `Asks you to ${TRUST_LABEL}` : a.waitMessage ?? (a.state === 'blocked' ? 'Blocked on you' : 'Waiting for your input')
    out.set(`agent:${id}`, {
      key: `agent:${id}`,
      notifyId: `agent:${id}:${a.trustPrompt ? 'trust' : a.state}:${a.stateStartedAt ?? ''}`,
      kind: 'agent',
      who: clean(place ? `${name} · ${place}` : name, MAX.who),
      what: clean(what, MAX.what),
      options: [],
      label,
      since: a.stateStartedAt,
      target: a.terminalId ? { kind: 'terminal', terminalId: a.terminalId } : a.workspaceId ? { kind: 'workspace', workspaceId: a.workspaceId } : null,
      sources: ['agent']
    })
  }

  return [...out.values()].sort((a, b) => (b.since ?? -1) - (a.since ?? -1) || a.key.localeCompare(b.key))
}
