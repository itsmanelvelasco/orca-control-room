// Funnel slice 1 (PRD "Control Room funnel view"): the funnel model on fixed data with
// hand-labelled answers. R1 work key, R2 PRD link, R3 stage rules, R4 waits, R8 speed.
// Targets (PRD section 6): stage 100% right, every item/Run/task/PR in exactly one piece,
// the same waits as v1's Waits view, every known PRD found, under 50 ms for 60 bots.
import { assert, test } from 'orca/testing'
import { parseBotItemList, parseBotWorkList, parseGateList, parseRunList, parseTaskList, parseWorkerList, type BotItem, type BotWork } from '../src/model/index.ts'
import type { Wait } from '../src/views/waits/collect.ts'
import { buildFunnel, DONE_KEEP_MS, prdLinks, STAGES, type Funnel, type FunnelInput, type FunnelRun } from '../src/views/funnel/model.ts'
import { fixture } from './helpers.ts'
import { fixtureSnapshot, WAITS_CASE } from './waits-fixture.ts'

// ---------- loading ----------

type PrIn = { number: number; state: string }
const pr = (p: PrIn | undefined) => p && { shown: true, ref: `example-org/sample-app#${p.number}`, number: p.number, url: `https://github.com/example-org/sample-app/pull/${p.number}`, state: p.state, checks: null, review: null, title: null }

/** A case's item rows with the CLI fields it leaves out filled in. */
function items(rows: any[] = []): BotItem[] {
  return parseBotItemList({
    botId: 'bot-1',
    botName: 'Atlas',
    items: rows.map((r, i) => ({
      number: i + 1,
      title: `Item ${i + 1}`,
      chat: { id: 'chat-1', kind: 'home' },
      createdAt: 1795400000000 + i,
      ...r,
      owner: { botId: 'bot-1', name: 'Atlas' },
      links: (r.links ?? []).map((l: any) => ({ ...l, pr: pr(l.pr) }))
    }))
  }).items
}

function runs(rows: any[] = []): FunnelRun[] {
  return parseRunList({ runs: rows.map(({ id, objective, legacy }) => ({ id, objective, legacy })) }).map((run) => {
    const r = rows.find((x) => x.id === run.id)
    return {
      run,
      tasks: parseTaskList({ runId: run.id, tasks: r.tasks ?? [] }),
      workers: parseWorkerList({ runId: run.id, workers: r.workers ?? [] }),
      gates: parseGateList({ runId: run.id, gates: r.gates ?? [] })
    }
  })
}

const works = (rows: any[] = []): BotWork[] => parseBotWorkList({ items: rows.map((w) => ({ ...w, pr: pr(w.pr) })) }).items

const wait = (w: any): Wait => ({ notifyId: w.key, who: 'Someone', what: 'Something', options: [], label: 'Waiting', since: null, target: null, sources: [], ...w })

type Case = { name: string; items?: any[]; runs?: any[]; works?: any[]; waits?: any[]; expect: { pieces: Record<string, any>; left?: any[]; unlinked?: string[]; looseWorks?: string[] } }
const CASES = fixture('funnel/cases.json') as { now: number; cases: Case[] }

const caseInput = (c: Case): FunnelInput => ({ items: items(c.items), runs: runs(c.runs), works: works(c.works), waits: (c.waits ?? []).map(wait), now: CASES.now })

/** today.json (live data, names swapped) as funnel input. */
function todayInput(): FunnelInput {
  const t = fixture('funnel/today.json')
  const labels = fixture('funnel/today-labels.json')
  const allItems = Object.values(t.items).flatMap((page: any) => parseBotItemList(page).items)
  const allWorks = Object.values(t.works).flatMap((page: any) => parseBotWorkList(page).items)
  const allRuns = parseRunList(t.runList).map((run) => {
    const r = t.runs[run.id] ?? {}
    return { run, tasks: parseTaskList(r.tasks ?? {}), workers: parseWorkerList(r.workers ?? {}), gates: parseGateList(r.gates ?? {}) }
  })
  return { items: allItems, works: allWorks, runs: allRuns, waits: [], now: labels.now }
}

