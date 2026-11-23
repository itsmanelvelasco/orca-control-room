// R6, shipping line. The PRD target (section 6): on the fixture set every Run, task, worker and
// gate shows in the right place, 100%. "Right place" is checked twice: in the snapshot the worker
// builds (model) and in what the panel draws (each worker, gate and PR inside its task's box).
import { assert, mockHost, mount, mountWorker, test, type TestPanel } from 'orca/testing'
import type { CliRequest, CliResult } from '../src/cli/index.ts'
import { parseGateList, parseRunList, parseTaskList, parseWorkerList } from '../src/model/index.ts'
import { lineFromCase } from '../src/views/line/demo.ts'
import { buildRunLine, cleanText, gateKind, type LineSnapshot, type TaskLine } from '../src/views/line/model.ts'
import * as panel from '../src/views/line/panel.tsx'
import { createLineRefresher } from '../src/views/line/refresh.ts'
import { LineView } from '../src/views/line/view.tsx'
import { registerLine } from '../src/views/line/worker.ts'
import { fixture, resultOf } from './helpers.ts'

const PR = { ref: 'example-org/sample-app#42', number: 42, url: 'https://github.com/example-org/sample-app/pull/42', state: 'open' as const, checks: 'success', review: 'APPROVED', title: 'Slice 2' }

/** The 4-task case with a PR on the slice-2 worker. */
function caseWithPr(): any {
  return { ...fixture('cases/run-4-tasks.json'), prs: { ctx_1b2c3d4e5f0a: PR } }
}

const allTasks = (s: LineSnapshot): TaskLine[] => s.runs.flatMap((r) => [...r.tasks, ...r.done])

// ---------- model: every item in exactly one right place ----------

test('fixture: every Run, task, worker and gate lands in the right place (100%)', () => {
  const c = caseWithPr()
  const snap = lineFromCase(c)
  const runs = parseRunList(c.runList.result)
  const tasks = parseTaskList(c.taskList.result)
  const workers = parseWorkerList(c.workerList.result)
  const gates = parseGateList(c.gateList.result)

  // Runs: the real Run gets a line; run_unbound (mail only) does not.
  assert.deepEqual(snap.runs.map((r) => r.id), runs.filter((r) => !r.unbound && !r.legacy).map((r) => r.id))
  const [run] = snap.runs

  // Tasks: each once, in build order.
  const shown = allTasks(snap)
  assert.equal(shown.length, tasks.length)
  assert.deepEqual([...shown].sort((a, b) => a.step - b.step).map((t) => t.id), c.expect.buildOrder)

  let placed = 0
  const total = runs.length - 1 + tasks.length + workers.length + gates.length
  placed += snap.runs.length
  for (const t of tasks) if (shown.filter((s) => s.id === t.id).length === 1) placed++
  // Workers: under the task they work on.
  for (const w of workers) {
    const homes = shown.filter((t) => t.workers.some((x) => x.dispatchId === w.dispatchId))
    if (homes.length === 1 && homes[0].id === w.taskId) placed++
  }
  // Gates: under their task, in the A or B group.
  for (const g of gates) {
    const homes = shown.filter((t) => [...t.gates.a, ...t.gates.b].some((x) => x.id === g.id))
    const kind = g.question.startsWith('Gate B') ? 'b' : 'a'
    if (homes.length === 1 && homes[0].id === g.taskId && homes[0].gates[kind].some((x) => x.id === g.id)) placed++
  }
  assert.equal(placed, total, `${placed} of ${total} in the right place`)
  assert.equal(run.loose.workers.length + run.loose.gates.length, 0)

  // The failed worker is marked failed; the PR sits on the task of the worker that opened it.
  const failed = shown.flatMap((t) => t.workers).filter((w) => w.failed).map((w) => w.dispatchId)
  assert.deepEqual(failed, c.expect.failedWorkers)
  assert.deepEqual(shown.filter((t) => t.pr).map((t) => [t.id, t.pr?.number]), [['task_b2c3d4e5f6a1', 42]])
  assert.deepEqual(run.counts, { tasks: 4, done: 1, workers: 3, failed: 1, pendingGates: 2 })
})

