import { Chat } from 'chat'
import { createMemoryState } from '@chat-adapter/state-memory'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section, type Harness } from '@earendil-works/pi-durable'
import type { selectModel } from 'model'
import { Conversations } from 'extensions/discovery'
import { findIdentity, getIdentity, recordAutomatedInput, type IdentityAccess } from 'extensions/identity'
import { Discord } from 'extensions/chat/adapters/discord'
import { platformFor, type PlatformAdapter } from 'extensions/chat/adapters'
import { connectChat, prepareConversation } from 'extensions/chat/bridge'
import { createDelivery } from 'extensions/chat/delivery'
import { createPost } from 'extensions/chat/post'
import { Messages } from 'extensions/chat/state'
import type { ScheduleChat } from 'extensions/schedules'
import type { ScheduleInput } from 'extensions/schedules/task'
import type { SandboxAccess } from 'extensions/sandbox'

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
      const entry = (await api.snapshot(Conversations, ctx))?.conversations[api.conversationId]
      if (!entry) throw new Error('No chat thread is associated with this conversation')
      const platform = platformFor(chat, entry.threadId)
      if (!platform.renameThread) throw new Error('This platform does not support thread renaming')
      return { content: [{ type: 'text', text: JSON.stringify(await platform.renameThread(entry.threadId, title)) }] }
    }
  })
  const agentFor = (threadId: string) => ({
    model: { provider: selection.model.provider, modelId: selection.model.id },
    thinkingLevel: selection.thinkingLevel,
    tools: platformFor(chat, threadId).renameThread ? null : { remove: [rename] }
  })

  return {
    sandbox: {
      async resolve(read, conversationId, accounts, ctx) {
        if (!accounts.length) throw new Error('Sandbox access requires a verified requester')
        const entry = (await read.snapshot(Conversations, ctx))?.conversations[conversationId]
        if (!entry) throw new Error('Sandbox access requires a chat conversation')
        const platform = platformFor(chat, entry.threadId)
        if (!platform.sandboxAudience) throw new Error('This platform cannot verify sandbox membership')
        const recipient = await platform.sandboxAudience(entry.threadId, accounts)
        if (!recipient) return { kind: 'conversation', id: String(conversationId) }
        const id = await findIdentity(read, recipient, ctx)
        if (!id || (await Promise.all(accounts.map(account => findIdentity(read, account, ctx)))).some(author => author !== id)) {
          throw new Error('Private sandbox access requires the verified recipient')
        }
        return { kind: 'identity', id, aliases: (await getIdentity(read, id, ctx)).aliases }
      }
    } satisfies SandboxAccess,
    schedules: {
      async resolve(source, account, reference, ctx) {
        const current = (await harness.snapshot(Conversations, ctx))?.conversations[source]
        if (!current) throw new Error('No chat thread is associated with this conversation')
        if (reference === undefined) return { threadId: current.threadId, title: current.title }
        const platform = platformFor(chat, current.threadId)
        if (!platform.resolveDestination) throw new Error('This platform does not support directing tasks to other channels')
        return platform.resolveDestination(current.threadId, account, reference)
      },
      async check(destination, account) {
        const platform = platformFor(chat, destination.threadId)
        await platform.resolveDestination?.(destination.threadId, account, destination.threadId)
        await chat.thread(destination.threadId).subscribe()
      },
      prepare: (tx, destination) => prepareConversation(tx, destination.threadId, agentFor(destination.threadId), destination.title),
      async enqueue(tx, conversationId, schedule, requestId, text) {
        const destination = (await tx.doc(Conversations)).conversations[conversationId]
        if (!destination) throw new Error('No chat thread is associated with this schedule')
        const owner = (await tx.task(schedule))!.input as ScheduleInput
        await recordAutomatedInput(tx, conversationId, requestId, {
          identityId: owner.ownerIdentityId,
          account: owner.ownerAccount,
          displayName: owner.ownerName
        })
        const messages = await tx.doc(Messages, conversationId)
        const reply = await tx.createTask(
          Reply,
          { threadId: destination.threadId, messageId: requestId, text, previous: messages.lastTask, schedule },
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
        const entry = (await read.snapshot(Conversations, ctx))?.conversations[conversationId]
        if (!entry) return null
        return (await platformFor(chat, entry.threadId).privateRecipient?.(entry.threadId)) ?? null
      }
    } satisfies IdentityAccess,
    extension: defineExtension({
      // Keep the stored selection name stable while moving its implementation.
      name: 'clanker',
      tasks: [Reply, Post],
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
      await connectChat(chat, harness, Reply, selection.model, agentFor)
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
