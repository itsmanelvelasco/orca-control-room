// Funnel slice 1: the funnel model (PRD "Control Room funnel view", R1-R4, R8).
//
// One piece of work = one bot item (R1). Runs, tasks, workers, gates and PRs join the item they
// belong to; a Run with no item is its own piece. Each piece gets one stage (R3) and the waits on
// the user it holds (R4). Pure: it takes what the CLI already printed (parsed by src/model) and the
// v1 Waits list, and returns plain JSON. No CLI calls, no Node modules, no time but `now`.
//
// Join rules, in order:
//  1. An item claims the dispatch ids of its `dispatch` links.
//  2. A task belongs to the item that claims its current Dispatch or any of its workers' Dispatches.
//  3. A Run joins the one item its tasks point at. Tasks pointing at two or more items split the
//     Run: those tasks go to their items, the Run and its other tasks become their own piece.
//     A Run whose tasks point only at items that left the view (canceled, done over 7 days)
//     leaves with them. A Run whose tasks point at no item joins the one open item that names its
//     PRD (R2); a PRD shared by several items leaves the Run on its own (one PRD, several pieces).
//  4. A bot worker (`bot work list`) follows its Dispatch; with no match and a PR it is its own piece.
//  5. A PR (by URL) belongs to the first piece that names it, in the order items, Runs, workers.
//
// A Run on its own whose tasks all finished is done, like a done item: Shipping, and it leaves
// 7 days after its newest worker started. Runs carry no time, so with no known time it stays.

import { isWorkerFailed, type BotItem, type BotItemLink, type BotWork, type Gate, type PullRequest, type Run, type Task, type Worker } from '../../model/index.ts'
import { cleanText } from '../line/model.ts'
import type { Wait } from '../waits/collect.ts'

// ---------- types ----------

export type Stage = 'ideation' | 'planning' | 'execution' | 'shipping'
export const STAGES: readonly Stage[] = ['ideation', 'planning', 'execution', 'shipping']

/** A done item stays in Shipping this long after it closed, then leaves the view (R3). */
export const DONE_KEEP_MS = 7 * 24 * 60 * 60 * 1000

/** Where a piece's PRD link was found (R2). */
export type PrdSource = 'link' | 'description' | 'run'

/** One Run as the CLI gave it. Same shape as the Shipping line's input, without run-show. */
export type FunnelRun = { run: Run; tasks: readonly Task[]; workers: readonly Worker[]; gates: readonly Gate[] }

export type FunnelInput = {
  /** Every item of every bot the CLI listed. Canceled and old done items leave the view. */
  items: readonly BotItem[]
  /** `bot work list` rows of every bot. */
  works: readonly BotWork[]
  runs: readonly FunnelRun[]
  /** v1's Waits list (collectWaits), so the funnel shows the same waits (R4 AC). */
  waits: readonly Wait[]
  /** ms since epoch. */
  now: number
}

/** A worker as the funnel sees it, whichever source reported it. */
export type WorkerState = 'working' | 'done' | 'failed' | 'stopped' | 'unknown'
export type FunnelWorker = { dispatchId: string; state: WorkerState; taskId: string | null }

export type FunnelPr = { url: string; ref: string; number: number; state: PullRequest['state'] }

export type Piece = {
  /** `item:<uid>`, `run:<runId>` or `work:<rowId>`. */
  key: string
  kind: 'item' | 'run' | 'work'
  /** One line, cut, plain text. Untrusted. */
  title: string
  botId: string | null
  botName: string | null
  item: { uid: string; number: number; status: BotItem['status']; chatId: string; chatKind: BotItem['chat']['kind'] } | null
  stage: Stage
  /** One short line on why the piece is in its stage. */
  why: string
  /** The piece's PRD (the newest one), and where it was found. */
  prd: { url: string; from: PrdSource } | null
  /** Every PRD link found, oldest first; the last is `prd`. */
  prds: string[]
  prs: FunnelPr[]
  prCount: { open: number; merged: number; closed: number }
  /** Every PR closed and none merged: the slice was dropped (card says "PR closed"). */
  prClosed: boolean
  /** Runs this piece holds. A split Run is held by its own piece only; its tasks still go to their items. */
  runIds: string[]
  taskIds: string[]
  gateIds: string[]
  workers: FunnelWorker[]
  /** Failed workers nothing has replaced yet. Amber (R4). */
  failed: string[]
  /** v1 waits held by this piece. Amber (R4). */
  waits: Wait[]
  amber: boolean
  /** ms since epoch, newest activity; null when no source says. */
  updatedAt: number | null
}

