// Funnel slice 4: the graph (PRD "Control Room funnel view", R5 graph, R9 pictures).
//
// Regia-style layout, left to right: You -> the bots that own work -> four stage columns. Each piece
// of work is a node in its stage column, wired to its bot; its workers and PRs sit on the node. The
// worker builds this from the funnel and sends it to the HTML panel, which only draws it: every
// position and every wire kind is decided here, so it is tested here.
//
// Pure: no Node modules, no CLI, no time. Bot text is already cut to one line by the funnel model;
// the page escapes it again before it draws.

import { STAGES, type Funnel, type Piece, type Stage } from '../funnel/model.ts'

/** Amber = waits on you (R4), blue = active, grey = done or not started. */
export type Wire = 'waiting' | 'active' | 'done'

export const STAGE_TITLE: Record<Stage, string> = { ideation: 'Ideation', planning: 'Planning', execution: 'Execution', shipping: 'Shipping' }
export const WIRE_LABEL: Record<Wire, string> = { waiting: 'Waits on you', active: 'Active', done: 'Done or not started' }

/** Each column shows this many nodes, then "+N more" (PRD section 5). */
export const COLUMN_CAP = 20

// Layout, in SVG units (the page draws 1:1 and scrolls sideways when the panel is narrow).
export const LAYOUT = {
  pad: 16,
  head: 40,
  you: { x: 16, w: 72, h: 72 },
  bot: { x: 128, w: 150, h: 52, gap: 14 },
  col: { x: 318, w: 196, gap: 20 },
  node: { h: 58, gap: 10 },
  more: { h: 26 }
} as const

export type GraphPr = { ref: string; url: string; state: 'open' | 'draft' | 'merged' | 'closed' }

export type GraphNode = {
  key: string
  title: string
  why: string
  stage: Stage
  wire: Wire
  botId: string | null
  x: number
  y: number
  w: number
  h: number
  /** Workers per state: what runs, what failed, what ended. */
  workers: { working: number; failed: number; ended: number }
  /** Up to 3 PRs, open ones first; `morePrs` counts the rest. */
  prs: GraphPr[]
  morePrs: number
  /** The first dispatch id of a working worker, for "open its terminal". */
  dispatchId: string | null
}

export type GraphBot = {
  id: string
  name: string
  /** One letter for the drawn fallback picture. */
  initial: string
  wire: Wire
  pieces: number
  waiting: number
  x: number
  y: number
  w: number
  h: number
}

export type GraphColumn = { stage: Stage; title: string; count: number; waiting: number; x: number; more: number; moreY: number }

export type GraphEdge = { from: string; to: string; wire: Wire; d: string }

export type DoingCard = { botId: string; botName: string; wire: Wire; key: string | null; title: string; line: string }

export type Graph = {
  width: number
  height: number
  you: { x: number; y: number; w: number; h: number; wire: Wire }
  bots: GraphBot[]
  columns: GraphColumn[]
  nodes: GraphNode[]
  /** Drawn first, so nodes sit on top. */
  edges: GraphEdge[]
  /** Waits no piece holds: an amber line above the graph. */
  unlinked: { key: string; label: string; who: string; what: string }[]
  /** "What the bots are doing": one card per bot that owns work. */
  doing: DoingCard[]
  empty: boolean
}

const RANK: Record<Wire, number> = { waiting: 0, active: 1, done: 2 }

/** The wire kind of one piece: amber when it waits on you, blue when it runs, grey otherwise. */
export function wireOf(p: Piece): Wire {
  if (p.amber) return 'waiting'
  if (p.stage === 'shipping') return 'done'
  if (p.stage === 'execution') return 'active'
  if (p.item?.status === 'working' || p.workers.some((w) => w.state === 'working')) return 'active'
  return 'done'
}

/** The strongest wire of a set: waiting beats active beats done. */
export function strongest(wires: readonly Wire[]): Wire {
  return wires.reduce<Wire>((a, b) => (RANK[b] < RANK[a] ? b : a), 'done')
}

/** One upper-case letter or digit from a name; `?` when it has none. */
export function initialOf(name: string): string {
  const m = /[\p{L}\p{N}]/u.exec(name)
  return m ? m[0].toLocaleUpperCase('en') : '?'
}

/** A smooth left-to-right wire from (x1, y1) to (x2, y2). */
export function wirePath(x1: number, y1: number, x2: number, y2: number): string {
  const r = (n: number) => Math.round(n * 10) / 10
  const bend = Math.max(24, (x2 - x1) * 0.45)
  return `M${r(x1)},${r(y1)} C${r(x1 + bend)},${r(y1)} ${r(x2 - bend)},${r(y2)} ${r(x2)},${r(y2)}`
}

const UNKNOWN_BOT = 'bot:none'
const botKey = (p: Piece): string => p.botId ?? (p.botName ? `name:${p.botName}` : UNKNOWN_BOT)

function prsOf(p: Piece): { prs: GraphPr[]; more: number } {
  const order: Record<GraphPr['state'], number> = { open: 0, draft: 1, merged: 2, closed: 3 }
  const all = [...p.prs].sort((a, b) => order[a.state] - order[b.state] || b.number - a.number)
  return { prs: all.slice(0, 3).map((x) => ({ ref: x.ref, url: x.url, state: x.state })), more: Math.max(0, all.length - 3) }
}

