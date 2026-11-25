// Funnel slice 4 (PRD "Control Room funnel view", R5 graph, R6, R7, R9): the graph the worker builds
// for the HTML panel, the page's drawing (draw.js), and the panel's safety rules.
import { readFileSync } from 'node:fs'
import { assert, test } from 'orca/testing'
import { funnelFromCase } from '../src/views/funnel/demo.ts'
import { buildFunnel, STAGES, type Piece } from '../src/views/funnel/model.ts'
import { emptyFunnel } from '../src/views/funnel/refresh.ts'
import { buildGraph, COLUMN_CAP, initialOf, strongest, wireOf, wirePath, type Graph } from '../src/views/graph/model.ts'
// @ts-ignore: plain JS module of the page, loaded by the frame as it is.
import * as draw from '../src/views/graph/page/draw.js'
import { parseBotItemList } from '../src/model/index.ts'
import { fixture } from './helpers.ts'

const DEMO = fixture('cases/funnel-demo.json')
const NOW = DEMO.now as number
const demoGraph = (): { graph: Graph; pieces: Piece[] } => {
  const s = funnelFromCase(DEMO, NOW)
  return { graph: buildGraph(s.funnel), pieces: s.funnel.pieces }
}
/** n open items spread over `bots` bots; every 4th is being worked on when `working`. */
function ideas(n: number, bots: number, working = false) {
  const botId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  return Array.from({ length: bots }, (_, b) =>
    parseBotItemList({
      botId: botId(b),
      items: Array.from({ length: n }, (_, i) => i).filter((i) => i % bots === b).map((i) => ({ uid: `u${i}`, number: i + 1, title: `Idea ${i + 1}`, status: working && i % 4 === 0 ? 'in_progress' : 'planned', chat: { id: 'chat-1', kind: 'home' }, owner: { botId: botId(b), name: `Bot ${b}` }, links: [], createdAt: NOW - i * 1000 }))
    }).items
  ).flat()
}
const ROOT = new URL('../', import.meta.url)
const read = (p: string): string => readFileSync(new URL(p, ROOT), 'utf8')

// ---------- R5: layout ----------

test('R5 graph: You -> bots -> four stage columns; every piece is one node in its stage column, wired to its bot', () => {
  const { graph, pieces } = demoGraph()
  assert.deepEqual(graph.columns.map((c) => c.stage), [...STAGES])
  assert.deepEqual(graph.columns.map((c) => c.count), [2, 2, 3, 2])
  assert.equal(graph.nodes.length, pieces.length)
  for (const p of pieces) {
    const n = graph.nodes.find((x) => x.key === p.key)
    assert.ok(n, `no node for ${p.key}`)
    assert.equal(n.stage, p.stage)
    assert.equal(n.x, graph.columns.find((c) => c.stage === p.stage)!.x, 'a node sits in its stage column')
    const wires = graph.edges.filter((e) => e.to === p.key)
    assert.equal(wires.length, 1, `${p.key}: one wire from its bot`)
    assert.ok(graph.bots.some((b) => b.id === wires[0].from))
  }
  // Each bot has one wire from You, and You sits left of the bots, the bots left of the columns.
  for (const b of graph.bots) assert.equal(graph.edges.filter((e) => e.from === 'you' && e.to === b.id).length, 1)
  assert.ok(graph.you.x + graph.you.w < graph.bots[0].x)
  assert.ok(graph.bots[0].x + graph.bots[0].w < graph.columns[0].x)
  assert.ok(graph.width >= graph.columns[3].x + 196)
})

test('R5 graph: nodes in a column never overlap, and all fit inside the drawing', () => {
  const { graph } = demoGraph()
  for (const c of graph.columns) {
    const ns = graph.nodes.filter((n) => n.stage === c.stage).sort((a, b) => a.y - b.y)
    for (let i = 1; i < ns.length; i++) assert.ok(ns[i].y >= ns[i - 1].y + ns[i - 1].h, `${c.stage}: overlap`)
    for (const n of ns) assert.ok(n.y + n.h <= graph.height)
  }
  const bs = graph.bots
  for (let i = 1; i < bs.length; i++) assert.ok(bs[i].y >= bs[i - 1].y + bs[i - 1].h)
})

test('R5 wires: amber = waits on you, blue = active, grey = done or not started; a bot and You take their strongest', () => {
  const { graph, pieces } = demoGraph()
  for (const p of pieces) {
    const n = graph.nodes.find((x) => x.key === p.key)!
    if (p.amber) assert.equal(n.wire, 'waiting', p.key)
    else if (p.stage === 'shipping') assert.equal(n.wire, 'done', p.key)
    else if (p.stage === 'execution') assert.equal(n.wire, 'active', p.key)
  }
  assert.equal(strongest(['done', 'active', 'waiting']), 'waiting')
  assert.equal(strongest(['done', 'active']), 'active')
  assert.equal(strongest([]), 'done')
  assert.equal(graph.you.wire, 'waiting', 'the demo holds waits')
  for (const b of graph.bots) assert.equal(b.wire, strongest(graph.nodes.filter((n) => n.botId === b.id).map((n) => n.wire)))
  // Amber wires are drawn last, so nothing covers them.
  const kinds = graph.edges.map((e) => e.wire)
  assert.ok(kinds.lastIndexOf('done') < kinds.indexOf('waiting') || !kinds.includes('done'))
})