// ---------- checks ----------

/** Every expected field of each piece matches; the set of pieces is exactly the expected one. */
function checkPieces(f: Funnel, want: Record<string, any>, label: string): void {
  assert.deepEqual(f.pieces.map((p) => p.key).sort(), Object.keys(want).sort(), `${label}: pieces`)
  for (const [key, e] of Object.entries(want)) {
    const p = f.pieces.find((x) => x.key === key)
    assert.ok(p, `${label}: ${key}`)
    if (!p) continue
    const at = `${label}: ${key}`
    assert.equal(p.stage, e.stage, `${at} stage`)
    if ('amber' in e) assert.equal(p.amber, e.amber, `${at} amber`)
    if ('why' in e) assert.equal(p.why, e.why, `${at} why`)
    if ('prd' in e) assert.equal(p.prd?.url ?? null, e.prd, `${at} prd`)
    if ('prdFrom' in e) assert.equal(p.prd?.from, e.prdFrom, `${at} prd from`)
    if ('prds' in e) assert.deepEqual(p.prds, e.prds, `${at} prds`)
    if ('prClosed' in e) assert.equal(p.prClosed, e.prClosed, `${at} prClosed`)
    if ('prCount' in e) assert.deepEqual(p.prCount, e.prCount, `${at} prCount`)
    if ('runIds' in e) assert.deepEqual(p.runIds, e.runIds, `${at} runIds`)
    if ('taskIds' in e) assert.deepEqual(p.taskIds, e.taskIds, `${at} taskIds`)
    if ('failed' in e) assert.deepEqual([...p.failed].sort(), [...e.failed].sort(), `${at} failed`)
    if ('waits' in e) assert.deepEqual(p.waits.map((w) => w.key).sort(), [...e.waits].sort(), `${at} waits`)
    if ('title' in e) assert.equal(p.title, e.title, `${at} title`)
    if ('chatKind' in e) assert.equal(p.item?.chatKind, e.chatKind, `${at} chat kind`)
    if ('updatedAt' in e) assert.equal(p.updatedAt, e.updatedAt, `${at} updatedAt`)
  }
}

/** R1 AC: every item, Run, task, gate and PR of the input is in exactly one piece (or left the view on purpose). */
function checkAccounting(input: FunnelInput, f: Funnel, label: string): void {
  const count = (xs: string[]): Map<string, number> => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())
  const left = new Set(f.left.map((l) => l.key))
  const itemKeys = count(f.pieces.filter((p) => p.item).map((p) => p.key))
  for (const i of input.items) {
    const k = `item:${i.uid}`
    assert.equal((itemKeys.get(k) ?? 0) + (left.has(k) ? 1 : 0), 1, `${label}: item ${k} once`)
  }
  const runIds = count(f.pieces.flatMap((p) => p.runIds))
  for (const r of input.runs) assert.equal((runIds.get(r.run.id) ?? 0) + (left.has(`run:${r.run.id}`) ? 1 : 0), 1, `${label}: Run ${r.run.id} once`)
  const taskIds = count(f.pieces.flatMap((p) => p.taskIds))
  const gateIds = count(f.pieces.flatMap((p) => p.gateIds))
  // A task or gate is in exactly one piece; when its Run left the view, in none (a split Run's
  // tasks on items stay with their items).
  const goneDispatch = new Set<string>()
  for (const r of input.runs) {
    const gone = left.has(`run:${r.run.id}`)
    for (const t of r.tasks) {
      const n = taskIds.get(t.id) ?? 0
      assert.ok(n === 1 || (gone && n === 0), `${label}: task ${t.id} once (${n})`)
    }
    for (const g of r.gates) {
      const n = gateIds.get(g.id) ?? 0
      assert.ok(n === 1 || (gone && n === 0), `${label}: gate ${g.id} once (${n})`)
    }
    if (gone) for (const w of r.workers) goneDispatch.add(w.dispatchId)
  }
  const prUrls = count(f.pieces.flatMap((p) => p.prs.map((x) => x.url)))
  const inputPrs = new Set<string>()
  for (const i of input.items) {
    if (left.has(`item:${i.uid}`)) continue
    for (const l of i.links) if ((l.kind === 'pr' || l.kind === 'dispatch') && l.pr) inputPrs.add(l.pr.url)
  }
  // A bot worker's PR counts unless the worker left with its item or Run.
  for (const w of input.works) if (w.pr && !f.looseWorks.includes(w.id) && !(w.dispatchId && goneDispatch.has(w.dispatchId))) inputPrs.add(w.pr.url)
  for (const url of inputPrs) assert.equal(prUrls.get(url) ?? 0, 1, `${label}: PR ${url} once`)
  for (const [url, n] of prUrls) assert.equal(n, 1, `${label}: PR ${url} not twice`)
  // Columns hold every piece once, in its stage.
  const inColumns = STAGES.flatMap((s) => f.columns[s].map((k) => `${s}:${k}`)).sort()
  assert.deepEqual(inColumns, f.pieces.map((p) => `${p.stage}:${p.key}`).sort(), `${label}: columns`)
}

