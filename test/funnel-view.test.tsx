// Funnel slice 3 (PRD "Control Room funnel view"): stage columns and cards. R4 waits glow amber
// and every wait shows once, R5 four columns with counts and a card per piece, R6 presses only
// open or focus, R7 English times and no Node module below the panel (panel-imports.test.ts),
// section 5: 20 cards then "+N more", "No work yet.", bot text drawn as plain text.
import { assert, mockHost, mount, test, type TestPanel } from 'orca/testing'
import { emptySnapshot as emptyAgents } from '../src/views/agents/model.ts'
import { caseInputs, funnelFromCase } from '../src/views/funnel/demo.ts'
import { STAGES, type Piece } from '../src/views/funnel/model.ts'
import * as funnelPanel from '../src/views/funnel/panel.tsx'
import type { FunnelSnapshot } from '../src/views/funnel/refresh.ts'
import { FunnelView, MAX_CARDS, STAGE_LABEL } from '../src/views/funnel/view.tsx'
import { funnelTarget, openTarget, registerFunnel } from '../src/views/funnel/worker.ts'
import { createFunnelRefresher } from '../src/views/funnel/refresh.ts'
import { createLineRefresher } from '../src/views/line/refresh.ts'
import { createWaitsRefresher } from '../src/views/waits/refresh.ts'
import { lineFromCase } from '../src/views/line/demo.ts'
import * as room from '../src/views/room/panel.tsx'
import { fixture } from './helpers.ts'
import { fixtureSnapshot } from './waits-fixture.ts'

const DEMO = fixture('cases/funnel-demo.json')
const NOW = DEMO.now as number
const demo = (): FunnelSnapshot => funnelFromCase(DEMO, NOW)
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

const ITEM = (n: string) => `item:${n}`
const OFFLINE = ITEM('22222222-0000-4000-8000-000000000005')
const BILLING = ITEM('11111111-0000-4000-8000-000000000004')
const SEARCH = ITEM('11111111-0000-4000-8000-000000000007')
const RUN = 'run:run_settings_page'

/** The hand-labelled answer for the demo case: each piece's column and whether it is amber. */
const LABELS: Record<string, { stage: string; amber: boolean }> = {
  [ITEM('11111111-0000-4000-8000-000000000012')]: { stage: 'ideation', amber: false },
  [ITEM('22222222-0000-4000-8000-000000000003')]: { stage: 'ideation', amber: false },
  [ITEM('11111111-0000-4000-8000-000000000009')]: { stage: 'planning', amber: false },
  [OFFLINE]: { stage: 'planning', amber: true },
  [SEARCH]: { stage: 'execution', amber: false },
  [BILLING]: { stage: 'execution', amber: true },
  [RUN]: { stage: 'execution', amber: true },
  [ITEM('11111111-0000-4000-8000-000000000001')]: { stage: 'shipping', amber: false },
  [ITEM('22222222-0000-4000-8000-000000000002')]: { stage: 'shipping', amber: false }
}

/** Card keys drawn inside a column, in order. */
function cardsIn(view: TestPanel, stage: string): string[] {
  const col = view.find({ testId: `col:${stage}` })
  assert.ok(col, `no column ${stage}`)
  return view
    .findAll({ type: 'Box' })
    .filter((b) => b.key?.startsWith('piece:') && b.path.startsWith(col.path))
    .map((b) => (b.key as string).slice('piece:'.length))
}

const mountView = (snap: FunnelSnapshot, theme: 'light' | 'dark' = 'dark', extra: Partial<Parameters<typeof FunnelView>[0]> = {}) => mount(() => <FunnelView snap={snap} onOpen={() => undefined} onOpenWait={() => undefined} {...extra} />, { theme })

// ---------- R5: four columns, a card per piece ----------

