import { Chat } from 'chat'
import { createMemoryState } from '@chat-adapter/state-memory'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section, type Harness } from '@earendil-works/pi-durable'
import type { selectModel } from 'model'
import { recordAutomatedInput, type IdentityAccess } from 'extensions/identity'
import { Discord } from 'extensions/chat/adapters/discord'
import { platformFor, type PlatformAdapter } from 'extensions/chat/adapters'
import { connectChat, prepareConversation } from 'extensions/chat/bridge'
import { createDelivery } from 'extensions/chat/delivery'
import { createPost } from 'extensions/chat/post'
import { listSources, threadFor, Messages } from 'extensions/chat/state'
import type { ScheduleChat } from 'extensions/schedules'
import type { SandboxAccess } from 'extensions/sandbox'

export function createChatIntegration(selection: ReturnType<typeof selectModel>, adapters: Record<string, PlatformAdapter> = { discord: new Discord() }) {
  const chat = new Chat({
    userName: 'clanker',
    adapters,
    state: createMemoryState(),
    concurrency: { strategy: 'concurrent', maxConcurrent: 1 },
    logger: 'info'
  })
  let harness: Harness
  const shutdown = new AbortController()
  let listening: Promise<unknown> = Promise.resolve()
  let closing: Promise<void> | undefined
  const Post = createPost(chat)
  const Reply = createDelivery(chat, () => harness, Post)
  const rename = defineTool({
    name: 'rename_thread',
    description:
      'Set a substantive, specific public title for the current thread. Skip greetings and vague summaries. May be called again when the subject meaningfully changes. Does not modify discovery metadata.',
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 100 }) }),
    replay: 'safe',
    execute: async ({ title }, api, ctx) => {
      ctx.abortSignal?.throwIfAborted()
      const threadId = await threadFor(api, api.conversationId, ctx)
      const platform = platformFor(chat, threadId)
      if (!platform.renameThread) throw new Error('This platform does not support thread renaming')
      return { content: [{ type: 'text', text: JSON.stringify(await platform.renameThread(threadId, title)) }] }
    }
  })
  const agentFor = (threadId: string) => ({
    model: { provider: selection.model.provider, modelId: selection.model.id },
    thinkingLevel: selection.thinkingLevel,
    tools: platformFor(chat, threadId).renameThread ? null : { remove: [rename] }
  })

  return {
    sandbox: {
      async audience(read, conversationId, accounts, ctx) {
        const threadId = await threadFor(read, conversationId, ctx)
        const platform = platformFor(chat, threadId)
        if (!platform.sandboxAudience) throw new Error('This platform cannot verify sandbox membership')
        return platform.sandboxAudience(threadId, accounts)
      }
    } satisfies SandboxAccess,
    schedules: {
      async resolve(source, account, reference, ctx) {
        const threadId = await threadFor(harness, source, ctx)
        const platform = platformFor(chat, threadId)
        if (!platform.resolveDestination) throw new Error('This platform does not support directing tasks to other channels')
        return platform.resolveDestination(threadId, account, reference ?? threadId)
      },
      async check(destination, account) {
        const platform = platformFor(chat, destination.threadId)
        if (!platform.resolveDestination) throw new Error('This platform cannot verify scheduled task destinations')
        await platform.resolveDestination(destination.threadId, account, destination.threadId)
        await chat.thread(destination.threadId).subscribe()
      },
      prepare: (tx, destination) => prepareConversation(tx, destination.threadId, agentFor(destination.threadId)),
      async enqueue(tx, conversationId, { schedule, requestId, text, owner, threadId }) {
        await recordAutomatedInput(tx, conversationId, requestId, owner)
        const messages = await tx.doc(Messages, conversationId)
        const reply = await tx.createTask(
          Reply,
          { threadId, messageId: requestId, text, previous: messages.lastTask, schedule },
          {
            conversationId,
            ownership: { kind: 'conversation' },
            background: true
          }
        )
        messages.lastTask = reply
        return reply
      }
    } satisfies ScheduleChat,
    identity: {
      async privateAccount(read, conversationId, ctx) {
        const source = (await listSources(read, ctx)).find(source => source.id === conversationId)
        return source ? ((await platformFor(chat, source.threadId).privateRecipient?.(source.threadId)) ?? null) : null
      }
    } satisfies IdentityAccess,
    extension: defineExtension({
      // Keep the stored selection name stable while moving its implementation.
      name: 'clanker',
      tasks: [Reply, Post],
      tools: [rename],
      sections: [
        section('chat', async (input, ctx) => {
          const source = (await listSources(input.read, ctx)).find(source => source.id === input.conversationId)
          return source ? platformFor(chat, source.threadId).renameInstructions : undefined
        })
      ]
    }),
    discovery: {
      list: listSources,
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
    async connect(agent: Harness, onMessage?: Parameters<typeof connectChat>[5]) {
      harness = agent
      await chat.initialize()
      await connectChat(chat, harness, Reply, selection.model, agentFor, onMessage)
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
