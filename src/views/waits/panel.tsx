// R4: the "Waits on you" panel. It only shows what the worker sends; a click asks the worker to
// open or focus the wait's place, by row key. Text comes cleaned from the worker and is drawn as
// text (Orca components never render HTML).
import {
  atom, Badge, Box, Button, Callout, EmptyState, Heading, plugin, read, RelativeTime, Row, set, Skeleton, Stack, Text,
  type PanelContext, type Tone
} from 'orca'
import '../../protocol.ts'
import type { Wait, WaitsSnapshot } from '../../protocol.ts'

/** The worker's last snapshot; null until it answers. */
const snapshot = atom<WaitsSnapshot | null>(null)
/** A row whose place could not be opened, for one line under it. */
const notOpened = atom<string | null>(null)

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('waits.changed', (s) => set(snapshot, s)))
  void plugin.request('waits.get').then((s) => set(snapshot, s)).catch(() => undefined)
}

async function open(key: string): Promise<void> {
  set(notOpened, null)
  try {
    const r = await plugin.request('waits.open', { key })
    if (!r.opened) set(notOpened, key)
  } catch {
    set(notOpened, key)
  }
}

const TONE: Record<string, Tone> = { 'trust this folder': 'danger', Blocked: 'danger', Gate: 'accent', 'Needs you': 'warning', Waiting: 'neutral' }

function WaitRow({ wait }: { wait: Wait }) {
  const failed = read(notOpened) === wait.key
  return (
    <Box border padding="sm" radius="md" gap="xs">
      <Row justify="between" gap="sm">
        <Row gap="xs">
          <Badge tone={TONE[wait.label] ?? 'neutral'}>{wait.label}</Badge>
          <Text weight="semibold" truncate>{wait.who}</Text>
        </Row>
        {wait.since !== null ? <RelativeTime at={wait.since} format="short" muted /> : null}
      </Row>
      <Text>{wait.what}</Text>
      {wait.options.length > 0 ? (
        <Row gap="xs" wrap>
          {wait.options.map((o) => <Badge key={o}>{o}</Badge>)}
        </Row>
      ) : null}
      <Row justify="between">
        {wait.target ? (
          <Button size="sm" variant="ghost" icon="open-external" onPress={() => open(wait.key)}>
            {wait.target.kind === 'terminal' ? 'Focus terminal' : 'Open workspace'}
          </Button>
        ) : (
          <Text muted size="xs">Open it in Orca to answer.</Text>
        )}
        {failed ? <Text tone="danger" size="xs">Could not open it.</Text> : null}
      </Row>
    </Box>
  )
}

function Banner({ snap }: { snap: WaitsSnapshot }) {
  const b = snap.banner
  if (!b) return null
  const title = b.kind === 'not_found' ? 'Orca CLI not found' : 'The Orca CLI is not answering'
  return (
    <Callout tone="warning" title={title}>
      <Stack gap="xs">
        <Text size="sm">{b.message}</Text>
        {b.tried && b.tried.length ? <Text size="xs" muted>Tried: {b.tried.join(', ')}. Set the path in Settings, Orca CLI path.</Text> : null}
        {snap.waits.length ? <Text size="xs" muted>Showing the last good data.</Text> : null}
      </Stack>
    </Callout>
  )
}

export default function Panel() {
  const snap = read(snapshot)
  const waits = snap?.waits ?? []
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading level={2}>Waits on you</Heading>
        <Badge tone={waits.length ? 'warning' : 'neutral'}>{waits.length}</Badge>
      </Row>
      {snap ? <Banner snap={snap} /> : null}
      {!snap || snap.updatedAt === null ? (
        <Skeleton shape="text" lines={3} label="Reading waits" />
      ) : waits.length === 0 ? (
        <EmptyState icon="check" title="Nothing waits on you" description="Bot questions, open gates and agents that wait for you show here." />
      ) : (
        <Stack gap="sm">
          {waits.map((w) => <WaitRow key={w.key} wait={w} />)}
        </Stack>
      )}
      {snap ? (
        <Row justify="between" gap="sm">
          <Text muted size="xs" truncate>CLI: {snap.cliPath ?? 'not found yet'}</Text>
          {snap.updatedAt !== null ? (
            <Text muted size="xs">
              Updated <RelativeTime at={snap.updatedAt} format="short" muted />
            </Text>
          ) : null}
        </Row>
      ) : null}
    </Stack>
  )
}