test('R5: four stage columns in order, each with its count; every piece is one card in its stage column (100% on the demo set)', async () => {
  const snap = demo()
  for (const theme of ['light', 'dark'] as const) {
    const view = await mountView(snap, theme)
    const heads = STAGES.map((s) => view.find({ testId: `col:${s}` })?.text ?? '')
    STAGES.forEach((s, i) => assert.ok(heads[i].startsWith(STAGE_LABEL[s]), `column ${i} is ${heads[i].slice(0, 20)}`))
    let right = 0
    const drawn: string[] = []
    for (const s of STAGES) {
      const keys = cardsIn(view, s)
      drawn.push(...keys)
      for (const k of keys) if (LABELS[k]?.stage === s) right++
      // The count badge says how many cards the column holds.
      assert.ok(view.find({ testId: `col:${s}` })?.text.includes(String(keys.length)))
    }
    assert.equal(drawn.length, new Set(drawn).size, 'a piece drawn twice')
    assert.deepEqual([...drawn].sort(), Object.keys(LABELS).sort())
    assert.equal(right, Object.keys(LABELS).length, `${right} of ${Object.keys(LABELS).length} cards in the right column`)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    await view.unmount()
  }
})

test('R5: a card shows title, owner, why, PR counts; the detail lists tasks, workers, gates, PRs and the PRD', async () => {
  const view = await mountView(demo())
  const card = view.find({ testId: `piece:${BILLING}` })
  assert.ok(card)
  for (const want of ['Billing page redesign', 'Atlas #4', '1 of 3 merged', 'PRs: 2 open · 1 merged', 'Worker failed: ctx_b2b2b2b2b2b2']) assert.ok(card.text.includes(want), `card lacks "${want}": ${card.text}`)
  // The run card's detail, once opened.
  const run = view.findAll({ type: 'Collapsible' }).find((c) => c.key === `detail:${RUN}`)
  assert.ok(run)
  await view.toggle(run)
  const runCard = view.find({ testId: `piece:${RUN}` })?.text ?? ''
  for (const want of ['Settings layout', 'Settings form and validation', 'Gate A: keep the old settings URL working?', 'Options: Keep it / Redirect', 'ctx_d4d4d4d4d4d4', 'PRD', "found in the Run's objective"]) assert.ok(runCard.includes(want), `run detail lacks "${want}"`)
  await view.unmount()
})

// ---------- R4: waits on the user ----------

test('R4 AC: every wait shows on exactly one card or in "Unlinked waits"; amber cards are exactly the labelled ones', async () => {
  const snap = demo()
  const view = await mountView(snap)
  const waits = caseInputs(DEMO, NOW).waits.waits
  for (const w of waits) {
    const onCards = view.findAll({ type: 'Box' }).filter((b) => b.key?.startsWith('piece:') && b.text.includes(`${w.label}: ${w.what}`)).length
    const unlinked = view.find({ testId: `unlinked:${w.key}` }) ? 1 : 0
    assert.equal(onCards + unlinked, 1, `wait ${w.key}: ${onCards} cards + ${unlinked} unlinked rows`)
  }
  assert.ok(view.summary().some((l) => l.includes('Callout warning "Unlinked waits (1)"')), view.summary().join(' / '))
  for (const [key, want] of Object.entries(LABELS)) {
    const box = view.find({ testId: `piece:${key}` })
    assert.ok(box)
    assert.equal(box.props.border === 'warning', want.amber, `${key} amber should be ${want.amber}`)
    assert.equal(box.text.includes('Waits on you'), want.amber)
  }
  // The Needs-you card shows its question and options.
  const offline = view.find({ testId: `piece:${OFFLINE}` })?.text ?? ''
  assert.ok(offline.includes('Needs you: Which sync rule should offline edits use?') && offline.includes('Options: Last write wins / Ask each time'))
  // Amber cards lead their column.
  assert.deepEqual(cardsIn(view, 'execution').at(-1), SEARCH)
  assert.deepEqual(cardsIn(view, 'planning')[0], OFFLINE)
  await view.unmount()
})

// ---------- section 5 edge cases ----------