// ---------- R3: stage rules and edge cases, one hand-labelled case each ----------

for (const c of CASES.cases) {
  test(`case: ${c.name}`, () => {
    const input = caseInput(c)
    const f = buildFunnel(input)
    checkPieces(f, c.expect.pieces, c.name)
    assert.deepEqual(f.left.map((l) => `${l.key} ${l.reason}`).sort(), (c.expect.left ?? []).map((l: any) => `${l.key} ${l.reason}`).sort(), `${c.name}: left`)
    assert.deepEqual(f.unlinkedWaits.map((w) => w.key).sort(), [...(c.expect.unlinked ?? [])].sort(), `${c.name}: unlinked waits`)
    if (c.expect.looseWorks) assert.deepEqual(f.looseWorks, c.expect.looseWorks, `${c.name}: loose workers`)
    checkAccounting(input, f, c.name)
  })
}

test('PRD target: stage right for 100% of pieces in the fixture set', () => {
  let right = 0
  let total = 0
  for (const c of CASES.cases) {
    const f = buildFunnel(caseInput(c))
    for (const [k, e] of Object.entries(c.expect.pieces)) {
      total++
      if (f.pieces.find((p) => p.key === k)?.stage === e.stage) right++
    }
  }
  const labels = fixture('funnel/today-labels.json')
  const today = buildFunnel(todayInput())
  for (const [k, e] of Object.entries<any>(labels.pieces)) {
    total++
    if (today.pieces.find((p) => p.key === k)?.stage === e.stage) right++
  }
  assert.ok(total >= 40, `the set has ${total} labelled pieces`)
  assert.equal(right / total, 1, `${right} of ${total}`)
})

// ---------- today's data, names swapped ----------

test("today's data: every piece matches its hand label", () => {
  const labels = fixture('funnel/today-labels.json')
  const input = todayInput()
  const f = buildFunnel(input)
  checkPieces(f, labels.pieces, 'today')
  assert.deepEqual(f.left, labels.left)
  checkAccounting(input, f, 'today')
  // 8 items, 3 Runs that land, 2 Runs that leave.
  assert.equal(input.items.length, 8)
  assert.equal(f.pieces.filter((p) => p.kind === 'run').length, 2)
})

test("R2 AC: every PRD named today is found, on the item or Run that names it", () => {
  const labels = fixture('funnel/today-labels.json')
  const f = buildFunnel(todayInput())
  const found = Object.fromEntries(f.pieces.filter((p) => p.prd).map((p) => [p.key, p.prd?.url]))
  assert.deepEqual(found, labels.prds)
})

