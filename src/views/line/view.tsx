// R6. Draws a LineSnapshot. Pure: no host calls, so tests mount it with any snapshot.
// All CLI text arrives cut by model.ts and is drawn as text children, never as Markdown or HTML.
import { Badge, Box, Callout, Card, Collapsible, EmptyState, Heading, IconButton, Link, RelativeTime, Row, Skeleton, Stack, Text, type Tone } from 'orca'
import type { GateLine, LineSnapshot, PrLine, RunLine, TaskLine, WorkerLine } from './model.ts'

const TASK_TONE: Record<string, Tone> = { completed: 'success', failed: 'danger', circuit_broken: 'danger', blocked: 'warning', dispatched: 'accent', ready: 'neutral', pending: 'neutral' }
const TASK_LABEL: Record<string, string> = { circuit_broken: 'stopped', dispatched: 'working', completed: 'done' }

const WORKER_TONE: Record<string, Tone> = { failed: 'danger', succeeded: 'success', ready: 'accent', starting: 'accent', stopping: 'neutral', stopped: 'neutral', abandoned: 'neutral', start_unknown: 'warning', stop_unknown: 'warning' }
const WORKER_LABEL: Record<string, string> = { ready: 'running', start_unknown: 'start unknown', stop_unknown: 'stop unknown' }

/** The error banner's title by failure kind; any other kind is a CLI that did not answer. */
const ERROR_TITLE: Record<string, string> = { not_found: 'CLI not found', worker: 'The plugin worker did not answer', internal: 'The shipping line failed to load', refused: 'A CLI call was refused' }

const PR_TONE: Record<string, Tone> = { open: 'accent', draft: 'neutral', merged: 'success', closed: 'neutral' }

function workerLabel(w: WorkerLine): string {
  if (w.failed) return 'failed'
  return WORKER_LABEL[w.state] ?? w.state
}

function WorkerRow({ w }: { w: WorkerLine }) {
  return (
    <Row key={`worker:${w.dispatchId}`} gap="xs" wrap>
      <Badge tone={w.failed ? 'danger' : (WORKER_TONE[w.state] ?? 'neutral')}>{workerLabel(w)}</Badge>
      <Text size="xs" muted={!w.current}>
        {w.agent ?? 'agent unknown'}
      </Text>
      <Text size="xs" muted>
        {w.dispatchId}
        {w.current ? '' : ' (earlier)'}
      </Text>
    </Row>
  )
}

function PrRow({ pr, taskId }: { pr: PrLine; taskId: string }) {
  const label = `PR #${pr.number}`
  return (
    <Row key={`pr:${taskId}`} gap="xs" wrap>
      {pr.url ? <Link href={pr.url}>{label}</Link> : <Text size="xs">{label}</Text>}
      <Badge tone={PR_TONE[pr.state] ?? 'neutral'}>{pr.state}</Badge>
      {pr.checks ? <Text size="xs" muted>checks {pr.checks}</Text> : null}
      {pr.review ? <Text size="xs" muted>{pr.review.toLowerCase().replace(/_/g, ' ')}</Text> : null}
    </Row>
  )
}

function GateRow({ g }: { g: GateLine }) {
  const open = g.status === 'pending'
  return (
    <Stack key={`gate:${g.id}`} gap="none">
      <Row gap="xs" wrap>
        <Badge tone={open ? 'warning' : 'neutral'}>{g.kind === 'A' ? 'Gate A: question' : 'Gate B: merge'}</Badge>
        <Text size="xs" muted>
          {open ? 'open' : g.status}
        </Text>
      </Row>
      <Text size="xs" muted={!open}>
        {g.question || '(no question text)'}
      </Text>
      {g.options.length > 0 ? (
        <Text size="xs" muted>
          Options: {g.options.join(' / ')}
        </Text>
      ) : null}
    </Stack>
  )
}

function TaskBox({ t, steps }: { t: TaskLine; steps: Map<string, number> }) {
  const after = t.deps.map((d) => steps.get(d)).filter((n): n is number => n !== undefined)
  const gates = [...t.gates.a, ...t.gates.b]
  return (
    <Box key={`task:${t.id}`} border={t.status === 'failed' ? 'danger' : true} radius="md" padding="sm" gap="xs">
      <Row justify="between" gap="sm">
        <Text weight="medium">
          {`${t.step}. ${t.title}`}
        </Text>
        <Badge tone={TASK_TONE[t.status] ?? 'neutral'}>{TASK_LABEL[t.status] ?? t.status}</Badge>
      </Row>
      {after.length > 0 ? (
        <Text size="xs" muted>
          After {after.map((n) => `#${n}`).join(', ')}
        </Text>
      ) : null}
      {t.workers.length > 0 ? t.workers.map((w) => <WorkerRow key={`worker:${w.dispatchId}`} w={w} />) : <Text size="xs" muted>No worker</Text>}
      {t.pr ? <PrRow key={`pr:${t.id}`} pr={t.pr} taskId={t.id} /> : null}
      {gates.map((g) => (
        <GateRow key={`gate:${g.id}`} g={g} />
      ))}
    </Box>
  )
}

