import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { AssistantMessage, ImageContent, Models, ModelThinkingLevel } from '@earendil-works/pi-ai'
import { Type } from '@earendil-works/pi-ai'
import {
  AssistantEntry,
  configure,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
  section,
  type ConversationId,
  type ModelRef,
  type Storage,
  type TaskId
} from '@earendil-works/pi-durable'
import type { Chat, Message, Thread } from 'chat'
import type { Discord } from './adapter/discord'
import { Conversations, createDiscovery } from './conversations'
import { downloadImages } from './attachments'
import { showTyping } from './typing'
import type { selectModel } from './model'

const Threads = defineDoc<{ threads: Record<string, ConversationId> }>({
  kind: 'clanker.threads',
  version: 1,
  scope: 'session',
  initial: () => ({ threads: {} })
})

const Messages = defineDoc<{ received: Record<string, TaskId>; lastTask: TaskId | null }>({
  kind: 'clanker.messages',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ received: {}, lastTask: null })
})

export async function connectBot(
  chat: Chat,
  storage: Storage,
  models: Models,
  model: ModelRef,
  thinkingLevel: ModelThinkingLevel,
  queryModel: ReturnType<typeof selectModel>
) {
  const Reply = defineTask<
    { threadId: string; messageId: string; text: string; images?: ImageContent[]; previous: TaskId | null },
    { phase: 'queue' } | { phase: 'answer' } | { phase: 'send'; text: string },
    null
  >({
    name: 'clanker.reply',
    version: 1,
    initial: () => ({ phase: 'queue' }),
    phases: {
      queue: async (task, runtime, ctx) => {
        // Serialize the entire exchange per thread, including Discord delivery, across restarts.
        await runtime.commit(
          () => ({ status: 'waiting', checkpoint: { phase: 'answer' }, on: task.input.previous ? [task.input.previous] : [], policy: 'allSettled' }),
          ctx
        )
      },
      answer: async (task, runtime, ctx) => {
        using typing = showTyping(chat.thread(task.input.threadId))
        const conversation = (await runtime.conversation(runtime.conversationId, ctx))!
        const submission = await conversation.submit(
          {
            type: 'input',
            content: task.input.images?.length ? [{ type: 'text', text: task.input.text }, ...task.input.images] : task.input.text,
            requestId: task.input.messageId
          },
          ctx
        )
        const settled = await submission.wait(ctx)
        if (settled.status === 'unanswered') console.error('[clanker] Unanswered message', settled)
        await runtime.commit(async tx => {
          let text = 'Sorry, I could not generate a response. Please try again.'
          if (settled.status === 'done' && settled.type === 'input') {
            const entry = await tx.entry(AssistantEntry, settled.answer)
            const answer = entry!.model![0] as AssistantMessage
            text =
              answer.content
                .flatMap(part => (part.type === 'text' ? [part.text] : []))
                .join('\n')
                .trim() || text
          }
          return { status: 'running', checkpoint: { phase: 'send', text } }
        }, ctx)
      },
      send: async (task, runtime, ctx) => {
        const text = task.state.checkpoint.text
        // Discord limits content to 2,000 UTF-16 units. Keep surrogate pairs intact.
        const end = /[\uD800-\uDBFF]/.test(text[1999] ?? '') ? 1999 : 2000
        ctx.abortSignal?.throwIfAborted()
        // A crash after Discord accepts a post but before this checkpoint can repeat that chunk.
        await chat.thread(task.input.threadId).post({ raw: text.slice(0, end) })
        await runtime.commit(
          () =>
            text.length > end
              ? { status: 'running', checkpoint: { phase: 'send', text: text.slice(end) } }
              : { status: 'terminal', outcome: { status: 'completed', result: null } },
          ctx
        )
      }
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
    }
  })

  const registry = createRegistry()
  const discord = chat.getAdapter('discord') as Discord
  const discovery = createDiscovery(threadId => discord.discoveryScope(threadId), models, queryModel)
  registry.install(discovery)
  registry.install(
    defineExtension({
      name: 'clanker',
      tasks: [Reply],
      sections: [
        section(
          'clanker',
          () =>
            [
              'You are Clanker, a helpful Discord assistant. Reply clearly and concisely.',
              'Use rename_thread to give the current Discord thread a useful public-facing title only once a substantive topic, project, question, or decision emerges. Keep the existing title for greetings or small talk; never use generic labels like "Friendly Greeting", "General Chat", or "Conversation".',
              'Name the concrete subject, such as "Codex OAuth in Docker". You may rename again as the topic develops, but only when it meaningfully improves the title, not for minor wording changes. This is independent of the internal discovery summary. Do not announce routine renames. The tool only works in actual Discord threads, not DMs or ordinary channels.'
            ].join('\n'),
          { tag: false }
        )
      ],
      tools: [
        defineTool({
          name: 'rename_thread',
          description:
            'Set a substantive, specific title for the current Discord thread. Skip greetings and vague summaries. May be called again when the subject meaningfully changes. Does not modify discovery metadata.',
          parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 100 }) }),
          replay: 'safe',
          execute: async ({ title }, api, ctx) => {
            ctx.abortSignal?.throwIfAborted()
            const entry = (await api.snapshot(Conversations, ctx))?.conversations[api.conversationId]
            if (!entry) throw new Error('No Discord thread is associated with this conversation')
            return { content: [{ type: 'text', text: JSON.stringify(await discord.renameThread(entry.threadId, title)) }] }
          }
        })
      ]
    })
  )
  const harness = await Harness.open(storage, { models, registry, settings: { stream: { timeoutMs: 120_000 } }, onReport: console.error }, context)
  try {
    const receive = async (thread: Thread, message: Message) => {
      if (message.author.isBot) return
      using typing = showTyping(thread)
      const attachments = message.attachments.filter(attachment => attachment.type === 'image' || attachment.mimeType?.startsWith('image/'))
      if (!message.text.trim() && !attachments.length) {
        await thread.post('Please send text or an image. Other attachments are not supported yet.')
        return
      }
      if (attachments.length && !models.getModel(model.provider, model.modelId)!.input.includes('image')) {
        await thread.post('The configured model does not support images. Please select a model with image input.')
        return
      }
      let images: ImageContent[]
      try {
        images = await downloadImages(attachments)
      } catch (error) {
        await thread.post((error as Error).message)
        return
      }
      await thread.subscribe()
      await harness.commit(async tx => {
        const directory = await tx.doc(Threads)
        let id = directory.threads[thread.id]
        if (!id) {
          id = (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id
          await configure(tx, id, { model, thinkingLevel })
          directory.threads[thread.id] = id
        }
        await configure(tx, id, { tools: null })
        const messages = await tx.doc(Messages, id)
        if (messages.received[message.id]) return
        const catalog = (await tx.doc(Conversations)).conversations
        const description = message.text.trim() || 'Image discussion'
        catalog[id] ??= { threadId: thread.id, title: description.slice(0, 100), summary: description.slice(0, 600), updatedAt: '' }
        catalog[id]!.updatedAt = new Date().toISOString()
        const task = await tx.createTask(
          Reply,
          {
            threadId: thread.id,
            messageId: message.id,
            text: `${message.author.fullName || message.author.userName}: ${message.text.trim() || 'Please describe this image.'}`,
            images,
            previous: messages.lastTask
          },
          { conversationId: id, ownership: { kind: 'conversation' } }
        )
        messages.received[message.id] = task
        messages.lastTask = task
      }, context)
      harness.resume()
    }
    chat.onNewMention(receive)
    chat.onDirectMessage(receive)
    chat.onSubscribedMessage(receive)
    for (const [threadId, id] of Object.entries((await harness.snapshot(Threads, context))?.threads ?? {})) {
      await harness.commit(async tx => {
        const catalog = (await tx.doc(Conversations)).conversations
        if (!catalog[id]) {
          const page = await tx.scanEntries({ conversationId: id }, 50)
          const last = page.items.flatMap(entry => entry.model ?? []).find(message => message.role === 'user' && typeof message.content === 'string')
          const text = typeof last?.content === 'string' ? last.content : threadId
          catalog[id] = { threadId, title: text.slice(0, 100), summary: text.slice(0, 600), updatedAt: new Date(last?.timestamp ?? 0).toISOString() }
        }
        await configure(tx, id, { model, thinkingLevel, tools: null })
      }, context)
      await chat.thread(threadId).subscribe()
    }
    harness.resume()
    return harness
  } catch (error) {
    await harness.close(context)
    throw error
  }
}
