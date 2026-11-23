// Typed models parsed from the recorded --json of the 12 commands and the hand-made cases.
import { assert, test } from 'orca/testing'
import {
  agentFromEvent, agentFromListRow, agentWaits, allAgents, buildOrder, mergeAgents, sameAgent, type Agent, type AgentsListRow, isWorkerFailed, itemNeedsYou, parseAutomations, parseBotChats,
  parseBotItemList, parseBotList, parseBotWorkList, parseEnvelope, parseGateList, parseInbox, parseRunList, parseRunShow,
  parseTaskList, parseWorkerList, parseWorktreePs, type AgentStatusEvent
} from '../src/model/index.ts'
import { fixture, fixtureText, resultOf } from './helpers.ts'

// ---------- recorded: one test per command ----------

test('bot list (recorded, 9 bots)', () => {
  const bots = parseBotList(resultOf('cli/bot-list.json'))
  assert.equal(bots.length, 9)
  for (const b of bots) assert.match(b.id, /^[0-9a-f-]{36}$/)
  assert.equal(bots[0].name, 'Anvil')
  assert.equal(bots[1].chatCount, 8)
})

test('bot item list (recorded): in_progress reads as working; dispatch link with PR', () => {
  const page = parseBotItemList(resultOf('cli/bot-item-list.json'))
  assert.equal(page.items.length, 4)
  assert.deepEqual(page.counts, { done: 1, working: 3 })
  assert.equal(page.items.filter((i) => i.status === 'working').length, 3)
  const link = page.items[0].links[0]
  assert.equal(link.kind, 'dispatch')
  if (link.kind === 'dispatch') {
    assert.equal(link.state, 'working')
    assert.equal(link.pr?.state, 'open')
  }
  assert.equal(page.items.some(itemNeedsYou), false)
})

test('bot work list (recorded, empty)', () => {
  const page = parseBotWorkList(resultOf('cli/bot-work-list.json'))
  assert.deepEqual(page.items, [])
  assert.deepEqual(page.workspaces, [])
})

test('bot chats (recorded)', () => {
  const { chats } = parseBotChats(resultOf('cli/bot-chats.json'))
  assert.equal(chats.length, 4)
  assert.ok(chats.every((c) => c.id && typeof c.home === 'boolean'))
})

test('worktree ps (recorded)', () => {
  const ps = parseWorktreePs(resultOf('cli/worktree-ps.json'))
  assert.equal(ps.worktrees.length, 6)
  const agents = allAgents(ps)
  assert.ok(agents.length > 0)
  for (const a of agents) assert.ok(['working', 'blocked', 'waiting', 'done'].includes(a.state))
  assert.equal(agents.some((a) => a.trustPrompt), false)
})

test('automations list (recorded)', () => {
  const list = parseAutomations(resultOf('cli/automations-list.json'))
  assert.equal(list.length, 3)
  assert.ok(list.every((a) => typeof a.enabled === 'boolean'))
})

test('orchestration inbox (recorded)', () => {
  const msgs = parseInbox(resultOf('cli/orchestration-inbox.json'))
  assert.equal(msgs.length, 5)
})

test('run-list and run-show (recorded)', () => {
  const runs = parseRunList(resultOf('cli/orchestration-run-list.json'))
  assert.equal(runs.length, 4)
  assert.equal(runs.find((r) => r.id === 'run_unbound')?.unbound, true)
  assert.equal(runs.find((r) => r.id === 'run_legacy_local')?.legacy, true)
  const show = parseRunShow(resultOf('cli/orchestration-run-show.json'))
  assert.equal(show?.id, runs[0].id)
  assert.equal(show?.removed.tasks, 0)
})

test('task-list (recorded): deps parsed from a JSON string; build order', () => {
  const tasks = parseTaskList(resultOf('cli/orchestration-task-list.json'))
  assert.equal(tasks.length, 5)
  assert.equal(tasks[0].status, 'dispatched')
  assert.equal(tasks[4].deps.length, 3)
  const order = buildOrder(tasks).map((t) => t.id)
  assert.equal(order[0], tasks[0].id)
  assert.equal(order.at(-1), tasks[4].id)
})

