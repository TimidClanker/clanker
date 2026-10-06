import type { Adapter, Author, Chat } from 'chat'
import type { PlatformAccount } from 'extensions/identity'

// Account namespaces and platform behavior beyond Chat SDK's common messaging interface.
export type PlatformAdapter = Adapter & {
  acceptsThread?(threadId: string): boolean
  identifyAuthor(threadId: string, author: Author): PlatformAccount
  resolveDestination?(threadId: string, account: PlatformAccount, reference: string): Promise<{ threadId: string; title: string }>
  privateRecipient?(threadId: string): Promise<PlatformAccount | null>
  sandboxAudience?(threadId: string, accounts: PlatformAccount[]): Promise<PlatformAccount | null>
  start?(signal: AbortSignal): Promise<void>
  replyChunk?(text: string): string
  discoveryGroup?(threadId: string): string
  discoveryScope?(threadId: string): Promise<string | null>
  sourceUrl?(threadId: string): string
  renameThread?(threadId: string, title: string): Promise<{ title: string; changed: boolean }>
  renameInstructions?: string
}

export const platformFor = (chat: Chat, threadId: string) => chat.thread(threadId).adapter as PlatformAdapter