function manyPieces(n: number): FunnelSnapshot {
  const snap = demo()
  const base = snap.funnel.pieces.find((p) => p.key === SEARCH) as Piece
  const pieces = Array.from({ length: n }, (_, i) => ({ ...base, key: `item:many-${i}`, title: `Piece ${i}`, waits: [], amber: false }))
  return { ...snap, funnel: { ...snap.funnel, pieces, columns: { ideation: [], planning: [], execution: pieces.map((p) => p.key), shipping: [] }, unlinkedWaits: [] }, details: { tasks: {}, gates: {} } }
}

test('section 5: a column shows 20 cards, then "+N more"; its count is the full number', async () => {
  const view = await mountView(manyPieces(MAX_CARDS + 5))
  assert.equal(cardsIn(view, 'execution').length, MAX_CARDS)
  assert.ok(view.find({ text: '+5 more' }))
  assert.ok(view.find({ testId: 'col:execution' })?.text.includes(String(MAX_CARDS + 5)))
  await view.unmount()
})

test('section 5: 0 items: four empty columns and one line, "No work yet."', async () => {
  const view = await mountView(funnelFromCase({ now: NOW, items: {}, runList: { runs: [] } }, NOW))
  assert.ok(view.find({ text: 'No work yet.' }))
  for (const s of STAGES) assert.ok(view.find({ testId: `col:${s}` })?.text.includes('Nothing here'))
  assert.equal(view.findAll({ text: 'Nothing here' }).length, 4)
  await view.unmount()
})

test('section 5: text from bots is drawn as plain text, never Markdown or HTML', async () => {
  const snap = demo()
  const evil = '<img src=x onerror=alert(1)> **bold** [link](https://example.org)'
  snap.funnel.pieces = snap.funnel.pieces.map((p) => (p.key === SEARCH ? { ...p, title: evil } : p))
  const view = await mountView(snap)
  assert.equal(view.find({ testId: `piece:${SEARCH}` })?.text.startsWith(evil), true)
  assert.equal(view.findAll({ type: 'Markdown' }).length, 0)
  assert.equal(JSON.stringify(view.tree()).includes('dangerouslySetInnerHTML'), false)
  await view.unmount()
})

test('R7: times on cards are English ("39m ago"), whatever the locale', async () => {
  const view = await mount(() => <FunnelView snap={funnelFromCase(DEMO, Date.now())} />, { locale: 'es-ES' })
  const card = view.find({ testId: `piece:${ITEM('11111111-0000-4000-8000-000000000009')}` })?.text ?? ''
  assert.match(card, /\b\d+m ago\b/)
  assert.equal(/hace/.test(JSON.stringify(view.tree())), false)
  await view.unmount()
})

// ---------- R6: presses only open or focus ----------

