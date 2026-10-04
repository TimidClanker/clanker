import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { ImageContent } from '@earendil-works/pi-ai'
import { configure, type AgentChange, type ConversationId, type Harness, type Tx } from '@earendil-works/pi-durable'
import type { Chat, Message, Thread } from 'chat'
import { recordMessageAuthor } from 'extensions/identity'
import type { selectModel } from 'model'
import { Threads, Messages } from 'extensions/chat/state'
import { downloadImages } from 'extensions/chat/attachments'
import { showTyping } from 'extensions/chat/typing'
import type { createDelivery } from 'extensions/chat/delivery'
import { platformFor } from 'extensions/chat/adapters'

export async function prepareConversation(tx: Tx, threadId: string, agent: AgentChange) {
  const directory = await tx.doc(Threads)
  const id = (directory.threads[threadId] ??= (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id)
  await configure(tx, id, agent)
  return id
}

export async function connectChat(
  chat: Chat,
  harness: Harness,
  Reply: ReturnType<typeof createDelivery>,
  model: ReturnType<typeof selectModel>['model'],
  agentFor: (threadId: string) => AgentChange,
  onMessage?: (tx: Tx, id: ConversationId, text: string) => Promise<void>
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
      const id = await prepareConversation(tx, thread.id, agentFor(thread.id))
      const messages = await tx.doc(Messages, id)
      if (messages.received[message.id]) return
      const author = await recordMessageAuthor(
        tx,
        id,
        message.id,
        platformFor(chat, thread.id).identifyAuthor(thread.id, message.author),
        message.author.fullName || message.author.userName
      )
      await onMessage?.(tx, id, message.text.trim() || 'Image discussion')
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
    await harness.commit(tx => configure(tx, id, agentFor(threadId)), context)
    await chat.thread(threadId).subscribe()
  }
  harness.resume()
}
