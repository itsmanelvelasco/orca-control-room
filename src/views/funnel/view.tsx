// Funnel slice 3 (PRD "Control Room funnel view", R4, R5 cards, R6, R7). Draws a FunnelSnapshot:
// four stage columns with counts, one card per piece of work, amber when it waits on the user,
// and a detail per card (tasks, workers, gates, PRs). Pure: no host calls, so tests mount it with
// any snapshot. Every text from the CLI arrives cut by the model and is drawn as text children,
// never as Markdown or HTML. Presses only open or focus (R6), through the callbacks.
import { atom, Badge, Box, Button, Callout, Collapsible, Grid, Heading, IconButton, Link, read, Row, Skeleton, Stack, Text, update, type Tone } from 'orca'
import { agoNow } from '../time.ts'
import type { Wait } from '../waits/collect.ts'
import { STAGES, type FunnelDetails, type FunnelWorker, type Piece, type Stage } from './model.ts'
import type { FunnelSnapshot } from './refresh.ts'

/** Each column shows this many cards, then "+N more" (PRD section 5). */
export const MAX_CARDS = 20

/** Cards whose detail is open. A closed detail is not drawn at all, so 200 cards stay a small tree. */
export const openDetails = atom<string[]>([])
const toggleDetail = (key: string, open: boolean): void => update(openDetails, (keys) => (open ? (keys.includes(key) ? keys : [...keys, key]) : keys.filter((k) => k !== key)))

export const STAGE_LABEL: Record<Stage, string> = { ideation: 'Ideation', planning: 'Planning', execution: 'Execution', shipping: 'Shipping' }
/** What each column means, under its name. Shipping is merged only until a deploy source exists. */
export const STAGE_HINT: Record<Stage, string> = { ideation: 'No PRD yet', planning: 'PRD or Run', execution: 'Open PR or worker', shipping: 'Merged' }

const PR_TONE: Record<string, Tone> = { open: 'accent', draft: 'neutral', merged: 'success', closed: 'neutral' }
const WORKER_TONE: Record<FunnelWorker['state'], Tone> = { working: 'accent', done: 'success', failed: 'danger', stopped: 'neutral', unknown: 'neutral' }
const TASK_TONE: Record<string, Tone> = { completed: 'success', failed: 'danger', circuit_broken: 'danger', blocked: 'warning', dispatched: 'accent', ready: 'neutral', pending: 'neutral' }
const TASK_LABEL: Record<string, string> = { circuit_broken: 'stopped', dispatched: 'working', completed: 'done' }

export type FunnelActions = {
  onRefresh?: () => void
  /** A card's Open (no dispatch id) or a worker's Focus. */
  onOpen?: (key: string, dispatchId?: string) => void
  /** An unlinked wait's Open: the Waits view's own open. */
  onOpenWait?: (key: string) => void
  /** The card or worker (`<key>` or `<key>#<dispatchId>`) whose last press opened nothing. */
  notOpened?: string | null
}

/** "Atlas #12", "Run", "Worker": who owns the piece and which item it is. */
function ownerLine(p: Piece): string {
  const who = p.botName ?? (p.kind === 'run' ? 'Run' : p.kind === 'work' ? 'Bot worker' : 'No bot')
  return p.item ? `${who} #${p.item.number}` : who
}

/** "2 open · 3 merged · 1 closed", only the counts above 0. */
function prLine(p: Piece): string | null {
  const c = p.prCount
  const parts = [c.open ? `${c.open} open` : '', c.merged ? `${c.merged} merged` : '', c.closed ? `${c.closed} closed` : ''].filter(Boolean)
  return parts.length ? `PRs: ${parts.join(' · ')}` : null
}

function WaitLine({ w }: { w: Wait }) {
  return (
    <Stack gap="none">
      <Text size="xs" tone="warning" weight="medium">
        {`${w.label}: ${w.what}`}
      </Text>
      {w.options.length > 0 ? (
        <Text size="xs" muted>
          {`Options: ${w.options.join(' / ')}`}
        </Text>
      ) : null}
    </Stack>
  )
}