test('R5 wires: a planned item with nothing running is grey; one being worked on is blue', () => {
  const base = { key: 'item:x', kind: 'item', title: 'x', botId: 'b', botName: 'B', stage: 'planning', why: '', prd: null, prds: [], prs: [], prCount: { open: 0, merged: 0, closed: 0 }, prClosed: false, runIds: [], taskIds: [], gateIds: [], workers: [], failed: [], waits: [], amber: false, updatedAt: null } as const
  const item = { uid: 'x', number: 1, chatId: 'c', chatKind: 'home' } as const
  assert.equal(wireOf({ ...base, item: { ...item, status: 'planned' } } as unknown as Piece), 'done')
  assert.equal(wireOf({ ...base, item: { ...item, status: 'working' } } as unknown as Piece), 'active')
  assert.equal(wireOf({ ...base, item: null, workers: [{ dispatchId: 'd', state: 'working', taskId: null }] } as unknown as Piece), 'active')
  assert.equal(wireOf({ ...base, item: null, amber: true, stage: 'shipping' } as unknown as Piece), 'waiting')
})

test('R5 graph: "What the bots are doing" has one card per bot, its most urgent piece first', () => {
  const { graph, pieces } = demoGraph()
  assert.equal(graph.doing.length, graph.bots.length)
  for (const d of graph.doing) {
    const keys = new Set(graph.nodes.filter((n) => n.botId === d.botId).map((n) => n.key))
    const mine = pieces.filter((p) => keys.has(p.key))
    const p = pieces.find((x) => x.key === d.key)!
    assert.ok(mine.includes(p))
    if (mine.some((x) => x.amber)) assert.ok(p.amber, `${d.botName}: an amber piece comes first`)
    assert.ok(d.line.length > 0)
  }
})

test('R4 graph: waits no piece holds show as Unlinked waits', () => {
  const s = funnelFromCase(DEMO, NOW)
  const g = buildGraph(s.funnel)
  assert.equal(g.unlinked.length, s.funnel.unlinkedWaits.length)
  assert.ok(g.unlinked.length > 0, 'the demo has one')
  assert.match(draw.unlinkedHtml(g), /data-wait=/)
})

test('PRD section 5: each column shows 20 nodes, then "+N more"; 0 items gives four empty columns and "No work yet."', () => {
  const f = buildFunnel({ items: ideas(45, 3), works: [], runs: [], waits: [], now: NOW })
  const g = buildGraph(f)
  const idea = g.columns.find((c) => c.stage === 'ideation')!
  assert.equal(idea.count, 45)
  assert.equal(g.nodes.filter((n) => n.stage === 'ideation').length, COLUMN_CAP)
  assert.equal(idea.more, 45 - COLUMN_CAP)
  assert.match(draw.graphSvg(g), /\+25 more/)
  assert.equal(g.bots.length, 3)

  const empty = buildGraph(emptyFunnel())
  assert.equal(empty.empty, true)
  assert.equal(empty.columns.length, 4)
  assert.equal(empty.bots.length, 0)
  assert.match(draw.graphSvg(empty), /No work yet\./)
})

test('R8: building the graph for 60 bots and 240 pieces takes well under 50 ms', () => {
  const f = buildFunnel({ items: ideas(240, 60, true), works: [], runs: [], waits: [], now: NOW })
  const t0 = performance.now()
  const g = buildGraph(f)
  draw.graphSvg(g)
  const ms = performance.now() - t0
  assert.ok(ms < 50, `${ms} ms`)
  assert.equal(g.bots.length, 60)
})

test('helpers: initials, wire paths', () => {
  assert.equal(initialOf('outcompet'), 'O')
  assert.equal(initialOf('  42 bots'), '4')
  assert.equal(initialOf('***'), '?')
  assert.equal(initialOf('ñandú'), 'Ñ')
  assert.match(wirePath(0, 10, 100, 50), /^M0,10 C[\d.]+,10 [\d.]+,50 100,50$/)
})

// ---------- the page: draw.js ----------

const HOSTILE = '<img src=x onerror=alert(1)> "quoted" \'single\' `tick` & <script>alert(2)</script>'

function hostileGraph(): Graph {
  const { graph } = demoGraph()
  const g = structuredClone(graph)
  for (const n of g.nodes) {
    n.title = HOSTILE
    n.why = HOSTILE
  }
  for (const b of g.bots) b.name = HOSTILE
  for (const d of g.doing) {
    d.botName = HOSTILE
    d.title = HOSTILE
    d.line = HOSTILE
  }
  for (const u of g.unlinked) {
    u.who = HOSTILE
    u.what = HOSTILE
    u.label = HOSTILE
  }
  g.columns[0].title = HOSTILE
  return g
}

