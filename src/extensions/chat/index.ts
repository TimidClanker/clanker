import { Chat } from 'chat'
import { createMemoryState } from '@chat-adapter/state-memory'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section, type Harness } from '@earendil-works/pi-durable'
import type { selectModel } from '../../model'
import { Conversations } from '../discovery'
import type { IdentityAccess } from '../identity'
import { Discord } from './adapters/discord'
import { platformFor, type PlatformAdapter } from './adapters'
import { connectChat } from './bridge'
import { createDelivery } from './delivery'

export function createChatIntegration(
  selection: ReturnType<typeof selectModel>,
  adapters: Record<string, PlatformAdapter> = { discord: new Discord() },
  chat: Chat = new Chat({
    userName: 'clanker',
    adapters,
    state: createMemoryState(),
    concurrency: { strategy: 'concurrent', maxConcurrent: 1 },
    logger: 'info'
  })
) {
  let harness: Harness
  const shutdown = new AbortController()
  let listening: Promise<unknown> = Promise.resolve()
  let closing: Promise<void> | undefined
  const Reply = createDelivery(chat, () => harness)
  const rename = defineTool({
    name: 'rename_thread',
    description:
      'Set a substantive, specific public title for the current thread. Skip greetings and vague summaries. May be called again when the subject meaningfully changes. Does not modify discovery metadata.',
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 100 }) }),
    replay: 'safe',
    execute: async ({ title }, api, ctx) => {
      ctx.abortSignal?.throwIfAborted()
      const entry = (await api.snapshot(Conversations, ctx))?.conversations[api.conversationId]
      if (!entry) throw new Error('No chat thread is associated with this conversation')
      const platform = platformFor(chat, entry.threadId)
      if (!platform.renameThread) throw new Error('This platform does not support thread renaming')
      return { content: [{ type: 'text', text: JSON.stringify(await platform.renameThread(entry.threadId, title)) }] }
    }
  })

  return {
    identity: {
      async privateAccount(read, conversationId, ctx) {
        const entry = (await read.snapshot(Conversations, ctx))?.conversations[conversationId]
        if (!entry) return null
        return (await platformFor(chat, entry.threadId).privateRecipient?.(entry.threadId)) ?? null
      }
    } satisfies IdentityAccess,
    extension: defineExtension({
      // Keep the stored selection name stable while moving its implementation.
      name: 'clanker',
      tasks: [Reply],
      tools: [rename],
      sections: [
        section('chat', async (input, ctx) => {
          const entry = (await input.read.snapshot(Conversations, ctx))?.conversations[input.conversationId]
          return entry ? platformFor(chat, entry.threadId).renameInstructions : undefined
        })
      ]
    }),
    discovery: {
      async scope(threadId: string) {
        const platform = platformFor(chat, threadId)
        const scope = await platform.discoveryScope?.(threadId)
        return scope == null ? null : JSON.stringify([platform.name, scope])
      },
      group(threadId: string) {
        const platform = platformFor(chat, threadId)
        return JSON.stringify([platform.name, platform.discoveryGroup?.(threadId) ?? threadId])
      },
      url: (threadId: string) => platformFor(chat, threadId).sourceUrl?.(threadId) ?? ''
    },
    webhooks: chat.webhooks,
    async connect(agent: Harness) {
      harness = agent
      await chat.initialize()
      await connectChat(chat, harness, Reply, selection.model, threadId => ({
        model: { provider: selection.model.provider, modelId: selection.model.id },
        thinkingLevel: selection.thinkingLevel,
        tools: platformFor(chat, threadId).renameThread ? null : { remove: [rename] }
      }))
      listening = Promise.all(Object.values(adapters).map(adapter => adapter.start?.(shutdown.signal)))
      try {
        await listening
      } catch (error) {
        if (!shutdown.signal.aborted) throw error
      }
    },
    close() {
      shutdown.abort()
      return (closing ??= (async () => {
        await chat.shutdown()
        await listening
      })())
    }
  }
}