test('R2: PRD link forms', () => {
  assert.deepEqual(prdLinks('see https://claude.ai/artifact/Abc_1-x. and http://www.claude.ai/code/artifact/0b1c2d3e-4f50-4617-8899-aabbccddeeff?x=1'), ['https://claude.ai/artifact/Abc_1-x', 'https://claude.ai/code/artifact/0b1c2d3e-4f50-4617-8899-aabbccddeeff'])
  // The same link twice counts once, at its last place.
  assert.deepEqual(prdLinks('https://claude.ai/artifact/A1 then https://claude.ai/artifact/B2 then https://claude.ai/artifact/A1'), ['https://claude.ai/artifact/B2', 'https://claude.ai/artifact/A1'])
  assert.deepEqual(prdLinks('https://claude.ai/chat/123 and https://example.com/artifact/x'), [])
  assert.deepEqual(prdLinks(null), [])
})

// ---------- R4: the same waits as v1's Waits view ----------

test("R4 AC: every wait in v1's Waits view shows on exactly one piece, or in Unlinked waits", async () => {
  const snap = await fixtureSnapshot()
  const cli = WAITS_CASE.cli as Record<string, any>
  const allItems = Object.entries(cli).filter(([k]) => k.startsWith('bot item list')).flatMap(([, v]) => parseBotItemList(v.result).items)
  const allRuns = parseRunList(cli['orchestration run-list'].result).map((run) => ({
    run,
    tasks: parseTaskList(cli[`orchestration task-list --run ${run.id}`]?.result ?? {}),
    workers: parseWorkerList(cli[`orchestration worker-list --run ${run.id}`]?.result ?? {}),
    gates: parseGateList(cli[`orchestration gate-list --run ${run.id}`]?.result ?? {})
  }))
  const f = buildFunnel({ items: allItems, works: [], runs: allRuns, waits: snap.waits, now: 1795400900000 })
  const shown = [...f.pieces.flatMap((p) => p.waits.map((w) => w.key)), ...f.unlinkedWaits.map((w) => w.key)]
  assert.deepEqual([...shown].sort(), snap.waits.map((w) => w.key).sort(), 'same set, each once')
  // Hand labels: questions on their items, both gates on the item whose dispatch the gated Run runs.
  const holder = (key: string): string => f.pieces.find((p) => p.waits.some((w) => w.key === key))?.key ?? 'unlinked'
  assert.equal(holder('item:6f3df7d1-33d6-44c6-8e9d-6ac0e3e756d2'), 'item:6f3df7d1-33d6-44c6-8e9d-6ac0e3e756d2')
  assert.equal(holder('item:ca28fa95-0015-4c88-9af8-d8e34dbaed59'), 'item:ca28fa95-0015-4c88-9af8-d8e34dbaed59')
  assert.equal(holder('task:task_a1b2c3d4e5f6'), 'item:a329a828-e9c7-4840-971f-2dd219189d5b')
  assert.equal(holder('task:task_b2c3d4e5f6a1'), 'item:a329a828-e9c7-4840-971f-2dd219189d5b')
  for (const w of snap.waits.filter((x) => x.kind === 'agent')) assert.equal(holder(w.key), 'unlinked', `${w.key}: no worker of any piece runs there`)
  for (const p of f.pieces) assert.equal(p.amber, p.waits.length > 0 || p.failed.length > 0, `${p.key} amber`)
})

// ---------- columns ----------

test('columns: amber first, then newest first', () => {
  const f = buildFunnel({
    items: items([
      { uid: 'old', status: 'planned', lastActivityAt: 1795400000000 },
      { uid: 'new', status: 'planned', lastActivityAt: 1795490000000 },
      { uid: 'ask', status: 'needs_you', lastActivityAt: 1795300000000 }
    ]),
    runs: [],
    works: [],
    waits: [wait({ key: 'item:ask', kind: 'question' })],
    now: CASES.now
  })
  assert.deepEqual(f.columns.ideation, ['item:ask', 'item:new', 'item:old'])
  assert.deepEqual(f.columns.planning, [])
})

