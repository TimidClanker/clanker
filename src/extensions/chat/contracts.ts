import type { Context } from '@earendil-works/chord'
import type { ConversationId, DocumentReader, TaskId, Tx } from '@earendil-works/pi-durable'
import type { Author, PlatformAccount } from 'extensions/identity'

export type Destination = { threadId: string; title: string }

export type ChatAccess = {
  privateIdentity(read: DocumentReader, conversationId: ConversationId, ctx: Context): Promise<string | undefined>
  // Use the transaction reader when checking on a durable commit line.
  check(destination: Destination, account: PlatformAccount, ctx: Context, read?: DocumentReader): Promise<void>
  threadFor(read: DocumentReader, conversationId: ConversationId, ctx: Context): Promise<string>
}

export type ChatDestinations = {
  resolve(source: ConversationId, account: PlatformAccount, reference: string | undefined, ctx: Context): Promise<Destination>
}

export type ChatDelivery = {
  prepare(tx: Tx, destination: Destination): Promise<ConversationId>
  enqueue(
    tx: Tx,
    conversationId: ConversationId,
    event: { schedule?: TaskId; requestId: string; text: string; owner: Author; threadId: string; internal?: boolean; job?: TaskId }
  ): Promise<TaskId<null>>
}
