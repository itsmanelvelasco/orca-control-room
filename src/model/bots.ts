// Bots, their items, their work and their chats.
// Sources: `bot list`, `bot item list --bot <id>`, `bot work list --bot <id>`, `bot chats --bot <id>`.

import { bool, isRecord, numOrNull, oneOf, rows, str, strOrNull, stringList, type JsonRecord } from './envelope.ts'

// ---------- bot list ----------

/** One bot on this computer. */
export type Bot = {
  /** UUID; the id every `--bot` takes. */
  id: string
  name: string
  /** The agent the bot runs on, e.g. `claude` or `codex`. */
  agent: string | null
  paused: boolean
  /** First paragraph of its SOUL.md. Untrusted text. */
  specialty: string | null
  chatCount: number
}

export function parseBotList(result: unknown): Bot[] {
  const r = isRecord(result) ? result : {}
  return rows(r.bots, (b): Bot | null => {
    const id = str(b.id)
    const name = str(b.name)
    if (!id || !name) return null
    const chats = isRecord(b.chats) ? b.chats : {}
    return { id, name, agent: strOrNull(b.agent), paused: bool(b.paused), specialty: strOrNull(b.specialty), chatCount: numOrNull(chats.count) ?? 0 }
  })
}

// ---------- bot item list ----------

/**
 * An item's status. Orca's store names `working`; the CLI prints `in_progress` for it, and this
 * model folds both into `working`. Anything newer reads as `unknown`.
 */
export type BotItemStatus = 'planned' | 'working' | 'needs_you' | 'done' | 'canceled' | 'unknown'
const ITEM_STATUSES: readonly BotItemStatus[] = ['planned', 'working', 'needs_you', 'done', 'canceled']

export function itemStatus(v: unknown): BotItemStatus {
  return v === 'in_progress' ? 'working' : oneOf(v, ITEM_STATUSES, 'unknown')
}

/** A worker's state as items and `bot work list` report it. */
export type WorkerRunState = 'working' | 'completed' | 'failed' | 'stopped' | 'unknown' | 'missing'
const WORKER_RUN_STATES: readonly WorkerRunState[] = ['working', 'completed', 'failed', 'stopped', 'unknown', 'missing']

/** A pull request as Orca last checked it. */
export type PullRequest = {
  /** `owner/repo#n`. */
  ref: string
  number: number
  url: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  /** `pending`, `success`, `failure`, `neutral`, or null. */
  checks: string | null
  /** `APPROVED`, `CHANGES_REQUESTED`, or null. */
  review: string | null
  title: string | null
}

export function parsePullRequest(v: unknown): PullRequest | null {
  if (!isRecord(v) || v.shown !== true) return null
  const ref = str(v.ref)
  const url = str(v.url)
  const number = numOrNull(v.number)
  if (!ref || !url || number === null) return null
  return { ref, number, url, state: oneOf(v.state, ['open', 'draft', 'merged', 'closed'] as const, 'open'), checks: strOrNull(v.checks), review: strOrNull(v.review), title: strOrNull(v.title) }
}

/** What an item links to: a worker (dispatch), a PR, a URL or a file. */
export type BotItemLink =
  | { kind: 'dispatch'; dispatchId: string; title: string | null; state: WorkerRunState; startedAt: number | null; settledAt: number | null; report: { subject: string; body: string | null } | null; pr: PullRequest | null }
  | { kind: 'pr'; ref: string; pr: PullRequest | null }
  | { kind: 'url'; ref: string }
  | { kind: 'file'; ref: string }

function parseLink(l: JsonRecord): BotItemLink | null {
  const ref = str(l.ref)
  if (!ref) return null
  switch (l.kind) {
    case 'dispatch': {
      const rep = isRecord(l.report) && typeof l.report.subject === 'string' ? { subject: l.report.subject, body: strOrNull(l.report.body) } : null
      return { kind: 'dispatch', dispatchId: ref, title: strOrNull(l.title), state: oneOf(l.state, WORKER_RUN_STATES, 'unknown'), startedAt: numOrNull(l.startedAt), settledAt: numOrNull(l.settledAt), report: rep, pr: parsePullRequest(l.pr) }
    }
    case 'pr':
      return { kind: 'pr', ref, pr: parsePullRequest(l.pr) }
    case 'url':
    case 'file':
      return { kind: l.kind, ref }
    default:
      return null
  }
}

/** One item on a bot's list. Status `needs_you` is a wait on the user (R4). */
export type BotItem = {
  /** UUID; stable key for the item. */
  uid: string
  /** Number shown to people, unique per bot. */
  number: number
  botId: string
  botName: string | null
  title: string
  description: string | null
  doneMeans: string | null
  status: BotItemStatus
  /** The open question when status is `needs_you`, with the answers it offers (if any). Untrusted text. */
  question: { eventId: string; text: string; options: string[] } | null
  /** The chat the item lives in; open it to answer. */
  chat: { id: string; kind: 'home' | 'chat' | 'thread' | 'automation'; title: string | null }
  links: BotItemLink[]
  snoozedUntil: number | null
  createdAt: number | null
  updatedAt: number | null
  lastActivityAt: number | null
  closedAt: number | null
}

