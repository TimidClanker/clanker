import type { Context } from '@earendil-works/chord'
import { defineDoc, type ConversationId, type DocumentReader, type EntryId, type TaskId } from '@earendil-works/pi-durable'
import { sourceConversation } from 'extensions/identity'

export const Threads = defineDoc<{ threads: Record<string, ConversationId> }>({
  kind: 'clanker.threads',
  version: 1,
  scope: 'session',
  initial: () => ({ threads: {} })
})

export async function listSources(read: DocumentReader, ctx: Context) {
  return Object.entries((await read.snapshot(Threads, ctx))?.threads ?? {}).map(([threadId, id]) => ({ id, threadId }))
}

export async function threadFor(read: DocumentReader, conversationId: ConversationId, ctx: Context) {
  conversationId = await sourceConversation(read, conversationId, ctx)
  const source = (await listSources(read, ctx)).find(source => source.id === conversationId)
  if (!source) throw new Error('No chat thread is associated with this conversation')
  return source.threadId
}

export const Messages = defineDoc<{
  received: Record<string, TaskId>
  lastTask: TaskId | null
  lastAnswer?: EntryId
  // Entry receipts and the post-only delivery chain survive replay and coalesced steers.
  replies?: Record<string, TaskId<null>>
  lastPost?: TaskId<null>
  // Highest committed entry examined by the conversation-owned message consumer.
  cursor?: EntryId
}>({
  kind: 'clanker.messages',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ received: {}, lastTask: null })
})