test('a done item leaves exactly 7 days after it closed', () => {
  const closedAt = CASES.now - DONE_KEEP_MS
  const at = (now: number) => buildFunnel({ items: items([{ uid: 'd', status: 'done', closedAt }]), runs: [], works: [], waits: [], now })
  assert.equal(at(CASES.now).pieces.length, 1)
  assert.equal(at(CASES.now + 1).pieces.length, 0)
})

test('pure: the same input gives the same output and is not changed', () => {
  const c = CASES.cases.find((x) => x.name.startsWith('Waits')) as Case
  const input = caseInput(c)
  const before = JSON.stringify(input)
  assert.deepEqual(buildFunnel(input), buildFunnel(input))
  assert.equal(JSON.stringify(input), before)
})

// ---------- R8: speed ----------

/** 60 bots (the 60-bot fixture), 4 items each with a worker and a PR, 20 Runs of 10 tasks. */
function sixtyBots(): FunnelInput {
  const bots = fixture('cases/bot-list-60.json').result.bots as { id: string; name: string }[]
  const allItems: BotItem[] = []
  const allRuns: FunnelRun[] = []
  const allWaits: Wait[] = []
  let n = 0
  for (const b of bots) {
    const rows = Array.from({ length: 4 }, (_, i) => {
      n++
      const ctx = `ctx_${n.toString(16).padStart(12, '0')}`
      const links: any[] = i === 0 ? [] : [{ kind: 'dispatch', ref: ctx, state: i === 1 ? 'working' : 'completed', pr: i > 1 ? { number: n, state: i === 2 ? 'open' : 'merged' } : undefined }]
      if (i === 3) links.push({ kind: 'url', ref: `https://claude.ai/artifact/Prd${n}` })
      return { uid: `${b.id}-${i}`, number: i + 1, title: `${b.name} item ${i}`, status: i === 0 ? 'needs_you' : 'working', chat: { id: `${b.id}-chat`, kind: 'home' }, owner: { botId: b.id, name: b.name }, links: links.map((l) => ({ ...l, pr: pr(l.pr) })) }
    })
    allItems.push(...parseBotItemList({ botId: b.id, botName: b.name, items: rows }).items)
    allWaits.push(wait({ key: `item:${b.id}-0`, kind: 'question' }))
  }
  for (let r = 0; r < 20; r++) {
    const id = `run_${r.toString(16).padStart(12, '0')}`
    const tasks = Array.from({ length: 10 }, (_, t) => ({ id: `task_${r}x${t}`, status: 'completed', dispatchId: `ctx_${(r * 10 + t + 1).toString(16).padStart(12, '0')}` }))
    allRuns.push({ run: parseRunList({ runs: [{ id, objective: `Run ${r}` }] })[0], tasks: parseTaskList({ runId: id, tasks }), workers: parseWorkerList({ runId: id, workers: tasks.map((t) => ({ dispatchId: t.dispatchId, taskId: t.id, state: 'succeeded' })) }), gates: [] })
  }
  return { items: allItems, works: [], runs: allRuns, waits: allWaits, now: CASES.now }
}

test('R8 AC: the funnel for 60 bots (240 items, 20 Runs, 200 tasks) builds in under 50 ms', () => {
  const input = sixtyBots()
  const f = buildFunnel(input)
  assert.equal(input.items.length, 240)
  checkAccounting(input, f, '60 bots')
  const times: number[] = []
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now()
    buildFunnel(input)
    times.push(performance.now() - t0)
  }
  const median = times.sort((a, b) => a - b)[3]
  assert.ok(median < 50, `median ${median.toFixed(1)} ms`)
})

test('R8 AC: the model makes no CLI calls and imports no Node module', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/views/funnel/model.ts', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
  assert.deepEqual(imports.filter((s) => !s.startsWith('../')), [], 'relative imports only')
  assert.ok(!/cli\/|\bcli\.run\b|child_process/.test(src), 'no CLI access')
})
