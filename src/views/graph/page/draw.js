// @ts-check
// Funnel slice 4: draws the graph the worker built, as HTML and SVG text. Pure: no DOM, no `orca`,
// no Node, so the tests import it as it is. Positions and wire kinds come from the worker
// (src/views/graph/model.ts); this file only turns them into markup.
//
// Every text from the worker is bot text and untrusted: it goes through `esc` (text and attributes)
// and is cut to fit. Pictures are used only when they are a `data:image/...;base64,` URL.

// Shapes: Graph, GraphNode, GraphBot in ../model.ts (the worker builds them).
/** @typedef {any} Graph */
/** @typedef {any} GraphNode */
/** @typedef {any} GraphBot */
/** @typedef {{ url: string, from: 'upload' | 'mascot' } | null} Picture */

export const WIRE_LABEL = /** @type {const} */ ({ waiting: 'Waits on you', active: 'Active', done: 'Done or not started' })
export const PICTURE_URL = /^data:image\/(png|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/
/** Only GitHub pull request pages open in the browser. */
export const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/

/** Escapes text for HTML and SVG, text and attribute values alike. */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c] ?? c)
}

/** One line, at most `n` characters, with "…" when cut. */
export function cut(v, n) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1)).trimEnd()}…` : s
}

/** A wire kind from the worker, or `done` when it is anything else. */
const wire = (/** @type {unknown} */ w) => (w === 'waiting' || w === 'active' ? w : 'done')
const num = (/** @type {unknown} */ n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : 0)

/** A path the worker made: only M, C and numbers. */
const PATH = /^[MC0-9.,\s-]+$/

/** The picture for a bot id, or null when there is none or it is not a safe data URL. */
export function pictureOf(/** @type {Record<string, Picture>} */ pictures, /** @type {string} */ id) {
  const p = pictures && Object.prototype.hasOwnProperty.call(pictures, id) ? pictures[id] : null
  return p && typeof p.url === 'string' && PICTURE_URL.test(p.url) ? p.url : null
}

/** A round bot picture at (cx, cy), or the bot's initial in a circle. */
function face(/** @type {string | null} */ url, /** @type {string} */ initial, /** @type {number} */ cx, /** @type {number} */ cy, /** @type {number} */ r) {
  const x = num(cx - r)
  const y = num(cy - r)
  const d = num(r * 2)
  if (url) return `<circle class="face-bg" cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}"/><image href="${esc(url)}" x="${x}" y="${y}" width="${d}" height="${d}" clip-path="url(#round)" preserveAspectRatio="xMidYMid slice"/>`
  return `<circle class="face-letter" cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}"/><text class="letter" x="${num(cx)}" y="${num(cy + r * 0.36)}" text-anchor="middle">${esc(cut(initial, 1) || '?')}</text>`
}

/** The short PR label: `#12`. */
export function prLabel(/** @type {string} */ ref) {
  const m = /#(\d+)$/.exec(String(ref ?? ''))
  return m ? `#${m[1]}` : 'PR'
}

/** One piece of work: its title, then chips for workers and PRs. */
function node(/** @type {GraphNode} */ n) {
  const w = wire(n.wire)
  const x = num(n.x)
  const y = num(n.y)
  const title = cut(n.title, 30)
  const chips = []
  if (n.workers?.working) chips.push({ cls: 'chip-run', text: `${n.workers.working} running`, attrs: n.dispatchId ? ` data-key="${esc(n.key)}" data-dispatch="${esc(n.dispatchId)}"` : '', tip: 'Open the worker terminal' })
  if (n.workers?.failed) chips.push({ cls: 'chip-fail', text: `${n.workers.failed} failed`, attrs: '', tip: 'A worker failed' })
  for (const pr of n.prs ?? []) {
    const ok = PR_URL.test(pr.url)
    chips.push({ cls: `chip-pr pr-${esc(pr.state)}`, text: `${prLabel(pr.ref)} ${pr.state}`, attrs: ok ? ` data-pr="${esc(pr.url)}"` : '', tip: ok ? `Open ${pr.ref} in the browser` : pr.ref })
  }
  if (n.morePrs) chips.push({ cls: 'chip-more', text: `+${n.morePrs}`, attrs: '', tip: `${n.morePrs} more PRs` })
  let cx = x + 12
  const chipY = y + 34
  const chipSvg = []
  for (const c of chips) {
    const width = 10 + c.text.length * 6.2
    if (cx + width > x + n.w - 6) break
    const press = c.attrs ? ` role="button" tabindex="0"` : ''
    chipSvg.push(`<g class="chip ${c.cls}"${c.attrs}${press}><title>${esc(c.tip)}</title><rect x="${num(cx)}" y="${chipY}" width="${num(width)}" height="16" rx="8"/><text x="${num(cx + 5)}" y="${chipY + 12}">${esc(c.text)}</text></g>`)
    cx += width + 5
  }
  const label = `${n.title} (${WIRE_LABEL[w]}). ${n.why}`
  return `<g class="node w-${w}" data-key="${esc(n.key)}" role="button" tabindex="0" aria-label="${esc(cut(label, 200))}"><title>${esc(cut(n.title, 200))}&#10;${esc(cut(n.why, 200))}</title>`
    + `<rect class="card" x="${x}" y="${y}" width="${num(n.w)}" height="${num(n.h)}" rx="8"/>`
    + `<rect class="bar" x="${x}" y="${y}" width="4" height="${num(n.h)}" rx="2"/>`
    + `<text class="title" x="${num(x + 12)}" y="${num(y + 21)}">${esc(title)}</text>`
    + `${chipSvg.join('')}</g>`
}

