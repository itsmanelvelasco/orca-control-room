// R3. The fixed allow-list of read commands. Nothing else can reach execFile.
//
// A request names one of the 12 commands and, for some, an id. `buildArgv` checks every
// field (known command, known keys only, ids by pattern, numbers in range) and turns the
// request into argv. It throws on anything else, so free text never becomes an argument.

/** A bot id: the UUID `orca bot list` prints. */
export type BotId = string
/** A Run id: `run_` plus lower-case letters, digits or `_` (e.g. `run_e9ab7779805a`, `run_unbound`). */
export type RunId = string
/** A Task id: `task_` plus lower-case letters or digits (e.g. `task_10c86e44be27`). */
export type TaskId = string

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const RUN_ID_PATTERN = /^run_[a-z0-9_]{1,64}$/
export const TASK_ID_PATTERN = /^task_[a-z0-9]{1,64}$/

export const isBotId = (v: unknown): v is BotId => typeof v === 'string' && UUID_PATTERN.test(v)
export const isRunId = (v: unknown): v is RunId => typeof v === 'string' && RUN_ID_PATTERN.test(v)
export const isTaskId = (v: unknown): v is TaskId => typeof v === 'string' && TASK_ID_PATTERN.test(v)

/** One allowed call. `command` picks the row of the allow-list; the other fields are its only inputs. */
export type CliRequest =
  | { command: 'bot list' }
  | { command: 'bot item list'; bot: BotId; all?: boolean }
  | { command: 'bot work list'; bot: BotId }
  | { command: 'bot chats'; bot: BotId }
  /** `agentWait` adds `--agent-wait`: each agent's wait verdict, which names a trust prompt (R5). */
  | { command: 'worktree ps'; limit?: number; agentWait?: boolean }
  | { command: 'automations list' }
  | { command: 'orchestration inbox'; run?: RunId; limit?: number }
  | { command: 'orchestration run-list' }
  | { command: 'orchestration run-show'; run: RunId }
  | { command: 'orchestration task-list'; run: RunId }
  | { command: 'orchestration worker-list'; run: RunId }
  | { command: 'orchestration gate-list'; run: RunId; task?: TaskId }

export type CliCommandName = CliRequest['command']

/** Why a request was refused before anything ran. */
export class CliRequestError extends Error {
  readonly code = 'request_refused'
  constructor(message: string) {
    super(message)
    this.name = 'CliRequestError'
  }
}

type Field = { kind: 'bot' | 'run' | 'task' | 'flag' | 'limit'; flag: string; required: boolean }

const bot = (required = true): Field => ({ kind: 'bot', flag: '--bot', required })
const run = (required = true): Field => ({ kind: 'run', flag: '--run', required })

/** The allow-list: the 12 read commands from the PRD (R3) and the only inputs each takes. */
export const ALLOWED_COMMANDS: Readonly<Record<CliCommandName, { argv: readonly string[]; fields: Readonly<Record<string, Field>> }>> = Object.freeze({
  'bot list': { argv: ['bot', 'list'], fields: {} },
  'bot item list': { argv: ['bot', 'item', 'list'], fields: { bot: bot(), all: { kind: 'flag', flag: '--all', required: false } } },
  'bot work list': { argv: ['bot', 'work', 'list'], fields: { bot: bot() } },
  'bot chats': { argv: ['bot', 'chats'], fields: { bot: bot() } },
  'worktree ps': { argv: ['worktree', 'ps'], fields: { limit: { kind: 'limit', flag: '--limit', required: false }, agentWait: { kind: 'flag', flag: '--agent-wait', required: false } } },
  'automations list': { argv: ['automations', 'list'], fields: {} },
  'orchestration inbox': { argv: ['orchestration', 'inbox'], fields: { run: run(false), limit: { kind: 'limit', flag: '--limit', required: false } } },
  'orchestration run-list': { argv: ['orchestration', 'run-list'], fields: {} },
  'orchestration run-show': { argv: ['orchestration', 'run-show'], fields: { run: { kind: 'run', flag: '--id', required: true } } },
  'orchestration task-list': { argv: ['orchestration', 'task-list'], fields: { run: run() } },
  'orchestration worker-list': { argv: ['orchestration', 'worker-list'], fields: { run: run() } },
  'orchestration gate-list': { argv: ['orchestration', 'gate-list'], fields: { run: run(), task: { kind: 'task', flag: '--task', required: false } } }
})

export const ALLOWED_COMMAND_NAMES = Object.freeze(Object.keys(ALLOWED_COMMANDS) as CliCommandName[])

/** Largest `--limit` Orca accepts on these commands. */
export const MAX_LIMIT = 100

function check(field: Field, key: string, value: unknown): string[] {
  switch (field.kind) {
    case 'bot':
      if (!isBotId(value)) throw new CliRequestError(`${key} is not a bot id (UUID)`)
      return [field.flag, value]
    case 'run':
      if (!isRunId(value)) throw new CliRequestError(`${key} is not a run id (run_…)`)
      return [field.flag, value]
    case 'task':
      if (!isTaskId(value)) throw new CliRequestError(`${key} is not a task id (task_…)`)
      return [field.flag, value]
    case 'flag':
      if (typeof value !== 'boolean') throw new CliRequestError(`${key} must be true or false`)
      return value ? [field.flag] : []
    case 'limit':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
        throw new CliRequestError(`${key} must be a whole number from 1 to ${MAX_LIMIT}`)
      }
      return [field.flag, String(value)]
  }
}

/**
 * The argv for one allowed request, always ending in `--json`. Throws CliRequestError for an
 * unknown command, an unknown or missing field, or a value that fails its pattern.
 */
export function buildArgv(request: unknown): string[] {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) throw new CliRequestError('request must be an object')
  const proto = Object.getPrototypeOf(request)
  if (proto !== Object.prototype && proto !== null) throw new CliRequestError('request must be a plain object')
  const { command, ...rest } = request as Record<string, unknown>
  if (typeof command !== 'string' || !Object.prototype.hasOwnProperty.call(ALLOWED_COMMANDS, command)) {
    throw new CliRequestError(`command is not on the allow-list: ${JSON.stringify(String(command)).slice(0, 60)}`)
  }
  const spec = ALLOWED_COMMANDS[command as CliCommandName]
  const argv = [...spec.argv]
  for (const key of Object.keys(rest)) {
    if (!Object.prototype.hasOwnProperty.call(spec.fields, key)) throw new CliRequestError(`${command} takes no field ${JSON.stringify(key).slice(0, 40)}`)
  }
  for (const [key, field] of Object.entries(spec.fields)) {
    const value = rest[key]
    if (value === undefined) {
      if (field.required) throw new CliRequestError(`${command} needs ${key}`)
      continue
    }
    argv.push(...check(field, key, value))
  }
  argv.push('--json')
  return argv
}

/** A stable key per request, so a caller can keep one call of each kind in flight (R9). */
export function requestKey(request: CliRequest): string {
  return buildArgv(request).join(' ')
}