test('R7 / section 5: bot text is escaped everywhere the page draws it, never HTML', () => {
  const g = hostileGraph()
  const out = [draw.graphSvg(g), draw.doingHtml(g), draw.unlinkedHtml(g)].join('\n')
  assert.doesNotMatch(out, /<script/i)
  assert.doesNotMatch(out, /<img src=x/i)
  assert.match(out, /&lt;script&gt;/)
  assert.equal(draw.esc(`<a href="x" onclick='y'>&\``), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;')
})

test('R7: bot text is cut to one line', () => {
  assert.equal(draw.cut('one\ntwo\r\nthree\u2028four', 100), 'one two three four')
  assert.equal(draw.cut('abcdefghij', 5), 'abcd…')
})

test('R9 page: a picture is used only when it is a data:image URL; otherwise the bot initial is drawn', () => {
  const { graph } = demoGraph()
  const id = graph.bots[0].id
  const png = 'data:image/png;base64,iVBORw0KGgo='
  assert.match(draw.graphSvg(graph, { [id]: { url: png, from: 'upload' } }), /<image href="data:image\/png;base64,iVBORw0KGgo="/)
  for (const bad of ['https://example.com/a.png', 'javascript:alert(1)', 'data:text/html;base64,PGI+', 'data:image/svg+xml;utf8,<svg onload=alert(1)>', 'data:image/png;base64,abc"onload="x']) {
    const svg = draw.graphSvg(graph, { [id]: { url: bad, from: 'mascot' } })
    assert.doesNotMatch(svg, /<image /, bad)
    assert.doesNotMatch(draw.doingHtml(graph, { [id]: { url: bad, from: 'mascot' } }), /<img /, bad)
  }
  assert.match(draw.graphSvg(graph), new RegExp(`class="letter"[^>]*>${graph.bots[0].initial}<`))
})

test('R6 page: only GitHub PR links get a browser press; nodes press by key, workers by dispatch id', () => {
  const { graph } = demoGraph()
  const g = structuredClone(graph)
  const withPr = g.nodes.find((n) => n.prs.length)!
  assert.ok(withPr, 'the demo has a PR')
  const good = draw.graphSvg(g)
  assert.match(good, /data-pr="https:\/\/github\.com\/example-org\/[^"]+\/pull\/\d+"/)
  withPr.prs = withPr.prs.map((p) => ({ ...p, url: 'javascript:alert(1)' }))
  assert.doesNotMatch(draw.graphSvg(g), /data-pr="javascript/)
  for (const n of g.nodes) assert.match(draw.graphSvg(g), new RegExp(`data-key="${n.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))
  const running = g.nodes.find((n) => n.dispatchId)
  if (running) assert.match(draw.graphSvg(g), /data-dispatch="/)
  // A path that is not the worker's M/C numbers is never drawn.
  g.edges[0].d = 'M0,0" onmouseover="x'
  assert.doesNotMatch(draw.graphSvg(g), /onmouseover/)
})

test('R5 AC: the legend names the three wire kinds; the CSS stops every animation on reduced motion', () => {
  const legend = draw.legendHtml()
  for (const w of ['Waits on you', 'Active', 'Done or not started']) assert.ok(legend.includes(w))
  const css = read('src/views/graph/page/graph.css')
  const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([^}]*\})\s*\}/.exec(css)
  assert.ok(reduced, 'a reduced-motion block')
  assert.match(reduced[1], /animation:\s*none/)
  // Every animated rule is under a selector the reduced-motion block covers.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '')
  for (const m of rules.matchAll(/([^{}]+)\{[^}]*\banimation:\s*(?!none)[^;]+;/g)) {
    const sel = m[1].trim()
    assert.ok(/\.wire|\.node[^,]*\.card/.test(sel), `animated selector not covered: ${sel}`)
  }
  // Both themes define the wire colours.
  assert.match(css, /html\.dark \{[^}]*--amber:/)
  assert.match(css, /:root \{[^}]*--amber:/)
})

test('rules: the page makes no network call and touches no Node, file or storage API', () => {
  for (const f of ['src/views/graph/page/page.js', 'src/views/graph/page/draw.js', 'src/views/graph/page/index.html']) {
    const text = read(f).replace(/\/\/.*$/gm, '')
    assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\brequire\(|\bprocess\.|node:|import\(/, f)
    assert.doesNotMatch(text, /https?:\/\/(?!github\.com\\\/|www\.w3\.org\/2000\/svg)/, `${f}: no outside URL`)
  }
  const html = read('src/views/graph/page/index.html')
  assert.doesNotMatch(html, /<script(?![^>]*type="module" src="\.\/page\.js")/, 'one module script, no inline script')
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline handlers')
})
