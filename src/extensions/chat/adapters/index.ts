import type { Adapter, Chat } from 'chat'

// Optional platform behavior beyond Chat SDK's common messaging interface.
export type PlatformAdapter = Adapter & {
  start?(signal: AbortSignal): Promise<void>
  replyChunk?(text: string): string
  discoveryGroup?(threadId: string): string
  discoveryScope?(threadId: string): Promise<string | null>
  sourceUrl?(threadId: string): string
  renameThread?(threadId: string, title: string): Promise<{ title: string; changed: boolean }>
  renameInstructions?: string
}

export const platformFor = (chat: Chat, threadId: string) => chat.thread(threadId).adapter as PlatformAdapter