export type LeftReason = 'canceled' | 'done-over-7-days' | 'unbound' | 'legacy'

export type Funnel = {
  pieces: Piece[]
  /** Piece keys per stage: amber first, then newest first. */
  columns: Record<Stage, string[]>
  /** Waits no piece holds ("Unlinked waits" row). */
  unlinkedWaits: Wait[]
  /** What left the view, and why. With `pieces`, every input item, Run, task and gate is in one place. */
  left: { key: string; reason: LeftReason }[]
  /** Bot workers with no item, no Run and no PR: not a piece of work. */
  looseWorks: string[]
}

// ---------- R2: the PRD link ----------

const PRD_RE = /https?:\/\/(?:www\.)?claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/gi

/** Every PRD link in a text, oldest (first in the text) first, each once, as `https://claude.ai/...`. */
export function prdLinks(text: string | null | undefined): string[] {
  if (!text) return []
  const out: string[] = []
  for (const m of text.matchAll(PRD_RE)) {
    const path = m[0].replace(/^https?:\/\/(?:www\.)?claude\.ai/i, '')
    const url = `https://claude.ai${path}`
    const at = out.indexOf(url)
    if (at >= 0) out.splice(at, 1)
    out.push(url)
  }
  return out
}

/** An item's PRD links: from its `url` links if any, else from its description (R2 order). */
function itemPrds(item: BotItem): { links: string[]; from: PrdSource } | null {
  const fromLinks = prdLinks(item.links.filter((l) => l.kind === 'url').map((l) => l.ref).join('\n'))
  if (fromLinks.length) return { links: fromLinks, from: 'link' }
  const fromText = prdLinks(item.description)
  return fromText.length ? { links: fromText, from: 'description' } : null
}

// ---------- helpers ----------

type Draft = {
  piece: Piece
  /** Dispatch id -> best state seen and its source rank (orchestration 3 > work list 2 > item link 1). */
  workers: Map<string, FunnelWorker & { rank: number; startedAt: number | null }>
  prSeen: Map<string, FunnelPr>
  done: boolean
  hasRun: boolean
}

function emptyPiece(key: string, kind: Piece['kind'], title: string): Piece {
  return { key, kind, title, botId: null, botName: null, item: null, stage: 'ideation', why: '', prd: null, prds: [], prs: [], prCount: { open: 0, merged: 0, closed: 0 }, prClosed: false, runIds: [], taskIds: [], gateIds: [], workers: [], failed: [], waits: [], amber: false, updatedAt: null }
}

const linkState = (s: Extract<BotItemLink, { kind: 'dispatch' }>['state'] | BotWork['state']): WorkerState =>
  s === 'working' ? 'working' : s === 'completed' ? 'done' : s === 'failed' ? 'failed' : s === 'stopped' ? 'stopped' : 'unknown'

function orchState(w: Worker): WorkerState {
  if (isWorkerFailed(w)) return 'failed'
  switch (w.state) {
    case 'starting':
    case 'ready':
    case 'start_unknown':
      return 'working'
    case 'succeeded':
      return 'done'
    case 'stopping':
    case 'stop_unknown':
    case 'stopped':
    case 'abandoned':
      return 'stopped'
    default:
      return 'unknown'
  }
}

function addWorker(d: Draft, dispatchId: string, state: WorkerState, rank: number, taskId: string | null, startedAt: number | null = null): void {
  const prev = d.workers.get(dispatchId)
  if (prev && prev.rank > rank) {
    // A lower source keeps the better state out, but may still know the task or the start time.
    if (!prev.taskId && taskId) prev.taskId = taskId
    if (prev.startedAt === null) prev.startedAt = startedAt
    return
  }
  d.workers.set(dispatchId, { dispatchId, state, taskId: taskId ?? prev?.taskId ?? null, rank, startedAt: startedAt ?? prev?.startedAt ?? null })
}

const PR_RANK: Record<PullRequest['state'], number> = { draft: 0, open: 0, closed: 1, merged: 2 }