test('worker-list and gate-list (recorded)', () => {
  const workers = parseWorkerList(resultOf('cli/orchestration-worker-list.json'))
  assert.equal(workers.length, 1)
  assert.equal(workers[0].state, 'ready')
  assert.deepEqual(parseGateList(resultOf('cli/orchestration-gate-list.json')), [])
})

// ---------- hand-made cases ----------

test('0 bots', () => {
  assert.deepEqual(parseBotList(resultOf('cases/bot-list-0.json')), [])
})

test('60 bots', () => {
  const bots = parseBotList(resultOf('cases/bot-list-60.json'))
  assert.equal(bots.length, 60)
  assert.equal(new Set(bots.map((b) => b.id)).size, 60)
})

test('a Run with 4 tasks and both gates', () => {
  const c = fixture('cases/run-4-tasks.json')
  const tasks = parseTaskList(c.taskList.result)
  assert.equal(tasks.length, 4)
  assert.deepEqual(buildOrder(tasks).map((t) => t.id), c.expect.buildOrder)
  const gates = parseGateList(c.gateList.result)
  assert.deepEqual(gates.filter((g) => g.status === 'pending').map((g) => g.id), c.expect.pendingGates)
  assert.deepEqual(gates[0].options, ['CSV', 'JSON'])
  assert.deepEqual(gates[1].options, [])
  for (const g of gates) assert.ok(tasks.some((t) => t.id === g.taskId), 'each gate sits on a task of the Run')
  const workers = parseWorkerList(c.workerList.result)
  assert.deepEqual(workers.filter(isWorkerFailed).map((w) => w.dispatchId), c.expect.failedWorkers)
  for (const w of workers) assert.ok(tasks.some((t) => t.id === w.taskId), 'each worker sits on a task of the Run')
  assert.equal(parseRunList(c.runList.result)[0].id, parseRunShow(c.runShow.result)?.id)
})

test('failed worker', () => {
  const [w] = parseWorkerList(resultOf('cases/worker-failed.json'))
  assert.equal(w.state, 'failed')
  assert.equal(isWorkerFailed(w), true)
})

test('bot item that needs you keeps its question as text', () => {
  const page = parseBotItemList(resultOf('cases/bot-item-needs-you.json'))
  const waits = page.items.filter(itemNeedsYou)
  assert.equal(waits.length, 1)
  assert.equal(waits[0].question?.text, 'Ship <b>v2</b> today, or wait for the review?')
  assert.equal(page.items[2].status, 'planned')
})

test('trust-blocked agent (live R5 record): event says waiting, worktree ps names the trust prompt', () => {
  const c = fixture('cases/trust-blocked-agent.json')
  for (const e of c.agentStatusChanged as AgentStatusEvent[]) {
    const a = agentFromEvent(e)
    assert.equal(a.state, 'waiting')
    assert.equal(a.trustPrompt, false, 'the plugin event carries no trust reason')
    assert.equal(agentWaits(a), true)
  }
  for (const key of ['worktreePsAgentWait', 'worktreePsPlain']) {
    const [a] = allAgents(parseWorktreePs(c[key].result))
    assert.equal(a.state, 'waiting')
    assert.equal(a.trustPrompt, true, key)
    assert.equal(a.waitMessage, 'trust this folder')
    assert.equal(a.key, c.agentStatusChanged[0].paneKey, 'same pane key as the event')
    assert.equal(a.terminalId, c.agentStatusChanged[0].terminalId, 'terminal id read from `address`, as agents.list names it')
  }
})

const trustSources = () => {
  const c = fixture('cases/trust-blocked-agent.json')
  const list = (c.agentsList.agents as AgentsListRow[]).map((r) => agentFromListRow(r, c.agentsList.workspaceId)).filter((a): a is Agent => a !== null)
  const events = (c.agentStatusChanged as AgentStatusEvent[]).map(agentFromEvent)
  const ps = allAgents(parseWorktreePs(c.worktreePsAgentWait.result))
  return { c, list, events, ps }
}