/** Builds the graph the HTML panel draws. `names` maps bot id -> name for bots the pieces name only by id. */
export function buildGraph(f: Funnel, names: Readonly<Record<string, string>> = {}): Graph {
  const L = LAYOUT
  const byKey = new Map(f.pieces.map((p) => [p.key, p]))

  // Bots that own work, in the order their first piece shows (amber first, by the columns' order).
  const botOrder: string[] = []
  const botPieces = new Map<string, Piece[]>()
  for (const stage of STAGES) {
    for (const key of f.columns[stage]) {
      const p = byKey.get(key)
      if (!p) continue
      const k = botKey(p)
      if (!botPieces.has(k)) {
        botPieces.set(k, [])
        botOrder.push(k)
      }
      botPieces.get(k)!.push(p)
    }
  }
  // Waiting bots first, then active, then the rest; ties keep the order above.
  const wireOfBot = (k: string) => strongest((botPieces.get(k) ?? []).map(wireOf))
  botOrder.sort((a, b) => RANK[wireOfBot(a)] - RANK[wireOfBot(b)])

  // Columns and nodes.
  const top = L.pad + L.head
  const columns: GraphColumn[] = []
  const nodes: GraphNode[] = []
  let tallest = 0
  STAGES.forEach((stage, i) => {
    const x = L.col.x + i * (L.col.w + L.col.gap)
    const keys = f.columns[stage]
    const shown = keys.slice(0, COLUMN_CAP)
    let y = top
    for (const key of shown) {
      const p = byKey.get(key)
      if (!p) continue
      const { prs, more } = prsOf(p)
      const working = p.workers.find((w) => w.state === 'working')
      nodes.push({
        key: p.key,
        title: p.title,
        why: p.why,
        stage,
        wire: wireOf(p),
        botId: botKey(p),
        x,
        y,
        w: L.col.w,
        h: L.node.h,
        workers: {
          working: p.workers.filter((w) => w.state === 'working').length,
          failed: p.failed.length,
          ended: p.workers.filter((w) => w.state !== 'working' && !p.failed.includes(w.dispatchId)).length
        },
        prs,
        morePrs: more,
        dispatchId: working?.dispatchId ?? null
      })
      y += L.node.h + L.node.gap
    }
    const more = Math.max(0, keys.length - shown.length)
    const moreY = y
    if (more) y += L.more.h + L.node.gap
    tallest = Math.max(tallest, y - top)
    const waiting = keys.filter((k) => byKey.get(k)?.amber).length
    columns.push({ stage, title: STAGE_TITLE[stage], count: keys.length, waiting, x, more, moreY })
  })

  // Bots, stacked in their own column and centred against the tallest stage column.
  const botsH = botOrder.length ? botOrder.length * L.bot.h + (botOrder.length - 1) * L.bot.gap : 0
  const bodyH = Math.max(tallest, botsH, L.you.h)
  const botTop = top + Math.max(0, (bodyH - botsH) / 2)
  const bots: GraphBot[] = botOrder.map((k, i) => {
    const ps = botPieces.get(k) ?? []
    const first = ps[0]
    const name = first?.botName ?? (first?.botId ? names[first.botId] : undefined) ?? (k === UNKNOWN_BOT ? 'No bot' : 'Bot')
    return {
      id: k,
      name,
      initial: initialOf(name),
      wire: wireOfBot(k),
      pieces: ps.length,
      waiting: ps.filter((p) => p.amber).length,
      x: L.bot.x,
      y: botTop + i * (L.bot.h + L.bot.gap),
      w: L.bot.w,
      h: L.bot.h
    }
  })
  const you = { x: L.you.x, y: top + (bodyH - L.you.h) / 2, w: L.you.w, h: L.you.h, wire: strongest(bots.map((b) => b.wire)) }

  // Wires: You -> each bot, each bot -> each of its shown nodes.
  const edges: GraphEdge[] = []
  const botAt = new Map(bots.map((b) => [b.id, b]))
  for (const b of bots) edges.push({ from: 'you', to: b.id, wire: b.wire, d: wirePath(you.x + you.w, you.y + you.h / 2, b.x, b.y + b.h / 2) })
  for (const n of nodes) {
    const b = n.botId ? botAt.get(n.botId) : undefined
    if (b) edges.push({ from: b.id, to: n.key, wire: n.wire, d: wirePath(b.x + b.w, b.y + b.h / 2, n.x, n.y + n.h / 2) })
  }
  // Grey under blue under amber, so the wires that matter are never hidden.
  edges.sort((a, b) => RANK[b.wire] - RANK[a.wire])

  // "What the bots are doing": each bot's most urgent piece, then its newest.
  const doing: DoingCard[] = bots.map((b) => {
    const ps = [...(botPieces.get(b.id) ?? [])].sort((x, y) => RANK[wireOf(x)] - RANK[wireOf(y)] || (y.updatedAt ?? 0) - (x.updatedAt ?? 0))
    const p = ps[0]
    return { botId: b.id, botName: b.name, wire: b.wire, key: p?.key ?? null, title: p?.title ?? '', line: p ? `${STAGE_TITLE[p.stage]}: ${p.why}` : '' }
  })

  const lastX = L.col.x + STAGES.length * (L.col.w + L.col.gap) - L.col.gap
  return {
    width: lastX + L.pad,
    height: top + bodyH + L.pad,
    you,
    bots,
    columns,
    nodes,
    edges,
    unlinked: f.unlinkedWaits.map((w) => ({ key: w.key, label: w.label, who: w.who, what: w.what })),
    doing,
    empty: f.pieces.length === 0
  }
}