function RunCard({ run }: { run: RunLine }) {
  const steps = new Map([...run.tasks, ...run.done].map((t) => [t.id, t.step]))
  const c = run.counts
  const parts = [`${c.tasks} task${c.tasks === 1 ? '' : 's'}`, `${c.done} done`]
  if (c.failed > 0) parts.push(`${c.failed} failed`)
  if (c.pendingGates > 0) parts.push(`${c.pendingGates} open gate${c.pendingGates === 1 ? '' : 's'}`)
  const looseCount = run.loose.workers.length + run.loose.gates.length
  return (
    <Card key={`run:${run.id}`} title={run.objective} description={`${run.id} · ${parts.join(' · ')}`}>
      <Stack gap="sm">
        {run.error ? (
          <Text size="xs" tone="warning">
            Part of this Run did not load: {run.error}
          </Text>
        ) : null}
        {run.tasks.length === 0 && run.done.length === 0 ? <Text muted size="sm">No tasks</Text> : null}
        {run.tasks.map((t) => (
          <TaskBox key={`task:${t.id}`} t={t} steps={steps} />
        ))}
        {run.done.length > 0 ? (
          <Collapsible key={`done:${run.id}`} title={`Done (${run.done.length})`} defaultOpen={false}>
            <Stack gap="sm">
              {run.done.map((t) => (
                <TaskBox key={`task:${t.id}`} t={t} steps={steps} />
              ))}
            </Stack>
          </Collapsible>
        ) : null}
        {looseCount > 0 ? (
          <Collapsible key={`loose:${run.id}`} title={`Not on a listed task (${looseCount})`} defaultOpen>
            <Stack gap="xs">
              {run.loose.workers.map((w) => (
                <WorkerRow key={`worker:${w.dispatchId}`} w={w} />
              ))}
              {run.loose.gates.map((g) => (
                <GateRow key={`gate:${g.id}`} g={g} />
              ))}
            </Stack>
          </Collapsible>
        ) : null}
        {run.removed.tasks > 0 ? (
          <Text size="xs" muted>
            {run.removed.tasks} task{run.removed.tasks === 1 ? '' : 's'} removed from this Run
          </Text>
        ) : null}
      </Stack>
    </Card>
  )
}

export function LineView({ snap, onRefresh }: { snap: LineSnapshot; onRefresh?: () => void }) {
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading level={2}>Shipping line</Heading>
        {onRefresh ? <IconButton icon="refresh" label="Refresh the shipping line" variant="ghost" size="sm" onPress={onRefresh} /> : null}
      </Row>
      {snap.error ? (
        <Callout key="line-error" tone={snap.updatedAt === null ? 'danger' : 'warning'} title={ERROR_TITLE[snap.error.kind] ?? 'The Orca CLI did not answer'}>
          <Stack gap="xs">
            <Text size="sm">{snap.error.message}</Text>
            {snap.error.tried.length > 0 ? (
              <Text size="xs" muted>
                Tried: {snap.error.tried.join(', ')}
              </Text>
            ) : null}
            {snap.updatedAt !== null ? (
              <Text size="xs" muted>
                Showing data from <RelativeTime at={snap.updatedAt} />.
              </Text>
            ) : null}
          </Stack>
        </Callout>
      ) : null}
      {snap.notes.map((n, i) => (
        <Text key={`note:${i}`} size="xs" tone="warning">
          {n}
        </Text>
      ))}
      {snap.status === 'loading' ? <Skeleton lines={3} label="Loading the shipping line" /> : null}
      {snap.status === 'ok' && snap.runs.length === 0 ? <EmptyState key="no-runs" icon="rocket" title="No runs" description="Runs that Orca orchestration starts show here." /> : null}
      {snap.runs.map((r) => (
        <RunCard key={`run:${r.id}`} run={r} />
      ))}
      {snap.hiddenRuns > 0 ? (
        <Text key="hidden-runs" size="xs" muted>
          {`+${snap.hiddenRuns} more Run${snap.hiddenRuns === 1 ? '' : 's'} not shown (the first 50 are)`}
        </Text>
      ) : null}
      {snap.legacy.length > 0 ? (
        <Text size="xs" muted>
          Legacy runs, read only: {snap.legacy.map((r) => r.objective).join('; ')}
        </Text>
      ) : null}
      {snap.updatedAt !== null ? (
        <Text size="xs" muted>
          Updated <RelativeTime at={snap.updatedAt} format="short" /> · every {snap.refreshSeconds} s
        </Text>
      ) : null}
    </Stack>
  )
}