function Detail({ p, details, actions }: { p: Piece; details: FunnelDetails; actions: FunnelActions }) {
  const tasks = p.taskIds.map((id) => details.tasks[id]).filter((t) => t)
  const gates = p.gateIds.map((id) => details.gates[id]).filter((g) => g)
  const empty = tasks.length + gates.length + p.workers.length + p.prs.length + p.prds.length === 0
  return (
    <Stack gap="xs">
      {empty ? (
        <Text size="xs" muted>
          No tasks, workers, gates or PRs yet.
        </Text>
      ) : null}
      {p.prds.map((url, i) => (
        <Row key={`prd:${i}`} gap="xs" wrap>
          <Link href={url}>{i === p.prds.length - 1 ? 'PRD' : `Older PRD ${i + 1}`}</Link>
          {i === p.prds.length - 1 && p.prd && p.prd.from !== 'link' ? (
            <Text size="xs" muted>
              {p.prd.from === 'description' ? 'found in the description' : "found in the Run's objective"}
            </Text>
          ) : null}
        </Row>
      ))}
      {tasks.map((t) => (
        <Row key={`task:${t.id}`} gap="xs" wrap>
          <Badge tone={TASK_TONE[t.status] ?? 'neutral'}>{TASK_LABEL[t.status] ?? t.status}</Badge>
          <Text size="xs">{t.title}</Text>
        </Row>
      ))}
      {gates.map((g) => (
        <Stack key={`gate:${g.id}`} gap="none">
          <Row gap="xs" wrap>
            <Badge tone={g.status === 'pending' ? 'warning' : 'neutral'}>{g.status === 'pending' ? 'Gate open' : `Gate ${g.status}`}</Badge>
            <Text size="xs" muted={g.status !== 'pending'}>
              {g.question || '(no question text)'}
            </Text>
          </Row>
          {g.options.length > 0 ? (
            <Text size="xs" muted>
              {`Options: ${g.options.join(' / ')}`}
            </Text>
          ) : null}
        </Stack>
      ))}
      {p.workers.map((w) => {
        const id = `${p.key}#${w.dispatchId}`
        const failed = p.failed.includes(w.dispatchId)
        return (
          <Stack key={`worker:${w.dispatchId}`} gap="none">
            <Row gap="xs" wrap>
              <Badge tone={failed ? 'danger' : WORKER_TONE[w.state]}>{failed ? 'failed' : w.state}</Badge>
              <Text size="xs" muted>
                {w.dispatchId}
              </Text>
              {actions.onOpen ? (
                <Button size="xs" variant="ghost" icon="terminal" tooltip="Focus this worker's terminal" onPress={() => actions.onOpen?.(p.key, w.dispatchId)}>
                  Focus
                </Button>
              ) : null}
            </Row>
            {actions.notOpened === id ? (
              <Text size="xs" tone="danger">
                Could not focus it.
              </Text>
            ) : null}
          </Stack>
        )
      })}
      {p.prs.map((pr) => (
        <Row key={`pr:${pr.url || pr.ref}`} gap="xs" wrap>
          {pr.url ? <Link href={pr.url}>{`PR #${pr.number}`}</Link> : <Text size="xs">{`PR #${pr.number}`}</Text>}
          <Badge tone={PR_TONE[pr.state] ?? 'neutral'}>{pr.state}</Badge>
          <Text size="xs" muted>
            {pr.ref}
          </Text>
        </Row>
      ))}
    </Stack>
  )
}

export function PieceCard({ p, details, actions }: { p: Piece; details: FunnelDetails; actions: FunnelActions }) {
  const open = read(openDetails).includes(p.key)
  const prs = prLine(p)
  return (
    <Box key={`piece:${p.key}`} border={p.amber ? 'warning' : true} background={p.amber ? 'warning' : 'card'} radius="md" padding="sm" gap="xs">
      <Text weight="medium" truncate>
        {p.title}
      </Text>
      <Row gap="xs" wrap>
        <Text size="xs" muted>
          {ownerLine(p)}
        </Text>
        {p.amber ? <Badge tone="warning">Waits on you</Badge> : null}
        {p.prClosed ? <Badge tone="neutral">PR closed</Badge> : null}
      </Row>
      <Text size="xs">{p.why}</Text>
      {prs ? (
        <Text size="xs" muted>
          {prs}
        </Text>
      ) : null}
      {p.waits.map((w) => (
        <WaitLine key={`wait:${w.key}`} w={w} />
      ))}
      {p.failed.length > 0 ? (
        <Text size="xs" tone="danger">
          {p.failed.length === 1 ? `Worker failed: ${p.failed[0]}` : `${p.failed.length} workers failed`}
        </Text>
      ) : null}
      <Row gap="xs" justify="between" wrap>
        {actions.onOpen ? (
          <Button size="xs" variant="ghost" icon="open-external" tooltip={p.item ? "Open the item's chat" : 'Open where this work runs'} onPress={() => actions.onOpen?.(p.key)}>
            {p.item ? 'Open chat' : 'Open'}
          </Button>
        ) : null}
        {p.updatedAt !== null ? (
          <Text size="xs" muted>
            {agoNow(p.updatedAt)}
          </Text>
        ) : null}
      </Row>
      {actions.notOpened === p.key ? (
        <Text size="xs" tone="danger">
          Could not open it.
        </Text>
      ) : null}
      <Collapsible key={`detail:${p.key}`} title="Details" open={open} onChange={(o) => toggleDetail(p.key, o)}>
        {open ? <Detail p={p} details={details} actions={actions} /> : null}
      </Collapsible>
    </Box>
  )
}