test('merge: the trust-prompt agent from all 3 sources is 1 row with trustPrompt', () => {
  const { c, list, events, ps } = trustSources()
  assert.equal(list[0].key, list[0].terminalId, 'agents.list alone keys on the terminal id')
  for (const order of [[list, events, ps], [ps, list, events], [events, ps, list], [list, ps]] as Agent[][][]) {
    const merged = mergeAgents(...order)
    assert.equal(merged.length, 1, `orders: ${order.map((o) => o[0].source).join(', ')}`)
    const [a] = merged
    assert.equal(a.key, c.agentStatusChanged[0].paneKey)
    assert.equal(a.paneKey, c.agentStatusChanged[0].paneKey)
    assert.equal(a.terminalId, c.agentStatusChanged[0].terminalId)
    assert.equal(a.state, 'waiting')
    assert.equal(a.trustPrompt, true)
    assert.equal(a.waitMessage, 'trust this folder')
    assert.equal(a.agentKind, 'claude')
    assert.equal(agentWaits(a), true)
  }
})

test('merge: a list row and an event row with no common id join through the ps row', () => {
  const { list, events, ps } = trustSources()
  assert.equal(sameAgent(list[0], events[0]), true, 'same terminal id')
  const eventNoTerminal = { ...events[1], terminalId: null }
  assert.equal(sameAgent(list[0], eventNoTerminal), false)
  assert.equal(mergeAgents([list[0]], [eventNoTerminal]).length, 2, 'no shared id: two rows')
  assert.equal(mergeAgents([list[0]], [eventNoTerminal], ps).length, 1, 'ps row links them')
})

test('merge: an answered trust prompt drops trustPrompt; a newer wait does not inherit it', () => {
  const { events, ps } = trustSources()
  const t = ps[0].stateStartedAt as number
  const working = agentFromEvent({ ...(events[1] as AgentStatusEvent), state: 'working', receivedAt: t + 5_000, mainAgent: { state: 'working', stateStartedAt: t + 5_000 } })
  const [a] = mergeAgents(ps, [working])
  assert.equal(a.state, 'working')
  assert.equal(a.trustPrompt, false)
  assert.equal(a.waitMessage, null)
  const laterWait = agentFromEvent({ ...(events[1] as AgentStatusEvent), state: 'waiting', receivedAt: t + 60_000, mainAgent: { state: 'waiting', stateStartedAt: t + 60_000 } })
  const [b] = mergeAgents(ps, [laterWait])
  assert.equal(b.state, 'waiting')
  assert.equal(b.trustPrompt, false, 'stale ps row')
})

test('merge: different agents stay apart; recorded worktree ps keeps its row count', () => {
  const ps = allAgents(parseWorktreePs(resultOf('cli/worktree-ps.json')))
  assert.ok(ps.every((a) => a.terminalId === null || a.terminalId.startsWith('term_')))
  assert.equal(mergeAgents(ps).length, ps.length)
  assert.equal(mergeAgents(ps, ps).length, ps.length, 'the same rows twice collapse')
})

test('malformed JSON and error envelopes', () => {
  assert.equal(parseEnvelope(fixtureText('cases/malformed.txt')), null)
  assert.equal(parseEnvelope(''), null)
  assert.equal(parseEnvelope('[1,2]'), null)
  assert.deepEqual(parseEnvelope(fixtureText('cases/cli-error-no-bot.json')), { ok: false, error: { code: 'invalid_argument', message: 'Name the bot with --bot, or run this from the bot’s chat.' } })
})

test('parsers never throw on junk and drop bad rows', () => {
  const junk: unknown[] = [null, undefined, 1, 'x', [], {}, { bots: 'no' }, { items: [null, 1, { uid: 'a' }] }]
  for (const j of junk) {
    parseBotList(j); parseBotItemList(j); parseBotWorkList(j); parseBotChats(j); parseWorktreePs(j); parseAutomations(j)
    parseInbox(j); parseRunList(j); parseRunShow(j); parseTaskList(j); parseWorkerList(j); parseGateList(j)
  }
  assert.deepEqual(parseTaskList({ tasks: [{ id: 'not-a-task', title: 'x' }, { id: 'task_abc', title: 'ok', deps: 'not json' }] }).map((t) => [t.id, t.deps]), [['task_abc', []]])
  assert.deepEqual(parseRunList({ runs: [{ id: 'run_ok', objective: 'o' }, { id: 'evil; rm', objective: 'x' }] }).map((r) => r.id), ['run_ok'])
  assert.equal(parseBotItemList({ items: [{ uid: 'u', number: 1, title: 't', status: 'brand_new' }] }).items[0].status, 'unknown')
})
