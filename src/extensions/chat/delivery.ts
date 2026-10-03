import type { AssistantMessage, ImageContent } from '@earendil-works/pi-ai'
import { AssistantEntry, defineTask, InboxDoc, LiveDoc, type Harness, type EntryId, type SubmissionId, type TaskId } from '@earendil-works/pi-durable'
import type { Chat } from 'chat'
import { Messages } from 'extensions/chat/state'
import { showTyping } from 'extensions/chat/typing'
import { platformFor } from 'extensions/chat/adapters'

export function createDelivery(chat: Chat, getHarness: () => Harness) {
  return defineTask<
    { threadId: string; messageId: string; text: string; images?: ImageContent[]; previous: TaskId | null },
    | { phase: 'queue' }
    | { phase: 'answer'; submission: SubmissionId }
    | { phase: 'withdraw'; submissions: SubmissionId[] }
    | { phase: 'send'; text: string; answer?: EntryId; attempt?: number; retryAt?: number },
    null
  >({
    name: 'clanker.reply',
    version: 1,
    initial: () => ({ phase: 'queue' }),
    phases: {
      queue: async (task, runtime, ctx) => {
        // Admit input before waiting for earlier replies, so it can steer an active run.
        const conversation = (await runtime.conversation(runtime.conversationId, ctx))!
        const submission = await conversation.submit(
          {
            type: 'input',
            content: task.input.images?.length ? [{ type: 'text', text: task.input.text }, ...task.input.images] : task.input.text,
            requestId: task.input.messageId,
            whenBusy: 'steer'
          },
          ctx
        )
        // Only delivery is serialized. requestId makes admission safe to repeat after a restart.
        await runtime.commit(
          () => ({
            status: 'waiting',
            checkpoint: { phase: 'answer', submission: submission.id },
            on: task.input.previous ? [task.input.previous] : [],
            policy: 'allSettled'
          }),
          ctx
        )
      },
      answer: async (task, runtime, ctx) => {
        using typing = showTyping(chat.thread(task.input.threadId))
        const submission = (await getHarness().submission(task.state.checkpoint.submission, ctx))!
        const settled = await submission.wait(ctx)
        if (settled.status === 'unanswered') {
          if (settled.reason !== 'aborted') console.error('[clanker] Unanswered message', settled)
          await runtime.commit(async tx => {
            if (settled.reason === 'aborted') return { status: 'terminal', outcome: { status: 'completed', result: null } }
            // A newer submission may already have resumed the inbox. Leave that run alone.
            const busy = (await tx.doc(LiveDoc, runtime.conversationId)).run !== undefined
            const inbox = await tx.doc(InboxDoc, runtime.conversationId)
            const submissions = busy ? [] : inbox.items.filter(item => item.mode !== 'write').map(item => item.id)
            // Persist the exact set before withdrawing anything, so recovery cannot cancel newer inputs.
            return { status: 'running', checkpoint: { phase: 'withdraw', submissions } }
          }, ctx)
          return
        }
        await runtime.commit(async tx => {
          let text = 'Sorry, I could not generate a response. Please try again.'
          if (settled.status === 'done' && settled.type === 'input') {
            // Several steers can share an answer. Deliver each distinct answer once, in order.
            if ((await tx.doc(Messages, runtime.conversationId)).lastAnswer === settled.answer) {
              return { status: 'terminal', outcome: { status: 'completed', result: null } }
            }
            const entry = await tx.entry(AssistantEntry, settled.answer)
            const answer = entry!.model![0] as AssistantMessage
            text =
              answer.content
                .flatMap(part => (part.type === 'text' ? [part.text] : []))
                .join('\n')
                .trim() || text
          }
          return {
            status: 'running',
            checkpoint: { phase: 'send', text, ...(settled.status === 'done' && settled.type === 'input' ? { answer: settled.answer } : {}) }
          }
        }, ctx)
      },
      withdraw: async (task, runtime, ctx) => {
        for (const id of task.state.checkpoint.submissions) {
          // This only withdraws queued inputs; already-placed work is unaffected.
          await getHarness().abortSubmission(id, ctx, runtime.conversationId)
        }
        await runtime.commit(
          () => ({
            status: 'running',
            checkpoint: { phase: 'send', text: "Sorry, I couldn't complete this request. Please resend any messages that haven't received a reply." }
          }),
          ctx
        )
      },
      send: async (task, runtime, ctx) => {
        const { text, attempt = 0, retryAt, ...checkpoint } = task.state.checkpoint
        if (retryAt !== undefined) await runtime.sleep(retryAt, ctx)
        const thread = chat.thread(task.input.threadId)
        const chunk = platformFor(chat, thread.id).replyChunk?.(text) ?? text
        const end = chunk.length
        ctx.abortSignal?.throwIfAborted()
        // A crash after the platform accepts a post but before this checkpoint can repeat that chunk.
        try {
          await thread.post({ raw: chunk })
        } catch (error) {
          ctx.abortSignal?.throwIfAborted()
          const message = error instanceof Error ? error.message : String(error)
          console.error('[clanker] Chat delivery failed', { threadId: task.input.threadId, taskId: runtime.taskId, attempt: attempt + 1, message })
          await runtime.commit(
            () =>
              attempt >= 4
                ? {
                    status: 'terminal',
                    outcome: { status: 'failed', error: { message, detail: { attempts: attempt + 1, remainingText: text, answer: checkpoint.answer ?? null } } }
                  }
                : { status: 'running', checkpoint: { ...checkpoint, text, attempt: attempt + 1, retryAt: runtime.now() + 1000 * 2 ** attempt } },
            ctx
          )
          return
        }
        await runtime.commit(async tx => {
          if (text.length > end) return { status: 'running', checkpoint: { ...checkpoint, text: text.slice(end) } }
          if (task.state.checkpoint.answer !== undefined) {
            const messages = await tx.doc(Messages, runtime.conversationId)
            messages.lastAnswer = task.state.checkpoint.answer
          }
          return { status: 'terminal', outcome: { status: 'completed', result: null } }
        }, ctx)
      }
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
    }
  })
}
