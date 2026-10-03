import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { ImageContent } from '@earendil-works/pi-ai'
import { configure, type AgentChange, type Harness } from '@earendil-works/pi-durable'
import type { Chat, Message, Thread } from 'chat'
import { Conversations } from '../discovery'
import { recordMessageAuthor } from '../identity'
import type { selectModel } from '../../model'
import { Threads, Messages } from './state'
import { downloadImages } from './attachments'
import { showTyping } from './typing'
import type { createDelivery } from './delivery'
import { platformFor } from './adapters'

export async function connectChat(
  chat: Chat,
  harness: Harness,
  Reply: ReturnType<typeof createDelivery>,
  model: ReturnType<typeof selectModel>['model'],
  agentFor: (threadId: string) => AgentChange
) {
  const receive = async (thread: Thread, message: Message) => {
    if (message.author.isBot) return
    using typing = showTyping(thread)
    const attachments = message.attachments.filter(attachment => attachment.type === 'image' || attachment.mimeType?.startsWith('image/'))
    if (!message.text.trim() && !attachments.length) {
      await thread.post('Please send text or an image. Other attachments are not supported yet.')
      return
    }
    if (attachments.length && !model.input.includes('image')) {
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
        directory.threads[thread.id] = id
      }
      await configure(tx, id, agentFor(thread.id))
      const messages = await tx.doc(Messages, id)
      if (messages.received[message.id]) return
      const author = await recordMessageAuthor(
        tx,
        id,
        message.id,
        platformFor(chat, thread.id).identifyAuthor(thread.id, message.author),
        message.author.fullName || message.author.userName
      )
      const catalog = (await tx.doc(Conversations)).conversations
      const description = message.text.trim() || 'Image discussion'
      catalog[id] ??= { threadId: thread.id, title: description.slice(0, 100), summary: description.slice(0, 600), updatedAt: '' }
      catalog[id]!.updatedAt = new Date().toISOString()
      const task = await tx.createTask(
        Reply,
        {
          threadId: thread.id,
          messageId: message.id,
          text: `Sender: ${JSON.stringify({ messageId: message.id, identityId: author.identityId, displayName: author.displayName })}\n${message.text.trim() || 'Please describe this image.'}`,
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
      await configure(tx, id, agentFor(threadId))
    }, context)
    await chat.thread(threadId).subscribe()
  }
  harness.resume()
}
