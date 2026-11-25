// @ts-check
// Funnel slice 4: the glue of the Funnel graph panel. Asks the worker for the graph every second
// while the page is visible (the worker reads when one is due, about every 20 s, and answers null
// when nothing changed), asks for the bot pictures once a minute, draws with draw.js, and turns a
// press into a request. A press only opens or focuses (R6): nothing is written. No network, no
// files, no Node: only `orca.plugin.request` to the plugin's own worker, and the browser for a PR.
import { doingHtml, graphSvg, legendHtml, PR_URL, unlinkedHtml } from './draw.js'

const api = /** @type {any} */ (globalThis).orca
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))

const TICK_MS = 1_000
const PICTURES_MS = 60_000

/** @type {any} */
let snap = null
/** @type {Record<string, any>} */
let pictures = {}
let pictureSig = ''
let error = ''
let note = ''
/** @type {Record<string, string>} */
const drawn = {}

/** Sets an element's markup only when it changed, so focus and scroll stay put. */
function put(/** @type {string} */ id, /** @type {string} */ html) {
  if (drawn[id] === html) return
  const el = $(id)
  const focused = el.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).dataset.key : undefined
  drawn[id] = html
  el.innerHTML = html
  if (focused) /** @type {HTMLElement | null} */ (el.querySelector(`[data-key="${CSS.escape(focused)}"]`))?.focus({ preventScroll: true })
}

function ago(/** @type {number | null} */ at) {
  if (!at) return 'not read yet'
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `updated ${s} s ago`
  const m = Math.round(s / 60)
  return m < 60 ? `updated ${m} min ago` : `updated ${Math.round(m / 60)} h ago`
}

function draw() {
  const g = snap?.graph
  put('status', [snap ? ago(snap.updatedAt) : 'reading…', error, note].filter(Boolean).map((t) => `<span>${t.replace(/[&<>]/g, '')}</span>`).join(' · '))
  put('notes', (snap?.notes ?? []).slice(0, 3).map((/** @type {string} */ n) => `<p>${String(n).replace(/[&<>"']/g, '')}</p>`).join(''))
  if (!g) return
  put('unlinked', unlinkedHtml(g))
  put('graph', graphSvg(g, pictures))
  put('legend', legendHtml())
  put('doing', doingHtml(g, pictures))
}

async function ask(force = false) {
  try {
    const version = typeof snap?.version === 'number' ? snap.version : -1
    const answer = await api.plugin.request('graph.snapshot', version >= 0 ? { force, version } : { force })
    if (answer) snap = answer
    error = ''
  } catch (e) {
    error = 'The worker did not answer; the last graph stays.'
  }
  draw()
  const sig = (snap?.graph?.bots ?? []).map((/** @type {{ id: string }} */ b) => b.id).join('|')
  if (sig !== pictureSig) {
    pictureSig = sig
    void askPictures()
  }
}

async function askPictures() {
  try {
    const r = await api.plugin.request('graph.pictures')
    pictures = r && typeof r.pictures === 'object' && r.pictures ? r.pictures : {}
    draw()
  } catch {
    /* the initials stay */
  }
}

async function open(/** @type {HTMLElement} */ el) {
  note = ''
  try {
    if (el.dataset.pr) {
      const url = el.dataset.pr
      if (!PR_URL.test(url) || !api.shell?.openExternal) {
        note = 'This panel cannot open the browser.'
      } else {
        await api.shell.openExternal(url)
      }
    } else if (el.dataset.wait) {
      const r = await api.plugin.request('waits.open', { key: el.dataset.wait })
      if (!r?.opened) note = 'Could not open that wait.'
    } else if (el.dataset.key) {
      const input = el.dataset.dispatch ? { key: el.dataset.key, dispatchId: el.dataset.dispatch } : { key: el.dataset.key }
      const r = await api.plugin.request('funnel.open', input)
      if (!r?.opened) note = 'Nothing to open for that work.'
    }
  } catch {
    note = 'Could not open that.'
  }
  draw()
}

/** The innermost pressable element under an event: a chip wins over its node. */
const pressable = (/** @type {Event} */ e) => /** @type {HTMLElement | null} */ (e.target instanceof Element ? e.target.closest('[data-pr], [data-wait], [data-dispatch], [data-key]') : null)

document.addEventListener('click', (e) => {
  const el = pressable(e)
  if (el) void open(el)
})
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const el = pressable(e)
  if (!el) return
  e.preventDefault()
  void open(el)
})
$('refresh').addEventListener('click', (e) => {
  e.stopPropagation()
  void ask(true)
})

let inFlight = false
setInterval(() => {
  if (document.hidden || inFlight) return
  inFlight = true
  void ask().finally(() => {
    inFlight = false
  })
}, TICK_MS)
setInterval(() => {
  if (!document.hidden) void askPictures()
}, PICTURES_MS)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void ask()
})
void ask()
