// R7. Draws an AgentsSnapshot. Pure: no host calls, so tests mount it with any snapshot.
// Every text arrives cut by model.ts and is drawn as text, never as Markdown or HTML.
import { Badge, Button, Callout, EmptyState, Heading, IconButton, Row, Skeleton, Stack, Table, Text, type TableRow, type Tone } from 'orca'
import { agoNow, durationNow } from '../time.ts'
import { GROUP_CAP, type AgentGroup, type AgentRow, type AgentsSnapshot } from './model.ts'

const STATE_LABEL: Record<AgentRow['state'], string> = { blocked: 'blocked', waiting: 'waiting', working: 'working', done: 'done' }

const COLUMNS = [
  { key: 'agent', label: 'Agent', width: 'auto' as const, minWidth: 'sm' as const },
  { key: 'state', label: 'State', width: 'xs' as const },
  { key: 'time', label: 'For', width: 'xs' as const, align: 'end' as const },
  { key: 'workspace', label: 'Workspace', width: 'sm' as const, hideBelow: 'md' as const }
]

function tableRow(r: AgentRow): TableRow {
  const agent = [r.title, r.agentKind && r.agentKind !== r.title ? r.agentKind : null, r.task ? `task: ${r.task}` : null].filter(Boolean).join(' · ')
  return {
    key: r.key,
    cells: {
      agent,
      state: STATE_LABEL[r.state],
      time: r.since !== null ? durationNow(r.since) : '',
      workspace: r.workspace ?? ''
    },
    disabled: !r.canOpen
  }
}

function Group({ g, all, onShowAll, onOpen }: { g: AgentGroup; all: boolean; onShowAll: (key: string, all: boolean) => void; onOpen: (key: string) => void }) {
  const rows = all ? g.rows : g.rows.slice(0, GROUP_CAP)
  const hidden = g.total - rows.length
  const tone: Tone = g.waiting > 0 ? 'warning' : 'neutral'
  return (
    <Stack key={`group:${g.key}`} gap="xs">
      <Row gap="xs" align="center" wrap>
        <Heading level={3}>{g.name}</Heading>
        {g.remote ? <Badge tone="accent">{g.host ?? 'remote'}</Badge> : null}
        <Badge tone="neutral">{`${g.total} ${g.total === 1 ? 'agent' : 'agents'}`}</Badge>
        {g.waiting > 0 ? <Badge tone={tone}>{`${g.waiting} waiting`}</Badge> : null}
      </Row>
      <Table label={`Agents in ${g.name}`} columns={COLUMNS} rows={rows.map(tableRow)} maxHeight="none" onRowAction={(r) => onOpen(r.key)} />
      {g.rows.length > GROUP_CAP ? (
        <Button key={`more:${g.key}`} size="sm" variant="ghost" onPress={() => onShowAll(g.key, !all)}>
          {all ? `Show first ${GROUP_CAP}` : g.rows.length < g.total ? `Show ${g.rows.length} of ${g.total}` : `Show all ${g.total}`}
        </Button>
      ) : null}
      {all && hidden > 0 ?<Text size="xs" muted>{`${hidden} more not shown.`}</Text> : null}
    </Stack>
  )
}

export type AgentsViewProps = {
  snap: AgentsSnapshot
  /** Group keys whose rows all show. */
  expanded: readonly string[]
  onShowAll: (key: string, all: boolean) => void
  onOpen: (key: string) => void
  onRefresh: () => void
  /** One line after a row press that could not open its agent. */
  notice?: string | null
}

export function AgentsView({ snap, expanded, onShowAll, onOpen, onRefresh, notice = null }: AgentsViewProps) {
  const projects = snap.groups.length
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Stack gap="none">
          <Heading level={2}>Agents</Heading>
          <Text size="xs" muted>
            {snap.total === 0 ? 'No agents' : `${snap.total} ${snap.total === 1 ? 'agent' : 'agents'} in ${projects} ${projects === 1 ? 'project' : 'projects'}`}
            {snap.updatedAt !== null ? (
              ` · read ${agoNow(snap.updatedAt)}`
            ) : null}
          </Text>
        </Stack>
        <IconButton icon="refresh" label="Read agents again" size="sm" variant="ghost" onPress={onRefresh} />
      </Row>
      {snap.error ? (
        <Callout key="agents-error" tone={snap.updatedAt === null ? 'danger' : 'warning'} title="Orca did not list the agents">
          <Text size="xs">{snap.error}</Text>
          {snap.updatedAt !== null ? <Text size="xs" muted>Showing the last good read.</Text> : null}
        </Callout>
      ) : null}
      {snap.stale.length > 0 ? (
        <Text key="agents-stale" size="xs" tone="warning">
          {`Could not read: ${snap.stale.slice(0, 5).join(', ')}${snap.stale.length > 5 ? ` and ${snap.stale.length - 5} more` : ''}. Last known agents shown.`}
        </Text>
      ) : null}
      {snap.truncated ? (
        <Text key="agents-truncated" size="xs" tone="warning">
          Orca listed only part of your workspaces, so some agents may be missing.
        </Text>
      ) : null}
      {notice ? (
        <Text key="agents-notice" size="xs" tone="warning">
          {notice}
        </Text>
      ) : null}
      {snap.status === 'loading' && snap.groups.length === 0 ? <Skeleton key="agents-loading" lines={4} label="Reading agents" /> : null}
      {snap.status !== 'loading' && snap.groups.length === 0 && !snap.error ? (
        <EmptyState key="agents-empty" icon="agent" title="No agents" description="No agent runs in any workspace." />
      ) : null}
      {snap.groups.map((g) => (
        <Group key={g.key} g={g} all={expanded.includes(g.key)} onShowAll={onShowAll} onOpen={onOpen} />
      ))}
      <Text size="xs" muted>From Orca's plugin API. Works without the Orca CLI.</Text>
    </Stack>
  )
}