test('R6: a card press asks funnel.open with its key; a worker press adds its dispatch id; a miss says so', async () => {
  const asked: unknown[] = []
  let answer = { opened: true }
  const host = mockHost({ requests: { 'funnel.snapshot': () => demo(), 'funnel.open': (input: unknown) => (asked.push(input), answer) } })
  const view = await mount(funnelPanel, { host })
  const open = view.findAll({ type: 'Button' }).filter((b) => b.text === 'Open' && b.path.startsWith(view.find({ testId: `piece:${OFFLINE}` })?.path ?? '-'))
  assert.equal(open.length, 1)
  await view.press(open[0])
  assert.deepEqual(asked.at(-1), { key: OFFLINE })
  // Focus a worker from the Run card's detail.
  const detail = view.findAll({ type: 'Collapsible' }).find((c) => c.key === `detail:${RUN}`)
  assert.ok(detail)
  await view.toggle(detail)
  answer = { opened: false }
  await view.press({ text: 'Focus' })
  assert.deepEqual(asked.at(-1), { key: RUN, dispatchId: 'ctx_c3c3c3c3c3c3' })
  assert.ok(view.find({ text: 'Could not focus it.' }))
  // No host call the panel made was refused.
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

/** A fake worker API: records handlers and host calls. */
function fakeOrca() {
  const handlers = new Map<string, (input: any) => unknown>()
  const calls: { method: string; params: any }[] = []
  const orca = {
    panels: { handle: (name: string, fn: (input: any) => unknown) => void handlers.set(name, fn), post: () => undefined },
    host: { call: async (method: string, params: any) => (calls.push({ method, params }), method === 'terminal.focus' ? { focused: true } : {}) },
    log: () => undefined
  }
  return { orca: orca as any, handlers, calls }
}

test('R6: the worker opens a card where it belongs: its wait, else the bot home chat, else a worker; a worker: its live terminal, else its workspace', () => {
  const { waits, works } = caseInputs(DEMO, NOW)
  const f = demo().funnel
  const t = (key: string, dispatchId?: string) => funnelTarget(f, dispatchId === undefined ? { key } : { key, dispatchId }, waits, works)
  // A wait's place first: the Needs-you question opens the bot's home; the gate, the worker's terminal.
  assert.deepEqual(t(OFFLINE), { target: { kind: 'workspace', workspaceId: 'repo-demo::/work/juno-home' } })
  assert.deepEqual(t(RUN), { target: { kind: 'terminal', terminalId: 'term_demo_2' } })
  // No wait: the item's chat, in its bot's home workspace.
  assert.deepEqual(t(SEARCH), { target: { kind: 'workspace', workspaceId: 'repo-demo::/work/atlas-home' } })
  // A worker: a live terminal; a gone one falls back to its workspace.
  assert.deepEqual(t(RUN, 'ctx_d4d4d4d4d4d4'), { target: { kind: 'terminal', terminalId: 'term_demo_2' }, fallback: { kind: 'workspace', workspaceId: 'repo-demo::/work/sample-app/settings-2' } })
  assert.deepEqual(t(RUN, 'ctx_c3c3c3c3c3c3'), { target: { kind: 'workspace', workspaceId: 'repo-demo::/work/sample-app/settings-1' } })
  // An item-link worker with no Run row and no bot work: nowhere to go.
  assert.deepEqual(t(BILLING, 'ctx_b2b2b2b2b2b2'), { reason: 'no_target' })
  // Only pieces and workers of the funnel open: a worker of another card is unknown.
  assert.deepEqual(t('item:nope'), { reason: 'unknown' })
  assert.deepEqual(t(SEARCH, 'ctx_d4d4d4d4d4d4'), { reason: 'unknown' })
  // No home known, and its one worker has no Run row and no bot work: nowhere to go.
  assert.deepEqual(funnelTarget(f, { key: SEARCH }, { ...waits, homes: {} }, works), { reason: "no_target" })
})

test('R6: funnel.open calls only terminal.focus or workspace.open (nothing written, no CLI)', async () => {
  const { orca, handlers, calls } = fakeOrca()
  const inputs = caseInputs(DEMO, NOW)
  let cli = 0
  const refresher = registerFunnel(orca, async () => (cli++, { ok: true, result: {}, ms: 0, cliPath: null } as any), () => inputs.waits)
  refresher.onWaitsChanged()
  await refresher.refresh(true)
  const callsBefore = cli
  const open = handlers.get('funnel.open') as (i: any) => Promise<any>
  assert.deepEqual(await open({ key: RUN }), { opened: true })
  assert.deepEqual(await open({ key: SEARCH }), { opened: true })
  assert.deepEqual(await open({ key: 'item:nope' }), { opened: false, reason: 'unknown' })
  assert.deepEqual(await open({ key: 42 }), { opened: false, reason: 'unknown' })
  assert.deepEqual(calls.map((c) => c.method), ['terminal.focus', 'workspace.open'])
  assert.equal(cli, callsBefore, 'funnel.open made a CLI call')
})

// ---------- slice 5: the Funnel tab in the panel (R8: hidden asks nothing) ----------

async function roomHost() {
  const asks = { funnel: 0 }
  const waits = await fixtureSnapshot()
  const host = mockHost({
    requests: {
      'waits.get': () => waits,
      'line.snapshot': () => lineFromCase({ runList: { ok: true, result: { runs: [] } } }),
      'agents.get': () => ({ ...emptyAgents(), status: 'ok' as const, updatedAt: 1 }),
      'funnel.snapshot': () => (asks.funnel++, demo())
    }
  })
  return { host, asks }
}

test('slice 5: the Funnel tab shows for everyone, after Shipping line; hidden, it asks nothing (R8)', async () => {
  // Opens on Waits: the Funnel tab is there, Shipping line stays (gate A), and the funnel asks nothing.
  const off = await roomHost()
  const plain = await mount(room, { host: off.host })
  const tabs = plain.findAll({ type: 'Tab' }).map((t) => String(t.props.label))
  assert.deepEqual(tabs.slice(1), ['Shipping line', 'Agents', 'Funnel'], tabs.join(' / '))
  await sleep(1_300)
  assert.equal(off.asks.funnel, 0, 'the hidden funnel asked')
  // A press on the tab shows the columns and asks at once.
  await plain.select({ type: 'Tabs' }, 'funnel')
  assert.ok(plain.summary()[0].includes('"Funnel" selected'), plain.summary()[0])
  assert.ok(off.asks.funnel >= 1, 'the funnel did not ask on the switch')
  assert.ok(plain.find({ testId: 'col:execution' }))
  assert.equal(plain.persisted.plugin['room.tab'], 'funnel')
  assert.deepEqual(plain.errors, [])
  await plain.unmount()

  // Opens where it was left, with no dev flag; leaving the tab stops the asks.
  const on = await roomHost()
  const kept = await mount(room, { host: on.host, persisted: { plugin: { 'room.tab': 'funnel' } } })
  assert.ok(kept.summary()[0].includes('"Funnel" selected'), kept.summary()[0])
  assert.ok(on.asks.funnel >= 1)
  await kept.select({ type: 'Tabs' }, 'waits')
  const at = on.asks.funnel
  await sleep(1_300)
  assert.equal(on.asks.funnel, at)
  assert.deepEqual(kept.errors, [])
  await kept.unmount()
})

// ---------- review of PR #11 ----------

test("review 1: with no wait and no bot home, Open prefers a live terminal over a finished worker's workspace", () => {
  const { waits, works } = caseInputs(DEMO, NOW)
  // The demo Run with its gate resolved: workers [ctx_c3 (gone, workspace settings-1), ctx_d4 (live, term_demo_2)].
  const f = demo().funnel
  const run = f.pieces.find((p) => p.key === RUN) as Piece
  assert.deepEqual(run.workers.map((w) => w.dispatchId), ['ctx_c3c3c3c3c3c3', 'ctx_d4d4d4d4d4d4'])
  const resolved = { ...f, pieces: f.pieces.map((p) => (p.key === RUN ? { ...p, waits: [] } : p)) }
  assert.deepEqual(funnelTarget(resolved, { key: RUN }, waits, works), { target: { kind: 'terminal', terminalId: 'term_demo_2' }, fallback: { kind: 'workspace', workspaceId: 'repo-demo::/work/sample-app/settings-2' } })
  // No live terminal at all: the newest worker's workspace, not the oldest.
  const gone = { ...waits, runs: waits.runs.map((r) => ({ ...r, workers: r.workers.map((w) => ({ ...w, liveness: 'gone' })) })) }
  assert.deepEqual(funnelTarget(resolved, { key: RUN }, gone, works), { target: { kind: 'workspace', workspaceId: 'repo-demo::/work/sample-app/settings-2' } })
})

test('review 2: a failed Open on an Unlinked waits row says "Could not open it." under that row', async () => {
  const host = mockHost({ requests: { 'funnel.snapshot': () => demo(), 'waits.open': () => ({ opened: false, reason: 'failed' as const }) } })
  const view = await mount(funnelPanel, { host })
  const row = view.find({ testId: 'unlinked:agent:pane-demo-9' })
  assert.ok(row)
  assert.ok(!row.text.includes('Could not open it.'))
  const open = view.findAll({ type: 'Button' }).find((b) => b.path.startsWith(row.path))
  assert.ok(open)
  await view.press(open)
  assert.ok(view.find({ testId: 'unlinked:agent:pane-demo-9' })?.text.includes('Could not open it.'))
  assert.equal(view.findAll({ text: 'Could not open it.' }).length, 1, 'the line shows on that row only')
  await view.unmount()
})

test('review nit 3: a worker whose terminal will not take focus opens its workspace instead', async () => {
  const calls: string[] = []
  const orca = { host: { call: async (method: string) => (calls.push(method), method === 'terminal.focus' ? { focused: false } : {}) } } as any
  assert.equal(await openTarget(orca, { kind: 'terminal', terminalId: 'term_demo_2' }, { kind: 'workspace', workspaceId: 'ws-1' }), true)
  assert.deepEqual(calls, ['terminal.focus', 'workspace.open'])
  calls.length = 0
  assert.equal(await openTarget(orca, { kind: 'terminal', terminalId: 'term_demo_2' }), false)
  assert.deepEqual(calls, ['terminal.focus'])
})

test('review nit 4: the card button says where it goes: "Open" with a wait, "Open bot home" for an item, "Open" for a Run', async () => {
  const view = await mountView(demo())
  const label = (key: string) => view.findAll({ type: 'Button' }).find((b) => b.path.startsWith(view.find({ testId: `piece:${key}` })?.path ?? '-') && b.text !== 'Focus')?.text
  assert.equal(label(OFFLINE), 'Open')
  assert.equal(label(SEARCH), 'Open bot home')
  assert.equal(label(RUN), 'Open')
  assert.equal(view.findAll({ text: 'Open chat' }).length, 0)
  await view.unmount()
})

test('review nit 5: an older snapshot never replaces a newer one the panel holds', async () => {
  const older = { ...demo(), version: 3 }
  const host = mockHost({ requests: { 'funnel.snapshot': () => older } })
  const view = await mount(funnelPanel, { host })
  const newer = demo()
  newer.version = 9
  newer.funnel.pieces = newer.funnel.pieces.map((p) => (p.key === SEARCH ? { ...p, title: 'Newer title' } : p))
  await view.post('funnel.changed', newer)
  assert.ok(view.find({ testId: `piece:${SEARCH}` })?.text.startsWith('Newer title'))
  await view.press({ label: 'Refresh the funnel' })
  await view.settled()
  assert.ok(view.find({ testId: `piece:${SEARCH}` })?.text.startsWith('Newer title'), 'the older reply overwrote the newer funnel.changed')
  // A restarted worker (version from 0) with a newer read time is taken.
  await view.post('funnel.changed', { ...demo(), version: 1, updatedAt: (newer.updatedAt ?? 0) + 1000 })
  assert.ok(view.find({ testId: `piece:${SEARCH}` })?.text.startsWith('Speed up the search index'))
  await view.unmount()
})

test('review nit 7: calls killed at shutdown come back "stopped", and no view shows a banner, error or note for them', async () => {
  const stopped = async () => ({ ok: false as const, error: { kind: 'stopped' as const, message: 'The plugin stopped this call.' }, ms: 0, cliPath: null })
  const waits = createWaitsRefresher({ run: stopped })
  await waits.cycle(true)
  assert.equal(waits.snapshot().banner, null)
  const line = createLineRefresher({ cli: { run: stopped } as any })
  const l = await line.refresh(true)
  assert.equal(l.error, null)
  assert.deepEqual(l.notes, [])
  const inputs = caseInputs(DEMO, NOW).waits
  const funnel = createFunnelRefresher({ run: stopped, waits: () => ({ ...inputs, bots: [{ id: '00000000-0000-4000-8000-00000000000a', name: 'Atlas', agent: 'claude', paused: false, specialty: null, chatCount: 1 }] }) })
  const s = await funnel.refresh(true)
  assert.deepEqual(s.notes, [])
})