function bot(/** @type {GraphBot} */ b, /** @type {Record<string, Picture>} */ pictures) {
  const w = wire(b.wire)
  const x = num(b.x)
  const y = num(b.y)
  const r = 17
  const sub = b.waiting ? `${b.pieces} · ${b.waiting} waiting` : `${b.pieces} ${b.pieces === 1 ? 'piece' : 'pieces'}`
  return `<g class="bot w-${w}"><title>${esc(cut(b.name, 80))}</title>`
    + `<rect class="card" x="${x}" y="${y}" width="${num(b.w)}" height="${num(b.h)}" rx="${num(b.h / 2)}"/>`
    + face(pictureOf(pictures, b.id), b.initial, x + 8 + r, y + b.h / 2, r)
    + `<text class="name" x="${num(x + 2 * r + 16)}" y="${num(y + 22)}">${esc(cut(b.name, 13))}</text>`
    + `<text class="sub" x="${num(x + 2 * r + 16)}" y="${num(y + 38)}">${esc(sub)}</text></g>`
}

/** The whole graph as one SVG. */
export function graphSvg(/** @type {Graph} */ g, /** @type {Record<string, Picture>} */ pictures = {}) {
  const parts = []
  parts.push(`<svg class="graph" xmlns="http://www.w3.org/2000/svg" width="${num(g.width)}" height="${num(g.height)}" viewBox="0 0 ${num(g.width)} ${num(g.height)}" role="img" aria-label="You, the bots that own work, and each piece of work by stage">`)
  parts.push('<defs><clipPath id="round" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5"/></clipPath></defs>')
  for (const c of g.columns) {
    const waiting = c.waiting ? `<tspan class="col-wait"> · ${num(c.waiting)} waiting</tspan>` : ''
    parts.push(`<text class="col-title" x="${num(c.x)}" y="30">${esc(c.title)} <tspan class="col-count">${num(c.count)}</tspan>${waiting}</text>`)
  }
  for (const e of g.edges) if (PATH.test(e.d)) parts.push(`<path class="wire w-${wire(e.wire)}" d="${e.d}"/>`)
  const y = g.you
  parts.push(`<g class="you w-${wire(y.wire)}"><title>You</title><circle class="card" cx="${num(y.x + y.w / 2)}" cy="${num(y.y + y.h / 2)}" r="${num(y.w / 2)}"/><text class="you-text" x="${num(y.x + y.w / 2)}" y="${num(y.y + y.h / 2 + 5)}" text-anchor="middle">You</text></g>`)
  for (const b of g.bots) parts.push(bot(b, pictures))
  for (const n of g.nodes) parts.push(node(n))
  for (const c of g.columns) if (c.more) parts.push(`<text class="more" x="${num(c.x + 12)}" y="${num(c.moreY + 17)}">+${num(c.more)} more</text>`)
  if (g.empty) parts.push(`<text class="empty" x="${num(g.columns[0]?.x ?? 0)}" y="70">No work yet.</text>`)
  parts.push('</svg>')
  return parts.join('')
}

/** The legend under the graph: one sample wire per kind. */
export function legendHtml() {
  return /** @type {const} */ (['waiting', 'active', 'done'])
    .map((w) => `<span class="key"><svg width="34" height="10" aria-hidden="true"><path class="wire w-${w}" d="M1,5 L33,5"/></svg>${esc(WIRE_LABEL[w])}</span>`)
    .join('')
}

/** "Waits no piece holds": one pressable row each. */
export function unlinkedHtml(/** @type {Graph} */ g) {
  if (!g.unlinked?.length) return ''
  const rows = g.unlinked.slice(0, 10).map((w) => `<button type="button" class="unlinked-row" data-wait="${esc(w.key)}" title="Open where this waits on you"><b>${esc(cut(w.label, 24))}</b> ${esc(cut(w.who, 40))}: ${esc(cut(w.what, 90))}</button>`)
  const more = g.unlinked.length > 10 ? `<span class="muted">+${g.unlinked.length - 10} more</span>` : ''
  return `<h2>Unlinked waits</h2>${rows.join('')}${more}`
}

/** "What the bots are doing": one card per bot that owns work. */
export function doingHtml(/** @type {Graph} */ g, /** @type {Record<string, Picture>} */ pictures = {}) {
  if (!g.doing?.length) return ''
  const cards = g.doing.map((d) => {
    const url = pictureOf(pictures, d.botId)
    const pic = url ? `<img class="pic" alt="" src="${esc(url)}">` : `<span class="pic letter-pic" aria-hidden="true">${esc(cut(g.bots.find((b) => b.id === d.botId)?.initial ?? '?', 1))}</span>`
    const attrs = d.key ? ` data-key="${esc(d.key)}" role="button" tabindex="0" title="Open this work"` : ''
    return `<div class="doing-card w-${wire(d.wire)}"${attrs}>${pic}<div class="doing-text"><b>${esc(cut(d.botName, 40))}</b><span class="doing-title">${esc(cut(d.title, 80))}</span><span class="muted">${esc(cut(d.line, 100))}</span></div></div>`
  })
  return `<h2>What the bots are doing</h2><div class="doing-grid">${cards.join('')}</div>`
}