/** Task states that end a task. A Run on its own whose tasks are all here is finished. */
const FINISHED_TASK: ReadonlySet<Task['status']> = new Set(['completed', 'failed', 'circuit_broken'])

/** Task states where a failed worker still waits on the user, when no Dispatch is current. */
const STUCK_TASK: ReadonlySet<Task['status']> = new Set(['failed', 'blocked', 'circuit_broken'])

/** Why a piece with workers but no PRD, Run or PR is in Planning, worded from its workers. */
function workerWhy(ws: readonly FunnelWorker[]): string {
  if (ws.some((w) => w.state === 'failed')) return 'Worker failed, no PR'
  if (ws.some((w) => w.state === 'stopped')) return 'Worker stopped, no PR'
  return 'Worker finished, no PR'
}

const isHttps = (url: string): boolean => /^https:\/\/[^\s"'<>]+$/i.test(url)

const latest = (...ts: (number | null | undefined)[]): number | null => {
  const xs = ts.filter((t): t is number => typeof t === 'number')
  return xs.length ? Math.max(...xs) : null
}

/** The task id inside a gate wait's key (`task:<taskId>` or `task:<taskId>:<gateId>`). */
const taskOfWaitKey = (key: string): string | null => (key.startsWith('task:') ? (key.split(':')[1] ?? null) : null)

// ---------- R1, R3, R4: build ----------

export function buildFunnel(input: FunnelInput): Funnel {
  const drafts: Draft[] = []
  const left: Funnel['left'] = []
  const draftOf = new Map<string, Draft>()
  const newDraft = (key: string, kind: Piece['kind'], title: string): Draft => {
    const d: Draft = { piece: emptyPiece(key, kind, title), workers: new Map(), prSeen: new Map(), done: false, hasRun: false }
    drafts.push(d)
    draftOf.set(key, d)
    return d
  }

  // 1. Items, and the dispatch ids each claims.
  const byDispatch = new Map<string, Draft>()
  /** Dispatch ids of items that left the view, so their Runs and workers leave with them. */
  const leftDispatch = new Map<string, LeftReason>()
  const prsOfItem = new Map<Draft, PullRequest[]>()
  for (const item of input.items) {
    const key = `item:${item.uid}`
    const closed = item.closedAt ?? item.updatedAt ?? item.lastActivityAt
    const gone: LeftReason | null = item.status === 'canceled' ? 'canceled' : item.status === 'done' && closed !== null && input.now - closed > DONE_KEEP_MS ? 'done-over-7-days' : null
    if (gone) {
      left.push({ key, reason: gone })
      for (const l of item.links) if (l.kind === 'dispatch' && !leftDispatch.has(l.dispatchId)) leftDispatch.set(l.dispatchId, gone)
      continue
    }
    if (draftOf.has(key)) continue
    const d = newDraft(key, 'item', cleanText(item.title) || `Item ${item.number}`)
    const p = d.piece
    p.botId = item.botId || null
    p.botName = item.botName ? cleanText(item.botName, 60) : null
    p.item = { uid: item.uid, number: item.number, status: item.status, chatId: item.chat.id, chatKind: item.chat.kind }
    p.updatedAt = latest(item.lastActivityAt, item.updatedAt, item.createdAt, item.closedAt)
    d.done = item.status === 'done'
    const prd = itemPrds(item)
    if (prd) {
      p.prds = prd.links
      p.prd = { url: prd.links[prd.links.length - 1], from: prd.from }
    }
    const prs: PullRequest[] = []
    for (const l of item.links) {
      if (l.kind === 'dispatch') {
        if (!byDispatch.has(l.dispatchId)) byDispatch.set(l.dispatchId, d)
        // Only the item that claimed the dispatch counts its worker; its PR is shared by URL below.
        if (byDispatch.get(l.dispatchId) === d) addWorker(d, l.dispatchId, linkState(l.state), 1, null, l.startedAt)
        if (l.pr) prs.push(l.pr)
      } else if (l.kind === 'pr' && l.pr) prs.push(l.pr)
    }
    prsOfItem.set(d, prs)
  }

  // PRD -> the open items that name it, by every PRD link of the item (for rule 3's fallback).
  const byPrd = new Map<string, Set<Draft>>()
  for (const d of drafts) if (!d.done) for (const url of d.piece.prds) byPrd.set(url, (byPrd.get(url) ?? new Set()).add(d))

  // 2-3. Runs and their tasks, workers and gates.
  const pieceOfTask = new Map<string, Draft>()
  /** Terminal -> the pieces whose live task or worker runs in it. Terminals are reused, so only live ones count. */
  const piecesOfTerminal = new Map<string, Set<Draft>>()
  const piecesOfWorkspace = new Map<string, Set<Draft>>()
  const addTo = (m: Map<string, Set<Draft>>, k: string, d: Draft): void => void m.set(k, (m.get(k) ?? new Set()).add(d))
  const runPrsByDispatch: { d: Draft; dispatchId: string }[] = []
  /** Run pieces whose every task finished. */
  const finishedRuns = new Set<Draft>()
  for (const fr of input.runs) {
    const { run } = fr
    if (run.unbound || run.legacy) {
      left.push({ key: `run:${run.id}`, reason: run.unbound ? 'unbound' : 'legacy' })
      continue
    }
    const runPrd = prdLinks(run.objective)
    const workersOf = (t: Task): Worker[] => fr.workers.filter((w) => w.taskId === t.id || (t.dispatchId !== null && w.dispatchId === t.dispatchId))
    const idsOf = (t: Task): string[] => [t.dispatchId, ...workersOf(t).map((w) => w.dispatchId)].filter((x): x is string => !!x)
    const itemOfTask = new Map<string, Draft>()
    for (const t of fr.tasks) {
      const hit = idsOf(t).map((id) => byDispatch.get(id)).find((x) => x)
      if (hit) itemOfTask.set(t.id, hit)
    }
    const matched = new Set(itemOfTask.values())
    // A Run whose tasks point only at items that left the view leaves with them.
    if (matched.size === 0) {
      const pointed = fr.tasks.map(idsOf).filter((ids) => ids.length > 0)
      const reasons = pointed.map((ids) => ids.map((id) => leftDispatch.get(id)).find((r) => r))
      if (pointed.length > 0 && reasons.every((r) => r)) {
        left.push({ key: `run:${run.id}`, reason: reasons[0] as LeftReason })
        for (const w of fr.workers) if (!leftDispatch.has(w.dispatchId)) leftDispatch.set(w.dispatchId, reasons[0] as LeftReason)
        continue
      }
    }
    const prdItems = runPrd.length ? byPrd.get(runPrd[runPrd.length - 1]) : undefined
    let home: Draft
    if (matched.size === 1) home = [...matched][0]
    else if (matched.size === 0 && prdItems?.size === 1) home = [...prdItems][0]
    else {
      home = newDraft(`run:${run.id}`, 'run', cleanText(run.objective) || run.id)
      // A Run on its own is finished when every task is: completed, failed or circuit broken.
      if (fr.tasks.length > 0 && fr.tasks.every((t) => FINISHED_TASK.has(t.status))) finishedRuns.add(home)
    }
    home.hasRun = true
    home.piece.runIds.push(run.id)
    // R2, last place: an item with no PRD of its own takes its Run's.
    if (runPrd.length && !home.piece.prd) {
      home.piece.prds = runPrd
      home.piece.prd = { url: runPrd[runPrd.length - 1], from: 'run' }
    }

    const taskIds = new Set(fr.tasks.map((t) => t.id))
    for (const t of fr.tasks) {
      const d = itemOfTask.get(t.id) ?? home
      d.hasRun = true
      d.piece.taskIds.push(t.id)
      pieceOfTask.set(t.id, d)
      if (t.assignee && t.status === 'dispatched') addTo(piecesOfTerminal, t.assignee, d)
    }
    for (const w of fr.workers) {
      const d = (w.taskId && taskIds.has(w.taskId) ? pieceOfTask.get(w.taskId) : byDispatch.get(w.dispatchId)) ?? home
      addWorker(d, w.dispatchId, orchState(w), 3, w.taskId)
      if (!byDispatch.has(w.dispatchId)) byDispatch.set(w.dispatchId, d)
      if (w.terminal && (orchState(w) === 'working' || w.liveness === 'live')) addTo(piecesOfTerminal, w.terminal, d)
      if (w.workspace) addTo(piecesOfWorkspace, w.workspace, d)
      runPrsByDispatch.push({ d, dispatchId: w.dispatchId })
    }
    for (const g of fr.gates) {
      const d = pieceOfTask.get(g.taskId) ?? home
      d.piece.gateIds.push(g.id)
    }

    // A task's failed worker is amber while the task is not completed. With a current Dispatch, only
    // that worker counts (an older success does not hide a failed retry); with none, the task's own
    // status says whether it still waits (failed, blocked, circuit broken).
    for (const t of fr.tasks) {
      if (t.status === 'completed') continue
      const ws = workersOf(t)
      const current = t.dispatchId ? ws.find((w) => w.dispatchId === t.dispatchId) : undefined
      const failed = current ? (orchState(current) === 'failed' ? [current] : []) : STUCK_TASK.has(t.status) ? ws.filter((w) => orchState(w) === 'failed') : []
      const d = pieceOfTask.get(t.id) as Draft
      for (const w of failed) if (!d.piece.failed.includes(w.dispatchId)) d.piece.failed.push(w.dispatchId)
    }
  }

  // 4. Bot workers.
  const looseWorks: string[] = []
  const workPrs: { d: Draft; pr: PullRequest }[] = []
  for (const w of input.works) {
    let d = w.dispatchId ? byDispatch.get(w.dispatchId) : undefined
    // A worker of an item or Run that left the view leaves with it.
    const gone = w.dispatchId ? leftDispatch.has(w.dispatchId) : false
    if (!d && w.pr && !gone) d = newDraft(`work:${w.id}`, 'work', cleanText(w.title) || w.id)
    if (!d) {
      looseWorks.push(w.id)
      continue
    }
    if (w.dispatchId) addWorker(d, w.dispatchId, w.state === 'unverifiable' || w.state === 'missing' ? 'unknown' : linkState(w.state), 2, null, w.startedAt)
    else d.piece.updatedAt = latest(d.piece.updatedAt, w.startedAt)
    if (w.workspace) addTo(piecesOfWorkspace, w.workspace, d)
    if (w.pr) workPrs.push({ d, pr: w.pr })
  }
  const prByDispatch = new Map<string, PullRequest>()
  for (const w of input.works) if (w.dispatchId && w.pr && !prByDispatch.has(w.dispatchId)) prByDispatch.set(w.dispatchId, w.pr)

  // 5. PRs: the first piece that names a URL owns it.
  const prOwner = new Map<string, Draft>()
  const claim = (d: Draft, pr: PullRequest): void => {
    const url = isHttps(pr.url) ? pr.url : `pr:${pr.ref}`
    const owner = prOwner.get(url)
    if (owner && owner !== d) return
    const known = d.prSeen.get(url)
    if (known) {
      // The same PR twice in one piece (a pr link and a dispatch's PR): the furthest state wins.
      if (PR_RANK[pr.state] > PR_RANK[known.state]) known.state = pr.state
      return
    }
    prOwner.set(url, d)
    const line: FunnelPr = { url: isHttps(pr.url) ? pr.url : '', ref: cleanText(pr.ref, 80), number: pr.number, state: pr.state }
    d.prSeen.set(url, line)
    d.piece.prs.push(line)
  }
  for (const [d, prs] of prsOfItem) for (const pr of prs) claim(d, pr)
  for (const { d, dispatchId } of runPrsByDispatch) {
    const pr = prByDispatch.get(dispatchId)
    if (pr) claim(d, pr)
  }
  for (const { d, pr } of workPrs) claim(d, pr)

  // A Run piece's newest time is its workers' newest start (Runs carry no time of their own).
  for (const d of drafts) d.piece.updatedAt = latest(d.piece.updatedAt, ...[...d.workers.values()].map((w) => w.startedAt))

  // A finished Run on its own is done; done for over 7 days (when a time is known), it leaves.
  for (const d of finishedRuns) {
    d.done = true
    if (d.piece.updatedAt !== null && input.now - d.piece.updatedAt > DONE_KEEP_MS) {
      left.push({ key: d.piece.key, reason: 'done-over-7-days' })
      drafts.splice(drafts.indexOf(d), 1)
      draftOf.delete(d.piece.key)
      for (const [t, td] of pieceOfTask) if (td === d) pieceOfTask.delete(t)
      for (const m of [piecesOfTerminal, piecesOfWorkspace]) for (const s of m.values()) s.delete(d)
    }
  }

  // Failed item links nothing replaced: no later Dispatch on the item that works or finished. A
  // replacement with no start time counts as later: the order is unknown, and a false amber costs more.
  for (const d of drafts) {
    if (d.done && d.piece.kind === 'item') {
      d.piece.failed = []
      continue
    }
    const ws = [...d.workers.values()]
    for (const w of ws) {
      if (w.state !== 'failed' || w.taskId || d.piece.failed.includes(w.dispatchId)) continue
      const later = ws.some((o) => o !== w && (o.state === 'working' || o.state === 'done') && (o.startedAt === null || o.startedAt >= (w.startedAt ?? 0)))
      if (!later) d.piece.failed.push(w.dispatchId)
    }
  }

  // 6. R3: stage. A done piece counts only open PRs: a worker link can still read "working" after
  // the item closed.
  for (const d of drafts) {
    const p = d.piece
    p.workers = [...d.workers.values()].map(({ dispatchId, state, taskId }) => ({ dispatchId, state, taskId }))
    for (const pr of p.prs) {
      if (pr.state === 'open' || pr.state === 'draft') p.prCount.open++
      else if (pr.state === 'merged') p.prCount.merged++
      else p.prCount.closed++
    }
    const working = d.done ? 0 : p.workers.filter((w) => w.state === 'working').length
    const total = p.prs.length
    const done = p.kind === 'run' ? 'Run finished' : 'Done'
    p.prClosed = total > 0 && p.prCount.closed === total
    if (p.prCount.open > 0 || working > 0) {
      p.stage = 'execution'
      p.why = p.prCount.open > 0 ? (p.prCount.merged > 0 ? `${p.prCount.merged} of ${total} merged` : `${p.prCount.open} PR${p.prCount.open === 1 ? '' : 's'} open`) : `${working} worker${working === 1 ? '' : 's'} working`
    } else if (d.done) {
      p.stage = 'shipping'
      p.why = p.prCount.merged > 0 ? `${done}, ${p.prCount.merged} merged` : done
    } else if (p.prCount.merged > 0) {
      p.stage = 'shipping'
      p.why = `${p.prCount.merged} merged`
    } else if (p.prd || d.hasRun || p.workers.length > 0 || total > 0) {
      p.stage = 'planning'
      p.why = p.prClosed ? 'PR closed' : p.prd ? (p.prd.from === 'description' ? 'PRD found in description' : p.prd.from === 'run' ? "PRD found in the Run's objective" : 'PRD linked') : d.hasRun ? 'Run started' : workerWhy(p.workers)
    } else {
      p.stage = 'ideation'
      p.why = 'No PRD, Run, worker or PR yet'
    }
  }

  // 7. R4: attach each v1 wait to one piece, else to "Unlinked waits".
  const unlinkedWaits: Wait[] = []
  for (const w of input.waits) {
    let d: Draft | undefined
    if (w.key.startsWith('item:')) d = draftOf.get(w.key)
    else if (w.kind === 'gate') {
      const t = taskOfWaitKey(w.key)
      d = t ? pieceOfTask.get(t) : undefined
    }
    // A terminal or workspace two pieces claim is ambiguous: the wait goes to Unlinked waits.
    const only = (ds: Set<Draft> | undefined): Draft | undefined => (ds?.size === 1 ? [...ds][0] : undefined)
    if (!d && w.target?.kind === 'terminal') d = only(piecesOfTerminal.get(w.target.terminalId))
    if (!d && w.target?.kind === 'workspace') d = only(piecesOfWorkspace.get(w.target.workspaceId))
    if (d) d.piece.waits.push(w)
    else unlinkedWaits.push(w)
  }

  const pieces = drafts.map((d) => d.piece)
  for (const p of pieces) p.amber = p.waits.length > 0 || p.failed.length > 0
  const columns = { ideation: [], planning: [], execution: [], shipping: [] } as Record<Stage, string[]>
  const order = [...pieces].sort((a, b) => Number(b.amber) - Number(a.amber) || (b.updatedAt ?? -1) - (a.updatedAt ?? -1) || a.key.localeCompare(b.key))
  for (const p of order) columns[p.stage].push(p.key)
  return { pieces, columns, unlinkedWaits, left, looseWorks }
}