test('done tasks fold; a done task with an open gate B (merge) stays open', () => {
  const c = caseWithPr()
  const open = lineFromCase(c).runs[0]
  // Task 2 is completed but its merge gate is pending: it stays in view.
  assert.deepEqual(open.tasks.map((t) => t.id), ['task_a1b2c3d4e5f6', 'task_b2c3d4e5f6a1', 'task_c3d4e5f6a1b2', 'task_d4e5f6a1b2c3'])
  assert.deepEqual(open.done, [])
  // Merge gate resolved: task 2 folds under Done, with its worker, PR and gates.
  c.gateList.result.gates[1].status = 'resolved'
  const folded = lineFromCase(c).runs[0]
  assert.deepEqual(folded.done.map((t) => t.id), ['task_b2c3d4e5f6a1'])
  assert.equal(folded.done[0].workers[0].dispatchId, 'ctx_1b2c3d4e5f0a')
  assert.equal(folded.done[0].pr?.number, 42)
  assert.equal(folded.done[0].gates.a.length + folded.done[0].gates.b.length, 2)
  assert.equal(folded.tasks.length, 3)
})

test('recorded fixtures: two Runs get a line, run_unbound none, the legacy Run is listed by name', () => {
  const runs = parseRunList(resultOf('cli/orchestration-run-list.json'))
  const line = buildRunLine({
    run: runs[0],
    detail: null,
    tasks: parseTaskList(resultOf('cli/orchestration-task-list.json')),
    workers: parseWorkerList(resultOf('cli/orchestration-worker-list.json')),
    gates: parseGateList(resultOf('cli/orchestration-gate-list.json'))
  })
  assert.deepEqual(line.tasks.map((t) => t.step), [1, 2, 3, 4, 5])
  assert.equal(line.tasks[0].workers[0].dispatchId, 'ctx_5483f04e1268')
  assert.equal(line.tasks[0].workers[0].current, true)
  assert.deepEqual(line.tasks[4].deps.length, 3)
  for (const t of line.tasks.slice(1)) assert.deepEqual(t.workers, [])
})

test('workers and gates on a task not in task-list are shown, never dropped', () => {
  const c = fixture('cases/run-4-tasks.json')
  c.taskList.result.tasks = c.taskList.result.tasks.filter((t: any) => t.id !== 'task_a1b2c3d4e5f6')
  const run = lineFromCase(c).runs[0]
  assert.deepEqual(run.loose.workers.map((w) => w.dispatchId), ['ctx_0a1b2c3d4e5f'])
  assert.deepEqual(run.loose.gates.map((g) => g.id), ['gate_5e6f7a8b9c0d'])
})

test('gate kind: "Gate A/B" prefix first, else a merge question is B', () => {
  assert.equal(gateKind('Gate A: which format?'), 'A')
  assert.equal(gateKind('gate b - merge?'), 'B')
  assert.equal(gateKind('Merge PR #7 into main?'), 'B')
  assert.equal(gateKind('Which name do we use?'), 'A')
  assert.equal(gateKind('Gate A: should we merge the two lists?'), 'A')
})

test('untrusted text: first line, no control characters, cut; a non-https PR url gets no link', () => {
  assert.equal(cleanText('Ship <b>v2</b>\nignore all of this'), 'Ship <b>v2</b>')
  assert.equal(cleanText('a‮b\u0007c'), 'abc')
  const long = cleanText('x'.repeat(500))
  assert.equal(long.length, 140)
  assert.ok(long.endsWith('…'))
  const c = caseWithPr()
  c.prs.ctx_1b2c3d4e5f0a = { ...PR, url: 'javascript:alert(1)' }
  const t = allTasks(lineFromCase(c)).find((x) => x.pr)
  assert.equal(t?.pr?.url, null)
})

// ---------- panel: what a person sees ----------