/** The page `bot item list --bot <id>` prints. */
export type BotItemPage = { botId: string | null; botName: string | null; items: BotItem[]; counts: Record<string, number> }

export function parseBotItemList(result: unknown): BotItemPage {
  const r = isRecord(result) ? result : {}
  const counts: Record<string, number> = {}
  if (isRecord(r.counts)) for (const [k, v] of Object.entries(r.counts)) if (typeof v === 'number') counts[itemStatus(k)] = (counts[itemStatus(k)] ?? 0) + v
  const items = rows(r.items, (i): BotItem | null => {
    const uid = str(i.uid)
    const title = str(i.title)
    const number = numOrNull(i.number)
    if (!uid || title === undefined || number === null) return null
    const owner = isRecord(i.owner) ? i.owner : {}
    const chat = isRecord(i.chat) ? i.chat : {}
    const q = isRecord(i.question) && typeof i.question.text === 'string' ? { eventId: str(i.question.eventId) ?? '', text: i.question.text, options: stringList(i.question.options) } : null
    return {
      uid,
      number,
      botId: str(owner.botId) ?? str(r.botId) ?? '',
      botName: strOrNull(owner.name) ?? strOrNull(r.botName),
      title,
      description: strOrNull(i.description),
      doneMeans: strOrNull(i.doneMeans),
      status: itemStatus(i.status),
      question: q,
      chat: { id: str(chat.id) ?? '', kind: oneOf(chat.kind, ['home', 'chat', 'thread', 'automation'] as const, 'chat'), title: strOrNull(chat.title) },
      links: rows(i.links, parseLink),
      snoozedUntil: numOrNull(i.snoozedUntil),
      createdAt: numOrNull(i.createdAt),
      updatedAt: numOrNull(i.updatedAt),
      lastActivityAt: numOrNull(i.lastActivityAt),
      closedAt: numOrNull(i.closedAt)
    }
  })
  return { botId: strOrNull(r.botId), botName: strOrNull(r.botName), items, counts }
}

// ---------- bot work list ----------

/** One worker a bot started. */
export type BotWork = {
  /** Row id, as the CLI prints it. */
  id: string
  dispatchId: string | null
  title: string
  agent: string | null
  workspace: string | null
  server: string | null
  state: WorkerRunState | 'unverifiable'
  idle: boolean
  pr: PullRequest | null
  startedAt: number | null
  /** `app` when started from Orca, else the connector name (slack, github, ...). */
  source: string
}

export type BotWorkPage = { botName: string | null; items: BotWork[]; workspaces: { id: string; name: string | null; agent: string | null }[] }

export function parseBotWorkList(result: unknown): BotWorkPage {
  const r = isRecord(result) ? result : {}
  const items = rows(r.items, (w): BotWork | null => {
    const id = str(w.id)
    if (!id) return null
    const source = isRecord(w.source) ? str(w.source.source) : undefined
    return {
      id,
      dispatchId: strOrNull(w.dispatchId),
      title: str(w.title) ?? id,
      agent: strOrNull(w.agent),
      workspace: strOrNull(w.workspace),
      server: strOrNull(w.server),
      state: oneOf(w.state, [...WORKER_RUN_STATES, 'unverifiable'] as const, 'unknown'),
      idle: bool(w.idle),
      pr: parsePullRequest(w.pr),
      startedAt: numOrNull(w.startedAt),
      source: source ?? 'app'
    }
  })
  const workspaces = rows(r.workspaces, (w) => (str(w.id) ? { id: str(w.id) as string, name: strOrNull(w.name), agent: strOrNull(w.agent) } : null))
  return { botName: strOrNull(r.botName), items, workspaces }
}

// ---------- bot chats ----------

/** One chat of a bot. The id is what opens it. */
export type BotChat = {
  id: string
  title: string | null
  lastActivityAt: number | null
  /** What it was last asked and said; untrusted, possibly cut by the CLI. */
  lastAsked: string | null
  lastSaid: string | null
  home: boolean
  closed: boolean
}

export function parseBotChats(result: unknown): { bot: string | null; chats: BotChat[] } {
  const r = isRecord(result) ? result : {}
  const chats = rows(r.chats, (c): BotChat | null => {
    const id = str(c.id)
    if (!id) return null
    return { id, title: strOrNull(c.title), lastActivityAt: numOrNull(c.lastActivityAt), lastAsked: strOrNull(c.lastAsked), lastSaid: strOrNull(c.lastSaid), home: bool(c.home), closed: bool(c.closed) }
  })
  return { bot: strOrNull(r.bot), chats }
}

/** True for an item that waits on the user. */
export const itemNeedsYou = (item: BotItem): boolean => item.status === 'needs_you'

