// R5 AC with a slow CLI: an agent at a trust prompt gets its "trust this folder" label within
// 10 s, even when every other CLI call takes 2.5 s (live: 1.6-2.7 s each). The real worker runs
// with its timers and the fake CLI's delays scaled down 20 times, so 10 s of Orca time is 0.5 s.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { CliRequest } from '../src/cli/commands.ts'
import type { CliResult, CliRunner } from '../src/cli/run.ts'
import * as main from '../src/worker.ts'
import { TRUST_LABEL } from '../src/views/waits/collect.ts'
import { fixture } from './helpers.ts'
import { FIXTURE_CLI_PATH } from './waits-fixture.ts'

const SCALE = 20
/** Orca time in ms -> test time in ms. */
const t = (ms: number): number => ms / SCALE
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

const PS_MS = 2_000
const OTHER_MS = 2_500
const BOTS = Array.from({ length: 4 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`)
const TRUST = fixture('cases/trust-blocked-agent.json').worktreePsAgentWait as { ok: true; result: unknown }

test('R5 AC, slow CLI: the trust label shows within 10 s while item and gate calls take 2.5 s each', async () => {
  let trustFrom = Infinity
  const kinds: string[] = []
  const run = async (r: CliRequest): Promise<CliResult> => {
    kinds.push(r.command)
    const started = Date.now()
    await sleep(t(r.command === 'worktree ps' ? PS_MS : OTHER_MS))
    // `worktree ps` reports the prompt only when the call starts after the agent reached it.
    if (r.command === 'worktree ps' && started >= trustFrom) return { ok: true, result: TRUST.result, ms: PS_MS, cliPath: FIXTURE_CLI_PATH }
    // 4 bots and 2 Runs, as on a live account: a full item pass is 4 x 2.5 s of items after
    // 2.5 s of lists and 2 x 2.5 s of tasks, about 17.5 s.
    if (r.command === 'bot list') return { ok: true, result: { bots: BOTS.map((id, i) => ({ id, name: `Bot ${i}` })) }, ms: OTHER_MS, cliPath: FIXTURE_CLI_PATH }
    if (r.command === 'orchestration run-list') return { ok: true, result: { runs: [{ id: 'run_aaa' }, { id: 'run_bbb' }] }, ms: OTHER_MS, cliPath: FIXTURE_CLI_PATH }
    // Before the prompt, no agent waits (the fixture's own list has trust prompts already).
    if (r.command === 'worktree ps') return { ok: true, result: { worktrees: [] }, ms: PS_MS, cliPath: FIXTURE_CLI_PATH }
    return { ok: true, result: {}, ms: OTHER_MS, cliPath: FIXTURE_CLI_PATH }
  }
  const runner: CliRunner = {
    run,
    current: () => ({ path: FIXTURE_CLI_PATH, source: 'app' }),
    lastResolution: () => ({ ok: true, path: FIXTURE_CLI_PATH, source: 'app', tried: [{ path: FIXTURE_CLI_PATH, source: 'app' }] }),
    reset: () => undefined
  }
  const real = { ...main.runtime }
  main.runtime.createRunner = () => runner
  main.runtime.setInterval = ((fn: () => void, ms: number) => setInterval(fn, t(ms))) as unknown as typeof setInterval
  main.runtime.setTimeout = ((fn: () => void, ms: number) => setTimeout(fn, t(ms))) as unknown as typeof setTimeout
  const host = mockHost({ storage: { 'waits.notified': [] }, settings: { orcaCli: '', notifyNewWaits: true } })
  const worker = await mountWorker(main, { host, events: ['agent.status.changed'] })
  try {
    // Let both loops run a while (12 s of Orca time), then the agent reaches the trust prompt.
    await sleep(t(12_000))
    trustFrom = Date.now()
    let shownAfter = Infinity
    while (Date.now() - trustFrom < t(20_000)) {
      const snap = (await worker.request('waits.get')) as { waits: { label: string }[] }
      if (snap.waits.some((w) => w.label === TRUST_LABEL)) {
        shownAfter = (Date.now() - trustFrom) * SCALE
        break
      }
      await sleep(2)
    }
    assert.ok(shownAfter <= 10_000, `trust label after ${Math.round(shownAfter)} ms of Orca time`)
    // The test means something: the item loop read every bot, so its pass is longer than 10 s.
    assert.ok(kinds.filter((k) => k === 'bot item list').length >= BOTS.length, 'every bot read')
  } finally {
    await worker.deactivate()
    Object.assign(main.runtime, real)
  }
})