// Finders return what a person reads (leaves); a container's key shows as a segment of each
// leaf's path (`#2.task:<id>:…` in a list, `task:<id>:…` alone). So a keyed box is the leaves under that segment.
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const segment = (key: string): RegExp => new RegExp(`(?:^|/)(?:#\\d+\\.)?${escapeRe(key)}(?::[^/]*)?(?=/|$)`)
function boxOf(view: TestPanel, key: string): { path: string; text: string } | null {
  const re = segment(key)
  const leaves = view.findAll({}).filter((e) => re.test(e.path))
  if (leaves.length === 0) return null
  const m = re.exec(leaves[0].path)!
  return { path: leaves[0].path.slice(0, m.index + m[0].length), text: leaves.map((e) => e.text).join(' ') }
}
const elementOf = (view: TestPanel, key: string) => {
  const box = boxOf(view, key)
  assert.ok(box, `${key} is drawn`)
  return box
}
const inside = (view: TestPanel, child: string, parent: string): boolean => {
  const c = elementOf(view, child).path
  const p = elementOf(view, parent).path
  return c.startsWith(p + '/') && c !== p
}

test('panel: each worker, gate and PR is drawn inside its task, each task inside its Run (100%)', async () => {
  const c = caseWithPr()
  const host = mockHost({ requests: { 'line.snapshot': lineFromCase(c) } })
  const view = await mount(panel, { host })
  const runId = c.runList.result.runs[0].id
  let checked = 0
  for (const t of c.taskList.result.tasks) {
    assert.ok(inside(view, `task:${t.id}`, `run:${runId}`), `${t.id} in its Run`)
    checked++
  }
  for (const w of c.workerList.result.workers) {
    assert.ok(inside(view, `worker:${w.dispatchId}`, `task:${w.taskId}`), `${w.dispatchId} in ${w.taskId}`)
    checked++
  }
  for (const g of c.gateList.result.gates) {
    assert.ok(inside(view, `gate:${g.id}`, `task:${g.taskId}`), `${g.id} in ${g.taskId}`)
    checked++
  }
  assert.ok(inside(view, 'pr:task_b2c3d4e5f6a1', 'task:task_b2c3d4e5f6a1'))
  assert.equal(checked, 4 + 3 + 3)
  // Build order reads top to bottom.
  const order = c.expect.buildOrder.map((id: string) => elementOf(view, `task:${id}`).text.match(/^(\d+)\./)?.[1])
  assert.deepEqual(order, ['1', '2', '3', '4'])
  assert.match(elementOf(view, 'gate:gate_5e6f7a8b9c0d').text, /Gate A: question.*open.*Options: CSV \/ JSON/)
  assert.match(elementOf(view, 'gate:gate_6f7a8b9c0d1e').text, /Gate B: merge/)
  assert.match(elementOf(view, 'worker:ctx_2c3d4e5f0a1b').text, /^failed/)
  assert.equal(view.find({ text: 'PR #42' })?.props.href, PR.url)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('panel: done tasks sit folded under "Done" and open on a click', async () => {
  const c = caseWithPr()
  c.gateList.result.gates[1].status = 'resolved'
  const view = await mount(panel, { host: mockHost({ requests: { 'line.snapshot': lineFromCase(c) } }) })
  assert.equal(boxOf(view, 'task:task_b2c3d4e5f6a1'), null, 'folded')
  await view.toggle({ label: 'Done (1)' })
  assert.ok(inside(view, 'task:task_b2c3d4e5f6a1', 'done:run_4a9c1e7b2d30'))
  assert.ok(inside(view, 'worker:ctx_1b2c3d4e5f0a', 'task:task_b2c3d4e5f6a1'))
  await view.unmount()
})

test('panel: no Runs shows "No runs" and the panel still works', async () => {
  let asked = 0
  const empty = lineFromCase({ runList: { ok: true, result: { runs: [] } } })
  const view = await mount(panel, { host: mockHost({ requests: { 'line.snapshot': () => (asked++, empty) } }) })
  assert.ok(view.find({ type: 'EmptyState', label: 'No runs' }))
  await view.press({ label: 'Refresh the shipping line' })
  assert.ok(asked >= 2, `asked ${asked} times`)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('panel: CLI missing shows one banner with the paths tried', async () => {
  const snap: LineSnapshot = { status: 'error', updatedAt: null, error: { kind: 'not_found', message: 'No Orca CLI on any path.', tried: ['/opt/Orca/resources/bin/orca', 'orca (PATH)'] }, runs: [], legacy: [], hiddenRuns: 0, notes: [], refreshSeconds: 20 }
  const view = await mount(() => <LineView snap={snap} />)
  assert.equal(view.findAll({ type: 'Callout' }).length, 1)
  assert.match(view.find({ type: 'Callout' })?.text ?? '', /CLI not found.*\/opt\/Orca\/resources\/bin\/orca/)
  assert.equal(view.find({ label: 'No runs' }), null)
  await view.unmount()
})

test('panel: a title with HTML is drawn as plain text', async () => {
  const c = fixture('cases/run-4-tasks.json')
  c.taskList.result.tasks[1].title = '<img src=x onerror=alert(1)> Slice 1\nsecond line'
  const view = await mount(panel, { host: mockHost({ requests: { 'line.snapshot': lineFromCase(c) } }) })
  assert.match(elementOf(view, 'task:task_a1b2c3d4e5f6').text, /^1\. <img src=x onerror=alert\(1\)> Slice 1/)
  assert.ok(!elementOf(view, 'task:task_a1b2c3d4e5f6').text.includes('second line'))
  assert.equal(view.findAll({ type: 'Markdown' }).length, 0)
  await view.unmount()
})

// ---------- refresh: in turns, read only, keeps the last good data ----------

/** A fake CLI that answers from the 4-task case and records each call and how many ran at once. */
function fakeCli(over: Partial<Record<string, CliResult>> = {}) {
  const c = fixture('cases/run-4-tasks.json')
  const answers: Record<string, unknown> = {
    'orchestration run-list': c.runList.result,
    'orchestration run-show': c.runShow.result,
    'orchestration task-list': c.taskList.result,
    'orchestration worker-list': c.workerList.result,
    'orchestration gate-list': c.gateList.result,
    'bot list': { bots: [{ id: '0f6b2a9e-1c3d-4e5f-8a7b-9c0d1e2f3a4b', name: 'Anvil' }] },
    'bot work list': { items: [{ id: 'w1', dispatchId: 'ctx_1b2c3d4e5f0a', title: 'Slice 2', state: 'completed', pr: { ...PR, shown: true } }] }
  }
  const calls: CliRequest[] = []
  let active = 0
  let maxActive = 0
  const cli = {
    async run(req: CliRequest): Promise<CliResult> {
      calls.push(req)
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 1))
      active--
      return over[req.command] ?? { ok: true, result: answers[req.command], ms: 1, cliPath: '/opt/Orca/resources/bin/orca' }
    }
  }
  return { cli, calls, maxActive: () => maxActive, over }
}

test('refresh: one CLI call at a time, only read commands, PR from bot work list', async () => {
  const f = fakeCli()
  let t = 1_000_000
  const r = createLineRefresher({ cli: f.cli, now: () => t })
  const snap = await r.refresh()
  assert.equal(f.maxActive(), 1)
  assert.deepEqual(f.calls.map((c) => c.command), [
    'orchestration run-list', 'orchestration run-show', 'orchestration task-list', 'orchestration worker-list', 'orchestration gate-list', 'bot list', 'bot work list'
  ])
  assert.equal(snap.status, 'ok')
  assert.equal(allTasks(snap).find((x) => x.id === 'task_b2c3d4e5f6a1')?.pr?.number, 42)
  // Not due within 20 s less the 1 s slack (measured from the start of the last refresh); a second ask while one runs joins it.
  t += 18_000
  await r.refresh()
  assert.equal(f.calls.length, 7)
  t += 1_000
  await Promise.all([r.refresh(), r.refresh()])
  assert.equal(f.calls.length, 14)
})

test('refresh: a failed run-list keeps the last good data and says why', async () => {
  const f = fakeCli()
  let t = 0
  const r = createLineRefresher({ cli: f.cli, now: () => t })
  const good = await r.refresh()
  const fail = createLineRefresher({ cli: fakeCli({ 'orchestration run-list': { ok: false, error: { kind: 'cli_error', code: 'runtime_unavailable', message: 'runtime_unavailable: Orca is busy\nstack' }, ms: 5, cliPath: null } }).cli })
  assert.equal((await fail.refresh()).status, 'error')
  // Same refresher, now failing: the Runs stay, with the error and their time.
  ;(f.cli as any).run = async () => ({ ok: false, error: { kind: 'timeout', message: 'No answer in 10 s' }, ms: 10_000, cliPath: null })
  t += 20_000
  const after = await r.refresh()
  assert.equal(after.runs.length, good.runs.length)
  assert.equal(after.updatedAt, good.updatedAt)
  assert.equal(after.error?.kind, 'timeout')
})

test('refresh: no Runs means no per-Run calls and no bot calls', async () => {
  const f = fakeCli({ 'orchestration run-list': { ok: true, result: { runs: [{ id: 'run_unbound', objective: 'mail' }] }, ms: 1, cliPath: 'x' } })
  const snap = await createLineRefresher({ cli: f.cli }).refresh()
  assert.deepEqual(f.calls.map((c) => c.command), ['orchestration run-list'])
  assert.equal(snap.status, 'ok')
  assert.deepEqual(snap.runs, [])
})

test('worker: line.snapshot answers at once and posts line.changed after the refresh', async () => {
  const f = fakeCli()
  const worker = await mountWorker({ default: (orca: any) => registerLine(orca, f.cli) }, { events: [] })
  const first = (await worker.request('line.snapshot', {})) as LineSnapshot
  assert.equal(first.status, 'loading')
  for (let i = 0; i < 100 && !worker.posts.some((p) => p.event === 'line.changed'); i++) await new Promise((r) => setTimeout(r, 20))
  const posted = worker.posts.filter((p) => p.event === 'line.changed')
  assert.equal(posted.length, 1)
  assert.equal((posted[0].payload as LineSnapshot).runs.length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

// ---------- review of #3 ----------

const fail = (message: string): CliResult => ({ ok: false, error: { kind: 'timeout', message }, ms: 10_000, cliPath: null })

test('a failed per-Run call keeps that list from the last good refresh and shows every error', async () => {
  const f = fakeCli()
  let t = 0
  const r = createLineRefresher({ cli: f.cli, now: () => t })
  const good = (await r.refresh()).runs[0]
  f.over['orchestration task-list'] = fail('No answer in 10 s')
  f.over['orchestration gate-list'] = fail('gates timed out\nstack line')
  t += 20_000
  const run = (await r.refresh()).runs[0]
  // The tasks, their workers and gates stay where they were; nothing moves to "Not on a listed task".
  assert.deepEqual([...run.tasks, ...run.done].map((x) => x.id), [...good.tasks, ...good.done].map((x) => x.id))
  assert.deepEqual(run.tasks.map((x) => x.workers.map((w) => w.dispatchId)), good.tasks.map((x) => x.workers.map((w) => w.dispatchId)))
  assert.deepEqual(run.tasks.map((x) => [...x.gates.a, ...x.gates.b].map((g) => g.id)), good.tasks.map((x) => [...x.gates.a, ...x.gates.b].map((g) => g.id)))
  assert.equal(run.loose.workers.length + run.loose.gates.length, 0)
  assert.equal(run.error, 'task-list: No answer in 10 s; gate-list: gates timed out (showing the last good data)')
})

test('failed PR calls keep the last good PR links and say why', async () => {
  const f = fakeCli()
  let t = 0
  const r = createLineRefresher({ cli: f.cli, now: () => t })
  const prOf = (s: LineSnapshot) => allTasks(s).find((x) => x.id === 'task_b2c3d4e5f6a1')?.pr?.number
  assert.equal(prOf(await r.refresh()), 42)
  f.over['bot work list'] = fail('No answer in 10 s')
  t += 20_000
  let s = await r.refresh()
  assert.equal(prOf(s), 42)
  assert.match(s.notes[0], /^PR links: bot work list failed for 1 bot: No answer in 10 s/)
  f.over['bot list'] = fail('runtime_unavailable')
  t += 20_000
  s = await r.refresh()
  assert.equal(prOf(s), 42)
  assert.match(s.notes[0], /^PR links: bot list: runtime_unavailable/)
  delete f.over['bot list']
  delete f.over['bot work list']
  t += 20_000
  assert.deepEqual((await r.refresh()).notes, [])
})

test('a throw in onChange (post to a closed panel) never rejects the refresh', async () => {
  const r = createLineRefresher({ cli: fakeCli().cli, onChange: () => { throw new Error('panel closed') } })
  const s = await r.refresh()
  assert.equal(s.status, 'ok')
})

test('more than 50 Runs: the first 50 get a line and the panel says how many are not shown', async () => {
  const runs = Array.from({ length: 53 }, (_, i) => ({ id: `run_r${i}`, objective: `Run ${i}` }))
  const f = fakeCli({ 'orchestration run-list': { ok: true, result: { runs }, ms: 1, cliPath: 'x' }, 'orchestration task-list': { ok: true, result: { tasks: [] }, ms: 1, cliPath: 'x' }, 'orchestration worker-list': { ok: true, result: { workers: [] }, ms: 1, cliPath: 'x' } })
  const s = await createLineRefresher({ cli: f.cli }).refresh()
  assert.equal(s.runs.length, 50)
  assert.equal(s.hiddenRuns, 3)
  const view = await mount(() => <LineView snap={s} />)
  assert.ok(view.find({ text: '+3 more Runs not shown (the first 50 are)' }))
  await view.unmount()
})

test('error banner title follows the failure kind', async () => {
  const base: LineSnapshot = { status: 'error', updatedAt: null, error: { kind: 'worker', message: 'x', tried: [] }, runs: [], legacy: [], hiddenRuns: 0, notes: [], refreshSeconds: 20 }
  for (const [kind, title] of [['worker', 'The plugin worker did not answer'], ['internal', 'The shipping line failed to load'], ['timeout', 'The Orca CLI did not answer'], ['not_found', 'CLI not found']]) {
    const view = await mount(() => <LineView snap={{ ...base, error: { ...base.error!, kind } }} />)
    assert.equal(view.find({ type: 'Callout' })?.props.title, title)
    await view.unmount()
  }
})

test('cleanText cuts by code points and never splits an emoji', () => {
  const s = cleanText('😀'.repeat(10), 5)
  assert.equal(s, '😀😀😀😀…')
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(s))
})

// ---------- review of #3, round 2: the interval with a slow CLI ----------

test('slow CLI (about 5 s per refresh): a panel asking every second still gets a refresh about every 20 s', async () => {
  let t = 0
  const starts: number[] = []
  const f = fakeCli()
  const slow = {
    async run(req: CliRequest): Promise<CliResult> {
      if (req.command === 'orchestration run-list') starts.push(t)
      t += 700 // 7 calls per refresh: about 5 s
      return f.cli.run(req)
    }
  }
  const r = createLineRefresher({ cli: slow, now: () => t })
  // The panel's 1 s tick while visible: every tick asks, the refresher decides.
  while (t < 80_000) {
    await r.refresh()
    t = (Math.floor(t / 1000) + 1) * 1000
  }
  const gaps = starts.slice(1).map((s, i) => s - starts[i])
  assert.ok(starts.length >= 4, `${starts.length} refreshes in 80 s: ${starts.join(', ')}`)
  for (const g of gaps) assert.ok(g >= 19_000 && g <= 21_000, `gap ${g} ms between refresh starts`)
})

test('a refresh longer than the interval is not followed at once by the next', async () => {
  let t = 0
  const starts: number[] = []
  const f = fakeCli()
  const slower = {
    async run(req: CliRequest): Promise<CliResult> {
      if (req.command === 'orchestration run-list') starts.push(t)
      t += 4_000 // 7 calls: 28 s, longer than the 20 s interval
      return f.cli.run(req)
    }
  }
  const r = createLineRefresher({ cli: slower, now: () => t })
  while (t < 100_000) {
    await r.refresh()
    t = (Math.floor(t / 1000) + 1) * 1000
  }
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - (starts[i - 1] + 28_000) >= 2_000, `starts ${starts.join(', ')}`)
})

test('worker: an ask with the version the panel already has answers null', async () => {
  const f = fakeCli()
  const worker = await mountWorker({ default: (orca: any) => registerLine(orca, f.cli) }, { events: [] })
  await worker.request('line.snapshot', {})
  for (let i = 0; i < 100 && !worker.posts.some((p) => p.event === 'line.changed'); i++) await new Promise((r) => setTimeout(r, 20))
  const latest = (await worker.request('line.snapshot', {})) as LineSnapshot
  assert.equal(typeof latest.version, 'number')
  assert.equal(await worker.request('line.snapshot', { version: latest.version }), null)
  assert.equal(((await worker.request('line.snapshot', { version: -1 })) as LineSnapshot).version, latest.version)
  await worker.deactivate()
})
