// The Control Room data model. Slices 2-4 import from here.
//
// | Type          | From                                         | Parser             |
// |---------------|----------------------------------------------|--------------------|
// | Bot           | bot list                                     | parseBotList       |
// | BotItem       | bot item list --bot <id>                     | parseBotItemList   |
// | BotWork       | bot work list --bot <id>                     | parseBotWorkList   |
// | BotChat       | bot chats --bot <id>                         | parseBotChats      |
// | Worktree      | worktree ps                                  | parseWorktreePs    |
// | Agent         | agents.list, agent.status.changed, worktree ps | agentFromListRow, agentFromEvent, parseWorktreePs |
// | Automation    | automations list                             | parseAutomations   |
// | InboxMessage  | orchestration inbox                          | parseInbox         |
// | Run           | orchestration run-list / run-show            | parseRunList, parseRunShow |
// | Task          | orchestration task-list --run <id>           | parseTaskList      |
// | Worker        | orchestration worker-list --run <id>         | parseWorkerList    |
// | Gate          | orchestration gate-list --run <id>           | parseGateList      |
//
// Each parser takes the envelope's `result` (CliResult.result) and never throws.

export * from './envelope.ts'
export * from './bots.ts'
export * from './agents.ts'
export * from './orchestration.ts'
