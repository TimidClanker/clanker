import { defineDoc, type ConversationId, type EntryId, type TaskId } from '@earendil-works/pi-durable'

export const Threads = defineDoc<{ threads: Record<string, ConversationId> }>({
  kind: 'clanker.threads',
  version: 1,
  scope: 'session',
  initial: () => ({ threads: {} })
})

export const Messages = defineDoc<{ received: Record<string, TaskId>; lastTask: TaskId | null; lastAnswer?: EntryId }>({
  kind: 'clanker.messages',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ received: {}, lastTask: null })
})