function Column({ stage, snap, actions }: { stage: Stage; snap: FunnelSnapshot; actions: FunnelActions }) {
  const keys = snap.funnel.columns[stage] ?? []
  const byKey = new Map(snap.funnel.pieces.map((p) => [p.key, p]))
  const pieces = keys.map((k) => byKey.get(k)).filter((p): p is Piece => !!p)
  const amber = pieces.filter((p) => p.amber).length
  const shown = pieces.slice(0, MAX_CARDS)
  return (
    <Box key={`col:${stage}`} border radius="md" padding="sm" gap="sm" background="muted">
      <Stack gap="none">
        <Row gap="xs" justify="between">
          <Text weight="semibold">{STAGE_LABEL[stage]}</Text>
          <Row gap="xs">
            {amber > 0 ? <Badge tone="warning">{`${amber} wait${amber === 1 ? 's' : ''}`}</Badge> : null}
            <Badge tone="neutral">{String(pieces.length)}</Badge>
          </Row>
        </Row>
        <Text size="xs" muted>
          {STAGE_HINT[stage]}
        </Text>
      </Stack>
      {pieces.length === 0 ? (
        <Text size="xs" muted>
          Nothing here
        </Text>
      ) : null}
      {shown.length > 0 ? <Stack gap="sm">{shown.map((p) => PieceCard({ p, details: snap.details, actions }))}</Stack> : null}
      {pieces.length > shown.length ? (
        <Text size="xs" muted>
          {`+${pieces.length - shown.length} more`}
        </Text>
      ) : null}
    </Box>
  )
}

function UnlinkedWaits({ waits, actions }: { waits: readonly Wait[]; actions: FunnelActions }) {
  return (
    <Callout key="unlinked" tone="warning" title={`Unlinked waits (${waits.length})`}>
      <Stack gap="xs">
        {waits.map((w) => (
          <Row key={`unlinked:${w.key}`} gap="xs" justify="between" wrap>
            <Stack gap="none">
              <Text size="sm" weight="medium">
                {`${w.label}: ${w.what}`}
              </Text>
              <Text size="xs" muted>
                {w.who}
              </Text>
            </Stack>
            {actions.onOpenWait && w.target ? (
              <Button size="xs" variant="ghost" icon="open-external" onPress={() => actions.onOpenWait?.(w.key)}>
                Open
              </Button>
            ) : null}
          </Row>
        ))}
      </Stack>
    </Callout>
  )
}

export function FunnelView({ snap, error, ...actions }: { snap: FunnelSnapshot; error?: string | null } & FunnelActions) {
  const f = snap.funnel
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading level={2}>Funnel</Heading>
        {actions.onRefresh ? <IconButton icon="refresh" label="Refresh the funnel" variant="ghost" size="sm" onPress={actions.onRefresh} /> : null}
      </Row>
      {error ? (
        <Callout key="funnel-error" tone={snap.updatedAt === null ? 'danger' : 'warning'} title="The plugin worker did not answer">
          <Text size="sm">{error}</Text>
        </Callout>
      ) : null}
      {snap.notes.map((n, i) => (
        <Text key={`note:${i}`} size="xs" tone="warning">
          {n}
        </Text>
      ))}
      {snap.status === 'loading' ? <Skeleton lines={3} label="Loading the funnel" /> : null}
      {f.unlinkedWaits.length > 0 ? <UnlinkedWaits waits={f.unlinkedWaits} actions={actions} /> : null}
      {snap.status === 'ok' && f.pieces.length === 0 ? (
        <Text key="no-work" muted>
          No work yet.
        </Text>
      ) : null}
      {snap.status === 'ok' ? (
        <Grid key="columns" minItemWidth="md" gap="sm">
          {STAGES.map((s) => Column({ stage: s, snap, actions }))}
        </Grid>
      ) : null}
      {snap.updatedAt !== null ? (
        <Text size="xs" muted>
          {`Updated ${agoNow(snap.updatedAt)} · every ${snap.refreshSeconds} s`}
        </Text>
      ) : null}
    </Stack>
  )
}
